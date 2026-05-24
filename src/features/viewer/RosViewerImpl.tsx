import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@/shared/lib/utils';
import { createRosViewIntl } from '@/shared/intl/createRosViewIntl';
import { RosViewProvider } from './RosViewProvider';
import { AppShell } from '@/app/AppShell';
import { SampleDatasetDialog } from '@/features/workspace/common/SampleDatasetDialog';
import { getArchiveUrl, getSampleDatasetsManifestUrl, loadSampleDatasets } from '@/services/sampleDatasets';
import type { SampleDataset } from '@/services/sampleDatasets';
import { extractRosFilesFromTarArchive } from '@/shared/utils/tarRosRecordings';
import { WorkerSerializedSource } from '@/infra/workers/WorkerSerializedSource';
import { IterablePlayer } from '@/core/players/IterablePlayer';
import { MinimalPlayer } from '@/core/players/MinimalPlayer';
import type { Player } from '@/core/types/player';
import { useMessagePipelineStore } from '@/core/pipeline/store';
import { Navbar } from '@/features/workspace/navbar/Navbar';
import { WelcomeScreen } from '@/features/workspace/common/WelcomeScreen';
import type { DatasetItem, FileListItem } from '@/shared/utils/datasetSources';
import {
  datasetItemsFromListItems,
  dedupeDatasetItems,
  filterRosFilesFromFileList,
  isRosRecordingFilename,
  mergeDatasetLists,
  normalizeRosViewSources,
  parseRemoteDatasetListJson,
} from '@/shared/utils/datasetSources';
import {
  collectRosFilesFromUserDirectoryChoice,
  walkDirectoryHandle,
} from '@/shared/utils/collectDirectoryRosFiles';
import {
  ensureReadPermission,
  fingerprintRosFileSet,
  getDatasetHistoryEntry,
  getLatestReplayableHistoryByLocalLocator,
  listDatasetHistory,
  tarFileFingerprint,
  upsertDatasetHistoryEntry,
} from '@/shared/utils/datasetHistory';
import type { DatasetHistoryListItem, DatasetHistoryStoredEntry } from '@/shared/utils/datasetHistory';
import {
  alignFileHandlesToRosFiles,
  collectRosRecordingFilesFromDataTransfer,
  collectRosRecordingFileHandlesFromDataTransfer,
} from '@/shared/utils/collectDragFileHandles';
import { pickRosRecordingFiles } from '@/shared/utils/openRosRecordingFilePicker';
import { resolveBrowserHttpUrl } from '@/shared/utils/resolveBrowserHttpUrl';
import {
  type SourceLocator,
  isCustomLocalLocatorString,
  parseSourceLocator,
  pushSpaUrlParam,
  serializeSourceLocator,
} from '@/shared/utils/sourceLocator';
import { readPreferences, writePreferences } from '@/core/preferences/readWritePreferences';
import {
  mergeInitialUiPreferences,
  readUiPreferenceParamsFromSearch,
} from '@/core/preferences/mergeInitialUiPreferences';
import type { PreferencePersistence } from '@/core/preferences/types';
import type { FoxgloveLayoutData } from '@/core/preferences/foxgloveLayout';
import { ROS_VIEW_LAYOUT_STORAGE_KEY } from '@/core/preferences/storageKeys';
import type { OpenPanelInput } from '@/features/layout/dockviewController';
import { resolveEmbedChrome, type RosViewerChrome, type RosViewerMode } from './embedChrome';
import { RosViewerLayoutProvider } from './RosViewerLayoutContext';
import type { RosViewExtension } from '@/core/extensions/types';
import { toast } from 'sonner';
import sqlWasmUrl from "@foxglove/sql.js/dist/sql-wasm.wasm?url";

let sqlWasmBinaryPromise: Promise<ArrayBuffer> | null = null;

async function loadSqlWasmBinary(): Promise<ArrayBuffer> {
  sqlWasmBinaryPromise ??= fetch(sqlWasmUrl).then((response) => {
    if (!response.ok) {
      throw new Error(`Failed to load SQL wasm: HTTP ${response.status}`);
    }
    return response.arrayBuffer();
  });
  return await sqlWasmBinaryPromise;
}

function extensionForDataset(ds: DatasetItem): string | undefined {
  if (ds.kind === 'file' && ds.file) {
    return ds.file.name.split('.').pop()?.toLowerCase();
  }
  if (ds.kind === 'url' && ds.url) {
    try {
      const path = new URL(ds.url).pathname;
      return path.split('.').pop()?.toLowerCase();
    } catch {
      return ds.url.split('.').pop()?.toLowerCase();
    }
  }
  return undefined;
}

async function createWorkerForExtension(ext: string | undefined): Promise<Worker> {
  if (ext === 'bvh') {
    const { default: BvhWorkerClass } = await import('@/infra/workers/bvh.worker.ts?worker&inline');
    return new BvhWorkerClass();
  }
  if (ext === 'bag') {
    const { default: BagWorkerClass } = await import('@/infra/workers/bag.worker.ts?worker&inline');
    return new BagWorkerClass();
  }
  if (ext === 'db3') {
    const { default: Db3WorkerClass } = await import('@/infra/workers/db3.worker.ts?worker&inline');
    return new Db3WorkerClass();
  }
  if (ext === 'hdf5' || ext === 'h5') {
    const { default: Hdf5WorkerClass } = await import('@/infra/workers/hdf5.worker.ts?worker&inline');
    return new Hdf5WorkerClass();
  }
  const { default: McapWorkerClass } = await import('@/infra/workers/mcap.worker.ts?worker&inline');
  return new McapWorkerClass();
}

async function initializePlayerForDataset(
  player: IterablePlayer,
  ds: DatasetItem,
  ext: string | undefined,
  autoDataQualityScan: boolean,
): Promise<void> {
  const workerPerf =
    typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('workerPerf') === '1';
  const sqlWasmBinary = ext === 'db3' ? await loadSqlWasmBinary() : undefined;
  if (ds.kind === 'url' && ds.url) {
    const init: Record<string, unknown> = {
      url: resolveBrowserHttpUrl(ds.url),
      workerPerf,
      autoDataQualityScan,
    };
    if (ext === 'db3') {
      init.sqlWasmBinary = sqlWasmBinary;
    }
    if (
      typeof ds.sizeBytes === 'number' &&
      Number.isFinite(ds.sizeBytes) &&
      ds.sizeBytes > 0
    ) {
      init.knownTotalBytes = Math.floor(ds.sizeBytes);
    }
    await player.initialize(init);
    return;
  }
  if (ds.kind === 'file' && ds.file) {
    const siblingFiles = ds.siblingFiles?.filter((file) => isRosRecordingFilename(file.name)) ?? [];
    const files = siblingFiles.length > 0 ? siblingFiles : [ds.file];
    if (ext === 'bag' || ext === 'db3') {
      await player.initialize({
        file: ds.file,
        files,
        workerPerf,
        autoDataQualityScan,
        ...(sqlWasmBinary ? { sqlWasmBinary } : {}),
      });
    } else {
      await player.initialize({ file: ds.file, workerPerf, autoDataQualityScan });
    }
    return;
  }
  throw new Error('Invalid dataset item');
}

/** Try indices in order: startIdx .. end-1, then 0 .. startIdx-1 */
function fallbackIndexOrder(length: number, startIdx: number): number[] {
  if (length <= 0) return [];
  const s = Math.max(0, Math.min(startIdx, length - 1));
  const out: number[] = [];
  for (let i = s; i < length; i++) out.push(i);
  for (let i = 0; i < s; i++) out.push(i);
  return out;
}

function propsSignature(props: RosViewerProps): string {
  const urlState = props.urlState ?? 'off';
  const urls = (props.urls ?? []).map((u) => u.trim()).join('\0');
  const url = props.url?.trim() ?? '';
  const files = (props.files ?? []).map((f) => `${f.name}:${f.size}:${f.lastModified}`).join('\0');
  const file = props.file ? `${props.file.name}:${props.file.size}:${props.file.lastModified}` : '';
  const fileListSig =
    props.fileManifest == null
      ? ''
      : typeof props.fileManifest === 'string'
        ? props.fileManifest.trim()
        : JSON.stringify(props.fileManifest);
  return `${urlState}|${urls}|${url}|${files}|${file}|${fileListSig}`;
}

function initialUiFromProps(p: RosViewerProps) {
  const persistence: PreferencePersistence = p.preferencePersistence ?? 'localStorage';
  const { urlTheme, urlLanguage } = readUiPreferenceParamsFromSearch(
    typeof window !== 'undefined' ? window.location.search : '',
  );
  return mergeInitialUiPreferences({
    persistence,
    propsTheme: p.theme,
    propsLanguage: p.language,
    urlTheme,
    urlLanguage,
    stored: persistence === 'localStorage' ? readPreferences() : null,
  });
}

function errorMessageFromUnknown(error: unknown, fallback: string): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return fallback;
}

export interface RosViewerProps {
  url?: string;
  file?: File;
  urls?: string[];
  files?: File[];
  theme?: 'light' | 'dark' | 'system';
  language?: 'en' | 'zh' | 'ja';
  /** CSS class applied to the outermost container element. */
  className?: string;
  /** Inline styles applied to the outermost container element. */
  style?: React.CSSProperties;
  onFatalError?: (error: Error) => void;
  /**
   * `'localStorage'`: read/write `ioai.rosview.prefs`. `'off'`: no storage (host owns prefs).
   * @default 'localStorage'
   */
  preferencePersistence?: PreferencePersistence;
  /** Fired when the user changes theme in the navbar (orthogonal to persistence). */
  onThemeChange?: (theme: 'light' | 'dark' | 'system') => void;
  /** Fired when the user changes language in the navbar. */
  onLanguageChange?: (language: 'en' | 'zh' | 'ja') => void;
  /** Fired after this component rewrites SPA query state and the host should re-read `window.location.search`. */
  onSpaUrlQuerySync?: () => void;
  /**
   * Remote dataset manifest: JSON URL or parsed rows.
   * Merged/deduped with `url` / `urls`; fetch errors are logged only and do not block other sources.
   */
  fileManifest?: string | FileListItem[];
  /** Optional third-party extension contributions for sidebar and playback overlays. */
  extensions?: RosViewExtension[];
  /** Optional center label override shown in navbar source area. */
  navbarSourceName?: string;
  /** Whether to show navbar language switcher. @default true */
  showLanguageSwitcher?: boolean;
  /** Whether to show navbar theme switcher. @default true */
  showThemeSwitcher?: boolean;
  /** Prefer auto layout bootstrap over welcome placeholder in embedded mode. @default false */
  preferAutoLayout?: boolean;
  /**
   * `spa`: sync `?url=` with the active source; restore `file://` / `folder://` from IndexedDB on load, and `sample://` from the sample manifest.
   * `off`: library / embed — never writes the URL; custom locators in `url` do not auto-restore.
   * @default 'off'
   */
  urlState?: 'spa' | 'off';
  /**
   * Opaque host payload forwarded to every `RosViewExtension` as `context.hostContext`.
   * RosView does not read or validate this object.
   */
  hostContext?: unknown;
  /**
   * Embed preset. `tool` opens panels without a recording source (MinimalPlayer) and defaults to panels-only chrome.
   * @default 'viewer'
   */
  mode?: RosViewerMode;
  /** When false, mount MinimalPlayer and workspace without url/file. @default true (false when mode='tool'). */
  requireSource?: boolean;
  /** Chrome preset; overridden by explicit showNavbar/showSidebar/showPlaybackBar. */
  chrome?: RosViewerChrome;
  showNavbar?: boolean;
  showSidebar?: boolean;
  showPlaybackBar?: boolean;
  /** Hide navbar file menus and disable recording drag-and-drop in the workspace. */
  hideOpenFileMenus?: boolean;
  /**
   * `'inherit'`: follow `preferencePersistence`. `'off'`: never read/write layout localStorage.
   * @default 'inherit'
   */
  layoutPersistence?: PreferencePersistence | 'inherit';
  layoutStorageKey?: string;
  /** Applied on mount before saved layout. */
  initialLayout?: FoxgloveLayoutData;
  /** Shorthand single-panel layout when `initialLayout` is omitted. */
  defaultPanel?: OpenPanelInput;
  /** When true (default for mode='tool'), skip Dockview Welcome placeholder. */
  suppressWelcomePanel?: boolean;
  onLayoutReady?: (info: { panelCount: number }) => void;
  onPlayerReady?: (ctx: { player: Player; hasSource: boolean }) => void;
  onSourceLoadingChange?: (loading: boolean) => void;
}

function resolveLayoutPersistence(
  layoutPersistence: PreferencePersistence | 'inherit' | undefined,
  preferencePersistence: PreferencePersistence,
): PreferencePersistence {
  if (layoutPersistence === undefined || layoutPersistence === 'inherit') {
    return preferencePersistence;
  }
  return layoutPersistence;
}

function datasetItemToSourceLocator(ds: DatasetItem): SourceLocator | null {
  if (ds.kind === 'url' && ds.url) {
    const resolvedUrl = resolveBrowserHttpUrl(ds.url);
    return { kind: 'remote', raw: ds.url.trim(), resolvedUrl };
  }
  if (ds.kind === 'file' && ds.file) {
    return { kind: 'local_file', displayName: ds.file.name };
  }
  return null;
}

export const RosViewer: React.FC<RosViewerProps> = (props) => {
  const urlState = props.urlState ?? 'off';
  const propSig = propsSignature(props);
  const fromProps = useMemo(
    () =>
      normalizeRosViewSources({
        file: props.file,
        files: props.files,
        url: isCustomLocalLocatorString(props.url) ? undefined : props.url,
        urls: urlState === 'spa' ? undefined : props.urls,
        fileManifest: Array.isArray(props.fileManifest) ? props.fileManifest : undefined,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- propSig fingerprints File identity and source props
    [propSig, urlState],
  );

  const [extraDatasets, setExtraDatasets] = useState<DatasetItem[]>([]);

  useEffect(() => {
    const targets: string[] = [];
    if (typeof props.fileManifest === 'string' && props.fileManifest.trim()) {
      targets.push(resolveBrowserHttpUrl(props.fileManifest.trim()));
    }
    if (targets.length === 0) return;
    let cancelled = false;
    void (async () => {
      const merged: FileListItem[] = [];
      for (const t of targets) {
        try {
          const res = await fetch(t);
          if (!res.ok) {
            console.warn('[RosViewer] dataset list HTTP', res.status, t);
            continue;
          }
          const json: unknown = await res.json();
          merged.push(...parseRemoteDatasetListJson(json));
        } catch (e) {
          console.warn('[RosViewer] dataset list fetch failed', t, e);
        }
      }
      if (cancelled || merged.length === 0) return;
      setExtraDatasets((prev) => mergeDatasetLists(prev, datasetItemsFromListItems(merged)));
    })();
    return () => {
      cancelled = true;
    };
  }, [propSig, props.fileManifest]);

  const datasets = useMemo(() => mergeDatasetLists(fromProps, extraDatasets), [fromProps, extraDatasets]);

  const datasetsRef = useRef(datasets);
  // eslint-disable-next-line react-hooks/refs -- sync latest datasets for async player init
  datasetsRef.current = datasets;

  const onFatalErrorRef = useRef(props.onFatalError);
  useEffect(() => {
    onFatalErrorRef.current = props.onFatalError;
  }, [props.onFatalError]);

  const [activeId, setActiveId] = useState<string | null>(null);
  /** When fallback loads a non-selected dataset, highlights it in the sidebar without re-running the activeId load effect. */
  const [loadedDatasetId, setLoadedDatasetId] = useState<string | null>(null);
  const [lastLoadError, setLastLoadError] = useState<string | null>(null);
  const [manualOpenHint, setManualOpenHint] = useState<string | null>(null);

  useEffect(() => {
    setExtraDatasets([]);
    setLoadedDatasetId(null);
    setManualOpenHint(null);
  }, [propSig]);

  const [currentTheme, setCurrentTheme] = useState<'light' | 'dark' | 'system'>(() => initialUiFromProps(props).theme);
  const [currentLanguage, setCurrentLanguage] = useState<'en' | 'zh' | 'ja'>(() => initialUiFromProps(props).language);
  const [player, setPlayer] = useState<Player | null>(null);
  const [sampleDialogOpen, setSampleDialogOpen] = useState(false);
  const [remoteUrlBusy, setRemoteUrlBusy] = useState(false);
  const [historyItems, setHistoryItems] = useState<DatasetHistoryListItem[]>([]);
  const fileInputDomIdRef = useRef('rosview-landing-file');
  const tarInputDomIdRef = useRef('rosview-landing-tar');
  /** Invalidates in-flight SPA `file://` / `folder://` / `sample://` bootstrap when deps change or effect cleans up. */
  const spaUrlBootstrapGenRef = useRef(0);
  /** When set, successful player init writes `sample://…` to the address bar instead of the resolved archive URL. */
  const spaSampleLocatorParamRef = useRef<string | null>(null);

  const offlineIntl = useMemo(() => createRosViewIntl(currentLanguage), [currentLanguage]);

  const clearOpenFeedback = useCallback(() => {
    setLastLoadError(null);
    setManualOpenHint(null);
  }, []);

  const showOpenError = useCallback((message: string) => {
    setLastLoadError(message);
    setManualOpenHint(null);
    toast.error(message);
  }, []);

  const refreshHistory = useCallback(async () => {
    const list = await listDatasetHistory();
    setHistoryItems(list);
  }, []);

  useEffect(() => {
    void refreshHistory();
  }, [refreshHistory]);

  const recordHistoryEntry = useCallback(
    async (row: Omit<DatasetHistoryStoredEntry, 'id' | 'openedAt'>) => {
      try {
        await upsertDatasetHistoryEntry(row);
      } catch (e) {
        console.warn('[RosViewer] dataset history write failed', e);
      }
      await refreshHistory();
    },
    [refreshHistory],
  );

  const persistence: PreferencePersistence = props.preferencePersistence ?? 'localStorage';
  const requireSource = props.requireSource ?? props.mode !== 'tool';
  const embedChrome = useMemo(
    () =>
      resolveEmbedChrome({
        mode: props.mode,
        chrome: props.chrome,
        showNavbar: props.showNavbar,
        showSidebar: props.showSidebar,
        showPlaybackBar: props.showPlaybackBar,
      }),
    [props.mode, props.chrome, props.showNavbar, props.showSidebar, props.showPlaybackBar],
  );
  const resolvedLayoutPersistence = resolveLayoutPersistence(props.layoutPersistence, persistence);
  const layoutStorageKey = props.layoutStorageKey ?? ROS_VIEW_LAYOUT_STORAGE_KEY;
  const suppressWelcomePanel = props.suppressWelcomePanel ?? props.mode === 'tool';
  const onThemeChangeProp = props.onThemeChange;
  const onLanguageChangeProp = props.onLanguageChange;

  const handleThemeChange = useCallback(
    (theme: 'light' | 'dark' | 'system') => {
      setCurrentTheme(theme);
      if (persistence === 'localStorage' && (theme === 'light' || theme === 'dark')) {
        writePreferences({ theme });
      }
      onThemeChangeProp?.(theme);
    },
    [persistence, onThemeChangeProp],
  );

  const handleLanguageChange = useCallback(
    (language: 'en' | 'zh' | 'ja') => {
      setCurrentLanguage(language);
      if (persistence === 'localStorage') {
        writePreferences({ language });
      }
      onLanguageChangeProp?.(language);
    },
    [persistence, onLanguageChangeProp],
  );

  useEffect(() => {
    if (props.theme != null) setCurrentTheme(props.theme);
  }, [props.theme]);

  useEffect(() => {
    if (props.language != null) setCurrentLanguage(props.language);
  }, [props.language]);

  useEffect(() => {
    if (datasets.length === 0) {
      setActiveId(null);
      return;
    }
    setActiveId((prev) => {
      if (prev && datasets.some((d) => d.id === prev)) return prev;
      return datasets[0].id;
    });
  }, [datasets]);

  const resolvedDatasetId = loadedDatasetId ?? activeId;
  const activeDataset = useMemo(
    () => (resolvedDatasetId ? datasets.find((d) => d.id === resolvedDatasetId) ?? null : null),
    [datasets, resolvedDatasetId],
  );

  const loadingSourceName = activeDataset
    ? activeDataset.kind === 'url'
      ? activeDataset.url
      : activeDataset.file?.name
    : undefined;
  const effectiveSourceName = props.navbarSourceName ?? loadingSourceName;

  const hasSource = datasets.length > 0;
  const sourceLoading = hasSource && player == null && lastLoadError == null;

  const onPlayerReadyRef = useRef(props.onPlayerReady);
  useEffect(() => {
    onPlayerReadyRef.current = props.onPlayerReady;
  }, [props.onPlayerReady]);
  const playerReadyFiredRef = useRef(false);

  useEffect(() => {
    playerReadyFiredRef.current = false;
  }, [player]);

  useEffect(() => {
    if (!player) return;
    const fireIfReady = () => {
      if (playerReadyFiredRef.current) return;
      if (useMessagePipelineStore.getState().playerState.presence !== 'ready') return;
      playerReadyFiredRef.current = true;
      onPlayerReadyRef.current?.({ player, hasSource });
    };
    fireIfReady();
    return useMessagePipelineStore.subscribe(fireIfReady);
  }, [player, hasSource]);

  const onSourceLoadingChangeRef = useRef(props.onSourceLoadingChange);
  useEffect(() => {
    onSourceLoadingChangeRef.current = props.onSourceLoadingChange;
  }, [props.onSourceLoadingChange]);

  useEffect(() => {
    onSourceLoadingChangeRef.current?.(sourceLoading);
  }, [sourceLoading]);

  useEffect(() => {
    if (requireSource || hasSource) return;
    const minimal = new MinimalPlayer();
    setPlayer(minimal);
    return () => {
      minimal.close();
      setPlayer(null);
    };
  }, [requireSource, hasSource]);

  useEffect(() => {
    fileInputDomIdRef.current = hasSource ? 'rosview-inline-file' : 'rosview-landing-file';
    tarInputDomIdRef.current = hasSource ? 'rosview-inline-tar' : 'rosview-landing-tar';
  }, [hasSource]);

  const appendFilesAsDatasets = useCallback((files: File[], focusFirstNew = true, groupFiles?: File[]) => {
    const siblingFiles = groupFiles && groupFiles.length > 1 ? [...groupFiles] : undefined;
    const items = dedupeDatasetItems(
      files.map((f) => ({
        id: `file:${f.name}:${f.size}:${f.lastModified}`,
        kind: 'file' as const,
        name: f.name,
        file: f,
        ...(siblingFiles ? { siblingFiles } : {}),
      })),
    );
    setExtraDatasets((prev) => mergeDatasetLists(prev, items));
    if (items.length > 0 && focusFirstNew) {
      setActiveId(items[0].id);
      setLoadedDatasetId(null);
      clearOpenFeedback();
    } else if (items.length > 0) {
      setLoadedDatasetId(null);
      clearOpenFeedback();
    }
  }, [clearOpenFeedback]);

  const recordLocalRosFilesHistory = useCallback(
    (files: File[], fileHandles?: FileSystemFileHandle[]) => {
      if (files.length === 0) return;
      const displayName =
        files.length === 1 ? files[0].name : `${files[0].name} +${String(files.length - 1)}`;
      const canReplayWithHandles = Array.isArray(fileHandles) && fileHandles.length === files.length;
      const fileSetFingerprint = fingerprintRosFileSet(files);
      void recordHistoryEntry({
        kind: canReplayWithHandles ? 'files' : 'file_meta',
        displayName,
        fileSetFingerprint,
        ...(canReplayWithHandles ? { fileHandles } : {}),
        detail:
          files.length > 1
            ? offlineIntl.formatMessage({ id: 'welcome.historyFileCount' }, { count: files.length })
            : undefined,
      });
    },
    [offlineIntl, recordHistoryEntry],
  );

  const handleDropRosRecordingFiles = useCallback(
    async (inputFiles: File[], dataTransferItems?: DataTransferItemList) => {
      const dropped = await collectRosRecordingFilesFromDataTransfer(dataTransferItems);
      const files = dropped?.files.length ? dropped.files : filterRosFilesFromFileList(inputFiles);
      if (files.length === 0) return;
      let fileHandles = dropped?.fileHandles;
      if (!fileHandles && dataTransferItems && dataTransferItems.length > 0) {
        const raw = await collectRosRecordingFileHandlesFromDataTransfer(dataTransferItems);
        if (raw?.length) {
          fileHandles = await alignFileHandlesToRosFiles(files, raw);
        }
      }
      clearOpenFeedback();
      if (urlState === 'spa') {
        spaSampleLocatorParamRef.current = null;
      }
      appendFilesAsDatasets(files, true, files);
      if (dropped?.directoryHandle) {
        void recordHistoryEntry({
          kind: 'directory',
          displayName: dropped.directoryHandle.name,
          directoryHandle: dropped.directoryHandle,
          detail: offlineIntl.formatMessage({ id: 'welcome.historyFileCount' }, { count: files.length }),
        });
        if (urlState === 'spa') {
          pushSpaUrlParam(
            serializeSourceLocator({ kind: 'local_folder', displayName: dropped.directoryHandle.name }),
          );
        }
      } else {
        recordLocalRosFilesHistory(files, fileHandles);
      }
    },
    [appendFilesAsDatasets, clearOpenFeedback, offlineIntl, recordHistoryEntry, recordLocalRosFilesHistory, urlState],
  );

  const handleOpenDirectory = useCallback(async () => {
    clearOpenFeedback();
    if (urlState === 'spa') {
      spaSampleLocatorParamRef.current = null;
    }
    try {
      const { files, directoryHandle } = await collectRosFilesFromUserDirectoryChoice();
      if (files.length === 0) {
        return;
      }
      appendFilesAsDatasets(files, true, files);
      if (directoryHandle) {
        await recordHistoryEntry({
          kind: 'directory',
          displayName: directoryHandle.name,
          directoryHandle,
          detail: offlineIntl.formatMessage({ id: 'welcome.historyFileCount' }, { count: files.length }),
        });
        if (urlState === 'spa') {
          pushSpaUrlParam(
            serializeSourceLocator({ kind: 'local_folder', displayName: directoryHandle.name }),
          );
        }
      } else {
        await recordHistoryEntry({
          kind: 'directory_fallback',
          displayName: offlineIntl.formatMessage({ id: 'welcome.historyFolderPicker' }),
          detail: offlineIntl.formatMessage({ id: 'welcome.historyFileCount' }, { count: files.length }),
        });
      }
    } catch (e) {
      showOpenError(errorMessageFromUnknown(e, offlineIntl.formatMessage({ id: 'errors.loadFailed' })));
    }
  }, [appendFilesAsDatasets, clearOpenFeedback, offlineIntl, recordHistoryEntry, showOpenError, urlState]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (!Array.from(e.dataTransfer.types).includes('Files')) {
      return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      if (!Array.from(e.dataTransfer.types).includes('Files')) {
        return;
      }
      e.preventDefault();
      void handleDropRosRecordingFiles(Array.from(e.dataTransfer.files), e.dataTransfer.items);
    },
    [handleDropRosRecordingFiles],
  );

  useEffect(() => {
    if (!requireSource && !hasSource) {
      return;
    }
    if (!hasSource || !activeId) {
      setPlayer(null);
      return;
    }

    const datasetsLive = datasetsRef.current;
    if (!datasetsLive.find((d) => d.id === activeId)) {
      setPlayer(null);
      return;
    }

    let cancelled = false;
    let createdPlayer: IterablePlayer | null = null;

    const run = async () => {
      setLastLoadError(null);
      const startIdx = datasetsLive.findIndex((d) => d.id === activeId);
      const order = fallbackIndexOrder(datasetsLive.length, startIdx >= 0 ? startIdx : 0);
      let lastErr: unknown = null;

      for (const idx of order) {
        if (cancelled) return;
        const ds = datasetsLive[idx];
        const ext = extensionForDataset(ds);
        const worker = await createWorkerForExtension(ext);
        if (cancelled) {
          worker.terminate();
          return;
        }
        worker.onerror = (ev) => console.error('MAIN: Worker error', ev);

        const source = new WorkerSerializedSource(worker);
        const newPlayer = new IterablePlayer(source);
        createdPlayer = newPlayer;
        if (!cancelled) setPlayer(newPlayer);
        const autoDataQualityScan =
          persistence === 'localStorage' && readPreferences()?.autoDataQualityScan === true;

        try {
          await initializePlayerForDataset(newPlayer, ds, ext, autoDataQualityScan);
          if (cancelled) {
            newPlayer.close();
            createdPlayer = null;
            return;
          }
          // Do not call setActiveId here: it would re-run this effect's cleanup and close the player we just opened (multi-source fallback).
          setLoadedDatasetId(ds.id !== activeId ? ds.id : null);
          clearOpenFeedback();
          if (urlState === 'spa') {
            const sampleParam = spaSampleLocatorParamRef.current;
            if (sampleParam) {
              pushSpaUrlParam(sampleParam);
              spaSampleLocatorParamRef.current = null;
            } else {
              const loc = datasetItemToSourceLocator(ds);
              if (loc) {
                pushSpaUrlParam(serializeSourceLocator(loc));
              }
            }
          }
          return;
        } catch (err) {
          lastErr = err;
          newPlayer.close();
          createdPlayer = null;
          if (!cancelled) setPlayer(null);
        }
      }

      if (cancelled) return;
      const message =
        lastErr instanceof Error
          ? lastErr.message
          : typeof lastErr === 'string'
            ? lastErr
            : offlineIntl.formatMessage({ id: 'errors.loadFailed' });
      showOpenError(message);
      onFatalErrorRef.current?.(lastErr instanceof Error ? lastErr : new Error(message));
    };

    void run();

    return () => {
      cancelled = true;
      createdPlayer?.close();
      setPlayer(null);
    };
  }, [activeId, clearOpenFeedback, hasSource, offlineIntl, persistence, requireSource, showOpenError, urlState]);

  const onDatasetSelect = useCallback(
    (id: string) => {
      clearOpenFeedback();
      setLoadedDatasetId(null);
      if (urlState === 'spa') {
        spaSampleLocatorParamRef.current = null;
      }
      setActiveId(id);
    },
    [clearOpenFeedback, urlState],
  );

  const onAddFilesFromPicker = useCallback(
    (fileList: FileList | null) => {
      if (!fileList?.length) return;
      clearOpenFeedback();
      if (urlState === 'spa') {
        spaSampleLocatorParamRef.current = null;
      }
      const ros = filterRosFilesFromFileList(fileList);
      appendFilesAsDatasets(ros, false, ros);
      recordLocalRosFilesHistory(ros);
    },
    [appendFilesAsDatasets, clearOpenFeedback, recordLocalRosFilesHistory, urlState],
  );

  function remotePathnameLower(url: string): string {
    try {
      return new URL(url).pathname.toLowerCase();
    } catch {
      return url.split('?')[0].split('#')[0].toLowerCase();
    }
  }

  const handleOpenRemoteRecordingUrl = useCallback(
    async (
      rawUrl: string,
      meta?: {
        sample?: { id: string; title: string };
      },
    ) => {
      if (urlState === 'spa') {
        if (meta?.sample?.id?.trim()) {
          spaSampleLocatorParamRef.current = serializeSourceLocator({
            kind: 'sample',
            sampleId: meta.sample.id.trim(),
          });
        } else {
          spaSampleLocatorParamRef.current = null;
        }
      }

      const trimmed = rawUrl.trim();
      if (!trimmed) return;
      const resolved = resolveBrowserHttpUrl(trimmed);
      const pathLower = remotePathnameLower(resolved);
      const isRemoteTar =
        pathLower.endsWith('.tar') || pathLower.endsWith('.tar.gz') || pathLower.endsWith('.tgz');

      setRemoteUrlBusy(true);
      clearOpenFeedback();
      try {
        if (isRemoteTar) {
          const res = await fetch(resolved);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const buf = await res.arrayBuffer();
          const extracted = extractRosFilesFromTarArchive(buf);
          if (extracted.length === 0) {
            throw new Error(offlineIntl.formatMessage({ id: 'errors.noRecordingsInArchive' }));
          }
          appendFilesAsDatasets(extracted);
          const tail = resolved.split('/').pop() || resolved;
          await recordHistoryEntry({
            kind: meta?.sample ? 'sample' : 'remote_tar',
            displayName: meta?.sample?.title ?? tail,
            url: resolved,
            sampleId: meta?.sample?.id,
            detail: offlineIntl.formatMessage({ id: 'welcome.historyFileCount' }, { count: extracted.length }),
          });
        } else {
          setExtraDatasets((prev) => mergeDatasetLists(prev, normalizeRosViewSources({ url: resolved })));
          setActiveId(`url:${resolved}`);
          setLoadedDatasetId(null);
          const tail = resolved.split('/').pop() || resolved;
          await recordHistoryEntry({
            kind: meta?.sample ? 'sample' : 'url',
            displayName: meta?.sample?.title ?? tail,
            url: resolved,
            sampleId: meta?.sample?.id,
          });
        }
      } catch (e) {
        if (urlState === 'spa') {
          spaSampleLocatorParamRef.current = null;
        }
        showOpenError(errorMessageFromUnknown(e, offlineIntl.formatMessage({ id: 'errors.loadFailed' })));
      } finally {
        setRemoteUrlBusy(false);
      }
    },
    [appendFilesAsDatasets, clearOpenFeedback, offlineIntl, recordHistoryEntry, showOpenError, urlState],
  );

  const handleLocalTarFile = useCallback(
    async (file: File) => {
      clearOpenFeedback();
      if (urlState === 'spa') {
        spaSampleLocatorParamRef.current = null;
      }
      try {
        const extracted = extractRosFilesFromTarArchive(await file.arrayBuffer());
        if (extracted.length === 0) {
          throw new Error(offlineIntl.formatMessage({ id: 'errors.noRecordingsInArchive' }));
        }
        appendFilesAsDatasets(extracted);
        await recordHistoryEntry({
          kind: 'local_tar',
          displayName: file.name,
          tarFingerprint: tarFileFingerprint(file),
          detail: offlineIntl.formatMessage({ id: 'welcome.historyFileCount' }, { count: extracted.length }),
        });
      } catch (e) {
        showOpenError(errorMessageFromUnknown(e, offlineIntl.formatMessage({ id: 'errors.loadFailed' })));
      }
    },
    [appendFilesAsDatasets, clearOpenFeedback, offlineIntl, recordHistoryEntry, showOpenError, urlState],
  );

  const handleSelectSample = useCallback(
    async (sample: SampleDataset) => {
      const u = getArchiveUrl(sample).trim();
      if (!u) return;
      await handleOpenRemoteRecordingUrl(u, {
        sample: { id: sample.id, title: sample.title || sample.name },
      });
    },
    [handleOpenRemoteRecordingUrl],
  );

  const handleOpenRecordingFiles = useCallback(async () => {
    clearOpenFeedback();
    if (urlState === 'spa') {
      spaSampleLocatorParamRef.current = null;
    }
    const picked = await pickRosRecordingFiles();
    if (picked === null) {
      document.getElementById(fileInputDomIdRef.current)?.click();
      return;
    }
    if (picked.files.length === 0) {
      return;
    }
    recordLocalRosFilesHistory(picked.files, picked.fileHandles);
    appendFilesAsDatasets(picked.files, false, picked.files);
  }, [appendFilesAsDatasets, clearOpenFeedback, recordLocalRosFilesHistory, urlState]);

  const handleReplayHistory = useCallback(
    async (id: string) => {
      clearOpenFeedback();
      const entry = await getDatasetHistoryEntry(id);
      if (!entry) return;
      switch (entry.kind) {
        case 'url':
        case 'remote_tar':
        case 'sample': {
          const u = entry.url?.trim();
          if (!u) return;
          if (entry.kind === 'sample' && entry.sampleId?.trim()) {
            await handleOpenRemoteRecordingUrl(u, {
              sample: { id: entry.sampleId.trim(), title: entry.displayName },
            });
            return;
          }
          await handleOpenRemoteRecordingUrl(u);
          return;
        }
        case 'directory': {
          if (urlState === 'spa') {
            spaSampleLocatorParamRef.current = null;
          }
          const dh = entry.directoryHandle;
          if (!dh) return;
          const ok = await ensureReadPermission(dh);
          if (!ok) {
            showOpenError(offlineIntl.formatMessage({ id: 'welcome.historyPermissionDenied' }));
            return;
          }
          try {
            const out: File[] = [];
            await walkDirectoryHandle(dh, 8, 0, out);
            if (out.length === 0) {
              showOpenError(offlineIntl.formatMessage({ id: 'welcome.historyEmptyDirectory' }));
              return;
            }
            appendFilesAsDatasets(out, true, out);
          } catch (e) {
            showOpenError(errorMessageFromUnknown(e, offlineIntl.formatMessage({ id: 'errors.loadFailed' })));
          }
          return;
        }
        case 'files': {
          if (urlState === 'spa') {
            spaSampleLocatorParamRef.current = null;
          }
          const handles = entry.fileHandles ?? [];
          if (handles.length === 0) {
            document.getElementById(fileInputDomIdRef.current)?.click();
            return;
          }
          for (const h of handles) {
            const granted = await ensureReadPermission(h);
            if (!granted) {
              showOpenError(offlineIntl.formatMessage({ id: 'welcome.historyPermissionDenied' }));
              return;
            }
          }
          try {
            const files = await Promise.all(handles.map((h) => h.getFile()));
            const ros = files.filter((f) => isRosRecordingFilename(f.name));
            if (ros.length === 0) {
              showOpenError(offlineIntl.formatMessage({ id: 'welcome.historyNoSupportedRecordings' }));
              return;
            }
            appendFilesAsDatasets(ros, true, ros);
          } catch (e) {
            showOpenError(errorMessageFromUnknown(e, offlineIntl.formatMessage({ id: 'errors.loadFailed' })));
          }
          return;
        }
        case 'directory_fallback':
          void handleOpenDirectory();
          return;
        case 'file_meta':
          document.getElementById(fileInputDomIdRef.current)?.click();
          return;
        case 'local_tar':
          document.getElementById(tarInputDomIdRef.current)?.click();
          return;
        default:
          return;
      }
    },
    [
      appendFilesAsDatasets,
      clearOpenFeedback,
      handleOpenDirectory,
      handleOpenRemoteRecordingUrl,
      offlineIntl,
      showOpenError,
      urlState,
    ],
  );

  useEffect(() => {
    if (urlState !== 'spa') return;
    const raw = props.url?.trim();
    if (!raw) return;
    const loc = parseSourceLocator(raw);
    if (!loc || loc.kind === 'remote') return;

    const gen = ++spaUrlBootstrapGenRef.current;
    let cancelled = false;

    void (async () => {
      setManualOpenHint(null);
      if (loc.kind === 'sample') {
        if (cancelled || spaUrlBootstrapGenRef.current !== gen) return;
        if (!getSampleDatasetsManifestUrl()) {
          showOpenError(offlineIntl.formatMessage({ id: 'welcome.sampleManifestNotConfigured' }));
          return;
        }
        const samples = await loadSampleDatasets();
        if (cancelled || spaUrlBootstrapGenRef.current !== gen) return;
        const found = samples.find((s) => s.id === loc.sampleId);
        if (!found) {
          showOpenError(offlineIntl.formatMessage({ id: 'welcome.sampleIdNotFound' }, { id: loc.sampleId }));
          return;
        }
        await handleSelectSample(found);
        return;
      }

      const row = await getLatestReplayableHistoryByLocalLocator(loc);
      if (cancelled || spaUrlBootstrapGenRef.current !== gen) return;
      if (!row) {
        setLastLoadError(null);
        setManualOpenHint(
          offlineIntl.formatMessage(
            {
              id:
                loc.kind === 'local_folder'
                  ? 'welcome.manualOpenFolderHint'
                  : 'welcome.manualOpenFileHint',
            },
            { name: loc.displayName },
          ),
        );
        return;
      }
      await handleReplayHistory(row.id);
    })();

    return () => {
      cancelled = true;
      spaUrlBootstrapGenRef.current += 1;
    };
  }, [urlState, props.url, handleReplayHistory, handleSelectSample, offlineIntl, showOpenError]);

  const openRemotePrompt = useCallback(() => {
    const url =
      typeof window !== 'undefined' ? window.prompt(offlineIntl.formatMessage({ id: 'viewer.remoteUrlPrompt' })) : null;
    if (url?.trim()) void handleOpenRemoteRecordingUrl(url.trim());
  }, [handleOpenRemoteRecordingUrl, offlineIntl]);

  const onSpaUrlQuerySync = props.onSpaUrlQuerySync;

  const handleGoHome = useCallback(() => {
    clearOpenFeedback();
    spaSampleLocatorParamRef.current = null;
    spaUrlBootstrapGenRef.current += 1;
    setExtraDatasets([]);
    setLoadedDatasetId(null);
    setRemoteUrlBusy(false);
    if (urlState === 'spa') {
      setActiveId(null);
      pushSpaUrlParam(null);
      onSpaUrlQuerySync?.();
    }
  }, [clearOpenFeedback, onSpaUrlQuerySync, urlState]);

  const layoutProvider = (children: React.ReactNode) => (
    <RosViewerLayoutProvider
      layoutPersistence={resolvedLayoutPersistence}
      layoutStorageKey={layoutStorageKey}
    >
      {children}
    </RosViewerLayoutProvider>
  );

  const appShellElement = player ? (
    <AppShell
      player={player}
      loadingSourceName={effectiveSourceName}
      manualOpenHint={manualOpenHint}
      sourceLoading={sourceLoading}
      className={props.className}
      style={props.style}
      theme={currentTheme}
      language={currentLanguage}
      onThemeChange={handleThemeChange}
      onLanguageChange={handleLanguageChange}
      showLanguageSwitcher={props.showLanguageSwitcher ?? true}
      showThemeSwitcher={props.showThemeSwitcher ?? true}
      onBrandClick={handleGoHome}
      preferAutoLayout={props.preferAutoLayout ?? false}
      preferencePersistence={persistence}
      datasets={datasets}
      activeDatasetId={resolvedDatasetId ?? undefined}
      onDatasetSelect={onDatasetSelect}
      onAddFilesFromPicker={onAddFilesFromPicker}
      onOpenDirectory={handleOpenDirectory}
      onOpenFilePick={() => void handleOpenRecordingFiles()}
      onOpenTarPick={() => document.getElementById('rosview-inline-tar')?.click()}
      onLocalTarSelected={handleLocalTarFile}
      onOpenRemotePrompt={openRemotePrompt}
      onSubmitRemoteUrl={handleOpenRemoteRecordingUrl}
      remoteSubmitLoading={remoteUrlBusy}
      onSelectSample={handleSelectSample}
      historyItems={historyItems}
      onReplayHistory={(id) => void handleReplayHistory(id)}
      onDropRosRecordingFiles={handleDropRosRecordingFiles}
      extensions={props.extensions}
      hostContext={props.hostContext}
      showNavbar={embedChrome.showNavbar}
      showSidebar={embedChrome.showSidebar}
      showPlaybackBar={embedChrome.showPlaybackBar}
      hideOpenFileMenus={props.hideOpenFileMenus ?? false}
      initialLayout={props.initialLayout}
      defaultPanel={props.defaultPanel}
      layoutPersistence={resolvedLayoutPersistence}
      layoutStorageKey={layoutStorageKey}
      suppressWelcomePanel={suppressWelcomePanel}
      onLayoutReady={props.onLayoutReady}
    />
  ) : null;

  if (!hasSource && !requireSource && player) {
    return layoutProvider(
      <RosViewProvider theme={currentTheme} language={currentLanguage}>
        {appShellElement}
      </RosViewProvider>,
    );
  }

  if (!hasSource) {
    return layoutProvider(
      <RosViewProvider theme={currentTheme} language={currentLanguage}>
        <div
          className={cn('flex h-screen flex-col overflow-hidden bg-background text-foreground', props.className)}
          style={props.style}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
        >
          <Navbar
            sourceName={effectiveSourceName}
            sourceLoading={sourceLoading}
            theme={currentTheme}
            language={currentLanguage}
            onThemeChange={handleThemeChange}
            onLanguageChange={handleLanguageChange}
            showLanguageSwitcher={props.showLanguageSwitcher ?? true}
            showThemeSwitcher={props.showThemeSwitcher ?? true}
            onBrandClick={handleGoHome}
            onOpenFilePick={() => {
              clearOpenFeedback();
              void handleOpenRecordingFiles();
            }}
            onOpenDirectory={handleOpenDirectory}
            onOpenTarPick={() => document.getElementById('rosview-landing-tar')?.click()}
            onOpenRemotePrompt={openRemotePrompt}
            onOpenSampleDialog={() => setSampleDialogOpen(true)}
            recentHistoryItems={historyItems.slice(0, 10)}
            onReplayHistory={(id) => void handleReplayHistory(id)}
          />
          <WelcomeScreen
            manualOpenHint={manualOpenHint}
            onOpenFile={() => {
              clearOpenFeedback();
              void handleOpenRecordingFiles();
            }}
            onOpenDirectory={handleOpenDirectory}
            onOpenTarPicker={() => document.getElementById('rosview-landing-tar')?.click()}
            onSubmitRemoteUrl={handleOpenRemoteRecordingUrl}
            remoteSubmitLoading={remoteUrlBusy}
            onSelectSample={handleSelectSample}
            historyItems={historyItems}
            onReplayHistory={(id) => void handleReplayHistory(id)}
          />
          <input
            id="rosview-landing-file"
            type="file"
            name="rosview-landing-file"
            accept=".mcap,.bag,.db3,.hdf5,.h5,.bvh"
            multiple
            className="hidden"
            onChange={(e) => {
              onAddFilesFromPicker(e.target.files);
              e.target.value = '';
            }}
          />
          <input
            id="rosview-landing-tar"
            type="file"
            name="rosview-landing-tar"
            accept=".tar,.tgz,.tar.gz,application/x-tar"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void handleLocalTarFile(f);
              e.target.value = '';
            }}
          />
          <SampleDatasetDialog
            open={sampleDialogOpen}
            onOpenChange={setSampleDialogOpen}
            onSelect={handleSelectSample}
          />
        </div>
      </RosViewProvider>,
    );
  }

  return layoutProvider(
    <RosViewProvider theme={currentTheme} language={currentLanguage}>
      <>
        <input
          id="rosview-inline-file"
          type="file"
          name="rosview-inline-file"
          accept=".mcap,.bag,.db3,.hdf5,.h5,.bvh"
          multiple
          className="hidden"
          onChange={(e) => {
            onAddFilesFromPicker(e.target.files);
            e.target.value = '';
          }}
        />
        <input
          id="rosview-inline-tar"
          type="file"
          name="rosview-inline-tar"
          accept=".tar,.tgz,.tar.gz,application/x-tar"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void handleLocalTarFile(f);
            e.target.value = '';
          }}
        />
        {!player ? (
          <div
            className={cn('flex h-screen flex-col overflow-hidden bg-background text-foreground', props.className)}
            style={props.style}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
          >
            <Navbar
              sourceName={effectiveSourceName}
              sourceLoading={sourceLoading}
              theme={currentTheme}
              language={currentLanguage}
              onThemeChange={handleThemeChange}
              onLanguageChange={handleLanguageChange}
              showLanguageSwitcher={props.showLanguageSwitcher ?? true}
              showThemeSwitcher={props.showThemeSwitcher ?? true}
              onBrandClick={handleGoHome}
              onOpenFilePick={() => {
                clearOpenFeedback();
                void handleOpenRecordingFiles();
              }}
              onOpenDirectory={handleOpenDirectory}
              onOpenTarPick={() => document.getElementById('rosview-inline-tar')?.click()}
              onOpenRemotePrompt={openRemotePrompt}
              onOpenSampleDialog={() => setSampleDialogOpen(true)}
              recentHistoryItems={historyItems.slice(0, 10)}
              onReplayHistory={(id) => void handleReplayHistory(id)}
            />
            <WelcomeScreen
              isLoading={!lastLoadError && !manualOpenHint}
              loadingSourceName={loadingSourceName}
              manualOpenHint={manualOpenHint}
              onOpenFile={() => {
                clearOpenFeedback();
                void handleOpenRecordingFiles();
              }}
              onOpenDirectory={handleOpenDirectory}
              onOpenTarPicker={() => document.getElementById('rosview-inline-tar')?.click()}
              onSubmitRemoteUrl={handleOpenRemoteRecordingUrl}
              remoteSubmitLoading={remoteUrlBusy}
              onSelectSample={handleSelectSample}
              onRequestChangeRemoteUrl={openRemotePrompt}
              historyItems={historyItems}
              onReplayHistory={(id) => void handleReplayHistory(id)}
            />
            <SampleDatasetDialog
              open={sampleDialogOpen}
              onOpenChange={setSampleDialogOpen}
              onSelect={handleSelectSample}
            />
          </div>
        ) : (
          appShellElement
        )}
      </>
    </RosViewProvider>,
  );
};

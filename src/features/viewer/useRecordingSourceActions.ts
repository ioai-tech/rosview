import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import type { SampleDataset } from '@/services/sampleDatasets';
import { getArchiveUrl } from '@/services/sampleDatasets';
import { extractRosFilesFromTarArchive } from '@/shared/utils/tarRosRecordings';
import {
  createDatasetGroupId,
  filterRosFilesFromFileList,
  isRosRecordingFilename,
  mergeDatasetLists,
  normalizeRosViewSources,
  type DatasetItem,
} from '@/shared/utils/datasetSources';
import { collectRosFilesFromUserDirectoryChoice, walkDirectoryHandle } from '@/shared/utils/collectDirectoryRosFiles';
import {
  ensureReadPermission,
  fingerprintRosFileSet,
  getDatasetHistoryEntry,
  tarFileFingerprint,
  type DatasetHistoryStoredEntry,
} from '@/shared/utils/datasetHistory';
import {
  alignFileHandlesToRosFiles,
  collectRosRecordingFilesFromDataTransfer,
  collectRosRecordingFileHandlesFromDataTransfer,
} from '@/shared/utils/collectDragFileHandles';
import { pickRosRecordingFiles } from '@/shared/utils/openRosRecordingFilePicker';
import { resolveBrowserHttpUrl } from '@/shared/utils/resolveBrowserHttpUrl';
import { pushSpaUrlParam, serializeSourceLocator } from '@/shared/utils/sourceLocator';
import type { createRosViewIntl } from '@/shared/intl/createRosViewIntl';
import { useSpaUrlBootstrap } from './useSpaUrlBootstrap';
import { errorMessageFromUnknown, fileBatchDisplayName } from './rosViewerUtils';
import type { AppendFilesResult } from './useDatasetSession';
import type { RosViewerProps } from './RosViewer.types';

export interface UseRecordingSourceActionsArgs {
  urlState: 'spa' | 'off';
  appendFilesAsDatasets: (
    files: File[],
    focusFirstNew?: boolean,
    groupFiles?: File[],
    forceNewSession?: boolean,
  ) => AppendFilesResult;
  setExtraDatasets: React.Dispatch<React.SetStateAction<DatasetItem[]>>;
  setActiveId: React.Dispatch<React.SetStateAction<string | null>>;
  setLoadedGroupId: (value: string | null) => void;
  fileInputDomIdRef: React.RefObject<string>;
  tarInputDomIdRef: React.RefObject<string>;
  /** When set, successful player init writes `sample://…` to the address bar instead of the resolved archive URL. Shared with `usePlayerLifecycle`, which reads and clears it on success. */
  spaSampleLocatorParamRef: React.RefObject<string | null>;
  offlineIntl: ReturnType<typeof createRosViewIntl>;
  clearOpenFeedback: () => void;
  showOpenError: (message: string) => void;
  setLastLoadError: (value: string | null) => void;
  setManualOpenHint: (value: string | null) => void;
  recordHistoryEntry: (row: Omit<DatasetHistoryStoredEntry, 'id' | 'openedAt'>) => Promise<void>;
}

function remotePathnameLower(url: string): string {
  try {
    return new URL(url).pathname.toLowerCase();
  } catch {
    return url.split('?')[0].split('#')[0].toLowerCase();
  }
}

/**
 * Merging new files into the active session is silent/non-blocking by
 * default (see `appendFilesAsDatasets`), but the user has no way to say "no,
 * open these as their own session instead" once it's happened. This surfaces
 * a lightweight, dismissible toast with a one-click "switch to replace"
 * action: it detaches the files just added from the current group into a
 * fresh one and switches to it. The previous session is left untouched (not
 * closed), so it stays reachable from the sidebar Data tab.
 */
function notifyMergeWithUndo(
  result: AppendFilesResult,
  displayName: string,
  offlineIntl: ReturnType<typeof createRosViewIntl>,
  setExtraDatasets: React.Dispatch<React.SetStateAction<DatasetItem[]>>,
  setActiveId: React.Dispatch<React.SetStateAction<string | null>>,
): void {
  if (!result.merged || result.addedItemIds.length === 0) return;
  const addedIds = new Set(result.addedItemIds);
  toast(offlineIntl.formatMessage({ id: 'viewer.mergeToast.message' }, { name: displayName }), {
    duration: 8000,
    // Stack the message above the action instead of sonner's default
    // side-by-side row, which reads as cramped once the message text wraps
    // to more than one line. `!important` is needed because sonner's own
    // (higher-specificity, attribute-selector) base styles set
    // align-items/gap/margin directly; scoped to this toast only, so
    // simple toast.error()/toast.success() calls elsewhere are unaffected.
    classNames: {
      toast: 'flex-col! items-stretch! gap-2.5!',
      actionButton: 'ml-0! mr-0! w-full! justify-center!',
    },
    action: {
      label: offlineIntl.formatMessage({ id: 'viewer.mergeToast.action' }),
      onClick: () => {
        const replaceGroupId = createDatasetGroupId();
        setExtraDatasets((prev) => prev.map((d) => (addedIds.has(d.id) ? { ...d, groupId: replaceGroupId } : d)));
        setActiveId(replaceGroupId);
      },
    },
  });
}

/**
 * Every "open a recording" entry point: drag-and-drop, directory/file
 * pickers, remote URL / tar submission, sample selection, history replay,
 * the SPA `?url=` bootstrap, and "go home". All funnel into
 * `appendFilesAsDatasets` (from `useDatasetSession`) or the direct
 * URL-dataset path, recording a history entry along the way.
 */
export function useRecordingSourceActions(props: RosViewerProps, args: UseRecordingSourceActionsArgs) {
  const {
    urlState,
    appendFilesAsDatasets,
    setExtraDatasets,
    setActiveId,
    setLoadedGroupId,
    fileInputDomIdRef,
    tarInputDomIdRef,
    spaSampleLocatorParamRef,
    offlineIntl,
    clearOpenFeedback,
    showOpenError,
    setLastLoadError,
    setManualOpenHint,
    recordHistoryEntry,
  } = args;

  const [remoteUrlBusy, setRemoteUrlBusy] = useState(false);

  const recordLocalRosFilesHistory = useCallback(
    (files: File[], fileHandles?: FileSystemFileHandle[]) => {
      if (files.length === 0) return;
      const displayName = fileBatchDisplayName(files);
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
      const appendResult = appendFilesAsDatasets(files, true, files);
      notifyMergeWithUndo(appendResult, fileBatchDisplayName(files), offlineIntl, setExtraDatasets, setActiveId);
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
    [
      appendFilesAsDatasets,
      clearOpenFeedback,
      offlineIntl,
      recordHistoryEntry,
      recordLocalRosFilesHistory,
      setActiveId,
      setExtraDatasets,
      spaSampleLocatorParamRef,
      urlState,
    ],
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
      const appendResult = appendFilesAsDatasets(files, true, files);
      notifyMergeWithUndo(
        appendResult,
        directoryHandle?.name ?? fileBatchDisplayName(files),
        offlineIntl,
        setExtraDatasets,
        setActiveId,
      );
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
  }, [
    appendFilesAsDatasets,
    clearOpenFeedback,
    offlineIntl,
    recordHistoryEntry,
    setActiveId,
    setExtraDatasets,
    showOpenError,
    spaSampleLocatorParamRef,
    urlState,
  ]);

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

  const onDatasetSelect = useCallback(
    (id: string) => {
      clearOpenFeedback();
      setLoadedGroupId(null);
      if (urlState === 'spa') {
        spaSampleLocatorParamRef.current = null;
      }
      setActiveId(id);
    },
    [clearOpenFeedback, setActiveId, setLoadedGroupId, spaSampleLocatorParamRef, urlState],
  );

  const onAddFilesFromPicker = useCallback(
    (fileList: FileList | null) => {
      if (!fileList?.length) return;
      clearOpenFeedback();
      if (urlState === 'spa') {
        spaSampleLocatorParamRef.current = null;
      }
      const ros = filterRosFilesFromFileList(fileList);
      const appendResult = appendFilesAsDatasets(ros, false, ros);
      notifyMergeWithUndo(appendResult, fileBatchDisplayName(ros), offlineIntl, setExtraDatasets, setActiveId);
      recordLocalRosFilesHistory(ros);
    },
    [
      appendFilesAsDatasets,
      clearOpenFeedback,
      offlineIntl,
      recordLocalRosFilesHistory,
      setActiveId,
      setExtraDatasets,
      spaSampleLocatorParamRef,
      urlState,
    ],
  );

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
          appendFilesAsDatasets(extracted, true, undefined, true);
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
          setLoadedGroupId(null);
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
    [
      appendFilesAsDatasets,
      clearOpenFeedback,
      offlineIntl,
      recordHistoryEntry,
      setActiveId,
      setExtraDatasets,
      setLoadedGroupId,
      showOpenError,
      spaSampleLocatorParamRef,
      urlState,
    ],
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
        appendFilesAsDatasets(extracted, true, undefined, true);
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
    [
      appendFilesAsDatasets,
      clearOpenFeedback,
      offlineIntl,
      recordHistoryEntry,
      showOpenError,
      spaSampleLocatorParamRef,
      urlState,
    ],
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
    const appendResult = appendFilesAsDatasets(picked.files, false, picked.files);
    notifyMergeWithUndo(
      appendResult,
      fileBatchDisplayName(picked.files),
      offlineIntl,
      setExtraDatasets,
      setActiveId,
    );
  }, [
    appendFilesAsDatasets,
    clearOpenFeedback,
    fileInputDomIdRef,
    offlineIntl,
    recordLocalRosFilesHistory,
    setActiveId,
    setExtraDatasets,
    spaSampleLocatorParamRef,
    urlState,
  ]);

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
            appendFilesAsDatasets(out, true, out, true);
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
            appendFilesAsDatasets(ros, true, ros, true);
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
      fileInputDomIdRef,
      handleOpenDirectory,
      handleOpenRemoteRecordingUrl,
      offlineIntl,
      showOpenError,
      spaSampleLocatorParamRef,
      tarInputDomIdRef,
      urlState,
    ],
  );

  const { reset: resetSpaUrlBootstrap } = useSpaUrlBootstrap(urlState === 'spa', props.url, {
    onManualOpenHint: setManualOpenHint,
    onNoLocalHistoryMatch: (loc) => {
      setLastLoadError(null);
      setManualOpenHint(
        offlineIntl.formatMessage(
          { id: loc.kind === 'local_folder' ? 'welcome.manualOpenFolderHint' : 'welcome.manualOpenFileHint' },
          { name: loc.displayName },
        ),
      );
    },
    onReplayHistoryRow: (rowId) => handleReplayHistory(rowId),
    onSelectSample: (sample) => handleSelectSample(sample),
    onSampleManifestNotConfigured: () =>
      showOpenError(offlineIntl.formatMessage({ id: 'welcome.sampleManifestNotConfigured' })),
    onSampleNotFound: (sampleId) =>
      showOpenError(offlineIntl.formatMessage({ id: 'welcome.sampleIdNotFound' }, { id: sampleId })),
  });

  const openRemotePrompt = useCallback(() => {
    const url =
      typeof window !== 'undefined' ? window.prompt(offlineIntl.formatMessage({ id: 'viewer.remoteUrlPrompt' })) : null;
    if (url?.trim()) void handleOpenRemoteRecordingUrl(url.trim());
  }, [handleOpenRemoteRecordingUrl, offlineIntl]);

  const onSpaUrlQuerySync = props.onSpaUrlQuerySync;

  const handleGoHome = useCallback(() => {
    clearOpenFeedback();
    spaSampleLocatorParamRef.current = null;
    resetSpaUrlBootstrap();
    setExtraDatasets([]);
    setLoadedGroupId(null);
    setRemoteUrlBusy(false);
    if (urlState === 'spa') {
      setActiveId(null);
      pushSpaUrlParam(null);
      onSpaUrlQuerySync?.();
    }
  }, [
    clearOpenFeedback,
    onSpaUrlQuerySync,
    resetSpaUrlBootstrap,
    setActiveId,
    setExtraDatasets,
    setLoadedGroupId,
    spaSampleLocatorParamRef,
    urlState,
  ]);

  return {
    remoteUrlBusy,
    handleDropRosRecordingFiles,
    handleOpenDirectory,
    handleDragOver,
    handleDrop,
    onDatasetSelect,
    onAddFilesFromPicker,
    handleOpenRemoteRecordingUrl,
    handleLocalTarFile,
    handleSelectSample,
    handleOpenRecordingFiles,
    handleReplayHistory,
    openRemotePrompt,
    handleGoHome,
  };
}

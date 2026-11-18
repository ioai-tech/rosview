import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Sidebar } from '@/features/workspace/sidebar/Sidebar';
import { PlaybackBar } from '@/features/workspace/playback/PlaybackBar';
import { DockviewLayout } from '@/features/layout/DockviewLayout';
import type { Player } from '@/core/types/player';
import type { DatasetItem } from '@/shared/utils/datasetSources';
import type { PreferencePersistence } from '@/core/preferences/types';
import { readPreferences, writePreferences } from '@/core/preferences/readWritePreferences';
import {
  hasTopicDragPayload,
  readTopicDragPayload,
} from '@/features/workspace/sidebar/topic-list/topicDragPayload';
import { openRawMessagesPanel } from '@/features/workspace/sidebar/topic-list/openRawMessagesPanel';
import { useIntl } from 'react-intl';
import { WelcomeScreen } from '@/features/workspace/common/WelcomeScreen';
import { LoadingOverlay } from '@/features/workspace/common/LoadingOverlay';
import { PlaybackBufferingOverlay } from '@/features/workspace/common/PlaybackBufferingOverlay';
import { useMessagePipeline } from '@/core/pipeline/useMessagePipeline';
import type { MessagePipelineState } from '@/core/pipeline/store';
import { useMessagePipelineStore } from '@/core/pipeline/store';
import type { SampleDataset } from '@/services/sampleDatasets';
import type { DatasetHistoryListItem } from '@/shared/utils/datasetHistory';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/shared/ui/resizable';
import { useGroupRef } from 'react-resizable-panels';
import { useIsomorphicLayoutEffect, useStackedLayout } from './useStackedLayout';
import { Skeleton } from '@/shared/ui/skeleton';
import type { RosViewExtension } from '@/core/extensions/types';
import { buildExtensionContext } from '@/core/extensions/buildContext';
import type { FoxgloveLayoutData } from '@/core/preferences/foxgloveLayout';
import type { OpenPanelInput } from '@/features/layout/dockviewController';
import {
  SIDEBAR_MAX_PANEL_PERCENT,
  SIDEBAR_MIN_PANEL_PERCENT,
} from '@/features/layout/layoutConstants';
import {
  clampSidebarPanelPercent,
  getInitialSidebarPanelPercent,
} from '@/features/layout/sidebarPanelSize';

/** Sidebar share of the stacked (vertical) split, in percent. */
const STACKED_SIDEBAR_DEFAULT_PERCENT = 32;

interface RosViewContentProps {
  player: Player;
  loadingSourceName?: string;
  manualOpenHint?: string | null;
  preferencePersistence: PreferencePersistence;
  preferAutoLayout?: boolean;
  datasets: DatasetItem[];
  activeDatasetId?: string;
  onDatasetSelect: (id: string) => void;
  onAddFilesFromPicker: (files: FileList | null) => void;
  onOpenDirectory: () => void;
  onOpenFilePick: () => void;
  onOpenTarPick: () => void;
  onLocalTarSelected: (file: File) => void | Promise<void>;
  onSubmitRemoteUrl: (url: string) => void | Promise<void>;
  remoteSubmitLoading?: boolean;
  onSelectSample: (sample: SampleDataset) => void | Promise<void>;
  onCancelLoading?: () => void;
  historyItems: DatasetHistoryListItem[];
  onReplayHistory: (id: string) => void | Promise<void>;
  onDropRosRecordingFiles: (files: File[], items?: DataTransferItemList) => void | Promise<void>;
  extensions?: RosViewExtension[];
  locale: 'en' | 'zh' | 'ja';
  theme: 'light' | 'dark' | 'system';
  activeDataset?: DatasetItem;
  /** Passed through to extension context as opaque `hostContext`. */
  hostContext?: unknown;
  showSidebar?: boolean;
  showPlaybackBar?: boolean;
  hideOpenFileMenus?: boolean;
  initialLayout?: FoxgloveLayoutData;
  defaultPanel?: OpenPanelInput;
  layoutPersistence?: PreferencePersistence;
  layoutStorageKey?: string;
  suppressWelcomePanel?: boolean;
  onLayoutReady?: (info: { panelCount: number }) => void;
  /** Sidebar tab id to select on first mount (e.g. extension `sidebarTabs[].id`). */
  initialSidebarTab?: string;
}

export const RosViewContent: React.FC<RosViewContentProps> = ({
  player,
  loadingSourceName,
  manualOpenHint,
  preferencePersistence,
  preferAutoLayout = false,
  datasets,
  activeDatasetId,
  onDatasetSelect,
  onAddFilesFromPicker,
  onOpenDirectory,
  onOpenFilePick,
  onOpenTarPick,
  onLocalTarSelected,
  onSubmitRemoteUrl,
  remoteSubmitLoading,
  onSelectSample,
  onCancelLoading,
  historyItems,
  onReplayHistory,
  onDropRosRecordingFiles,
  extensions = [],
  locale,
  theme,
  activeDataset,
  hostContext,
  showSidebar = true,
  showPlaybackBar = true,
  hideOpenFileMenus = false,
  initialLayout,
  defaultPanel,
  layoutPersistence,
  layoutStorageKey,
  suppressWelcomePanel,
  onLayoutReady,
  initialSidebarTab,
}) => {
  const { formatMessage } = useIntl();
  const presence = useMessagePipeline((state: MessagePipelineState) => state.playerState.presence);
  const sortedTopics = useMessagePipeline((state: MessagePipelineState) => state.sortedTopics);
  const isReady = presence === 'ready';
  const showWelcomeFallback = !isReady && Boolean(manualOpenHint);
  const topicDragDepthRef = useRef(0);
  const [sidebarPanelPercent, setSidebarPanelPercent] = useState(() =>
    getInitialSidebarPanelPercent(preferencePersistence),
  );
  const [autoDataQualityScan, setAutoDataQualityScan] = useState(() => {
    if (preferencePersistence !== 'localStorage') {
      return false;
    }
    return readPreferences()?.autoDataQualityScan === true;
  });
  const [isTopicDragOver, setIsTopicDragOver] = useState(false);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const groupRef = useGroupRef();

  const stacked = useStackedLayout(contentRef, showWelcomeFallback);

  // One panel group for both layouts: switching orientation must not remount
  // the panels or the sidebar (Dockview layout, scroll and search state).
  const sidebarSizePercent = stacked ? STACKED_SIDEBAR_DEFAULT_PERCENT : sidebarPanelPercent;
  const lastStackedRef = useRef(stacked);
  useIsomorphicLayoutEffect(() => {
    if (lastStackedRef.current === stacked) {
      return;
    }
    lastStackedRef.current = stacked;
    if (!showSidebar) {
      return;
    }
    try {
      groupRef.current?.setLayout({ sidebar: sidebarSizePercent, main: 100 - sidebarSizePercent });
    } catch {
      // The group re-reads defaults on its next layout pass.
    }
  }, [stacked, showSidebar, sidebarSizePercent, groupRef]);
  const extensionContext = useMemo(
    () =>
      buildExtensionContext({
        player,
        dataset: activeDataset,
        topics: sortedTopics,
        locale,
        theme,
        hostContext,
        getPlayerState: () => useMessagePipelineStore.getState().playerState,
      }),
    [activeDataset, hostContext, locale, player, sortedTopics, theme],
  );

  const clearTopicDragState = useCallback(() => {
    topicDragDepthRef.current = 0;
    setIsTopicDragOver(false);
  }, []);

  useEffect(() => {
    if (preferencePersistence !== 'localStorage') {
      setAutoDataQualityScan(false);
      return;
    }
    setAutoDataQualityScan(readPreferences()?.autoDataQualityScan === true);
  }, [preferencePersistence]);

  useEffect(() => {
    if (preferencePersistence !== 'localStorage') {
      return;
    }
    const writeTimer = window.setTimeout(() => {
      writePreferences({ sidebarPanelPercent });
    }, 120);
    return () => {
      window.clearTimeout(writeTimer);
    };
  }, [preferencePersistence, sidebarPanelPercent]);

  const handleTopicDragEnter = useCallback((event: React.DragEvent<HTMLElement>) => {
    if (!hasTopicDragPayload(event.dataTransfer)) {
      return;
    }
    event.preventDefault();
    topicDragDepthRef.current += 1;
    setIsTopicDragOver(true);
  }, []);

  const handleTopicDragOver = useCallback((event: React.DragEvent<HTMLElement>) => {
    if (!hasTopicDragPayload(event.dataTransfer)) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    setIsTopicDragOver(true);
  }, []);

  const handleTopicDragLeave = useCallback(
    (event: React.DragEvent<HTMLElement>) => {
      if (!hasTopicDragPayload(event.dataTransfer)) {
        return;
      }
      event.preventDefault();
      topicDragDepthRef.current = Math.max(0, topicDragDepthRef.current - 1);
      if (topicDragDepthRef.current === 0) {
        setIsTopicDragOver(false);
      }
    },
    [],
  );

  const handleTopicDrop = useCallback(
    (event: React.DragEvent<HTMLElement>) => {
      const payload = readTopicDragPayload(event.dataTransfer);
      clearTopicDragState();
      if (!payload) {
        return;
      }
      event.preventDefault();
      openRawMessagesPanel(payload.name);
    },
    [clearTopicDragState],
  );

  const handleMainDragOver = useCallback(
    (event: React.DragEvent<HTMLElement>) => {
      if (hideOpenFileMenus && Array.from(event.dataTransfer.types).includes('Files')) {
        return;
      }
      if (Array.from(event.dataTransfer.types).includes('Files')) {
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = 'copy';
        return;
      }
      handleTopicDragOver(event);
    },
    [handleTopicDragOver, hideOpenFileMenus],
  );

  const handleMainDrop = useCallback(
    (event: React.DragEvent<HTMLElement>) => {
      if (hideOpenFileMenus && Array.from(event.dataTransfer.types).includes('Files')) {
        return;
      }
      if (Array.from(event.dataTransfer.types).includes('Files')) {
        event.preventDefault();
        event.stopPropagation();
        void onDropRosRecordingFiles(Array.from(event.dataTransfer.files), event.dataTransfer.items);
        return;
      }
      handleTopicDrop(event);
    },
    [handleTopicDrop, hideOpenFileMenus, onDropRosRecordingFiles],
  );

  const handleLayoutChanged = useCallback((layout: Record<string, number>) => {
    const nextSidebarPercent = layout.sidebar;
    if (typeof nextSidebarPercent !== 'number' || !Number.isFinite(nextSidebarPercent)) {
      return;
    }
    setSidebarPanelPercent(clampSidebarPanelPercent(nextSidebarPercent));
  }, []);

  const sidebarElement = (
    <Sidebar
      stacked={stacked}
      player={player}
      datasets={datasets}
      activeDatasetId={activeDatasetId}
      onDatasetSelect={onDatasetSelect}
      autoDataQualityScan={autoDataQualityScan}
      onAutoDataQualityScanChange={setAutoDataQualityScan}
      preferencePersistence={preferencePersistence}
      extensionContext={extensionContext}
      extensions={extensions}
      initialSidebarTab={initialSidebarTab}
    />
  );

  const mainElement = (
    <div
      role="region"
      aria-label={formatMessage({ id: 'layout.viewerRegion' })}
      className={`relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background contain-strict ${
        isTopicDragOver ? 'ring-1 ring-inset ring-primary/40' : ''
      }`}
      onDragEnter={isReady ? handleTopicDragEnter : undefined}
      onDragOver={isReady ? handleMainDragOver : undefined}
      onDragLeave={isReady ? handleTopicDragLeave : undefined}
      onDrop={isReady ? handleMainDrop : undefined}
    >
      {isTopicDragOver && (
        <div className="pointer-events-none absolute inset-4 z-10 flex items-center justify-center rounded-lg border border-dashed border-primary/60 bg-primary/5">
          <div className="rounded-md bg-background/90 px-4 py-3 text-center shadow-xs">
            <div className="text-sm font-medium">
              {formatMessage({ id: 'sidebar.topicDropTitle' })}
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              {formatMessage({ id: 'sidebar.topicDropSubtitle' })}
            </div>
          </div>
        </div>
      )}
      {isReady ? (
        <DockviewLayout
          key={activeDatasetId ?? 'dataset'}
          player={player}
          preferAutoLayout={preferAutoLayout}
          initialLayout={initialLayout}
          defaultPanel={defaultPanel}
          layoutPersistence={layoutPersistence}
          layoutStorageKey={layoutStorageKey}
          suppressWelcomePanel={suppressWelcomePanel}
          onLayoutReady={onLayoutReady}
        />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
          <Skeleton className="h-8 w-40" />
          <Skeleton className="min-h-0 flex-1 rounded-lg" />
        </div>
      )}
      {!isReady ? (
        <LoadingOverlay
          sourceName={loadingSourceName}
          onCancel={onCancelLoading}
        />
      ) : (
        <PlaybackBufferingOverlay player={player} />
      )}
    </div>
  );

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
      {showWelcomeFallback ? (
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <WelcomeScreen
            manualOpenHint={manualOpenHint}
            onOpenFile={onOpenFilePick}
            onOpenDirectory={onOpenDirectory}
            onOpenTarPicker={onOpenTarPick}
            onSubmitRemoteUrl={onSubmitRemoteUrl}
            remoteSubmitLoading={remoteSubmitLoading}
            onSelectSample={onSelectSample}
            historyItems={historyItems}
            onReplayHistory={onReplayHistory}
          />
        </div>
      ) : (
        <div
          ref={contentRef}
          className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
          data-layout={stacked ? 'stacked' : 'split'}
        >
          <input
            id="rosview-content-file"
            type="file"
            name="rosview-content-file"
            accept=".mcap,.bag,.db3,.hdf5,.h5"
            multiple
            className="hidden"
            onChange={(e) => {
              onAddFilesFromPicker(e.target.files);
              e.target.value = '';
            }}
          />
          <input
            id="rosview-content-tar"
            type="file"
            name="rosview-content-tar"
            accept=".tar,.tgz,.tar.gz,application/x-tar"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void onLocalTarSelected(f);
              e.target.value = '';
            }}
          />
          <ResizablePanelGroup
            groupRef={groupRef}
            orientation={stacked ? 'vertical' : 'horizontal'}
            className="min-h-0 min-w-0 flex-1"
            onLayoutChanged={showSidebar && !stacked ? handleLayoutChanged : undefined}
          >
            {/*
             * Keyed children keep their state while React reorders them: the
             * sidebar leads the split layout and follows the panels when stacked,
             * so DOM (and focus) order always matches what is on screen.
             */}
            {(stacked ? ['main', 'handle', 'sidebar'] : ['sidebar', 'handle', 'main'])
              .filter((slot) => showSidebar || slot === 'main')
              .map((slot) => {
                if (slot === 'sidebar') {
                  return (
                    <ResizablePanel
                      key="sidebar"
                      id="sidebar"
                      className="flex min-h-0 min-w-0 flex-col"
                      defaultSize={`${sidebarSizePercent}%`}
                      minSize={stacked ? '15%' : `${SIDEBAR_MIN_PANEL_PERCENT}%`}
                      maxSize={stacked ? '70%' : `${SIDEBAR_MAX_PANEL_PERCENT}%`}
                    >
                      {sidebarElement}
                    </ResizablePanel>
                  );
                }
                if (slot === 'handle') {
                  return (
                    <ResizableHandle
                      key="handle"
                      withHandle={!stacked}
                      aria-label={formatMessage({ id: 'viewer.resizeSidebar' })}
                    />
                  );
                }
                return (
                  <ResizablePanel
                    key="main"
                    id="main"
                    className="flex min-h-0 min-w-0 flex-col"
                    defaultSize={showSidebar ? `${100 - sidebarSizePercent}%` : '100%'}
                    minSize={
                      showSidebar ? (stacked ? '30%' : `${100 - SIDEBAR_MAX_PANEL_PERCENT}%`) : '100%'
                    }
                  >
                    {mainElement}
                  </ResizablePanel>
                );
              })}
          </ResizablePanelGroup>
        </div>
      )}
      {showPlaybackBar && (
        <PlaybackBar player={player} extensionContext={extensionContext} extensions={extensions} />
      )}
    </div>
  );
};

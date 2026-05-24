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
import { useMessagePipeline } from '@/core/pipeline/useMessagePipeline';
import type { MessagePipelineState } from '@/core/pipeline/store';
import { useMessagePipelineStore } from '@/core/pipeline/store';
import type { SampleDataset } from '@/services/sampleDatasets';
import type { DatasetHistoryListItem } from '@/shared/utils/datasetHistory';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/shared/ui/resizable';
import type { RosViewExtension } from '@/core/extensions/types';
import { buildExtensionContext } from '@/core/extensions/buildContext';
import type { FoxgloveLayoutData } from '@/core/preferences/foxgloveLayout';
import type { OpenPanelInput } from '@/features/layout/dockviewController';

const DEFAULT_SIDEBAR_WIDTH = 288;
const MIN_SIDEBAR_WIDTH = 240;
const MAX_SIDEBAR_WIDTH = 520;
const DEFAULT_LAYOUT_WIDTH = 1280;
const DEFAULT_SIDEBAR_PANEL_PERCENT = (DEFAULT_SIDEBAR_WIDTH / DEFAULT_LAYOUT_WIDTH) * 100;
const MIN_SIDEBAR_PANEL_PERCENT = (MIN_SIDEBAR_WIDTH / DEFAULT_LAYOUT_WIDTH) * 100;
const MAX_SIDEBAR_PANEL_PERCENT = (MAX_SIDEBAR_WIDTH / DEFAULT_LAYOUT_WIDTH) * 100;

function clampSidebarPanelPercent(value: number): number {
  return Math.min(MAX_SIDEBAR_PANEL_PERCENT, Math.max(MIN_SIDEBAR_PANEL_PERCENT, value));
}

function getInitialSidebarPanelPercent(persistence: PreferencePersistence): number {
  if (persistence !== 'localStorage') {
    return DEFAULT_SIDEBAR_PANEL_PERCENT;
  }
  const preferences = readPreferences();
  if (preferences?.sidebarPanelPercent !== undefined) {
    return clampSidebarPanelPercent(preferences.sidebarPanelPercent);
  }
  if (preferences?.sidebarWidth !== undefined) {
    const viewportWidth =
      typeof globalThis === 'undefined' || !('innerWidth' in globalThis) || !globalThis.innerWidth
        ? DEFAULT_LAYOUT_WIDTH
        : globalThis.innerWidth;
    return clampSidebarPanelPercent((preferences.sidebarWidth / viewportWidth) * 100);
  }
  return DEFAULT_SIDEBAR_PANEL_PERCENT;
}

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
  onRequestChangeRemoteUrl?: () => void;
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
  onRequestChangeRemoteUrl,
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
}) => {
  const { formatMessage } = useIntl();
  const presence = useMessagePipeline((state: MessagePipelineState) => state.playerState.presence);
  const sortedTopics = useMessagePipeline((state: MessagePipelineState) => state.sortedTopics);
  const isLoading = presence === 'initializing';
  const isReady = presence === 'ready';
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

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
      {!isReady ? (
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <WelcomeScreen
            isLoading={isLoading}
            loadingSourceName={loadingSourceName}
            manualOpenHint={manualOpenHint}
            onOpenFile={onOpenFilePick}
            onOpenDirectory={onOpenDirectory}
            onOpenTarPicker={onOpenTarPick}
            onSubmitRemoteUrl={onSubmitRemoteUrl}
            remoteSubmitLoading={remoteSubmitLoading}
            onSelectSample={onSelectSample}
            onRequestChangeRemoteUrl={onRequestChangeRemoteUrl}
            historyItems={historyItems}
            onReplayHistory={onReplayHistory}
          />
        </div>
      ) : (
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
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
            orientation="horizontal"
            className="min-h-0 min-w-0 flex-1"
            onLayoutChanged={showSidebar ? handleLayoutChanged : undefined}
          >
            {showSidebar && (
              <>
                <ResizablePanel
                  id="sidebar"
                  className="flex h-full min-h-0 min-w-0 flex-col"
                  defaultSize={`${sidebarPanelPercent}%`}
                  minSize={`${MIN_SIDEBAR_PANEL_PERCENT}%`}
                  maxSize={`${MAX_SIDEBAR_PANEL_PERCENT}%`}
                >
                  <Sidebar
                    player={player}
                    datasets={datasets}
                    activeDatasetId={activeDatasetId}
                    onDatasetSelect={onDatasetSelect}
                    autoDataQualityScan={autoDataQualityScan}
                    onAutoDataQualityScanChange={setAutoDataQualityScan}
                    preferencePersistence={preferencePersistence}
                    extensionContext={extensionContext}
                    extensions={extensions}
                  />
                </ResizablePanel>
                <ResizableHandle withHandle aria-label={formatMessage({ id: 'viewer.resizeSidebar' })} />
              </>
            )}
            <ResizablePanel
              id="main"
              className="flex h-full min-h-0 min-w-0 flex-col"
              defaultSize={showSidebar ? `${100 - sidebarPanelPercent}%` : '100%'}
              minSize={showSidebar ? `${100 - MAX_SIDEBAR_PANEL_PERCENT}%` : '100%'}
            >
              <main
                className={`relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background [contain:strict] ${
                  isTopicDragOver ? 'ring-1 ring-inset ring-primary/40' : ''
                }`}
                onDragEnter={handleTopicDragEnter}
                onDragOver={handleMainDragOver}
                onDragLeave={handleTopicDragLeave}
                onDrop={handleMainDrop}
              >
                {isTopicDragOver && (
                  <div className="pointer-events-none absolute inset-4 z-10 flex items-center justify-center rounded-lg border border-dashed border-primary/60 bg-primary/5">
                    <div className="rounded-md bg-background/90 px-4 py-3 text-center shadow-sm">
                      <div className="text-sm font-medium">
                        {formatMessage({ id: 'sidebar.topicDropTitle' })}
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {formatMessage({ id: 'sidebar.topicDropSubtitle' })}
                      </div>
                    </div>
                  </div>
                )}
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
              </main>
            </ResizablePanel>
          </ResizablePanelGroup>
        </div>
      )}
      {showPlaybackBar && (
        <PlaybackBar player={player} extensionContext={extensionContext} extensions={extensions} />
      )}
    </div>
  );
};

import React, { useCallback, useState } from 'react';
import { cn } from '@/shared/lib/utils';
import { Navbar } from '@/features/workspace/navbar/Navbar';
import { RosViewContent } from '@/features/viewer/RosViewContent';
import type { Player } from '@/core/types/player';
import type { DatasetItem } from '@/shared/utils/datasetSources';
import type { PreferencePersistence } from '@/core/preferences/types';
import type { SampleDataset } from '@/services/sampleDatasets';
import type { DatasetHistoryListItem } from '@/shared/utils/datasetHistory';
import type { RosViewExtension } from '@/core/extensions/types';
import type { FoxgloveLayoutData } from '@/core/preferences/foxgloveLayout';
import type { OpenPanelInput } from '@/features/layout/dockviewController';

import { useKeyboardShortcuts } from '@/shared/hooks/useKeyboardShortcuts';
import { SampleDatasetDialog } from '@/features/workspace/common/SampleDatasetDialog';

interface AppShellProps {
  player: Player;
  loadingSourceName?: string;
  manualOpenHint?: string | null;
  sourceLoading?: boolean;
  className?: string;
  style?: React.CSSProperties;
  theme: 'light' | 'dark' | 'system';
  language: 'en' | 'zh' | 'ja';
  onThemeChange: (theme: 'light' | 'dark' | 'system') => void;
  onLanguageChange: (lang: 'en' | 'zh' | 'ja') => void;
  showLanguageSwitcher?: boolean;
  showThemeSwitcher?: boolean;
  showNavbarBrand?: boolean;
  navbarBrandLabel?: string;
  onBrandClick?: () => void;
  preferAutoLayout?: boolean;
  preferencePersistence: PreferencePersistence;
  datasets: DatasetItem[];
  activeDatasetId?: string;
  onDatasetSelect: (id: string) => void;
  onAddFilesFromPicker: (files: FileList | null) => void;
  onOpenDirectory: () => void;
  onOpenFilePick: () => void;
  onOpenTarPick: () => void;
  onLocalTarSelected: (file: File) => void | Promise<void>;
  onOpenRemotePrompt: () => void;
  onSubmitRemoteUrl: (url: string) => void | Promise<void>;
  remoteSubmitLoading?: boolean;
  onSelectSample: (sample: SampleDataset) => void | Promise<void>;
  onCancelLoading?: () => void;
  historyItems: DatasetHistoryListItem[];
  onReplayHistory: (id: string) => void | Promise<void>;
  onDropRosRecordingFiles: (files: File[], items?: DataTransferItemList) => void | Promise<void>;
  /** Optional third-party extension contributions. */
  extensions?: RosViewExtension[];
  /** Opaque value forwarded to extension context (`hostContext`). */
  hostContext?: unknown;
  showNavbar?: boolean;
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

export const AppShell: React.FC<AppShellProps> = ({
  player,
  loadingSourceName,
  manualOpenHint,
  sourceLoading = false,
  className,
  style,
  theme,
  language,
  onThemeChange,
  onLanguageChange,
  showLanguageSwitcher = true,
  showThemeSwitcher = true,
  showNavbarBrand = true,
  navbarBrandLabel,
  onBrandClick,
  preferAutoLayout = false,
  preferencePersistence,
  datasets,
  activeDatasetId,
  onDatasetSelect,
  onAddFilesFromPicker,
  onOpenDirectory,
  onOpenFilePick,
  onOpenTarPick,
  onLocalTarSelected,
  onOpenRemotePrompt,
  onSubmitRemoteUrl,
  remoteSubmitLoading,
  onSelectSample,
  onCancelLoading,
  historyItems,
  onReplayHistory,
  onDropRosRecordingFiles,
  extensions,
  hostContext,
  showNavbar = true,
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
  useKeyboardShortcuts(player);
  const [sampleDialogOpen, setSampleDialogOpen] = useState(false);
  const handleDragOver = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (hideOpenFileMenus) return;
      if (!Array.from(event.dataTransfer.types).includes('Files')) {
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    },
    [hideOpenFileMenus],
  );

  const handleDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (hideOpenFileMenus) return;
      event.preventDefault();
      void onDropRosRecordingFiles(Array.from(event.dataTransfer.files), event.dataTransfer.items);
    },
    [hideOpenFileMenus, onDropRosRecordingFiles],
  );

  return (
    <div
      className={cn('flex h-screen flex-col overflow-hidden bg-background text-foreground', className)}
      style={style}
      onDragOver={hideOpenFileMenus ? undefined : handleDragOver}
      onDrop={hideOpenFileMenus ? undefined : handleDrop}
    >
      {showNavbar && (
        <Navbar
          sourceName={loadingSourceName}
          sourceLoading={sourceLoading}
          theme={theme}
          language={language}
          onThemeChange={onThemeChange}
          onLanguageChange={onLanguageChange}
          showLanguageSwitcher={showLanguageSwitcher}
          showThemeSwitcher={showThemeSwitcher}
          showNavbarBrand={showNavbarBrand}
          brandLabel={navbarBrandLabel}
          onBrandClick={onBrandClick}
          onOpenFilePick={hideOpenFileMenus ? undefined : onOpenFilePick}
          onOpenDirectory={hideOpenFileMenus ? undefined : onOpenDirectory}
          onOpenTarPick={hideOpenFileMenus ? undefined : onOpenTarPick}
          onOpenRemotePrompt={hideOpenFileMenus ? undefined : onOpenRemotePrompt}
          onOpenSampleDialog={hideOpenFileMenus ? undefined : () => setSampleDialogOpen(true)}
          recentHistoryItems={hideOpenFileMenus ? [] : historyItems.slice(0, 10)}
          onReplayHistory={hideOpenFileMenus ? undefined : onReplayHistory}
        />
      )}
      <RosViewContent
        player={player}
        loadingSourceName={loadingSourceName}
        manualOpenHint={manualOpenHint}
        preferencePersistence={preferencePersistence}
        preferAutoLayout={preferAutoLayout}
        datasets={datasets}
        activeDatasetId={activeDatasetId}
        onDatasetSelect={onDatasetSelect}
        onAddFilesFromPicker={onAddFilesFromPicker}
        onOpenDirectory={onOpenDirectory}
        onOpenFilePick={onOpenFilePick}
        onOpenTarPick={onOpenTarPick}
        onLocalTarSelected={onLocalTarSelected}
        onSubmitRemoteUrl={onSubmitRemoteUrl}
        remoteSubmitLoading={remoteSubmitLoading}
        onSelectSample={onSelectSample}
        onCancelLoading={onCancelLoading}
        historyItems={historyItems}
        onReplayHistory={onReplayHistory}
        onDropRosRecordingFiles={onDropRosRecordingFiles}
        extensions={extensions}
        hostContext={hostContext}
        locale={language}
        theme={theme}
        activeDataset={datasets.find((item) => item.id === activeDatasetId)}
        showSidebar={showSidebar}
        showPlaybackBar={showPlaybackBar}
        hideOpenFileMenus={hideOpenFileMenus}
        initialLayout={initialLayout}
        defaultPanel={defaultPanel}
        layoutPersistence={layoutPersistence}
        layoutStorageKey={layoutStorageKey}
        suppressWelcomePanel={suppressWelcomePanel}
        onLayoutReady={onLayoutReady}
        initialSidebarTab={initialSidebarTab}
      />
      {!hideOpenFileMenus && (
        <SampleDatasetDialog open={sampleDialogOpen} onOpenChange={setSampleDialogOpen} onSelect={onSelectSample} />
      )}
    </div>
  );
};

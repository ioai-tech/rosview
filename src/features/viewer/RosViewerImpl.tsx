import React, { useMemo, useRef, useState } from 'react';
import { RosViewProvider } from './RosViewProvider';
import { AppShell } from '@/app/AppShell';
import type { PreferencePersistence } from '@/core/preferences/types';
import { ROS_VIEW_LAYOUT_STORAGE_KEY } from '@/core/preferences/storageKeys';
import { resolveEmbedChrome } from './embedChrome';
import { RosViewerLayoutProvider } from './RosViewerLayoutContext';
import { RosViewerLandingScreen } from './RosViewerLandingScreen';
import { useThemeLanguagePreferences } from './useThemeLanguagePreferences';
import { useDatasetHistory } from './useDatasetHistory';
import { useDatasetSession } from './useDatasetSession';
import { usePlayerLifecycle } from './usePlayerLifecycle';
import { useRecordingSourceActions } from './useRecordingSourceActions';
import { useOpenFeedback } from './useOpenFeedback';
import type { RosViewerProps } from './RosViewer.types';
import { propsSignature, resolveLayoutPersistence } from './rosViewerUtils';

export type { RosViewerProps } from './RosViewer.types';

export const RosViewer: React.FC<RosViewerProps> = (props) => {
  const urlState = props.urlState ?? 'off';
  const propSig = propsSignature(props);

  const { lastLoadError, manualOpenHint, setLastLoadError, setManualOpenHint, clearOpenFeedback, showOpenError } =
    useOpenFeedback();

  const {
    datasets,
    datasetsRef,
    setExtraDatasets,
    activeId,
    setActiveId,
    setLoadedGroupId,
    activeGroupMembersKey,
    resolvedDatasetId,
    loadingSourceName,
    effectiveSourceName,
    hasSource,
    fileInputDomIdRef,
    tarInputDomIdRef,
    appendFilesAsDatasets,
  } = useDatasetSession(props, urlState, propSig, clearOpenFeedback, setManualOpenHint);

  const [sampleDialogOpen, setSampleDialogOpen] = useState(false);
  /** When set, successful player init writes `sample://…` to the address bar instead of the resolved archive URL. Shared between `usePlayerLifecycle` (reads/clears on success) and `useRecordingSourceActions` (sets it). */
  const spaSampleLocatorParamRef = useRef<string | null>(null);

  const persistence: PreferencePersistence = props.preferencePersistence ?? 'localStorage';
  const { currentTheme, currentLanguage, offlineIntl, handleThemeChange, handleLanguageChange } =
    useThemeLanguagePreferences(props, persistence);

  const { historyItems, recordHistoryEntry } = useDatasetHistory(persistence !== 'off');

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

  const { player, sourceLoading } = usePlayerLifecycle(props, {
    requireSource,
    hasSource,
    lastLoadError,
    activeId,
    activeGroupMembersKey,
    datasetsRef,
    persistence,
    urlState,
    offlineIntl,
    clearOpenFeedback,
    showOpenError,
    setLastLoadError,
    setLoadedGroupId,
    spaSampleLocatorParamRef,
  });

  const {
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
  } = useRecordingSourceActions(props, {
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
  });

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
      showNavbarBrand={props.showNavbarBrand ?? true}
      navbarBrandLabel={props.navbarBrandLabel}
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
      onCancelLoading={handleGoHome}
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
      initialSidebarTab={props.initialSidebarTab}
    />
  ) : null;

  if (!hasSource && !requireSource && player) {
    return layoutProvider(
      <RosViewProvider theme={currentTheme} language={currentLanguage} messages={props.messages}>
        {appShellElement}
      </RosViewProvider>,
    );
  }

  if (!hasSource) {
    return layoutProvider(
      <RosViewProvider theme={currentTheme} language={currentLanguage} messages={props.messages}>
        <RosViewerLandingScreen
          className={props.className}
          style={props.style}
          fileInputId="rosview-landing-file"
          tarInputId="rosview-landing-tar"
          sourceName={effectiveSourceName}
          sourceLoading={sourceLoading}
          theme={currentTheme}
          language={currentLanguage}
          onThemeChange={handleThemeChange}
          onLanguageChange={handleLanguageChange}
          showLanguageSwitcher={props.showLanguageSwitcher ?? true}
          showThemeSwitcher={props.showThemeSwitcher ?? true}
          showNavbarBrand={props.showNavbarBrand ?? true}
          navbarBrandLabel={props.navbarBrandLabel}
          onBrandClick={handleGoHome}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
          onAddFilesFromPicker={onAddFilesFromPicker}
          onLocalTarSelected={handleLocalTarFile}
          onOpenFilePick={() => void handleOpenRecordingFiles()}
          onOpenDirectory={handleOpenDirectory}
          onOpenRemotePrompt={openRemotePrompt}
          onOpenSampleDialog={() => setSampleDialogOpen(true)}
          onSubmitRemoteUrl={handleOpenRemoteRecordingUrl}
          remoteSubmitLoading={remoteUrlBusy}
          onSelectSample={handleSelectSample}
          historyItems={historyItems}
          onReplayHistory={(id) => void handleReplayHistory(id)}
          manualOpenHint={manualOpenHint}
          showLoadingSkeleton={false}
          sampleDialogOpen={sampleDialogOpen}
          onSampleDialogOpenChange={setSampleDialogOpen}
        />
      </RosViewProvider>,
    );
  }

  return layoutProvider(
    <RosViewProvider theme={currentTheme} language={currentLanguage} messages={props.messages}>
      <>
        {/*
          Rendered unconditionally (not just while the landing screen below
          is shown): history replay can target `#rosview-inline-file` /
          `#rosview-inline-tar` via `document.getElementById(...).click()`
          even once a player exists and the landing screen has unmounted.
        */}
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
        {player ? (
          appShellElement
        ) : (
          <RosViewerLandingScreen
            className={props.className}
            style={props.style}
            fileInputId="rosview-inline-file"
            tarInputId="rosview-inline-tar"
            renderHiddenInputs={false}
            sourceName={effectiveSourceName}
            sourceLoading={sourceLoading}
            theme={currentTheme}
            language={currentLanguage}
            onThemeChange={handleThemeChange}
            onLanguageChange={handleLanguageChange}
            showLanguageSwitcher={props.showLanguageSwitcher ?? true}
            showThemeSwitcher={props.showThemeSwitcher ?? true}
            showNavbarBrand={props.showNavbarBrand ?? true}
            navbarBrandLabel={props.navbarBrandLabel}
            onBrandClick={handleGoHome}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
            onAddFilesFromPicker={onAddFilesFromPicker}
            onLocalTarSelected={handleLocalTarFile}
            onOpenFilePick={() => void handleOpenRecordingFiles()}
            onOpenDirectory={handleOpenDirectory}
            onOpenRemotePrompt={openRemotePrompt}
            onOpenSampleDialog={() => setSampleDialogOpen(true)}
            onSubmitRemoteUrl={handleOpenRemoteRecordingUrl}
            remoteSubmitLoading={remoteUrlBusy}
            onSelectSample={handleSelectSample}
            historyItems={historyItems}
            onReplayHistory={(id) => void handleReplayHistory(id)}
            manualOpenHint={manualOpenHint}
            showLoadingSkeleton={!lastLoadError}
            loadingSourceName={loadingSourceName}
            onCancelLoading={handleGoHome}
            sampleDialogOpen={sampleDialogOpen}
            onSampleDialogOpenChange={setSampleDialogOpen}
          />
        )}
      </>
    </RosViewProvider>,
  );
};

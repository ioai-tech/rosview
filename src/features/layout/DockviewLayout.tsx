import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { DockviewReact } from 'dockview';
import type { DockviewReadyEvent, IDockviewPanelProps, DockviewApi } from 'dockview';
import 'dockview/dist/styles/dockview.css';
import type { Player } from '@/core/types/player';
import { useRosViewTheme } from '@/features/viewer/RosViewProvider';
import { useMessagePipeline } from '@/core/pipeline/useMessagePipeline';
import type { MessagePipelineState } from '@/core/pipeline/store';
import {
  createPanelInstanceId,
  getPanelTypeFromId,
  listPanelStates,
  markPanelInstanceId,
  replacePanelConfigs,
  replacePanelStates,
  setPanelConfig,
  upsertPanelState,
} from '../panels/framework';
import { PanelRuntimeShell } from '../panels/framework/PanelRuntimeShell';
import type { PanelInstanceSnapshot, PanelType } from '../panels/framework';
import {
  getFoxgloveAdapter,
  getPanelDefinition,
  getPanelDefinitions,
  hasFoxgloveAdapter,
  hasPanelDefinition,
} from '../panels/registry';
import { PanelTabHeader } from './PanelTabHeader';
import { readSavedDockviewLayout } from '@/core/preferences/layoutStorage';
import { createSinglePanelLayout } from '@/core/preferences/createSinglePanelLayout';
import type { PreferencePersistence } from '@/core/preferences/types';
import { useSidebarStore } from '@/shared/hooks/useSidebarStore';
import {
  buildFoxgloveLayout,
  importFoxgloveLayout,
  parseFoxgloveLayout,
  restoreTabGroups,
  serializeDockviewApi,
  type FoxgloveLayoutData,
} from '@/core/preferences/foxgloveLayout';
import type { SerializedDockview } from 'dockview-core';
import { setDockviewController, type OpenPanelInput } from './dockviewController';
import { WELCOME_PANEL_ID } from './dockviewIds';
import { setGlobalDockviewApi } from './dockviewGlobalApi';
import { rosDockviewThemeDark, rosDockviewThemeLight } from './rosDockviewTheme';
import { applyDefaultRosDockLayoutFromImport } from '@/features/layout/autoLayout/applyDefaultRosDockLayout';
import { WelcomePanelContent } from './WelcomePanelContent';

const DockviewApiContext = createContext<DockviewApi | null>(null);

export const useDockviewApi = () => useContext(DockviewApiContext);

function collectTopicReferences(value: unknown, keyHint = '', out = new Set<string>()): Set<string> {
  if (typeof value === 'string') {
    if (keyHint.toLowerCase().includes('topic') && value.trim()) {
      out.add(value.trim());
    }
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectTopicReferences(item, keyHint, out);
    }
    return out;
  }
  if (typeof value !== 'object' || value == null) {
    return out;
  }
  for (const [key, child] of Object.entries(value)) {
    collectTopicReferences(child, key, out);
  }
  return out;
}

function layoutHasUnknownTopicReferences(layout: FoxgloveLayoutData, topics: ReadonlyArray<{ name: string }>): boolean {
  if (topics.length === 0) {
    return false;
  }
  const knownTopics = new Set(topics.map((topic) => topic.name));
  for (const config of Object.values(layout.configById)) {
    const refs = collectTopicReferences(config);
    for (const ref of refs) {
      if (!knownTopics.has(ref)) {
        return true;
      }
    }
  }
  return false;
}

interface DockviewLayoutProps {
  player: Player;
  preferAutoLayout?: boolean;
  /** Declarative layout applied on mount before localStorage. */
  initialLayout?: FoxgloveLayoutData;
  /** Shorthand for a single panel when `initialLayout` is omitted. */
  defaultPanel?: OpenPanelInput;
  /** When `'off'`, skip reading/writing layout localStorage. @default 'localStorage' */
  layoutPersistence?: PreferencePersistence;
  layoutStorageKey?: string;
  /** Skip Welcome placeholder and do not restore it when all panels close. */
  suppressWelcomePanel?: boolean;
  onLayoutReady?: (info: { panelCount: number }) => void;
}

export const DockviewLayout: React.FC<DockviewLayoutProps> = ({
  player,
  preferAutoLayout = false,
  initialLayout,
  defaultPanel,
  layoutPersistence = 'localStorage',
  layoutStorageKey,
  suppressWelcomePanel = false,
  onLayoutReady,
}) => {
  const { resolvedTheme } = useRosViewTheme();
  const dockviewTheme = useMemo(
    () => (resolvedTheme === 'dark' ? rosDockviewThemeDark : rosDockviewThemeLight),
    [resolvedTheme],
  );
  const apiRef = useRef<DockviewApi | null>(null);
  const [contextApi, setContextApi] = useState<DockviewApi | null>(null);
  const topics = useMessagePipeline((state: MessagePipelineState) => state.sortedTopics);
  const publishersByTopic = useMessagePipeline((state: MessagePipelineState) => state.publishersByTopic);
  const transportMode = useMessagePipeline((state: MessagePipelineState) => state.playerState.progress.transportMode);
  const hasAutoInitializedRef = useRef(false);
  /** Skips auto Welcome when panels are cleared intentionally (import / topic bootstrap). */
  const suppressWelcomeRestoreRef = useRef(false);
  const dockviewEventDisposablesRef = useRef<{ dispose: () => void }[]>([]);
  /** Kept in a ref so callbacks capturing it see the latest value without recreating. */
  const preferAutoLayoutRef = useRef(preferAutoLayout);
  const suppressWelcomePanelRef = useRef(suppressWelcomePanel);
  const layoutPersistenceRef = useRef(layoutPersistence);
  const layoutStorageKeyRef = useRef(layoutStorageKey);
  const initialLayoutRef = useRef(initialLayout);
  const defaultPanelRef = useRef(defaultPanel);
  const onLayoutReadyRef = useRef(onLayoutReady);

  useEffect(() => {
    preferAutoLayoutRef.current = preferAutoLayout;
  }, [preferAutoLayout]);

  useEffect(() => {
    suppressWelcomePanelRef.current = suppressWelcomePanel;
  }, [suppressWelcomePanel]);

  useEffect(() => {
    layoutPersistenceRef.current = layoutPersistence;
  }, [layoutPersistence]);

  useEffect(() => {
    layoutStorageKeyRef.current = layoutStorageKey;
  }, [layoutStorageKey]);

  useEffect(() => {
    initialLayoutRef.current = initialLayout;
  }, [initialLayout]);

  useEffect(() => {
    defaultPanelRef.current = defaultPanel;
  }, [defaultPanel]);

  useEffect(() => {
    onLayoutReadyRef.current = onLayoutReady;
  }, [onLayoutReady]);

  useEffect(() => {
    return () => {
      for (const d of dockviewEventDisposablesRef.current) {
        d.dispose();
      }
      dockviewEventDisposablesRef.current = [];
      setDockviewController(null);
      setGlobalDockviewApi(null);
    };
  }, []);

  const openPanel = useCallback((input: OpenPanelInput): string | null => {
    const api = apiRef.current;
    if (!api) return null;

    const definition = getPanelDefinition(input.type);
    const panelId = input.id ?? createPanelInstanceId(input.type);
    markPanelInstanceId(panelId);

    const config = definition.configSchema.parse(input.config ?? definition.createDefaultConfig());
    const title = input.title ?? definition.defaultTitle;

    // Seed the config store so the runtime shell (mounted asynchronously by
    // DockView) immediately picks up the desired config instead of falling
    // back to defaults.
    setPanelConfig(panelId, config);
    upsertPanelState({
      id: panelId,
      type: definition.type,
      title,
      config,
      configVersion: definition.configSchema.version,
    });

    if (api.getPanel(panelId)) {
      if (input.activate !== false) {
        api.getPanel(panelId)?.api.setActive();
      }
      return panelId;
    }

    api.addPanel({
      id: panelId,
      component: definition.type,
      tabComponent: 'default',
      title,
      params: config ?? {},
      position: input.position,
    });
    return panelId;
  }, []);

  const duplicatePanel = useCallback((panelId: string): string | null => {
    const snapshot = listPanelStates()[panelId];
    if (!snapshot) return null;
    return openPanel({
      type: snapshot.type,
      title: `${snapshot.title} Copy`,
      config: snapshot.config,
      position: { referencePanel: panelId, direction: 'right' },
    });
  }, [openPanel]);

  const duplicatePanelRef = useRef(duplicatePanel);
  const topicsRef = useRef(topics);
  const publishersByTopicRef = useRef(publishersByTopic);
  const layoutDatasetSignatureRef = useRef<string | null>(null);

  useEffect(() => {
    duplicatePanelRef.current = duplicatePanel;
  }, [duplicatePanel]);

  useEffect(() => {
    topicsRef.current = topics;
  }, [topics]);

  useEffect(() => {
    publishersByTopicRef.current = publishersByTopic;
  }, [publishersByTopic]);

  const currentDatasetSignature = useMemo(() => {
    if (topics.length === 0) return '';
    return topics
      .map((topic) => `${topic.name}:${topic.type}`)
      .sort()
      .join('|');
  }, [topics]);

  const reapplyAutoLayout = useCallback((): boolean => {
    const api = apiRef.current;
    if (!api) return false;
    suppressWelcomeRestoreRef.current = true;
    try {
      api.panels.forEach((panel) => panel.api.close());
      applyDefaultRosDockLayoutFromImport(api, topicsRef.current, {
        publishersByTopic: publishersByTopicRef.current,
      });
      hasAutoInitializedRef.current = true;
      layoutDatasetSignatureRef.current = topicsRef.current
        .map((topic) => `${topic.name}:${topic.type}`)
        .sort()
        .join('|');
      return true;
    } finally {
      suppressWelcomeRestoreRef.current = false;
    }
  }, []);

  /**
   * Build a Foxglove-compatible JSON blob from the current DockView state.
   * Welcome placeholder and any non-registered DockView panels are filtered
   * out so the payload is valid Foxglove `LayoutData`.
   */
  const exportLayoutState = useCallback((): FoxgloveLayoutData | null => {
    const api = apiRef.current;
    if (!api) return null;
    const ignore = new Set<string>([WELCOME_PANEL_ID]);
    return buildFoxgloveLayout({
      apiState: serializeDockviewApi(api),
      panels: listPanelStates(),
      ignoreIds: ignore,
    });
  }, []);

  /**
   * Import a JSON value that should follow Foxglove's `LayoutData` shape.
   * Unknown panel types degrade to `Unavailable`; their original config is
   * retained in `extras` for lossless re-export.
   */
  const importLayoutState = useCallback((
    value: unknown,
  ): { restored: number; degraded: number; skipped: number } => {
    const api = apiRef.current;
    const parsed = parseFoxgloveLayout(value);
    if (!api || !parsed) {
      return { restored: 0, degraded: 0, skipped: 1 };
    }

    const result = importFoxgloveLayout(parsed, { unavailableComponent: 'Unavailable' });

    suppressWelcomeRestoreRef.current = true;
    // Clear any existing panels (including the welcome placeholder) before
    // replacing with the imported state.
    for (const panel of api.panels) {
      panel.api.close();
    }

    replacePanelStates(result.panelStates);
    // Seed the config store for every imported panel so the runtime shell
    // renders the right config as soon as it mounts (rather than defaulting).
    const nextConfigs: Record<string, unknown> = {};
    for (const [panelId, snapshot] of Object.entries(result.panelStates)) {
      nextConfigs[panelId] = snapshot.config;
      markPanelInstanceId(panelId);
    }
    replacePanelConfigs(nextConfigs);

    try {
      if (result.dockviewState) {
        try {
          api.fromJSON(result.dockviewState as unknown as SerializedDockview, { reuseExistingPanels: false });
          restoreTabGroups(api, result.tabGroups);
        } catch (error) {
          console.warn('[DockviewLayout] api.fromJSON failed, falling back to sequential placement', error);
          sequentialFallback(api, result.panelStates);
        }
      } else {
        sequentialFallback(api, result.panelStates);
      }
    } finally {
      suppressWelcomeRestoreRef.current = false;
    }

    hasAutoInitializedRef.current = true;
    return { restored: result.restored, degraded: result.degraded, skipped: result.skipped };
  }, []);

  const components = useMemo(() => {
    const mapped: Record<string, (props: IDockviewPanelProps) => React.ReactElement> = {};
    for (const definition of getPanelDefinitions()) {
      mapped[definition.type] = (props: IDockviewPanelProps) => {
        const snapshot = listPanelStates()[props.api.id];
        const initialConfig = definition.configSchema.parse(
          snapshot?.config ?? props.params ?? definition.createDefaultConfig(),
        );
        return (
          <PanelRuntimeShell
            player={player}
            panelId={props.api.id}
            panelTitle={snapshot?.title ?? props.api.title ?? definition.defaultTitle}
            definition={definition}
            initialConfig={initialConfig}
            foxgloveType={snapshot?.foxgloveType}
            extras={snapshot?.extras}
            onDuplicate={(panelId) => duplicatePanelRef.current(panelId)}
            onClose={(panelId) => apiRef.current?.getPanel(panelId)?.api.close()}
          />
        );
      };
    }
    mapped.default = (props: IDockviewPanelProps) => (
      <WelcomePanelContent welcomePanelId={props.api.id} />
    );
    return mapped;
  }, [player]);

  const tabComponents = useMemo(
    () => ({
      default: PanelTabHeader,
    }),
    [],
  );

  useEffect(() => {
    if (!apiRef.current || topics.length === 0) return;
    const api = apiRef.current;
    if (
      hasAutoInitializedRef.current &&
      layoutDatasetSignatureRef.current &&
      layoutDatasetSignatureRef.current !== currentDatasetSignature
    ) {
      reapplyAutoLayout();
      layoutDatasetSignatureRef.current = currentDatasetSignature;
      return;
    }
    if (hasAutoInitializedRef.current) return;
    const hasAnyNonWelcomePanel = api.panels.some((panel) => panel.id !== WELCOME_PANEL_ID);
    if (hasAnyNonWelcomePanel) return;
    if (!preferAutoLayout && api.panels.length === 0) return;

    hasAutoInitializedRef.current = true;
    layoutDatasetSignatureRef.current = currentDatasetSignature;
    suppressWelcomeRestoreRef.current = true;
    try {
      api.panels.forEach((panel) => panel.api.close());
      applyDefaultRosDockLayoutFromImport(api, topics, {
        publishersByTopic,
      });
    } finally {
      suppressWelcomeRestoreRef.current = false;
    }
  }, [topics, publishersByTopic, preferAutoLayout, currentDatasetSignature, reapplyAutoLayout]);

  const onReady = useCallback((event: DockviewReadyEvent) => {
    apiRef.current = event.api;
    setGlobalDockviewApi(event.api);
    setContextApi(event.api);
    setDockviewController({
      openPanel,
      duplicatePanel,
      exportLayout: exportLayoutState,
      importLayout: importLayoutState,
      reapplyAutoLayout,
    });

    for (const d of dockviewEventDisposablesRef.current) {
      d.dispose();
    }
    dockviewEventDisposablesRef.current = [
      event.api.onDidRemovePanel(() => {
        if (suppressWelcomeRestoreRef.current) {
          return;
        }
        if (preferAutoLayoutRef.current || suppressWelcomePanelRef.current) {
          return;
        }
        queueMicrotask(() => {
          const api = apiRef.current;
          if (!api || api.panels.length > 0) {
            return;
          }
          api.addPanel({
            id: WELCOME_PANEL_ID,
            component: 'default',
            title: 'Welcome',
          });
        });
      }),
      // Keep the Sidebar's "settings for this panel" target in sync with
      // DockView's focus. `WELCOME_PANEL_ID` is filtered out so the sidebar
      // never shows settings for the placeholder.
      event.api.onDidActivePanelChange((panel) => {
        const id = panel?.id ?? null;
        useSidebarStore.getState().setActivePanelId(id && id !== WELCOME_PANEL_ID ? id : null);
      }),
    ];

    const sidebarStore = useSidebarStore.getState();
    const initialActive = event.api.activePanel?.id;
    if (initialActive && initialActive !== WELCOME_PANEL_ID) {
      sidebarStore.setActivePanelId(initialActive);
    }

    const declarativeLayout =
      initialLayoutRef.current ??
      (defaultPanelRef.current ? createSinglePanelLayout(defaultPanelRef.current) : null);

    if (declarativeLayout && !layoutHasUnknownTopicReferences(declarativeLayout, topicsRef.current)) {
      importLayoutState(declarativeLayout);
      if (event.api.panels.length > 0) {
        hasAutoInitializedRef.current = true;
        layoutDatasetSignatureRef.current = topicsRef.current
          .map((topic) => `${topic.name}:${topic.type}`)
          .sort()
          .join('|');
        onLayoutReadyRef.current?.({ panelCount: event.api.panels.length });
        return;
      }
    }

    if (layoutPersistenceRef.current === 'localStorage') {
      const stored = readSavedDockviewLayout(layoutStorageKeyRef.current);
      if (stored && !layoutHasUnknownTopicReferences(stored, topicsRef.current)) {
        importLayoutState(stored);
        if (event.api.panels.length > 0) {
          hasAutoInitializedRef.current = true;
          layoutDatasetSignatureRef.current = topicsRef.current
            .map((topic) => `${topic.name}:${topic.type}`)
            .sort()
            .join('|');
          onLayoutReadyRef.current?.({ panelCount: event.api.panels.length });
          return;
        }
      }
    }

    if (preferAutoLayoutRef.current) {
      if (topicsRef.current.length > 0) {
        suppressWelcomeRestoreRef.current = true;
        try {
          applyDefaultRosDockLayoutFromImport(event.api, topicsRef.current, {
            publishersByTopic: publishersByTopicRef.current,
          });
          hasAutoInitializedRef.current = true;
          layoutDatasetSignatureRef.current = topicsRef.current
            .map((topic) => `${topic.name}:${topic.type}`)
            .sort()
            .join('|');
          onLayoutReadyRef.current?.({ panelCount: event.api.panels.length });
        } finally {
          suppressWelcomeRestoreRef.current = false;
        }
      }
      return;
    }

    if (!suppressWelcomePanelRef.current) {
      event.api.addPanel({
        id: WELCOME_PANEL_ID,
        component: 'default',
        title: 'Welcome',
      });
    }
    onLayoutReadyRef.current?.({ panelCount: event.api.panels.length });
  }, [openPanel, duplicatePanel, exportLayoutState, importLayoutState, reapplyAutoLayout]);

  return (
    <DockviewApiContext.Provider value={contextApi}>
      <div
        className="ros-dockview-shell flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden [contain:strict]"
        data-testid="rosview-dockview"
        data-dockview-chrome-theme={resolvedTheme}
        data-transport-mode={transportMode ?? ''}
      >
        <div className="min-h-0 h-full min-w-0 flex-1 overflow-hidden">
          <DockviewReact
            theme={dockviewTheme}
            components={components}
            tabComponents={tabComponents}
            defaultTabComponent={PanelTabHeader}
            singleTabMode="fullwidth"
            disableTabsOverflowList
            onReady={onReady}
          />
        </div>
      </div>
    </DockviewApiContext.Provider>
  );
};

/**
 * Fallback path: when `api.fromJSON` rejects the serialized state we place
 * panels sequentially via `api.addPanel` so the session is not left empty.
 */
function sequentialFallback(
  api: DockviewApi,
  panelStates: Record<string, PanelInstanceSnapshot>,
): void {
  const ids = Object.keys(panelStates);
  let previousId: string | undefined;
  for (const panelId of ids) {
    const snapshot = panelStates[panelId];
    const foxgloveType = snapshot.foxgloveType ?? getPanelTypeFromId(panelId);
    const componentType: PanelType = hasPanelDefinition(snapshot.type)
      ? snapshot.type
      : hasFoxgloveAdapter(foxgloveType)
        ? getFoxgloveAdapter(foxgloveType).internalType
        : 'Unavailable';
    api.addPanel({
      id: panelId,
      component: componentType,
      tabComponent: 'default',
      title: snapshot.title,
      params: (snapshot.config ?? {}) as Record<string, unknown>,
      position: previousId ? { referencePanel: previousId, direction: 'right' } : undefined,
    });
    previousId = panelId;
  }
}

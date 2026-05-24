import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { Player } from '@/core/types/player';
import { useSidebarStore } from '@/shared/hooks/useSidebarStore';
import { PanelErrorBoundary } from './PanelErrorBoundary';
import { registerPanelActions, unregisterPanelActions } from './panelActionRegistry';
import {
  ensurePanelConfig,
  getPanelConfig,
  removePanelConfig,
  setPanelConfig,
  usePanelConfig,
} from './panelConfigStore';
import { removePanelState, upsertPanelState } from './panelStateRegistry';
import { registerPanelSettings, unregisterPanelSettings } from './panelSettingsRegistry';
import type { PanelDefinition, PanelInstanceSnapshot, PanelSettingsContext } from './types';

interface PanelRuntimeShellProps<TConfig> {
  player: Player;
  panelId: string;
  panelTitle: string;
  definition: PanelDefinition<TConfig>;
  initialConfig: TConfig;
  onDuplicate: (panelId: string) => void;
  onClose: (panelId: string) => void;
  /** Preserved Foxglove panel type (when id's prefix differs from internal type). */
  foxgloveType?: string;
  /** Preserved unknown Foxglove config fields for round-trip export. */
  extras?: Record<string, unknown>;
}

export function PanelRuntimeShell<TConfig>({
  player,
  panelId,
  panelTitle,
  definition,
  initialConfig,
  onDuplicate,
  onClose,
  foxgloveType,
  extras,
}: PanelRuntimeShellProps<TConfig>): React.ReactElement {
  // Seed the config store with our initial value (idempotent across strict-mode
  // double mounts) and read back the live value so external edits (e.g. from
  // the Sidebar) trigger re-renders via `useSyncExternalStore`.
  useMemo(() => ensurePanelConfig(panelId, initialConfig), [panelId, initialConfig]);
  const storeConfig = usePanelConfig<TConfig>(panelId);
  const config = storeConfig !== undefined ? storeConfig : initialConfig;

  const [resetKey, setResetKey] = useState(0);

  const setConfig = useCallback<PanelSettingsContext<TConfig>['setConfig']>(
    (next) => {
      // Read the freshest value from the store so functional updates see
      // changes that may have happened since the last render.
      const prev = (getPanelConfig<TConfig>(panelId) ?? initialConfig);
      const resolved: TConfig =
        typeof next === 'function' ? (next as (p: TConfig) => TConfig)(prev) : next;
      setPanelConfig<TConfig>(panelId, resolved);
    },
    [initialConfig, panelId],
  );

  // Keep the panel state registry in sync so layout export / sidebar lookups
  // see the current config + title. Cleared on unmount.
  useEffect(() => {
    const snapshot: PanelInstanceSnapshot = {
      id: panelId,
      type: definition.type,
      title: panelTitle,
      config,
      configVersion: definition.configSchema.version,
      foxgloveType,
      extras,
    };
    upsertPanelState(snapshot);
  }, [config, definition.configSchema.version, definition.type, extras, foxgloveType, panelId, panelTitle]);

  useEffect(() => {
    return () => {
      removePanelState(panelId);
      removePanelConfig(panelId);
    };
  }, [panelId]);

  const resetPanel = useCallback((): void => {
    setPanelConfig<TConfig>(panelId, definition.createDefaultConfig());
    setResetKey((value) => value + 1);
  }, [definition, panelId]);

  const handleCopyPanelId = useCallback(async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(panelId);
    } catch (error) {
      console.warn('Failed to copy panel id', error);
    }
  }, [panelId]);

  const handleDuplicate = useCallback(() => onDuplicate(panelId), [onDuplicate, panelId]);
  const handleClose = useCallback(() => onClose(panelId), [onClose, panelId]);

  // Register the action handlers so `PanelTabHeader` can invoke them from a
  // different subtree. Re-register on every relevant dep change.
  useEffect(() => {
    registerPanelActions(panelId, {
      hasSettings: definition.renderSettings != null,
      openSettingsSidebar: () => {
        useSidebarStore.getState().openSettingsFor(panelId);
      },
      resetPanel,
      copyPanelId: () => {
        void handleCopyPanelId();
      },
      duplicatePanel: handleDuplicate,
      closePanel: handleClose,
    });
    return () => {
      unregisterPanelActions(panelId);
    };
  }, [definition.renderSettings, handleCopyPanelId, handleClose, handleDuplicate, panelId, resetPanel]);

  // Register the settings renderer so the sidebar can render it when this
  // panel is active. We pass a thunk that closes over the *latest* deps via
  // `useEffect`'s dep array.
  useEffect(() => {
    if (definition.renderSettings == null) {
      return;
    }
    const renderer = definition.renderSettings;
    registerPanelSettings(panelId, (ctx) =>
      renderer(ctx as unknown as PanelSettingsContext<TConfig>),
    );
    return () => {
      unregisterPanelSettings(panelId);
    };
  }, [definition, panelId]);

  return (
    <PanelErrorBoundary panelName={definition.type} panelId={panelId} onReset={resetPanel}>
      <div key={resetKey} className="h-full min-h-0 w-full overflow-hidden">
        {definition.render({
          player,
          panelId,
          panelTitle,
          config,
          setConfig,
          resetPanel,
        })}
      </div>
    </PanelErrorBoundary>
  );
}


import React, { useMemo } from 'react';
import { Copy, RotateCcw, Settings2, X } from 'lucide-react';
import { useIntl, type IntlShape } from 'react-intl';
import type { Player } from '@/core/types/player';
import type { TopicInfo } from '@/core/types/ros';
import {
  getPanelActions,
  getPanelSettingsRenderer,
  getPanelState,
  getPanelConfig,
  setPanelConfig,
  usePanelConfig,
  usePanelSettingsRegistryVersion,
} from '../../panels/framework';
import { useSidebarStore } from '@/shared/hooks/useSidebarStore';
import { usePanelDisplayTitle } from '@/features/layout/usePanelDisplayTitle';

interface PanelSettingsTabProps {
  player: Player;
  topics: ReadonlyArray<TopicInfo>;
}

/**
 * Sidebar tab that shows the currently active panel's settings editor.
 *
 * - Active panel id comes from `useSidebarStore.activePanelId` which is
 *   driven by DockView's `onDidActivePanelChange` event (see DockviewLayout).
 * - The settings renderer is looked up from `panelSettingsRegistry`, which
 *   is populated by `PanelRuntimeShell` for every mounted panel.
 * - Config reads/writes go through `panelConfigStore` so both the panel body
 *   and this tab see the same live state.
 *
 * Empty states:
 * - No active panel → friendly prompt.
 * - Active panel exists but didn't register `renderSettings` → show shortcut
 *   buttons for Reset / Copy id / Duplicate / Close.
 */
export const PanelSettingsTab: React.FC<PanelSettingsTabProps> = ({ player, topics }) => {
  const { formatMessage } = useIntl();
  const activePanelId = useSidebarStore((s) => s.activePanelId);
  // Trigger a re-render whenever ANY panel's renderer registers or unregisters.
  usePanelSettingsRegistryVersion();
  // Trigger a re-render when the active panel's config changes.
  const config = usePanelConfig(activePanelId ?? '');
  const snapshot = activePanelId ? getPanelState(activePanelId) : undefined;
  const renderer = activePanelId ? getPanelSettingsRenderer(activePanelId) : undefined;
  const actions = activePanelId ? getPanelActions(activePanelId) : undefined;
  const displayTitle = usePanelDisplayTitle(activePanelId ?? '', snapshot?.title ?? '');

  const body = useMemo(() => {
    if (!activePanelId || !snapshot) {
      return (
        <div className="text-xs text-muted-foreground italic px-2 mt-6 text-center">
          {formatMessage({ id: 'sidebar.settings.noActivePanel' })}
        </div>
      );
    }
    if (!renderer) {
      return (
        <div className="px-3 pt-4 space-y-3">
          <div className="text-xs text-muted-foreground">
            {formatMessage({ id: 'sidebar.settings.noSettings' })}
          </div>
          {actions && <PanelQuickActions actions={actions} formatMessage={formatMessage} />}
        </div>
      );
    }
    // Build a context matching `PanelSettingsContext<unknown>` so the
    // renderer can use it regardless of its concrete TConfig.
    const currentConfig = config ?? getPanelConfig(activePanelId) ?? snapshot.config;
    return renderer({
      panelId: activePanelId,
      panelTitle: snapshot.title,
      config: currentConfig,
      setConfig: (next) => {
        const prev = getPanelConfig(activePanelId) ?? currentConfig;
        const resolved = typeof next === 'function' ? (next as (p: unknown) => unknown)(prev) : next;
        setPanelConfig(activePanelId, resolved);
      },
      player,
      topics,
      resetPanel: () => actions?.resetPanel(),
      duplicatePanel: () => actions?.duplicatePanel(),
      closePanel: () => actions?.closePanel(),
      copyPanelId: () => actions?.copyPanelId(),
      extras: snapshot.extras,
    });
  }, [activePanelId, snapshot, renderer, actions, config, player, topics, formatMessage]);

  return (
    <div className="flex flex-col min-h-0 h-full">
      {snapshot && (
        <div className="shrink-0 px-3 py-2 border-b border-border/60 flex items-center gap-2">
          <Settings2 className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="text-xs font-semibold truncate" title={displayTitle.tooltip} data-testid="panel-settings-title">
              {displayTitle.text}
            </div>
            <div className="text-[10px] text-muted-foreground font-mono truncate">
              {activePanelId}
            </div>
          </div>
          {actions && (
            <button
              type="button"
              onClick={() => actions.resetPanel()}
              className="p-1 rounded-md hover:bg-accent text-muted-foreground hover:text-foreground"
              title={formatMessage({ id: 'layout.panelTab.context.resetPanel' })}
              aria-label={formatMessage({ id: 'layout.panelTab.context.resetPanel' })}
            >
              <RotateCcw className="h-3 w-3" />
            </button>
          )}
        </div>
      )}
      <div className="flex-1 min-h-0 overflow-y-auto px-2 py-2 space-y-2">
        {body}
      </div>
    </div>
  );
};

const PanelQuickActions: React.FC<{
  actions: NonNullable<ReturnType<typeof getPanelActions>>;
  formatMessage: IntlShape['formatMessage'];
}> = ({ actions, formatMessage }) => (
  <div className="grid grid-cols-2 gap-1.5">
    <button
      type="button"
      onClick={actions.resetPanel}
      className="flex items-center justify-center gap-1.5 border border-input rounded-sm bg-background px-2 py-1 text-[11px] hover:bg-accent"
    >
      <RotateCcw className="h-3 w-3" /> {formatMessage({ id: 'layout.panelTab.context.resetPanel' })}
    </button>
    <button
      type="button"
      onClick={actions.copyPanelId}
      className="flex items-center justify-center gap-1.5 border border-input rounded-sm bg-background px-2 py-1 text-[11px] hover:bg-accent"
    >
      <Copy className="h-3 w-3" /> {formatMessage({ id: 'layout.panelTab.context.copyPanelId' })}
    </button>
    <button
      type="button"
      onClick={actions.duplicatePanel}
      className="flex items-center justify-center gap-1.5 border border-input rounded-sm bg-background px-2 py-1 text-[11px] hover:bg-accent col-span-2"
    >
      {formatMessage({ id: 'layout.panelTab.context.duplicatePanel' })}
    </button>
    <button
      type="button"
      onClick={actions.closePanel}
      className="flex items-center justify-center gap-1.5 border border-input rounded-sm bg-background px-2 py-1 text-[11px] hover:bg-destructive hover:text-destructive-foreground col-span-2"
    >
      <X className="h-3 w-3" /> {formatMessage({ id: 'layout.panelTab.closePanel' })}
    </button>
  </div>
);

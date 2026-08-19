import React, { useCallback, useMemo, useRef, useState } from 'react';
import type { IDockviewPanelHeaderProps } from 'dockview';
import { useIntl } from 'react-intl';
import { Separator } from '@/shared/ui/separator';
import { useElementWidth } from '@/shared/hooks/useElementWidth';
import type { PanelType } from '../panels/framework';
import {
  extractPrimaryTopicFromConfig,
  getPanelConfig,
  getPanelState,
  getPanelTypeFromId,
  listPanelStates,
  usePanelActions,
} from '../panels/framework';
import { PANEL_TYPE_MESSAGE_SLUG } from '../panels/framework/panelMessageSlug';
import { PanelTypeIcon } from '../panels/framework/panelIcons';
import {
  buildRosViewTabContextMenuItems,
  RosViewTabContextMenuPortal,
} from './rosviewTabContextMenu';
import { WELCOME_PANEL_ID } from './dockviewIds';
import { openDockviewPanel } from './dockviewController';
import { getAddablePanelDefinitions, getFoxgloveAdapter, getPanelDefinition, hasFoxgloveAdapter, hasPanelDefinition } from '../panels/registry';
import { PanelTabAddPanelDefinitionsSubmenus } from './PanelTabAddPanelDefinitionsSubmenus';
import { PanelTabActions } from './PanelTabActions';
import { PANEL_TAB_EXPANDED_MIN_WIDTH_PX } from './layoutConstants';

/** Tab label uses localized panel titles (`panels.<slug>.defaultTitle`). */
function resolveTabDefaultTitle(panelId: string, dockviewTitle: string): string {
  const snapshot = listPanelStates()[panelId];
  if (snapshot?.type && hasPanelDefinition(snapshot.type)) {
    return getPanelDefinition(snapshot.type).defaultTitle;
  }
  const prefix = getPanelTypeFromId(panelId);
  if (hasPanelDefinition(prefix)) {
    return getPanelDefinition(prefix).defaultTitle;
  }
  if (hasFoxgloveAdapter(prefix)) {
    return getPanelDefinition(getFoxgloveAdapter(prefix).internalType).defaultTitle;
  }
  return dockviewTitle;
}

/** Resolves the PanelType for a panel id, returns null for unknown/welcome panels. */
function resolveTabPanelType(panelId: string): PanelType | null {
  const snapshot = listPanelStates()[panelId];
  if (snapshot?.type && hasPanelDefinition(snapshot.type)) {
    return snapshot.type;
  }
  const prefix = getPanelTypeFromId(panelId);
  if (hasPanelDefinition(prefix)) {
    return prefix;
  }
  if (hasFoxgloveAdapter(prefix)) {
    return getFoxgloveAdapter(prefix).internalType;
  }
  return null;
}

export const PanelTabHeader: React.FC<IDockviewPanelHeaderProps> = ({ api, containerApi }) => {
  const { formatMessage } = useIntl();
  const panel = containerApi.getPanel(api.id);
  const dockviewTitle = panel?.title ?? api.title ?? 'Panel';
  const panelType = resolveTabPanelType(api.id);
  const defaultTitleFallback = resolveTabDefaultTitle(api.id, dockviewTitle);
  const title = useMemo(() => {
    if (panelType != null && hasPanelDefinition(panelType)) {
      const slug = PANEL_TYPE_MESSAGE_SLUG[panelType];
      return formatMessage({ id: `panels.${slug}.defaultTitle`, defaultMessage: defaultTitleFallback });
    }
    return defaultTitleFallback;
  }, [formatMessage, panelType, defaultTitleFallback]);
  const actions = usePanelActions(api.id);
  const isWelcome = api.id === WELCOME_PANEL_ID;
  const tabRowRef = useRef<HTMLDivElement>(null);
  const tabWidth = useElementWidth(tabRowRef);
  const useCompactTabActions =
    tabWidth === undefined ? true : tabWidth < PANEL_TAB_EXPANDED_MIN_WIDTH_PX;
  const definitions = useMemo(
    () => getAddablePanelDefinitions(),
    [],
  );
  const [ctx, setCtx] = useState<{ x: number; y: number } | null>(null);
  const [ctxItems, setCtxItems] = useState<ReturnType<typeof buildRosViewTabContextMenuItems>>([]);

  const onTabContextMenu = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      setCtxItems(
        buildRosViewTabContextMenuItems({
          containerApi,
          panelApi: api,
          welcomePanelId: WELCOME_PANEL_ID,
        }),
      );
      setCtx({ x: event.clientX, y: event.clientY });
    },
    [api, containerApi],
  );

  const closePanel = useCallback(() => {
    containerApi.getPanel(api.id)?.api.close();
  }, [api.id, containerApi]);

  const addPanelWithPlacement = useCallback(
    (type: PanelType, placement: 'replace' | 'right' | 'below' | 'within') => {
      const sourceConfig = getPanelConfig(api.id) ?? getPanelState(api.id)?.config;
      const inheritedTopic =
        type === 'RawMessages' ? extractPrimaryTopicFromConfig(sourceConfig) : undefined;
      const config = inheritedTopic ? { topic: inheritedTopic } : undefined;

      if (placement === 'replace') {
        openDockviewPanel({
          type,
          config,
          position: { referencePanel: api.id, direction: 'within' },
        });
        window.setTimeout(() => {
          containerApi.getPanel(api.id)?.api.close();
        }, 0);
        return;
      }
      openDockviewPanel({
        type,
        config,
        position: { referencePanel: api.id, direction: placement },
      });
    },
    [api.id, containerApi],
  );

  const openSettings = useCallback(() => {
    containerApi.getPanel(api.id)?.api.setActive();
    actions?.openSettingsSidebar();
  }, [actions, api.id, containerApi]);

  const addPanelSubmenus = (
    <PanelTabAddPanelDefinitionsSubmenus
      definitions={definitions}
      formatMessage={formatMessage}
      onPlacement={addPanelWithPlacement}
    />
  );

  return (
    <div
      ref={tabRowRef}
      className="ros-dockview-tab-row flex items-center w-full min-w-0 h-full gap-1 px-2 box-border"
      onContextMenu={onTabContextMenu}
    >
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
        {panelType && !isWelcome && (
          <PanelTypeIcon type={panelType} className="h-3 w-3 shrink-0 opacity-60" />
        )}
        <span className="min-w-0 flex-1 truncate text-sm" title={title}>
          {title}
        </span>
      </div>

      {!isWelcome && (
        <>
          <Separator orientation="vertical" className="mx-0.5 h-4 shrink-0 self-center" decorative />
          <div
            className="flex shrink-0 items-center gap-0.5"
            data-testid="panel-tab-actions"
            onPointerDown={(event) => {
              event.stopPropagation();
            }}
          >
            <PanelTabActions
              compact={useCompactTabActions}
              hasSettings={actions?.hasSettings ?? false}
              onOpenSettings={openSettings}
              onClose={closePanel}
              addPanelSubmenus={addPanelSubmenus}
              formatMessage={formatMessage}
            />
          </div>
        </>
      )}

      <RosViewTabContextMenuPortal anchor={ctx} items={ctxItems} onRequestClose={() => setCtx(null)} />
    </div>
  );
};

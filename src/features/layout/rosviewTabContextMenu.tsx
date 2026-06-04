import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useIntl } from 'react-intl';
import type { DockviewApi, DockviewPanelApi } from 'dockview';
import { cn } from '@/shared/lib/utils';
import { getRosViewPortalRoot } from '@/shared/lib/rosviewPortal';
import { getPanelActions } from '../panels/framework';

export interface TabContextMenuItem {
  id: string;
  messageId?: string;
  onSelect: () => void;
  destructive?: boolean;
  disabled?: boolean;
}

export function buildRosViewTabContextMenuItems(options: {
  containerApi: DockviewApi;
  panelApi: DockviewPanelApi;
  welcomePanelId: string;
}): TabContextMenuItem[] {
  const { containerApi, panelApi, welcomePanelId } = options;
  const panel = containerApi.getPanel(panelApi.id);
  if (!panel) {
    return [];
  }

  const groupPanels = panel.group.panels;
  const closeTarget = (): void => {
    panel.api.close();
  };

  const closeAll = (): void => {
    for (const p of [...groupPanels]) {
      p.api.close();
    }
  };

  const items: TabContextMenuItem[] = [
    {
      id: 'close',
      messageId: 'layout.panelTab.context.close',
      onSelect: closeTarget,
      destructive: true,
    },
    {
      id: 'closeAll',
      messageId: 'layout.panelTab.context.closeAllInGroup',
      onSelect: closeAll,
      disabled: groupPanels.length === 0,
    },
  ];

  const actions = getPanelActions(panelApi.id);
  const isWelcome = panelApi.id === welcomePanelId;

  if (actions && !isWelcome) {
    items.push(
      { id: '__sep__', onSelect: () => {} },
      {
        id: 'reset',
        messageId: 'layout.panelTab.context.resetPanel',
        onSelect: actions.resetPanel,
      },
      {
        id: 'copy',
        messageId: 'layout.panelTab.context.copyPanelId',
        onSelect: actions.copyPanelId,
      },
      {
        id: 'dup',
        messageId: 'layout.panelTab.context.duplicatePanel',
        onSelect: actions.duplicatePanel,
      },
    );
  }

  return items;
}

export const RosViewTabContextMenuPortal: React.FC<{
  anchor: { x: number; y: number } | null;
  items: TabContextMenuItem[];
  onRequestClose: () => void;
}> = ({ anchor, items, onRequestClose }) => {
  const { formatMessage } = useIntl();

  useEffect(() => {
    if (!anchor) {
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      const root = getRosViewPortalRoot() ?? document.body;
      const target = event.target as Node | null;
      if (target && root.querySelector('[data-ros-tab-context-menu="1"]')?.contains(target)) {
        return;
      }
      onRequestClose();
    };
    const id = window.setTimeout(() => {
      window.addEventListener('pointerdown', onPointerDown, true);
    }, 0);
    return () => {
      window.clearTimeout(id);
      window.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [anchor, onRequestClose]);

  if (!anchor) {
    return null;
  }

  const root = getRosViewPortalRoot() ?? document.body;

  return createPortal(
    <div
      data-ros-tab-context-menu="1"
      className={cn(
        'fixed z-[200] min-w-[11rem] overflow-hidden rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-xl',
      )}
      style={{ left: anchor.x, top: anchor.y }}
      role="menu"
      onContextMenu={(event) => {
        event.preventDefault();
      }}
    >
      {items.map((item) =>
        item.id === '__sep__' ? (
          <div key={item.id} className="-mx-1 my-1 h-px bg-muted" role="separator" />
        ) : (
          <button
            key={item.id}
            type="button"
            role="menuitem"
            disabled={item.disabled}
            className={cn(
              'flex w-full cursor-default select-none items-center rounded-sm px-2 py-1.5 text-left text-sm outline-none',
              'hover:bg-accent hover:text-accent-foreground',
              'disabled:pointer-events-none disabled:opacity-50',
              item.destructive && 'text-destructive hover:text-destructive',
            )}
            onClick={() => {
              if (!item.disabled) {
                item.onSelect();
                onRequestClose();
              }
            }}
          >
            {item.messageId ? formatMessage({ id: item.messageId }) : null}
          </button>
        ),
      )}
    </div>,
    root,
  );
};

import React from 'react';
import type { MessageDescriptor } from 'react-intl';
import { ArrowDown, ArrowLeftRight, ArrowRight, Layers2 } from 'lucide-react';
import {
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@/shared/ui/dropdown-menu';
import type { PanelDefinition, PanelType } from '../panels/framework';
import { PANEL_TYPE_MESSAGE_SLUG } from '../panels/framework/panelMessageSlug';
import { PanelTypeIcon } from '../panels/framework/panelIcons';

/** Shared row style for tab header dropdown items with a leading icon. */
export const panelTabDropdownIconRowClass =
  'flex w-full cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none';

export interface PanelTabAddPanelDefinitionsSubmenusProps {
  definitions: PanelDefinition<unknown>[];
  formatMessage: (descriptor: MessageDescriptor) => string;
  onPlacement: (type: PanelType, placement: 'replace' | 'right' | 'below' | 'within') => void;
}

/** One DropdownMenuSub per panel type, each with replace / right / below / within items. */
export const PanelTabAddPanelDefinitionsSubmenus: React.FC<PanelTabAddPanelDefinitionsSubmenusProps> = ({
  definitions,
  formatMessage,
  onPlacement,
}) => (
  <>
    {definitions.map((def) => (
      <DropdownMenuSub key={def.type}>
        <DropdownMenuSubTrigger data-testid={`panel-tab-add-type-${def.type}`}>
          <PanelTypeIcon type={def.type} className="h-3.5 w-3.5 shrink-0 opacity-70 mr-1.5" />
          {formatMessage({
            id: `panels.${PANEL_TYPE_MESSAGE_SLUG[def.type]}.defaultTitle`,
            defaultMessage: def.defaultTitle,
          })}
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent>
          <DropdownMenuItem
            data-testid={`panel-tab-add-placement-replace-${def.type}`}
            className={panelTabDropdownIconRowClass}
            onSelect={() => onPlacement(def.type, 'replace')}
          >
            <ArrowLeftRight className="h-3.5 w-3.5 shrink-0 opacity-70" />
            {formatMessage({ id: 'layout.panelTab.addReplaceCurrent' })}
          </DropdownMenuItem>
          <DropdownMenuItem
            data-testid={`panel-tab-add-placement-right-${def.type}`}
            className={panelTabDropdownIconRowClass}
            onSelect={() => onPlacement(def.type, 'right')}
          >
            <ArrowRight className="h-3.5 w-3.5 shrink-0 opacity-70" />
            {formatMessage({ id: 'layout.panelTab.addToRight' })}
          </DropdownMenuItem>
          <DropdownMenuItem
            data-testid={`panel-tab-add-placement-below-${def.type}`}
            className={panelTabDropdownIconRowClass}
            onSelect={() => onPlacement(def.type, 'below')}
          >
            <ArrowDown className="h-3.5 w-3.5 shrink-0 opacity-70" />
            {formatMessage({ id: 'layout.panelTab.addToBelow' })}
          </DropdownMenuItem>
          <DropdownMenuItem
            data-testid={`panel-tab-add-placement-within-${def.type}`}
            className={panelTabDropdownIconRowClass}
            onSelect={() => onPlacement(def.type, 'within')}
          >
            <Layers2 className="h-3.5 w-3.5 shrink-0 opacity-70" />
            {formatMessage({ id: 'layout.panelTab.addToGroup' })}
          </DropdownMenuItem>
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    ))}
  </>
);

import React, { useCallback, useMemo } from 'react';
import { useIntl } from 'react-intl';
import { getAddablePanelDefinitions } from '../panels/registry';
import { PanelTypeIcon } from '../panels/framework/panelIcons';
import { PANEL_TYPE_MESSAGE_SLUG } from '../panels/framework/panelMessageSlug';
import type { PanelType } from '../panels/framework/types';
import { openDockviewPanel } from './dockviewController';
import { getDockviewApi } from './dockviewGlobalApi';

/** Message id for the one-line blurb on each panel card (`layout.welcomePanel.desc.*`). */
const PANEL_DESCRIPTION_IDS: Partial<Record<PanelType, string>> = {
  Image: 'layout.welcomePanel.desc.Image',
  Plot: 'layout.welcomePanel.desc.Plot',
  JointStatePlot: 'layout.welcomePanel.desc.JointStatePlot',
  '3D': 'layout.welcomePanel.desc.3D',
  Audio: 'layout.welcomePanel.desc.Audio',
  Pose: 'layout.welcomePanel.desc.Pose',
  RawMessages: 'layout.welcomePanel.desc.RawMessages',
  Timeline: 'layout.welcomePanel.desc.Timeline',
  TopicGraph: 'layout.welcomePanel.desc.TopicGraph',
  Align: 'layout.welcomePanel.desc.Align',
};

interface WelcomePanelContentProps {
  welcomePanelId: string;
}

export const WelcomePanelContent: React.FC<WelcomePanelContentProps> = ({ welcomePanelId }) => {
  const { formatMessage } = useIntl();
  const definitions = useMemo(
    () => getAddablePanelDefinitions(),
    [],
  );

  const handleSelect = useCallback((type: PanelType) => {
    openDockviewPanel({
      type,
      position: { referencePanel: welcomePanelId, direction: 'within' },
    });
    // Wait one event-loop tick so dockview can register the new panel in the
    // same tab group before we close the Welcome placeholder.
    setTimeout(() => {
      getDockviewApi()?.getPanel(welcomePanelId)?.api.close();
    }, 0);
  }, [welcomePanelId]);

  return (
    <div className="flex h-full w-full flex-col overflow-y-auto bg-background">
      <div className="mx-auto w-full max-w-2xl px-6 py-8">
        <h2 className="mb-1 text-base font-semibold text-foreground">
          {formatMessage({ id: 'layout.welcomePanel.title' })}
        </h2>
        <p className="mb-6 text-xs text-muted-foreground">{formatMessage({ id: 'layout.welcomePanel.hint' })}</p>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {definitions.map((def) => {
            const descId = PANEL_DESCRIPTION_IDS[def.type];
            const description = descId ? formatMessage({ id: descId }) : '';
            return (
              <button
                key={def.type}
                type="button"
                onClick={() => handleSelect(def.type)}
                className="group flex flex-col items-start gap-2 rounded-lg border border-border bg-card p-4 text-left transition-colors hover:border-primary/50 hover:bg-accent focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring/40"
              >
                <div className="flex h-9 w-9 items-center justify-center rounded-md border border-border bg-muted text-muted-foreground transition-colors group-hover:border-primary/40 group-hover:text-primary">
                  <PanelTypeIcon type={def.type} className="h-5 w-5" />
                </div>
                <div className="min-w-0">
                  <div className="text-sm font-medium text-foreground">
                    {formatMessage({
                      id: `panels.${PANEL_TYPE_MESSAGE_SLUG[def.type]}.defaultTitle`,
                      defaultMessage: def.defaultTitle,
                    })}
                  </div>
                  {description ? (
                    <div className="mt-0.5 text-[11px] leading-snug text-muted-foreground line-clamp-2">
                      {description}
                    </div>
                  ) : null}
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
};

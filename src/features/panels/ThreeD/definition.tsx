import { lazy } from 'react';
import type { PanelDefinition } from '../framework/types';
import { PanelSuspense } from '../framework/panelSuspense';
import { defaultThreeDConfig, type ThreeDConfig } from './defaults';
import { parseThreeDConfig } from './schema';
import { ThreeDPanelSettings } from './ThreeDPanelSettings';

const ThreeDPanel = lazy(async () => {
  const m = await import('./ThreeDPanel');
  return { default: m.ThreeDPanel };
});

export const threeDPanelDefinition: PanelDefinition<ThreeDConfig> = {
  type: '3D',
  defaultTitle: '3D View',
  autoLayoutHints: {
    alwaysInclude: true,
  },
  createDefaultConfig: defaultThreeDConfig,
  configSchema: { version: 3, parse: parseThreeDConfig },
  render: ({ player, panelId, config }) => (
    <PanelSuspense>
      <ThreeDPanel
        player={player}
        panelId={panelId}
        showGrid={config.showGrid}
        showAxes={config.showAxes}
        showPlaceholder={config.showPlaceholder}
        pointSize={config.pointSize}
        followFrame={config.followFrame}
        skeleton={config.skeleton}
        urdf={config.urdf}
        topicSettings={config.topicSettings}
      />
    </PanelSuspense>
  ),
  renderSettings: (ctx) => <ThreeDPanelSettings {...ctx} />,
};

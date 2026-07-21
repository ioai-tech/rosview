import { lazy } from 'react';
import type { PanelDefinition } from '../framework/types';
import { PanelSuspense } from '../framework/panelSuspense';
import { defaultImageConfig, type ImageConfig } from './defaults';
import { parseImageConfig } from './schema';
import {
  ROS_MSG_FOXGLOVE_COMPRESSED_VIDEO,
  ROS_MSG_SENSOR_COMPRESSED_IMAGE,
  ROS_MSG_SENSOR_IMAGE,
} from '@/shared/ros/rosMessageTypes';
import { ImagePanelSettings } from './ImagePanelSettings';

const ImagePanel = lazy(async () => {
  const m = await import('./ImagePanel');
  return { default: m.ImagePanel };
});

export const imagePanelDefinition: PanelDefinition<ImageConfig> = {
  type: 'Image',
  defaultTitle: 'Image',
  schemaSupport: {
    supportedSchemas: [
      ROS_MSG_SENSOR_IMAGE,
      ROS_MSG_SENSOR_COMPRESSED_IMAGE,
      ROS_MSG_FOXGLOVE_COMPRESSED_VIDEO,
    ],
  },
  createDefaultConfig: defaultImageConfig,
  configSchema: { version: 6, parse: parseImageConfig },
  render: ({ player, panelId, config, setConfig }) => (
    <PanelSuspense>
      <ImagePanel player={player} panelId={panelId} {...config} setConfig={setConfig} />
    </PanelSuspense>
  ),
  renderSettings: (ctx) => <ImagePanelSettings {...ctx} />,
};

import type { PanelType } from './types';

/**
 * Second segment of `panels.<slug>.*` message ids. Slugs are camelCase folder
 * names; see `loadRosViewMessages` / CONTRIBUTING for the full naming scheme.
 */
export const PANEL_TYPE_MESSAGE_SLUG: Record<PanelType, string> = {
  RawMessages: 'rawMessages',
  Image: 'image',
  '3D': 'threeD',
  Pose: 'pose',
  JointStatePlot: 'jointStatePlot',
  Timeline: 'timeline',
  TopicGraph: 'topicGraph',
  Align: 'align',
  Audio: 'audio',
  UrdfDebug: 'urdfDebug',
  Unavailable: 'unavailable',
};

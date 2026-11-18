/**
 * Where the URDF document comes from. Aligned with Foxglove's `foxglove.Urdf`
 * layer for interop:
 * - `topic`: subscribe to a ROS topic carrying a string URDF (e.g. `/robot_description`).
 *   An empty `topic` means "auto-detect the first topic whose name contains
 *   `robot_description`" and matches legacy behaviour.
 * - `url`: download a URDF file via `fetch` (supports `http(s)://` and any
 *   `package://` prefix resolved by the app).
 * - `file`: inline XML content uploaded via the settings UI.
 */
export type UrdfSourceType = 'topic' | 'url' | 'file';

export interface UrdfSource {
  sourceType: UrdfSourceType;
  topic: string;
  url: string;
  fileContent: string;
}

export interface ThreeDConfig {
  showGrid: boolean;
  showAxes: boolean;
  showPlaceholder: boolean;
  pointSize: number;
  /** TF frame the orbit camera follows during playback (empty: a fixed camera). */
  followFrame: string;
  skeleton: ThreeDSkeletonConfig;
  urdf: UrdfSource;
  topicSettings: ThreeDTopicSetting[];
}

export interface ThreeDSkeletonConfig {
  enabled: boolean;
  /** Draw BVH as plain lines or box-link stickman primitives. */
  renderMode: 'line' | 'stick';
  /** BVH source is commonly centimeters; default converts to meters. */
  scale: number;
  /** Convert from BVH Y-up to scene Z-up. */
  yUpToZUp: boolean;
  /** Keep right-handed orientation by flipping resulting Y axis. */
  flipY: boolean;
  color: string;
}

export type ThreeDTopicRenderMode =
  | 'auto'
  | 'path'
  | 'pose'
  | 'marker'
  | 'laserScan'
  | 'depth'
  | 'skeleton';

export interface ThreeDTopicSetting {
  topic: string;
  enabled: boolean;
  renderMode: ThreeDTopicRenderMode;
  color: string;
}

export const defaultUrdfSource = (): UrdfSource => ({
  sourceType: 'topic',
  topic: '',
  url: '',
  fileContent: '',
});

export const defaultThreeDConfig = (): ThreeDConfig => ({
  showGrid: true,
  showAxes: false,
  showPlaceholder: true,
  pointSize: 0.05,
  followFrame: '',
  skeleton: {
    enabled: true,
    renderMode: 'stick',
    scale: 0.01,
    yUpToZUp: true,
    flipY: true,
    color: '#22c55e',
  },
  urdf: defaultUrdfSource(),
  topicSettings: [],
});

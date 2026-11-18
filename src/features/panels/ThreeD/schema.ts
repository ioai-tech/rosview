import { isRecord } from '../framework/types';
import {
  defaultThreeDConfig,
  defaultUrdfSource,
  type ThreeDConfig,
  type ThreeDSkeletonConfig,
  type ThreeDTopicRenderMode,
  type ThreeDTopicSetting,
  type UrdfSource,
  type UrdfSourceType,
} from './defaults';

const URDF_SOURCE_TYPES: readonly UrdfSourceType[] = ['topic', 'url', 'file'];
const RENDER_MODES: readonly ThreeDTopicRenderMode[] = [
  'auto',
  'path',
  'pose',
  'marker',
  'laserScan',
  'depth',
  'skeleton',
];

function parseSkeletonConfig(input: unknown): ThreeDSkeletonConfig {
  const base = defaultThreeDConfig().skeleton;
  if (!isRecord(input)) return base;
  return {
    enabled: typeof input.enabled === 'boolean' ? input.enabled : base.enabled,
    renderMode: input.renderMode === 'line' || input.renderMode === 'stick' ? input.renderMode : base.renderMode,
    scale:
      typeof input.scale === 'number' && Number.isFinite(input.scale)
        ? Math.max(0.0001, Math.min(10, input.scale))
        : base.scale,
    yUpToZUp: typeof input.yUpToZUp === 'boolean' ? input.yUpToZUp : base.yUpToZUp,
    flipY: typeof input.flipY === 'boolean' ? input.flipY : base.flipY,
    color: typeof input.color === 'string' && input.color.length > 0 ? input.color : base.color,
  };
}

function parseUrdfSource(input: unknown): UrdfSource {
  const base = defaultUrdfSource();
  if (!isRecord(input)) return base;
  const raw = input.sourceType;
  // Legacy `parameter` / Foxglove `param` → treat as topic; prefer explicit topic then parameter name.
  let sourceType: UrdfSourceType = base.sourceType;
  if (raw === 'parameter' || raw === 'param') {
    sourceType = 'topic';
  } else if (URDF_SOURCE_TYPES.includes(raw as UrdfSourceType)) {
    sourceType = raw as UrdfSourceType;
  }
  const topicFromLegacyParam =
    raw === 'parameter' || raw === 'param'
      ? typeof input.parameter === 'string' && input.parameter.length > 0
        ? input.parameter
        : typeof input.topic === 'string'
          ? input.topic
          : base.topic
      : typeof input.topic === 'string'
        ? input.topic
        : base.topic;
  return {
    sourceType,
    topic: topicFromLegacyParam,
    url: typeof input.url === 'string' ? input.url : base.url,
    fileContent: typeof input.fileContent === 'string' ? input.fileContent : base.fileContent,
  };
}

function parseTopicSettings(input: unknown): ThreeDTopicSetting[] {
  if (!Array.isArray(input)) return [];
  return input
    .filter(isRecord)
    .map((entry): ThreeDTopicSetting | null => {
      const topic = typeof entry.topic === 'string' ? entry.topic : '';
      if (!topic) return null;
      let rawMode = entry.renderMode;
      if (rawMode === 'pointCloud') {
        rawMode = 'auto';
      }
      const renderMode = RENDER_MODES.includes(rawMode as ThreeDTopicRenderMode)
        ? (rawMode as ThreeDTopicRenderMode)
        : 'auto';
      return {
        topic,
        enabled: typeof entry.enabled === 'boolean' ? entry.enabled : true,
        renderMode,
        color: typeof entry.color === 'string' && entry.color.length > 0 ? entry.color : '#38bdf8',
      };
    })
    .filter((entry): entry is ThreeDTopicSetting => entry != null);
}

export function parseThreeDConfig(input: unknown): ThreeDConfig {
  const base = defaultThreeDConfig();
  if (!isRecord(input)) return base;
  const pointSize =
    typeof input.pointSize === 'number' && Number.isFinite(input.pointSize)
      ? Math.max(0.002, Math.min(0.2, input.pointSize))
      : base.pointSize;
  return {
    showGrid: typeof input.showGrid === 'boolean' ? input.showGrid : base.showGrid,
    showAxes: typeof input.showAxes === 'boolean' ? input.showAxes : base.showAxes,
    showPlaceholder:
      typeof input.showPlaceholder === 'boolean' ? input.showPlaceholder : base.showPlaceholder,
    pointSize,
    followFrame: typeof input.followFrame === 'string' ? input.followFrame.trim() : base.followFrame,
    skeleton: parseSkeletonConfig(input.skeleton),
    urdf: parseUrdfSource(input.urdf),
    topicSettings: parseTopicSettings(input.topicSettings),
  };
}

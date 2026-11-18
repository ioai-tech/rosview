import type { DockviewApi } from 'dockview';
import type { SerializedDockview } from 'dockview-core';
import type { TopicInfo } from '@/core/types/ros';
import type { FoxgloveConfig } from '@/features/panels/framework';
import { FOXGLOVE_PANEL_TITLE_KEY } from '@/features/panels/framework';
import {
  createPanelInstanceId,
  markPanelInstanceId,
  getPanelTypeFromId,
  replacePanelConfigs,
  replacePanelStates,
} from '@/features/panels/framework';
import {
  importFoxgloveLayout,
  restoreTabGroups,
  type FoxgloveLayoutData,
  type FoxgloveMosaicNode,
} from '@/core/preferences/foxgloveLayout';
import { planImageGrid } from '@/features/layout/autoLayout/imageGrid';
import { selectImageTopicsForAutoLayout } from '@/features/layout/autoLayout/imageTopicSelection';
import { heuristicAudioInfoTopics } from '@/features/panels/Audio/core/resolveAudioInfo';
import { getPanelDefinition } from '@/features/panels/registry';
import { isAudioCommonInfoSchema, isJointStateSchema, isRawAudioSchema, normalizeRosSchemaName } from '@/shared/ros/rosMessageTypes';
import { pickDefaultRawMessagesTopic } from '@/features/layout/autoLayout/pickDefaultRawMessagesTopic';
import { lookupPlotSchema } from '@/features/panels/Plot/schemaRegistry/plotSchemaRegistry';
import { detectPlotSeriesForTopic } from '@/features/panels/Plot/plotTopicService';
import { buildJointStateCombinedPath } from '@/features/panels/Plot/jointStatePaths';
import { createPlotSeries, paletteColor, type PlotConfig } from '@/features/panels/Plot/defaults';
import { defaultPlotConfig } from '@/features/panels/Plot/defaults';
import { measuredTopicRank } from '@/shared/ros/rosMessageTypes';
import { isWebGLAvailable } from '@/shared/utils/webglSupport';

function imageTabTitle(topic: string): string {
  const parts = topic.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? 'Image';
}

/**
 * Mosaic defaults `splitPercentage` to 50; with 3+ siblings and no ratios, the first child
 * takes half and the rest share the other half. Recursively split n children as 1 : (n−1)
 * with top split 100/n so each leaf gets 1/n along the main axis.
 *
 * @see mosaicToDockviewGrid — `computeSizes(node.splitPercentage ?? 50)`
 */
function stackEqualMosaic(direction: 'row' | 'column', nodes: FoxgloveMosaicNode[]): FoxgloveMosaicNode {
  if (nodes.length === 0) {
    throw new Error('stackEqualMosaic: empty nodes');
  }
  if (nodes.length === 1) {
    return nodes[0];
  }
  if (nodes.length === 2) {
    return { direction, first: nodes[0], second: nodes[1] };
  }
  const n = nodes.length;
  return {
    direction,
    first: nodes[0],
    second: stackEqualMosaic(direction, nodes.slice(1)),
    splitPercentage: 100 / n,
  };
}

function rowMosaicFromPanelIds(ids: string[]): FoxgloveMosaicNode | undefined {
  if (ids.length === 0) return undefined;
  return stackEqualMosaic(
    'row',
    ids.map((id) => id as unknown as FoxgloveMosaicNode),
  );
}

function audioTabTitle(topic: string): string {
  const parts = topic.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? 'Audio';
}

function audioTopicPriorityScore(topicName: string): number {
  const n = topicName.toLowerCase();
  let s = 0;
  if (n.includes('rawaudio') || n.includes('foxglove')) s += 60;
  if (n.includes('mic') || n.includes('audio')) s += 40;
  if (n.includes('/io/')) s += 5;
  return s;
}

function appendAudioPanelsForTopics(
  topicNames: string[],
  topics: ReadonlyArray<TopicInfo>,
  configById: Record<string, FoxgloveConfig>,
): string[] {
  const ids: string[] = [];
  for (const topic of topicNames) {
    if (!topic) continue;
    const id = createPanelInstanceId('Audio');
    ids.push(id);
    const meta = topics.find((t) => t.name === topic);
    const isRaw = meta?.type ? isRawAudioSchema(meta.type) : false;
    let audioInfoTopic = '';
    if (!isRaw) {
      for (const h of heuristicAudioInfoTopics(topic)) {
        if (topics.some((t) => t.name === h && isAudioCommonInfoSchema(t.type))) {
          audioInfoTopic = h;
          break;
        }
      }
    }
    configById[id] = {
      topic,
      ...(audioInfoTopic ? { audioInfoTopic } : {}),
      [FOXGLOVE_PANEL_TITLE_KEY]: audioTabTitle(topic),
    };
  }
  return ids;
}

/** Single synthetic topic from `.bvh` sources — auto-layout should not add RawMessages just to branch the dock root. */
function isBvhOnlyDataset(topics: ReadonlyArray<TopicInfo>): boolean {
  return (
    topics.length === 1 &&
    typeof topics[0]?.type === 'string' &&
    topics[0].type.includes('BvhSkeletonFrame')
  );
}

function appendFallbackRawMessagesPanel(
  topics: ReadonlyArray<TopicInfo>,
  configById: Record<string, FoxgloveConfig>,
  options?: { excludeTopics?: ReadonlySet<string> },
): string {
  const id = createPanelInstanceId('RawMessages');
  const defaultTopic = pickDefaultRawMessagesTopic(topics, options);
  configById[id] = {
    ...(defaultTopic ? { topic: defaultTopic } : {}),
    [FOXGLOVE_PANEL_TITLE_KEY]: 'Raw Messages',
  };
  return id;
}

function appendImagePanelsForRow(
  row: (string | null)[],
  configById: Record<string, FoxgloveConfig>,
): string[] {
  const ids: string[] = [];
  for (const topic of row) {
    if (topic == null || topic.length === 0) continue;
    const id = createPanelInstanceId('Image');
    ids.push(id);
    configById[id] = {
      topic,
      [FOXGLOVE_PANEL_TITLE_KEY]: imageTabTitle(topic),
    };
  }
  return ids;
}

const DEFAULT_POSE_TOPIC_COLORS = [
  '#38bdf8',
  '#f97316',
  '#22c55e',
  '#e879f9',
  '#f43f5e',
  '#facc15',
] as const;

function indexTopicsByNormalizedSchema(topics: ReadonlyArray<TopicInfo>): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const topic of topics) {
    const key = normalizeRosSchemaName(topic.type);
    const prev = index.get(key);
    if (prev) {
      prev.push(topic.name);
    } else {
      index.set(key, [topic.name]);
    }
  }
  return index;
}

function collectTopicsForPanelSchemas(
  topics: ReadonlyArray<TopicInfo>,
  panelType: 'Pose' | 'Image' | 'Audio',
): string[] {
  const definition = getPanelDefinition(panelType);
  const supportedSchemas = definition.schemaSupport?.supportedSchemas ?? [];
  if (supportedSchemas.length === 0) {
    return [];
  }
  const indexed = indexTopicsByNormalizedSchema(topics);
  const selected = new Set<string>();
  for (const schema of supportedSchemas) {
    const matchedTopics = indexed.get(normalizeRosSchemaName(schema));
    if (!matchedTopics) continue;
    for (const topicName of matchedTopics) {
      selected.add(topicName);
    }
  }
  return [...selected].sort((a, b) => a.localeCompare(b));
}

export interface BuildDefaultRosLayoutOptions {
  publishersByTopic?: ReadonlyMap<string, ReadonlySet<string>>;
  /** Whether a 3D panel can render here. Defaults to detecting WebGL in the current browser. */
  webgl?: boolean;
}

const MAX_JOINT_STATE_PLOTS = 4;
const MAX_IMU_PLOTS = 2;
const PLOTS_PER_ROW = 3;
/** Share of the column height given to the Raw Messages strip under other panels. */
const RAW_STRIP_PERCENT = 14;

function isTransformTopicType(type: string): boolean {
  const normalized = type.trim().toLowerCase();
  return (
    normalized.includes('tfmessage') ||
    normalized.includes('tf2_msgs') ||
    normalized.includes('tf/tfmessage') ||
    normalized.includes('/transform')
  );
}

/**
 * Robot low-level state (per-motor q/dq/τ + IMU) is the densest signal in a teleop
 * recording; give it a Plot. The Plot panel auto-picks it via schema priority.
 */
function hasRobotLowLevelState(topics: ReadonlyArray<TopicInfo>): boolean {
  return topics.some((topic) => lookupPlotSchema(topic.type)?.adapterId === 'lowState');
}

/**
 * 3D needs something to draw: TF or pose topics (or a BVH skeleton), and WebGL. Joint states
 * alone give an empty grid without a robot model, so they get Plots instead.
 */
function shouldIncludeThreeDPanel(
  topics: ReadonlyArray<TopicInfo>,
  hasPoseTopics: boolean,
  webgl: boolean,
): boolean {
  if (!webgl) return false;
  if (isBvhOnlyDataset(topics)) return true;
  return hasPoseTopics || topics.some((topic) => isTransformTopicType(topic.type));
}

function isImuSchema(type: string): boolean {
  return normalizeRosSchemaName(type) === 'sensor_msgs/imu';
}

function plotTabTitle(topic: string): string {
  const parts = topic.split('/').filter(Boolean);
  return parts.slice(-2).join('/') || topic;
}

/** One Plot per JointState topic (`position[:]`, measured streams first) and per Imu topic. */
function appendSensorPlots(
  topics: ReadonlyArray<TopicInfo>,
  configById: Record<string, FoxgloveConfig>,
): string[] {
  const ids: string[] = [];
  const jointTopics = topics
    .filter((topic) => isJointStateSchema(topic.type))
    .sort((a, b) => measuredTopicRank(a.name) - measuredTopicRank(b.name) || a.name.localeCompare(b.name))
    .slice(0, MAX_JOINT_STATE_PLOTS);
  for (const topic of jointTopics) {
    const detected = detectPlotSeriesForTopic({
      topic: topic.name,
      schemaName: topic.type,
      jointStateFields: ['position'],
    });
    const series = detected.series.map((entry) => ({
      ...entry,
      path: entry.path || buildJointStateCombinedPath(['position']),
      label: entry.label || 'position',
    }));
    const config: PlotConfig = { ...defaultPlotConfig(), series };
    const id = createPanelInstanceId('Plot');
    configById[id] = { ...config, [FOXGLOVE_PANEL_TITLE_KEY]: plotTabTitle(topic.name) };
    ids.push(id);
  }
  const imuTopics = topics.filter((topic) => isImuSchema(topic.type)).slice(0, MAX_IMU_PLOTS);
  for (const topic of imuTopics) {
    const paths = ['angular_velocity.x', 'angular_velocity.y', 'angular_velocity.z', 'linear_acceleration.x', 'linear_acceleration.y', 'linear_acceleration.z'];
    const series = paths.map((path, index) =>
      createPlotSeries({ id: `series-${index + 1}`, topic: topic.name, path, label: path, color: paletteColor(index) }),
    );
    const id = createPanelInstanceId('Plot');
    configById[id] = { ...defaultPlotConfig(), series, [FOXGLOVE_PANEL_TITLE_KEY]: plotTabTitle(topic.name) };
    ids.push(id);
  }
  return ids;
}

function isHdf5Dataset(
  topics: ReadonlyArray<TopicInfo>,
  publishersByTopic?: ReadonlyMap<string, ReadonlySet<string>>,
): boolean {
  if (!publishersByTopic || topics.length === 0 || isBvhOnlyDataset(topics)) {
    return false;
  }
  for (const topic of topics) {
    const publishers = publishersByTopic.get(topic.name);
    if (!publishers || publishers.size !== 1 || !publishers.has('hdf5')) {
      return false;
    }
  }
  return true;
}

function hasRawPanel(configById: Record<string, FoxgloveConfig>): boolean {
  return Object.keys(configById).some((id) => getPanelTypeFromId(id) === 'RawMessages');
}

export function buildDefaultRosFoxgloveLayoutData(
  topics: ReadonlyArray<TopicInfo>,
  options?: BuildDefaultRosLayoutOptions,
): FoxgloveLayoutData {
  const configById: Record<string, FoxgloveConfig> = {};
  const hdf5Dataset = isHdf5Dataset(topics, options?.publishersByTopic);

  const stackParts: FoxgloveMosaicNode[] = [];
  const usedImageTopics = new Set<string>();

  const pickedImageTopics = selectImageTopicsForAutoLayout(topics);
  for (const row of planImageGrid(pickedImageTopics)) {
    const imageIds = appendImagePanelsForRow(row, configById);
    for (const topic of row) {
      usedImageTopics.add(topic);
    }
    const mosaic = rowMosaicFromPanelIds(imageIds);
    if (mosaic) stackParts.push(mosaic);
  }

  const audioTopicCandidates = collectTopicsForPanelSchemas(topics, 'Audio')
    .sort((a, b) => audioTopicPriorityScore(b) - audioTopicPriorityScore(a) || a.localeCompare(b))
    .slice(0, 4);
  const audioMosaic = rowMosaicFromPanelIds(appendAudioPanelsForTopics(audioTopicCandidates, topics, configById));
  if (audioMosaic) stackParts.push(audioMosaic);

  if (hdf5Dataset) {
    const rawId = appendFallbackRawMessagesPanel(topics, configById, {
      excludeTopics: usedImageTopics,
    });
    stackParts.push(rawId);
  } else {
    const poseTopics = collectTopicsForPanelSchemas(topics, 'Pose');
    const includeThreeD = shouldIncludeThreeDPanel(topics, poseTopics.length > 0, options?.webgl ?? isWebGLAvailable());
    const motionPanels: string[] = [];

    if (poseTopics.length > 0) {
      const poseId = createPanelInstanceId('Pose');
      configById[poseId] = {
        topics: poseTopics.map((topic, index) => ({
          topic,
          color: DEFAULT_POSE_TOPIC_COLORS[index % DEFAULT_POSE_TOPIC_COLORS.length],
          enabled: true,
        })),
      };
      motionPanels.push(poseId);
    }
    if (includeThreeD) {
      const threeDId = createPanelInstanceId('3D');
      configById[threeDId] = {};
      motionPanels.push(threeDId);
    }
    if (hasRobotLowLevelState(topics)) {
      const plotId = createPanelInstanceId('Plot');
      configById[plotId] = {};
      motionPanels.push(plotId);
    }
    motionPanels.push(...appendSensorPlots(topics, configById));
    for (let at = 0; at < motionPanels.length; at += PLOTS_PER_ROW) {
      const motionMosaic = rowMosaicFromPanelIds(motionPanels.slice(at, at + PLOTS_PER_ROW));
      if (motionMosaic) stackParts.push(motionMosaic);
    }
  }

  if (stackParts.length === 0 && !hdf5Dataset) {
    const rawId = appendFallbackRawMessagesPanel(topics, configById);
    stackParts.push(rawId);
  }

  let layout = stackEqualMosaic('column', stackParts);
  if (stackParts.length > 0 && !isBvhOnlyDataset(topics) && !hdf5Dataset && !hasRawPanel(configById)) {
    // Raw Messages stays available as a thin strip under the data panels, collapsed by default.
    const rawId = appendFallbackRawMessagesPanel(topics, configById, { excludeTopics: usedImageTopics });
    layout = { direction: 'column', first: layout, second: rawId, splitPercentage: 100 - RAW_STRIP_PERCENT };
  }

  return {
    layout,
    configById,
    globalVariables: {},
    userNodes: {},
  };
}

export function applyDefaultRosDockLayoutFromImport(
  api: DockviewApi,
  topics: ReadonlyArray<TopicInfo>,
  options?: BuildDefaultRosLayoutOptions,
): void {
  const data = buildDefaultRosFoxgloveLayoutData(topics, options);
  const result = importFoxgloveLayout(data, { unavailableComponent: 'Unavailable' });

  replacePanelStates(result.panelStates);
  const nextConfigs: Record<string, unknown> = {};
  for (const [panelId, snapshot] of Object.entries(result.panelStates)) {
    nextConfigs[panelId] = snapshot.config;
    markPanelInstanceId(panelId);
  }
  replacePanelConfigs(nextConfigs);

  if (result.dockviewState) {
    api.fromJSON(result.dockviewState as unknown as SerializedDockview, { reuseExistingPanels: false });
    restoreTabGroups(api, result.tabGroups);
  }
}

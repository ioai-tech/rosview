import type { DockviewApi } from 'dockview';
import type { SerializedDockview } from 'dockview-core';
import type { TopicInfo } from '@/core/types/ros';
import type { FoxgloveConfig } from '@/features/panels/framework';
import { FOXGLOVE_PANEL_TITLE_KEY } from '@/features/panels/framework';
import {
  createPanelInstanceId,
  markPanelInstanceId,
  replacePanelConfigs,
  replacePanelStates,
} from '@/features/panels/framework';
import {
  importFoxgloveLayout,
  restoreTabGroups,
  type FoxgloveLayoutData,
  type FoxgloveMosaicNode,
} from '@/core/preferences/foxgloveLayout';
import { planColorDepthCameraRows, isDepthImageTopicName } from '@/features/layout/autoLayout/planRosImageGrid';
import { buildImageRows } from '@/features/layout/autoLayout/buildImageRows';
import { selectImageTopicsForAutoLayout } from '@/features/layout/autoLayout/imageTopicSelection';
import { heuristicAudioInfoTopics } from '@/features/panels/Audio/core/resolveAudioInfo';
import { getPanelDefinition } from '@/features/panels/registry';
import { isAudioCommonInfoSchema, isJointStateSchema, isRawAudioSchema, isRosImageSchema, normalizeRosSchemaName } from '@/shared/ros/rosMessageTypes';
import { pickDefaultRawMessagesTopic } from '@/features/layout/autoLayout/pickDefaultRawMessagesTopic';
import { isSceneUpdateSchema } from '@/features/panels/Image/core/sceneMesh';

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
  meshTopic?: string,
): string[] {
  const ids: string[] = [];
  for (const topic of row) {
    if (topic == null || topic.length === 0) continue;
    const id = createPanelInstanceId('Image');
    ids.push(id);
    configById[id] = {
      topic,
      ...(meshTopic ? { meshTopic, meshVisible: true } : {}),
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
}

function isTransformTopicType(type: string): boolean {
  const normalized = type.trim().toLowerCase();
  return (
    normalized.includes('tfmessage') ||
    normalized.includes('tf2_msgs') ||
    normalized.includes('tf/tfmessage') ||
    normalized.includes('/transform')
  );
}

/** 3D is useful when the bag carries robot motion / TF — not for pure camera feeds. */
function shouldIncludeThreeDPanel(topics: ReadonlyArray<TopicInfo>): boolean {
  if (isBvhOnlyDataset(topics)) {
    return true;
  }
  return topics.some((topic) => isJointStateSchema(topic.type) || isTransformTopicType(topic.type));
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

export function buildDefaultRosFoxgloveLayoutData(
  topics: ReadonlyArray<TopicInfo>,
  options?: BuildDefaultRosLayoutOptions,
): FoxgloveLayoutData {
  const configById: Record<string, FoxgloveConfig> = {};
  const hdf5Dataset = isHdf5Dataset(topics, options?.publishersByTopic);

  const stackParts: FoxgloveMosaicNode[] = [];
  const usedImageTopics = new Set<string>();
  const sceneMeshTopics = topics.filter((topic) => isSceneUpdateSchema(topic.type));
  const meshTopic = sceneMeshTopics.length === 1 ? sceneMeshTopics[0]?.name : undefined;

  const pickedImageTopics = selectImageTopicsForAutoLayout(topics);
  const hasDepthImageStreams = topics.some(
    (topic) => isRosImageSchema(topic.type) && isDepthImageTopicName(topic.name),
  );

  if (hasDepthImageStreams) {
    const { colorRow, depthRow } = planColorDepthCameraRows(topics);
    const colorImageIds = appendImagePanelsForRow(colorRow, configById, meshTopic);
    const depthImageIds = appendImagePanelsForRow(depthRow, configById, meshTopic);
    for (const topic of colorRow) {
      if (topic) usedImageTopics.add(topic);
    }
    for (const topic of depthRow) {
      if (topic) usedImageTopics.add(topic);
    }
    const colorMosaic = rowMosaicFromPanelIds(colorImageIds);
    const depthMosaic = rowMosaicFromPanelIds(depthImageIds);
    if (colorMosaic) stackParts.push(colorMosaic);
    if (depthMosaic) stackParts.push(depthMosaic);
  } else if (pickedImageTopics.length > 0) {
    for (const row of buildImageRows(pickedImageTopics)) {
      const imageIds = appendImagePanelsForRow(row, configById, meshTopic);
      for (const topic of row) {
        usedImageTopics.add(topic);
      }
      const mosaic = rowMosaicFromPanelIds(imageIds);
      if (mosaic) stackParts.push(mosaic);
    }
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
    const includeThreeD = shouldIncludeThreeDPanel(topics);

    if (poseTopics.length > 0) {
      const poseId = createPanelInstanceId('Pose');
      configById[poseId] = {
        topics: poseTopics.map((topic, index) => ({
          topic,
          color: DEFAULT_POSE_TOPIC_COLORS[index % DEFAULT_POSE_TOPIC_COLORS.length],
          enabled: true,
        })),
      };
      if (includeThreeD) {
        const threeDId = createPanelInstanceId('3D');
        configById[threeDId] = {};
        stackParts.push({
          direction: 'row',
          first: poseId,
          second: threeDId,
        });
      } else {
        stackParts.push(poseId);
      }
    } else if (includeThreeD) {
      const threeDId = createPanelInstanceId('3D');
      configById[threeDId] = {};
      stackParts.push(threeDId);
    }
  }

  if (stackParts.length === 0 && !isBvhOnlyDataset(topics) && !hdf5Dataset) {
    const rawId = appendFallbackRawMessagesPanel(topics, configById);
    stackParts.push(rawId);
  } else if (stackParts.length === 1 && !isBvhOnlyDataset(topics) && !hdf5Dataset) {
    const rawId = appendFallbackRawMessagesPanel(topics, configById);
    stackParts.push(rawId);
  }

  const layout = stackEqualMosaic('column', stackParts);

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

import type { PanelDefinition, PanelType } from '../framework/types';
import type { PanelFoxgloveAdapter } from '../framework/foxgloveAdapter';
import { imagePanelDefinition } from '../Image';
import { canvasFoxgloveAdapter, imageFoxgloveAdapter } from '../Image/foxgloveAdapter';
import {
  jointStatePlotDefinition,
  jointStatePlotFoxgloveAdapter,
  legacyPlotFoxgloveAdapter,
  legacyJointsFoxgloveAdapter,
} from '../JointStatePlot';
import { rawMessagesPanelDefinition } from '../RawMessages';
import { rawMessagesFoxgloveAdapter } from '../RawMessages/foxgloveAdapter';
import { threeDPanelDefinition } from '../ThreeD';
import { threeDFoxgloveAdapter } from '../ThreeD/foxgloveAdapter';
import { posePanelDefinition } from '../Pose';
import { poseFoxgloveAdapter } from '../Pose/foxgloveAdapter';
import { topicGraphPanelDefinition } from '../TopicGraph';
import { topicGraphFoxgloveAdapter } from '../TopicGraph/foxgloveAdapter';
import { timelinePanelDefinition } from '../Timeline';
import { timelineFoxgloveAdapter } from '../Timeline/foxgloveAdapter';
import { alignPanelDefinition } from '../Align';
import { alignFoxgloveAdapter } from '../Align/foxgloveAdapter';
import { audioPanelDefinition } from '../Audio';
import { audioFoxgloveAdapter } from '../Audio/foxgloveAdapter';
import { urdfDebugPanelDefinition } from '../UrdfDebug';
import { urdfDebugFoxgloveAdapter } from '../UrdfDebug/foxgloveAdapter';
import { unavailablePanelDefinition } from '../Unavailable';
import { unavailableFoxgloveAdapter } from '../Unavailable/foxgloveAdapter';

const definitions = [
  rawMessagesPanelDefinition,
  imagePanelDefinition,
  threeDPanelDefinition,
  posePanelDefinition,
  jointStatePlotDefinition,
  timelinePanelDefinition,
  topicGraphPanelDefinition,
  alignPanelDefinition,
  audioPanelDefinition,
  urdfDebugPanelDefinition,
  unavailablePanelDefinition,
] as unknown as readonly PanelDefinition<unknown>[];

const definitionMap = new Map<PanelType, PanelDefinition<unknown>>(
  definitions.map((definition) => [definition.type, definition]),
);

/**
 * Map from Foxglove panel type string (as encoded in the id prefix) to the
 * adapter we want to use. Legacy `Plot` and `Joints` entries are mapped to
 * the new `JointStatePlot` adapter so that old layout JSON round-trips safely.
 */
const foxgloveAdapters = new Map<string, PanelFoxgloveAdapter<unknown>>([
  ['Image', imageFoxgloveAdapter],
  ['Canvas', canvasFoxgloveAdapter],
  ['3D', threeDFoxgloveAdapter],
  ['Pose', poseFoxgloveAdapter],
  ['JointStatePlot', jointStatePlotFoxgloveAdapter],
  // Legacy Foxglove types — redirect to JointStatePlot
  ['Plot', legacyPlotFoxgloveAdapter],
  ['Joints', legacyJointsFoxgloveAdapter],
  ['Timeline', timelineFoxgloveAdapter],
  ['RawMessages', rawMessagesFoxgloveAdapter],
  ['TopicGraph', topicGraphFoxgloveAdapter],
  ['Align', alignFoxgloveAdapter],
  ['Audio', audioFoxgloveAdapter],
  ['UrdfDebug', urdfDebugFoxgloveAdapter],
  ['Unavailable', unavailableFoxgloveAdapter],
]);

export function getPanelDefinitions(): PanelDefinition<unknown>[] {
  return [...definitions] as PanelDefinition<unknown>[];
}

export function getPanelDefinition(type: PanelType): PanelDefinition<unknown> {
  const definition = definitionMap.get(type);
  if (!definition) {
    return unavailablePanelDefinition as PanelDefinition<unknown>;
  }
  return definition;
}

export function hasPanelDefinition(type: string): type is PanelType {
  return definitionMap.has(type as PanelType);
}

/**
 * Resolve the Foxglove adapter for a given Foxglove panel-type string
 * (e.g. from `id.split('!')[0]`). Returns the `Unavailable` adapter when no
 * match exists so callers always get a valid object.
 */
export function getFoxgloveAdapter(foxgloveType: string): PanelFoxgloveAdapter<unknown> {
  return foxgloveAdapters.get(foxgloveType) ?? unavailableFoxgloveAdapter;
}

/** Whether our product knows how to render panels of the given Foxglove type. */
export function hasFoxgloveAdapter(foxgloveType: string): boolean {
  return foxgloveAdapters.has(foxgloveType);
}

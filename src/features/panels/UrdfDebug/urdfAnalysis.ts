import { parseUrdf } from '../ThreeD/foxglove-core/urdf';
import type { UrdfJoint } from '../ThreeD/foxglove-core/types';
import { applyUrdfVisualCorrection } from './urdfVisualCorrection';

export { TELEOP_ROTATE_MESH_RPY, applyUrdfVisualCorrection } from './urdfVisualCorrection';

const SLIDER_GRANULARITY = 100;
const DEFAULT_REVOLUTE_RANGE = Math.PI;
const DEFAULT_PRISMATIC_RANGE = 0.05;

export type UrdfJointDescriptor = {
  name: string;
  jointType: UrdfJoint['jointType'];
  lower: number;
  upper: number;
  step: number;
  defaultValue: number;
  sliderEnabled: boolean;
  valueUnit: 'rad' | 'm';
};

export type UrdfMimicJoint = {
  jointName: string;
  sourceJoint: string;
  multiplier: number;
  offset: number;
};

export type UrdfAnalysis = {
  robotName: string;
  linkCount: number;
  jointCount: number;
  movableJointNames: string[];
  meshReferences: string[];
  mimicJoints: UrdfMimicJoint[];
};

export function analyzeUrdfText(urdfText: string): UrdfAnalysis | null {
  try {
    const parsed = parseUrdf(urdfText);
    const movableJointNames = Array.from(parsed.robot.joints.values())
      .filter((joint) => joint.jointType !== 'fixed')
      .map((joint) => joint.name);
    const meshReferences: string[] = [];
    for (const link of parsed.robot.links.values()) {
      for (const visual of link.visuals) {
        if (visual.geometry.geometryType === 'mesh') {
          meshReferences.push(visual.geometry.filename);
        }
      }
    }
    return {
      robotName: parsed.robot.name,
      linkCount: parsed.robot.links.size,
      jointCount: parsed.robot.joints.size,
      movableJointNames,
      meshReferences,
      mimicJoints: extractUrdfMimicJoints(urdfText),
    };
  } catch {
    return null;
  }
}

/** Apply teleop_tf rotate_mesh visual correction and optional RPY offset. */
export function prepareUrdfForPreview(
  urdfText: string,
  rotateMeshVisuals: boolean,
  visualRpyOffset: [number, number, number],
): string {
  return applyUrdfVisualCorrection(urdfText, { rotateMeshVisuals, visualRpyOffset });
}

export function isJointStateTopicType(type: string): boolean {
  return type.includes('JointState');
}

export function filterJointStateTopics(
  topics: ReadonlyArray<{ name: string; type: string }>,
): Array<{ name: string; type: string }> {
  return topics.filter((topic) => isJointStateTopicType(topic.type));
}

export function pickJointStateTopic(
  topics: ReadonlyArray<{ name: string; type: string }>,
  preferred?: string,
): string {
  const jointStateTopics = filterJointStateTopics(topics);
  if (preferred) {
    const preferredTopic = jointStateTopics.find((topic) => topic.name === preferred);
    if (preferredTopic) return preferredTopic.name;
  }
  const bySuffix = jointStateTopics.find(
    (topic) => topic.name.endsWith('/joint_states') || topic.name.includes('joint_states'),
  );
  if (bySuffix) return bySuffix.name;
  return jointStateTopics[0]?.name ?? '';
}

function clamp(value: number, lower: number, upper: number): number {
  return Math.max(lower, Math.min(upper, value));
}

function hasValidLimit(limit: UrdfJoint['limit']): boolean {
  if (!limit) return false;
  return Number.isFinite(limit.lower) && Number.isFinite(limit.upper) && limit.lower < limit.upper;
}

function resolveJointRange(joint: UrdfJoint): { lower: number; upper: number; sliderEnabled: boolean } {
  switch (joint.jointType) {
    case 'revolute':
    case 'prismatic': {
      if (hasValidLimit(joint.limit)) {
        return { lower: joint.limit!.lower, upper: joint.limit!.upper, sliderEnabled: true };
      }
      if (joint.jointType === 'prismatic') {
        return {
          lower: -DEFAULT_PRISMATIC_RANGE,
          upper: DEFAULT_PRISMATIC_RANGE,
          sliderEnabled: true,
        };
      }
      return {
        lower: -DEFAULT_REVOLUTE_RANGE,
        upper: DEFAULT_REVOLUTE_RANGE,
        sliderEnabled: true,
      };
    }
    case 'continuous':
      return {
        lower: -DEFAULT_REVOLUTE_RANGE,
        upper: DEFAULT_REVOLUTE_RANGE,
        sliderEnabled: true,
      };
    case 'fixed':
      return { lower: 0, upper: 0, sliderEnabled: false };
    default:
      return { lower: 0, upper: 0, sliderEnabled: false };
  }
}

/** Extract joint metadata for manual pose sliders (document order). */
export function extractUrdfJointDescriptors(urdfText: string): UrdfJointDescriptor[] {
  const parsed = parseUrdf(urdfText);
  return Array.from(parsed.robot.joints.values()).map((joint) => {
    const { lower, upper, sliderEnabled } = resolveJointRange(joint);
    const span = upper - lower;
    const step = span > 0 ? span / SLIDER_GRANULARITY : 0;
    const defaultValue = clamp(0, lower, upper);
    return {
      name: joint.name,
      jointType: joint.jointType,
      lower,
      upper,
      step,
      defaultValue,
      sliderEnabled,
      valueUnit: joint.jointType === 'prismatic' ? 'm' : 'rad',
    };
  });
}

export function createDefaultManualPositions(descriptors: UrdfJointDescriptor[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const joint of descriptors) {
    if (joint.sliderEnabled) {
      out[joint.name] = joint.defaultValue;
    }
  }
  return out;
}

/** Parse `<mimic joint="..." multiplier="..." offset="..."/>` tags from URDF joint blocks. */
export function extractUrdfMimicJoints(urdfText: string): UrdfMimicJoint[] {
  const out: UrdfMimicJoint[] = [];
  const jointRe = /<joint\b[\s\S]*?<\/joint>/g;
  let blockMatch: RegExpExecArray | null;
  while ((blockMatch = jointRe.exec(urdfText)) !== null) {
    const block = blockMatch[0];
    const nameMatch = /<joint\b[^>]*\bname="([^"]+)"/.exec(block);
    const mimicMatch = /<mimic\b([^>]*)\/>/.exec(block);
    if (!nameMatch || !mimicMatch) continue;
    const attrs = mimicMatch[1];
    const sourceMatch = /\bjoint="([^"]+)"/.exec(attrs);
    if (!sourceMatch) continue;
    const multiplierMatch = /\bmultiplier="([^"]+)"/.exec(attrs);
    const offsetMatch = /\boffset="([^"]+)"/.exec(attrs);
    out.push({
      jointName: nameMatch[1].trim(),
      sourceJoint: sourceMatch[1].trim(),
      multiplier: multiplierMatch ? Number(multiplierMatch[1]) || 1 : 1,
      offset: offsetMatch ? Number(offsetMatch[1]) || 0 : 0,
    });
  }
  return out;
}

export function topicExists(
  topics: ReadonlyArray<{ name: string; type: string }>,
  matcher: (name: string, type: string) => boolean,
): boolean {
  return topics.some((topic) => matcher(topic.name, topic.type));
}

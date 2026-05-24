import type { JointStateMsg } from '../ThreeD/foxglove-core/types';
import type { JointStateLike } from './jointStateMapping';
import type { UrdfJointDescriptor, UrdfMimicJoint } from './urdfAnalysis';

export type BuildPreviewJointStateArgs = {
  descriptors: UrdfJointDescriptor[];
  manualPositions: Record<string, number>;
  liveJointState: JointStateLike | null;
  followLive: boolean;
  mimicJoints: UrdfMimicJoint[];
};

function clamp(value: number, lower: number, upper: number): number {
  return Math.max(lower, Math.min(upper, value));
}

function readLiveValue(live: JointStateLike | null, jointName: string): number | undefined {
  if (!live) return undefined;
  const index = live.name.indexOf(jointName);
  if (index < 0) return undefined;
  return live.position[index] ?? 0;
}

function resolveBaseValue(
  descriptor: UrdfJointDescriptor,
  manualPositions: Record<string, number>,
  liveJointState: JointStateLike | null,
  followLive: boolean,
): number {
  if (followLive) {
    const liveValue = readLiveValue(liveJointState, descriptor.name);
    if (liveValue != null) {
      return clamp(liveValue, descriptor.lower, descriptor.upper);
    }
  }
  const manual = manualPositions[descriptor.name];
  if (manual != null && Number.isFinite(manual)) {
    return clamp(manual, descriptor.lower, descriptor.upper);
  }
  return descriptor.defaultValue;
}

function applyMimicJoints(
  positions: Map<string, number>,
  mimicJoints: UrdfMimicJoint[],
  descriptors: UrdfJointDescriptor[],
): void {
  const limits = new Map(descriptors.map((d) => [d.name, d]));
  for (const mimic of mimicJoints) {
    const source = positions.get(mimic.sourceJoint);
    if (source == null) continue;
    const limit = limits.get(mimic.jointName);
    const value = source * mimic.multiplier + mimic.offset;
    positions.set(
      mimic.jointName,
      limit ? clamp(value, limit.lower, limit.upper) : value,
    );
  }
}

export function buildPreviewJointState(args: BuildPreviewJointStateArgs): JointStateMsg | null {
  const { descriptors, manualPositions, liveJointState, followLive, mimicJoints } = args;
  if (descriptors.length === 0) return null;

  const positions = new Map<string, number>();
  for (const descriptor of descriptors) {
    if (!descriptor.sliderEnabled) continue;
    positions.set(
      descriptor.name,
      resolveBaseValue(descriptor, manualPositions, liveJointState, followLive),
    );
  }

  applyMimicJoints(positions, mimicJoints, descriptors);

  const names = [...positions.keys()];
  if (names.length === 0) return null;
  return {
    name: names,
    position: names.map((name) => positions.get(name) ?? 0),
  };
}

export function getDisplayedJointValue(
  descriptor: UrdfJointDescriptor,
  manualPositions: Record<string, number>,
  liveJointState: JointStateLike | null,
  followLive: boolean,
): number {
  return resolveBaseValue(descriptor, manualPositions, liveJointState, followLive);
}

import { describe, expect, it } from 'vitest';
import { buildPreviewJointState, getDisplayedJointValue } from './jointPose';
import type { UrdfJointDescriptor } from './urdfAnalysis';

const descriptors: UrdfJointDescriptor[] = [
  {
    name: 'j1',
    jointType: 'revolute',
    lower: -1,
    upper: 1,
    step: 0.02,
    defaultValue: 0,
    sliderEnabled: true,
    valueUnit: 'rad',
  },
  {
    name: 'j2',
    jointType: 'revolute',
    lower: 0,
    upper: 2,
    step: 0.02,
    defaultValue: 0,
    sliderEnabled: true,
    valueUnit: 'rad',
  },
  {
    name: 'fixed_joint',
    jointType: 'fixed',
    lower: 0,
    upper: 0,
    step: 0,
    defaultValue: 0,
    sliderEnabled: false,
    valueUnit: 'rad',
  },
];

describe('buildPreviewJointState', () => {
  it('uses manual positions when not following live', () => {
    const out = buildPreviewJointState({
      descriptors,
      manualPositions: { j1: 0.5, j2: 1.2 },
      liveJointState: null,
      followLive: false,
      mimicJoints: [],
    });
    expect(out?.name).toEqual(['j1', 'j2']);
    expect(out?.position).toEqual([0.5, 1.2]);
  });

  it('prefers live values when followLive is on', () => {
    const out = buildPreviewJointState({
      descriptors,
      manualPositions: { j1: 0.5, j2: 1.2 },
      liveJointState: { name: ['j1'], position: [0.8] },
      followLive: true,
      mimicJoints: [],
    });
    expect(out).not.toBeNull();
    if (!out) return;
    expect(out.position[out.name.indexOf('j1')]).toBe(0.8);
    expect(out.position[out.name.indexOf('j2')]).toBe(1.2);
  });

  it('applies mimic joints after base values', () => {
    const out = buildPreviewJointState({
      descriptors,
      manualPositions: { j1: 0.4, j2: 0 },
      liveJointState: null,
      followLive: false,
      mimicJoints: [{ jointName: 'j2', sourceJoint: 'j1', multiplier: 2, offset: 0 }],
    });
    expect(out).not.toBeNull();
    if (!out) return;
    expect(out.position[out.name.indexOf('j2')]).toBe(0.8);
  });

  it('clamps live values to joint limits', () => {
    const value = getDisplayedJointValue(
      descriptors[0],
      { j1: 0.1 },
      { name: ['j1'], position: [5] },
      true,
    );
    expect(value).toBe(1);
  });
});

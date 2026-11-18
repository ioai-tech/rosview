import { describe, expect, it } from 'vitest';
import {
  bvhPrimitiveFrameKey,
  extractBvhSkeletonPrimitives,
  PLAYBACK_REWIND_CLEAR_POLICY,
  shouldUpdateBvhGroundLayout,
  type BvhGroundLayoutState,
  type MarkerPrimitive,
} from './ThreeDPanel';
import type { ThreeDSkeletonConfig } from './defaults';

const skeletonConfig = {
  enabled: true,
  renderMode: 'stick',
  scale: 1,
  yUpToZUp: false,
  flipY: false,
  color: '#22c55e',
} satisfies ThreeDSkeletonConfig;

function frameMessage(frameIndex: number, offset: number) {
  return {
    frame_index: frameIndex,
    joints: [
      { name: 'Hips', parent_index: -1, x: offset, y: 0, z: 0 },
      { name: 'Head', parent_index: 0, x: offset, y: 1, z: 0 },
    ],
  };
}

function isMeshPrimitive(
  primitive: MarkerPrimitive,
): primitive is Extract<MarkerPrimitive, { kind: 'sphere' | 'cube' | 'orientedBox' }> {
  return primitive.kind === 'sphere' || primitive.kind === 'cube' || primitive.kind === 'orientedBox';
}

describe('extractBvhSkeletonPrimitives', () => {
  it('keeps BVH primitive keys stable across frames', () => {
    const firstFrame = extractBvhSkeletonPrimitives(frameMessage(1, 0), skeletonConfig);
    const nextFrame = extractBvhSkeletonPrimitives(frameMessage(2, 0.25), skeletonConfig);
    const firstJoint = firstFrame.find(isMeshPrimitive);
    const nextJoint = nextFrame.find(isMeshPrimitive);

    expect(nextFrame.map((primitive) => primitive.key)).toEqual(firstFrame.map((primitive) => primitive.key));
    expect(new Set(nextFrame.map((primitive) => primitive.frameIndex))).toEqual(new Set([2]));
    expect(nextJoint?.position).not.toEqual(firstJoint?.position);
  });

  it('keeps line mode keys stable and colored from config', () => {
    const config = { ...skeletonConfig, renderMode: 'line', color: '#abcdef' } satisfies ThreeDSkeletonConfig;
    const firstFrame = extractBvhSkeletonPrimitives(frameMessage(1, 0), config);
    const nextFrame = extractBvhSkeletonPrimitives(frameMessage(2, 0.25), config);

    expect(firstFrame).toHaveLength(1);
    expect(nextFrame.map((primitive) => primitive.key)).toEqual(firstFrame.map((primitive) => primitive.key));
    expect(nextFrame[0]).toMatchObject({ kind: 'line', color: '#abcdef', frameIndex: 2 });
  });
});

describe('bvhPrimitiveFrameKey', () => {
  it('changes when frameIndex changes even if topology keys are stable', () => {
    const firstFrame = extractBvhSkeletonPrimitives(frameMessage(1, 0), skeletonConfig);
    const nextFrame = extractBvhSkeletonPrimitives(frameMessage(2, 0), skeletonConfig);

    expect(bvhPrimitiveFrameKey(0, nextFrame)).not.toBe(bvhPrimitiveFrameKey(0, firstFrame));
  });
});

describe('shouldUpdateBvhGroundLayout', () => {
  const layout = {
    size: 20,
    divisions: 10,
    position: [0, 0, 0],
  } satisfies BvhGroundLayoutState;

  it('updates for first layout and growth', () => {
    expect(shouldUpdateBvhGroundLayout(null, layout)).toBe(true);
    expect(shouldUpdateBvhGroundLayout(layout, { ...layout, size: 21 })).toBe(true);
  });

  it('skips tiny center drift and unchanged size', () => {
    expect(shouldUpdateBvhGroundLayout(layout, { ...layout, position: [0.02, -0.02, 0] })).toBe(false);
  });

  it('updates when center moves enough', () => {
    expect(shouldUpdateBvhGroundLayout(layout, { ...layout, position: [0.06, 0, 0] })).toBe(true);
  });
});

describe('PLAYBACK_REWIND_CLEAR_POLICY', () => {
  it('preserves BVH skeleton primitives after rewind', () => {
    expect(PLAYBACK_REWIND_CLEAR_POLICY.clearSkeletonPrimitives).toBe(false);
  });
});

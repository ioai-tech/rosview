import { describe, expect, it } from 'vitest';
import {
  applyUrdfVisualCorrection,
  multiplyMat3,
  rotationMatrixFromRpy,
  rpyFromRotationMatrix,
  TELEOP_ROTATE_MESH_RPY,
  transformVisualOriginRpy,
} from './urdfVisualCorrection';

const SAMPLE_URDF = `<?xml version="1.0"?>
<robot name="test">
  <link name="base">
    <visual>
      <origin rpy="0 0 0" xyz="0 0 0"/>
      <geometry><box size="1 1 1"/></geometry>
    </visual>
  </link>
  <link name="arm">
    <visual>
      <origin rpy="0.1 0.2 0.3" xyz="0 0 0"/>
      <geometry><cylinder length="1" radius="0.1"/></geometry>
    </visual>
  </link>
</robot>`;

describe('urdfVisualCorrection', () => {
  it('matches teleop_tf rotate_mesh for identity origin', () => {
    const next = transformVisualOriginRpy([0, 0, 0], {
      rotateMeshVisuals: true,
      visualRpyOffset: [0, 0, 0],
    });
    expect(next[0]).toBeCloseTo(TELEOP_ROTATE_MESH_RPY[0], 5);
    expect(next[1]).toBeCloseTo(0, 5);
    expect(next[2]).toBeCloseTo(0, 5);
  });

  it('post-multiplies rotation matrices like teleop_tf (not additive roll)', () => {
    const original = [0.1, 0.2, 0.3] as [number, number, number];
    const originalMatrix = rotationMatrixFromRpy(...original);
    const fixMatrix = rotationMatrixFromRpy(...TELEOP_ROTATE_MESH_RPY);
    const expected = rpyFromRotationMatrix(multiplyMat3(originalMatrix, fixMatrix));

    const next = transformVisualOriginRpy(original, {
      rotateMeshVisuals: true,
      visualRpyOffset: [0, 0, 0],
    });
    expect(next[0]).toBeCloseTo(expected[0], 5);
    expect(next[1]).toBeCloseTo(expected[1], 5);
    expect(next[2]).toBeCloseTo(expected[2], 5);

    // Old additive-roll shortcut would differ when pitch/yaw are non-zero.
    expect(next[0]).not.toBeCloseTo(original[0] + Math.PI / 2, 3);
  });

  it('leaves URDF unchanged when rotate_mesh is off and offset is zero', () => {
    expect(
      applyUrdfVisualCorrection(SAMPLE_URDF, {
        rotateMeshVisuals: false,
        visualRpyOffset: [0, 0, 0],
      }),
    ).toBe(SAMPLE_URDF);
  });

  it('updates every visual origin rpy when rotate_mesh is on', () => {
    const corrected = applyUrdfVisualCorrection(SAMPLE_URDF, {
      rotateMeshVisuals: true,
      visualRpyOffset: [0, 0, 0],
    });
    expect(corrected).toContain('rpy="-1.5707963267948966 0 0"');
    expect(corrected).toMatch(/arm[\s\S]*?rpy="[^"]+"/);
    expect(corrected).not.toContain('rpy="0.1 0.2 0.3"');
  });

  it('applies visualRpyOffset after rotate_mesh', () => {
    const withOffset = transformVisualOriginRpy([0, 0, 0], {
      rotateMeshVisuals: true,
      visualRpyOffset: [0.1, 0, 0],
    });
    const rotateOnly = transformVisualOriginRpy([0, 0, 0], {
      rotateMeshVisuals: true,
      visualRpyOffset: [0, 0, 0],
    });
    expect(withOffset[0]).not.toBeCloseTo(rotateOnly[0], 3);
  });
});

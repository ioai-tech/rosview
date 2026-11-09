import { describe, expect, it } from 'vitest';
import { G1_29DOF_JOINT_NAMES } from '@/shared/robots/unitreeG1';
import { BUILTIN_ROBOT_MODELS, matchBuiltinRobotModel } from './builtinRobots';

describe('builtin robot models', () => {
  it('matches the G1 from its body joints plus unrelated hand joints', () => {
    const names = [...G1_29DOF_JOINT_NAMES, 'left_hand_thumb_0_joint'];
    expect(matchBuiltinRobotModel(names)?.id).toBe('unitree_g1_29dof');
  });

  it('tolerates a few missing joints but not a different robot', () => {
    expect(matchBuiltinRobotModel(G1_29DOF_JOINT_NAMES.slice(2))?.id).toBe('unitree_g1_29dof');
    expect(matchBuiltinRobotModel(G1_29DOF_JOINT_NAMES.slice(0, 12))).toBeUndefined();
    expect(matchBuiltinRobotModel(['joint1', 'joint2'])).toBeUndefined();
  });

  it('bundles URDFs that define every signature joint', async () => {
    for (const model of BUILTIN_ROBOT_MODELS) {
      const urdf = await model.loadUrdf();
      const movable = new Set(
        [...urdf.matchAll(/<joint\s+name="([^"]+)"\s+type="(?:revolute|continuous|prismatic)"/g)].map((m) => m[1]),
      );
      for (const name of model.jointNames) {
        expect(movable.has(name), `${model.id}: ${name}`).toBe(true);
      }
    }
  });
});

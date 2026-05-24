import { describe, expect, it } from 'vitest';
import {
  applyJointMapping,
  buildAutoMatchRules,
  buildGripperNormalizedRule,
  buildInvertRule,
  buildMimicRulesFromUrdf,
  buildSymmetricPairFromHeuristic,
  buildSymmetricPairRule,
  buildXArm851Rule,
} from './jointStateMapping';

describe('applyJointMapping', () => {
  it('renames joints', () => {
    const out = applyJointMapping(
      { name: ['a'], position: [1] },
      [{ kind: 'rename', from: 'a', to: 'joint_a' }],
    );
    expect(out.name).toEqual(['joint_a']);
    expect(out.position[0]).toBe(1);
  });

  it('applies linear scale and offset', () => {
    const out = applyJointMapping(
      { name: ['gripper'], position: [100] },
      [{ kind: 'linear', from: 'gripper', to: 'drive', scale: 0.001, offset: -0.1 }],
    );
    expect(out.position[0]).toBeCloseTo(0);
  });

  it('inverts joint direction', () => {
    const out = applyJointMapping(
      { name: ['j1'], position: [0.5] },
      [buildInvertRule('j1', 'j1')],
    );
    expect(out.position[0]).toBe(-0.5);
  });

  it('duplicates one input to symmetric outputs', () => {
    const out = applyJointMapping(
      { name: ['gripper'], position: [0.02] },
      [
        {
          kind: 'duplicate',
          from: 'gripper',
          outputs: [
            { to: 'left', scale: -1, offset: 0 },
            { to: 'right', scale: 1, offset: 0 },
          ],
        },
      ],
    );
    expect(out.name.sort()).toEqual(['left', 'right']);
    expect(out.position[out.name.indexOf('left')]).toBe(-0.02);
    expect(out.position[out.name.indexOf('right')]).toBe(0.02);
  });

  it('writes constant and mimic joints', () => {
    const out = applyJointMapping(
      { name: ['source'], position: [0.3] },
      [
        { kind: 'constant', to: 'fixed_joint', value: 0.1 },
        { kind: 'mimic', source: 'source', to: 'follower', multiplier: 2, offset: 0.01 },
      ],
    );
    expect(out.name).toContain('fixed_joint');
    expect(out.name).toContain('follower');
    expect(out.position[out.name.indexOf('fixed_joint')]).toBe(0.1);
    expect(out.position[out.name.indexOf('follower')]).toBeCloseTo(0.61);
  });

  it('ignores passthrough for ignored joints', () => {
    const out = applyJointMapping(
      { name: ['keep', 'drop'], position: [1, 2] },
      [{ kind: 'ignore', from: 'drop' }],
    );
    expect(out.name).toEqual(['keep']);
    expect(out.position[0]).toBe(1);
  });

  it('passthroughs matching names when no rule applies', () => {
    const out = applyJointMapping({ name: ['j1'], position: [0.7] }, []);
    expect(out.name).toEqual(['j1']);
    expect(out.position[0]).toBe(0.7);
  });
});

describe('rule builders', () => {
  it('builds auto match rename rules', () => {
    const rules = buildAutoMatchRules(['Arm_J1'], ['arm_j1']);
    expect(rules).toEqual([{ kind: 'rename', from: 'Arm_J1', to: 'arm_j1' }]);
  });

  it('builds gripper normalized rule', () => {
    const rule = buildGripperNormalizedRule('gripper', 'drive', true, 0, 0.85);
    const out = applyJointMapping({ name: ['gripper'], position: [1] }, [rule]);
    expect(out.position[0]).toBe(0);
  });

  it('builds xArm851 rule', () => {
    const rule = buildXArm851Rule('gripper', 'drive_joint');
    const out = applyJointMapping({ name: ['gripper'], position: [851] }, [rule]);
    expect(out.position[0]).toBeCloseTo(0, 3);
  });

  it('builds symmetric pair rules', () => {
    const rules = buildSymmetricPairRule('gripper', 'left', 'right', 1, 0);
    const out = applyJointMapping({ name: ['gripper'], position: [0.034] }, rules);
    expect(out.name.sort()).toEqual(['left', 'right']);
  });

  it('builds symmetric pair from heuristic', () => {
    const rules = buildSymmetricPairFromHeuristic(
      ['drive_joint'],
      ['left_finger_joint', 'right_finger_joint', 'joint1'],
      ['joint1'],
    );
    expect(rules).not.toBeNull();
    const out = applyJointMapping({ name: ['drive_joint'], position: [0.02] }, rules!);
    expect(out.name.sort()).toEqual(['left_finger_joint', 'right_finger_joint']);
  });

  it('builds mimic rules from urdf metadata', () => {
    const rules = buildMimicRulesFromUrdf(
      [{ jointName: 'left_finger_joint', sourceJoint: 'drive_joint', multiplier: 1, offset: 0 }],
      ['drive_joint'],
      [],
    );
    expect(rules).toHaveLength(1);
    const out = applyJointMapping({ name: ['drive_joint'], position: [0.5] }, rules);
    expect(out.name).toContain('left_finger_joint');
    expect(out.position[out.name.indexOf('left_finger_joint')]).toBe(0.5);
  });
});

import type { JointMappingRule } from './recipe';

export type JointStateLike = {
  name: string[];
  position: number[];
};

function readPosition(positions: ArrayLike<number>, index: number): number {
  const value = positions[index];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function clampValue(value: number, min?: number, max?: number): number {
  let out = value;
  if (min != null && Number.isFinite(min)) out = Math.max(min, out);
  if (max != null && Number.isFinite(max)) out = Math.min(max, out);
  return out;
}

function applyLinear(value: number, scale: number, offset: number, min?: number, max?: number): number {
  return clampValue(value * scale + offset, min, max);
}

export function applyJointMapping(input: JointStateLike, rules: JointMappingRule[]): JointStateLike {
  const inputMap = new Map<string, number>();
  for (let i = 0; i < input.name.length; i += 1) {
    const jointName = input.name[i];
    if (typeof jointName !== 'string' || jointName.length === 0) continue;
    inputMap.set(jointName, readPosition(input.position, i));
  }

  const ignored = new Set(
    rules.filter((rule): rule is Extract<JointMappingRule, { kind: 'ignore' }> => rule.kind === 'ignore').map((r) => r.from),
  );
  const consumedInputs = new Set<string>();
  const output = new Map<string, number>();

  for (const rule of rules) {
    switch (rule.kind) {
      case 'ignore':
        consumedInputs.add(rule.from);
        output.delete(rule.from);
        break;
      case 'rename': {
        if (!inputMap.has(rule.from)) break;
        const value = inputMap.get(rule.from)!;
        consumedInputs.add(rule.from);
        if (rule.from !== rule.to) {
          output.delete(rule.from);
        }
        output.set(rule.to, value);
        break;
      }
      case 'linear': {
        if (!inputMap.has(rule.from)) break;
        const value = inputMap.get(rule.from)!;
        consumedInputs.add(rule.from);
        output.set(
          rule.to,
          applyLinear(value, rule.scale, rule.offset, rule.min, rule.max),
        );
        break;
      }
      case 'duplicate': {
        if (!inputMap.has(rule.from)) break;
        const value = inputMap.get(rule.from)!;
        consumedInputs.add(rule.from);
        output.delete(rule.from);
        for (const out of rule.outputs) {
          output.set(out.to, applyLinear(value, out.scale, out.offset, out.min, out.max));
        }
        break;
      }
      case 'mimic': {
        const sourceValue = inputMap.get(rule.source);
        if (sourceValue == null) break;
        output.set(rule.to, applyLinear(sourceValue, rule.multiplier, rule.offset));
        break;
      }
      case 'constant':
        output.set(rule.to, rule.value);
        break;
      default:
        break;
    }
  }

  for (const [name, value] of inputMap) {
    if (ignored.has(name) || consumedInputs.has(name)) continue;
    if (!output.has(name)) {
      output.set(name, value);
    }
  }

  const names = [...output.keys()];
  return {
    name: names,
    position: names.map((name) => output.get(name) ?? 0),
  };
}

export function buildAutoMatchRules(inputNames: string[], urdfJointNames: string[]): JointMappingRule[] {
  const urdfSet = new Set(urdfJointNames);
  const rules: JointMappingRule[] = [];
  for (const name of inputNames) {
    if (urdfSet.has(name)) continue;
    const normalized = name.toLowerCase().replace(/_/g, '');
    const match = urdfJointNames.find(
      (candidate) => candidate.toLowerCase().replace(/_/g, '') === normalized,
    );
    if (match && match !== name) {
      rules.push({ kind: 'rename', from: name, to: match });
    }
  }
  return rules;
}

export function buildInvertRule(from: string, to: string): JointMappingRule {
  return { kind: 'linear', from, to, scale: -1, offset: 0 };
}

export function buildGripperNormalizedRule(
  from: string,
  to: string,
  oneMeansClose: boolean,
  closedValue: number,
  openValue: number,
): JointMappingRule {
  return oneMeansClose
    ? {
        kind: 'linear',
        from,
        to,
        scale: closedValue - openValue,
        offset: openValue,
        min: Math.min(closedValue, openValue),
        max: Math.max(closedValue, openValue),
      }
    : {
        kind: 'linear',
        from,
        to,
        scale: openValue - closedValue,
        offset: closedValue,
        min: Math.min(closedValue, openValue),
        max: Math.max(closedValue, openValue),
      };
}

export function buildXArm851Rule(from: string, to: string, maxRadians = 0.85): JointMappingRule {
  return {
    kind: 'linear',
    from,
    to,
    scale: -maxRadians / 851,
    offset: maxRadians,
    min: 0,
    max: maxRadians,
  };
}

export function buildSymmetricPairRule(
  from: string,
  leftJoint: string,
  rightJoint: string,
  scale: number,
  offset = 0,
): JointMappingRule[] {
  return [
    {
      kind: 'duplicate',
      from,
      outputs: [
        { to: leftJoint, scale: -scale, offset },
        { to: rightJoint, scale, offset },
      ],
    },
  ];
}

export function buildSymmetricPairFromHeuristic(
  inputNames: string[],
  urdfJointNames: string[],
  mappedNames: string[],
): JointMappingRule[] | null {
  const from =
    inputNames.find((n) => /drive_joint|gripper/i.test(n)) ??
    inputNames.find((n) => mappedNames.includes(n)) ??
    inputNames[0];
  if (!from) return null;

  const missing = urdfJointNames.filter((n) => !mappedNames.includes(n));
  const leftCandidates = missing.filter((n) => /\bleft\b|left_/i.test(n));
  const rightCandidates = missing.filter((n) => /\bright\b|right_/i.test(n));

  const leftFinger = leftCandidates.find((n) => n.includes('finger'));
  const rightFinger = rightCandidates.find((n) => n.includes('finger'));
  if (leftFinger && rightFinger) {
    return buildSymmetricPairRule(from, leftFinger, rightFinger, 1, 0);
  }

  const leftKnuckle = leftCandidates.find((n) => n.includes('knuckle'));
  const rightKnuckle = rightCandidates.find((n) => n.includes('knuckle'));
  if (leftKnuckle && rightKnuckle) {
    return buildSymmetricPairRule(from, leftKnuckle, rightKnuckle, 1, 0);
  }

  if (leftCandidates[0] && rightCandidates[0]) {
    return buildSymmetricPairRule(from, leftCandidates[0], rightCandidates[0], 1, 0);
  }
  return null;
}

export function buildMimicRulesFromUrdf(
  mimicJoints: Array<{
    jointName: string;
    sourceJoint: string;
    multiplier: number;
    offset: number;
  }>,
  sourceJointNames: string[],
  existingTargetNames: string[],
): JointMappingRule[] {
  const sources = new Set(sourceJointNames);
  const targets = new Set(existingTargetNames);
  const rules: JointMappingRule[] = [];
  for (const mimic of mimicJoints) {
    if (!sources.has(mimic.sourceJoint)) continue;
    if (targets.has(mimic.jointName)) continue;
    rules.push({
      kind: 'mimic',
      source: mimic.sourceJoint,
      to: mimic.jointName,
      multiplier: mimic.multiplier,
      offset: mimic.offset,
    });
    targets.add(mimic.jointName);
  }
  return rules;
}

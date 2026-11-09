import { G1_29DOF_JOINT_NAMES } from '@/shared/robots/unitreeG1';

/**
 * Robot models bundled with ROS View. When a recording has joint states but
 * no `robot_description`, the 3D panel picks the model whose joints the
 * recording covers, so common robots render without manual URDF setup.
 * Mesh paths resolve through the URDF package base (see `resolveUrdfMeshUrl`).
 */
export interface BuiltinRobotModel {
  id: string;
  label: string;
  /** Movable joints that identify the model. */
  jointNames: readonly string[];
  loadUrdf(): Promise<string>;
}

export const BUILTIN_ROBOT_MODELS: readonly BuiltinRobotModel[] = [
  {
    id: 'unitree_g1_29dof',
    label: 'Unitree G1 (29 DoF)',
    jointNames: G1_29DOF_JOINT_NAMES,
    loadUrdf: async () => (await import('../urdf.xml?raw')).default,
  },
];

/** Share of a model's joints that must appear in the joint state to auto-select it. */
const MIN_JOINT_COVERAGE = 0.9;

export function matchBuiltinRobotModel(
  jointNames: readonly string[],
  models: readonly BuiltinRobotModel[] = BUILTIN_ROBOT_MODELS,
): BuiltinRobotModel | undefined {
  const present = new Set(jointNames);
  let best: { model: BuiltinRobotModel; coverage: number } | undefined;
  for (const model of models) {
    const coverage = model.jointNames.filter((name) => present.has(name)).length / model.jointNames.length;
    if (coverage >= MIN_JOINT_COVERAGE && (!best || coverage > best.coverage)) {
      best = { model, coverage };
    }
  }
  return best?.model;
}

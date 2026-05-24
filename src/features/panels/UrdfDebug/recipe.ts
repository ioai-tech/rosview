import type { UrdfDebugConfig } from './defaults';

export type MeshStrategy = 'localUpload' | 'packageBaseUrl' | 'leaveAsIs';

export type JointMappingRule =
  | { kind: 'rename'; from: string; to: string }
  | {
      kind: 'linear';
      from: string;
      to: string;
      scale: number;
      offset: number;
      min?: number;
      max?: number;
    }
  | {
      kind: 'duplicate';
      from: string;
      outputs: Array<{
        to: string;
        scale: number;
        offset: number;
        min?: number;
        max?: number;
      }>;
    }
  | { kind: 'mimic'; source: string; to: string; multiplier: number; offset: number }
  | { kind: 'constant'; to: string; value: number }
  | { kind: 'ignore'; from: string };

export type UrdfDebugRecipe = {
  version: 1;
  jointStateTopic: string;
  outputTfTopic: '/tf';
  outputRobotDescriptionTopic: '/robot_description';
  urdf: {
    fileName?: string;
    robotName?: string;
    framePrefix?: string;
    rotateMeshVisuals?: boolean;
    visualRpyOffset?: [number, number, number];
  };
  meshes: {
    strategy: MeshStrategy;
    packageName?: string;
    packageBaseUrl?: string;
  };
  rules: JointMappingRule[];
};

export function configToRecipe(config: UrdfDebugConfig, robotName?: string): UrdfDebugRecipe {
  return {
    version: 1,
    jointStateTopic: config.jointStateTopic,
    outputTfTopic: '/tf',
    outputRobotDescriptionTopic: '/robot_description',
    urdf: {
      fileName: config.urdfFileName || undefined,
      robotName,
      framePrefix: config.framePrefix || undefined,
      rotateMeshVisuals: config.rotateMeshVisuals,
      visualRpyOffset: [...config.visualRpyOffset],
    },
    meshes: {
      strategy: config.meshStrategy,
      packageName: config.packageName || undefined,
      packageBaseUrl: config.packageBaseUrl || undefined,
    },
    rules: [],
  };
}

export function parseRecipe(input: unknown): UrdfDebugRecipe | null {
  if (!input || typeof input !== 'object') return null;
  const rec = input as Record<string, unknown>;
  if (rec.version !== 1) return null;
  if (typeof rec.jointStateTopic !== 'string') return null;
  const rules = Array.isArray(rec.rules) ? rec.rules : [];
  const urdfRec =
    rec.urdf && typeof rec.urdf === 'object' ? (rec.urdf as Record<string, unknown>) : {};
  const meshRec =
    rec.meshes && typeof rec.meshes === 'object' ? (rec.meshes as Record<string, unknown>) : {};
  const visualRpy = urdfRec.visualRpyOffset;
  return {
    version: 1,
    jointStateTopic: rec.jointStateTopic,
    outputTfTopic: '/tf',
    outputRobotDescriptionTopic: '/robot_description',
    urdf: {
      fileName: typeof urdfRec.fileName === 'string' ? urdfRec.fileName : undefined,
      robotName: typeof urdfRec.robotName === 'string' ? urdfRec.robotName : undefined,
      framePrefix: typeof urdfRec.framePrefix === 'string' ? urdfRec.framePrefix : undefined,
      rotateMeshVisuals:
        typeof urdfRec.rotateMeshVisuals === 'boolean' ? urdfRec.rotateMeshVisuals : false,
      visualRpyOffset:
        Array.isArray(visualRpy) && visualRpy.length === 3
          ? [Number(visualRpy[0]) || 0, Number(visualRpy[1]) || 0, Number(visualRpy[2]) || 0]
          : [0, 0, 0],
    },
    meshes: {
      strategy:
        meshRec.strategy === 'localUpload' ||
        meshRec.strategy === 'packageBaseUrl' ||
        meshRec.strategy === 'leaveAsIs'
          ? meshRec.strategy
          : 'localUpload',
      packageName: typeof meshRec.packageName === 'string' ? meshRec.packageName : undefined,
      packageBaseUrl:
        typeof meshRec.packageBaseUrl === 'string' ? meshRec.packageBaseUrl : undefined,
    },
    rules: rules.filter(isJointMappingRule),
  };
}

function isJointMappingRule(value: unknown): value is JointMappingRule {
  if (!value || typeof value !== 'object') return false;
  const rec = value as Record<string, unknown>;
  const kind = rec.kind;
  if (kind === 'rename') {
    return typeof rec.from === 'string' && typeof rec.to === 'string';
  }
  if (kind === 'linear') {
    return (
      typeof rec.from === 'string' &&
      typeof rec.to === 'string' &&
      typeof rec.scale === 'number' &&
      typeof rec.offset === 'number'
    );
  }
  if (kind === 'duplicate') {
    return typeof rec.from === 'string' && Array.isArray(rec.outputs);
  }
  if (kind === 'mimic') {
    return (
      typeof rec.source === 'string' &&
      typeof rec.to === 'string' &&
      typeof rec.multiplier === 'number' &&
      typeof rec.offset === 'number'
    );
  }
  if (kind === 'constant') {
    return typeof rec.to === 'string' && typeof rec.value === 'number';
  }
  if (kind === 'ignore') {
    return typeof rec.from === 'string';
  }
  return false;
}

export function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function downloadText(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

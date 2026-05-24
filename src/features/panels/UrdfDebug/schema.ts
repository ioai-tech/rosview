import { isRecord } from '../framework/types';
import {
  defaultUrdfDebugConfig,
  MAX_SETTINGS_PANEL_PERCENT,
  MIN_SETTINGS_PANEL_PERCENT,
  type UrdfDebugConfig,
} from './defaults';
import type { MeshStrategy } from './recipe';

const MESH_STRATEGIES: readonly MeshStrategy[] = ['localUpload', 'packageBaseUrl', 'leaveAsIs'];

function parseRpy(input: unknown, fallback: [number, number, number]): [number, number, number] {
  if (!Array.isArray(input) || input.length !== 3) return fallback;
  return [
    typeof input[0] === 'number' && Number.isFinite(input[0]) ? input[0] : fallback[0],
    typeof input[1] === 'number' && Number.isFinite(input[1]) ? input[1] : fallback[1],
    typeof input[2] === 'number' && Number.isFinite(input[2]) ? input[2] : fallback[2],
  ];
}

function parseManualJointPositions(input: unknown): Record<string, number> {
  if (!isRecord(input)) return {};
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      out[key] = value;
    }
  }
  return out;
}

function clampSettingsPanelPercent(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(MAX_SETTINGS_PANEL_PERCENT, Math.max(MIN_SETTINGS_PANEL_PERCENT, value));
}

export function parseUrdfDebugConfig(input: unknown): UrdfDebugConfig {
  const base = defaultUrdfDebugConfig();
  if (!isRecord(input)) return base;
  const meshStrategy = MESH_STRATEGIES.includes(input.meshStrategy as MeshStrategy)
    ? (input.meshStrategy as MeshStrategy)
    : base.meshStrategy;
  return {
    jointStateTopic: typeof input.jointStateTopic === 'string' ? input.jointStateTopic : base.jointStateTopic,
    urdfFileName: typeof input.urdfFileName === 'string' ? input.urdfFileName : base.urdfFileName,
    urdfFileContent:
      typeof input.urdfFileContent === 'string' ? input.urdfFileContent : base.urdfFileContent,
    meshStrategy,
    packageName: typeof input.packageName === 'string' ? input.packageName : base.packageName,
    packageBaseUrl: typeof input.packageBaseUrl === 'string' ? input.packageBaseUrl : base.packageBaseUrl,
    framePrefix: typeof input.framePrefix === 'string' ? input.framePrefix : base.framePrefix,
    rotateMeshVisuals:
      typeof input.rotateMeshVisuals === 'boolean' ? input.rotateMeshVisuals : base.rotateMeshVisuals,
    visualRpyOffset: parseRpy(input.visualRpyOffset, base.visualRpyOffset),
    fallbackMeshColor:
      typeof input.fallbackMeshColor === 'string' && input.fallbackMeshColor.length > 0
        ? input.fallbackMeshColor
        : base.fallbackMeshColor,
    showGrid: typeof input.showGrid === 'boolean' ? input.showGrid : base.showGrid,
    showAxes: typeof input.showAxes === 'boolean' ? input.showAxes : base.showAxes,
    manualJointPositions: parseManualJointPositions(input.manualJointPositions),
    followLiveJointState:
      typeof input.followLiveJointState === 'boolean'
        ? input.followLiveJointState
        : base.followLiveJointState,
    settingsPanelPercent: clampSettingsPanelPercent(
      typeof input.settingsPanelPercent === 'number' ? input.settingsPanelPercent : base.settingsPanelPercent,
      base.settingsPanelPercent,
    ),
  };
}

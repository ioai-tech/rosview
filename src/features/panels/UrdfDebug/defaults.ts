import type { MeshStrategy } from './recipe';

export interface UrdfDebugConfig {
  jointStateTopic: string;
  urdfFileName: string;
  urdfFileContent: string;
  meshStrategy: MeshStrategy;
  packageName: string;
  packageBaseUrl: string;
  framePrefix: string;
  rotateMeshVisuals: boolean;
  visualRpyOffset: [number, number, number];
  fallbackMeshColor: string;
  showGrid: boolean;
  showAxes: boolean;
  manualJointPositions: Record<string, number>;
  followLiveJointState: boolean;
  settingsPanelPercent: number;
}

export const DEFAULT_SETTINGS_PANEL_PERCENT = 35;
export const MIN_SETTINGS_PANEL_PERCENT = 22;
export const MAX_SETTINGS_PANEL_PERCENT = 58;

export const defaultUrdfDebugConfig = (): UrdfDebugConfig => ({
  jointStateTopic: '',
  urdfFileName: '',
  urdfFileContent: '',
  meshStrategy: 'localUpload',
  packageName: '',
  packageBaseUrl: '',
  framePrefix: '',
  rotateMeshVisuals: false,
  visualRpyOffset: [0, 0, 0],
  fallbackMeshColor: '#94a3b8',
  showGrid: true,
  showAxes: true,
  manualJointPositions: {},
  followLiveJointState: false,
  settingsPanelPercent: DEFAULT_SETTINGS_PANEL_PERCENT,
});

import {
  collectExtras,
  FOXGLOVE_PANEL_TITLE_KEY,
  mergeWithExtras,
  type FoxgloveAdapterDecoded,
  type FoxgloveAdapterState,
  type FoxgloveConfig,
  type PanelFoxgloveAdapter,
} from '../framework/foxgloveAdapter';
import { type UrdfDebugConfig } from './defaults';
import { parseUrdfDebugConfig } from './schema';

const KNOWN_KEYS = [
  'jointStateTopic',
  'urdfFileName',
  'urdfFileContent',
  'meshStrategy',
  'packageName',
  'packageBaseUrl',
  'framePrefix',
  'rotateMeshVisuals',
  'visualRpyOffset',
  'fallbackMeshColor',
  'showGrid',
  'showAxes',
  'manualJointPositions',
  'followLiveJointState',
  'settingsPanelPercent',
] as const;

function fromConfig(config: FoxgloveConfig): FoxgloveAdapterDecoded<UrdfDebugConfig> {
  const title =
    typeof config[FOXGLOVE_PANEL_TITLE_KEY] === 'string'
      ? config[FOXGLOVE_PANEL_TITLE_KEY]
      : undefined;
  return {
    config: parseUrdfDebugConfig(config),
    extras: collectExtras(config, KNOWN_KEYS),
    title,
  };
}

function toConfig(state: FoxgloveAdapterState<UrdfDebugConfig>): FoxgloveConfig {
  const known: FoxgloveConfig = {
    jointStateTopic: state.config.jointStateTopic,
    urdfFileName: state.config.urdfFileName,
    urdfFileContent: state.config.urdfFileContent,
    meshStrategy: state.config.meshStrategy,
    packageName: state.config.packageName,
    packageBaseUrl: state.config.packageBaseUrl,
    framePrefix: state.config.framePrefix,
    rotateMeshVisuals: state.config.rotateMeshVisuals,
    visualRpyOffset: state.config.visualRpyOffset,
    fallbackMeshColor: state.config.fallbackMeshColor,
    showGrid: state.config.showGrid,
    showAxes: state.config.showAxes,
    manualJointPositions: state.config.manualJointPositions,
    followLiveJointState: state.config.followLiveJointState,
    settingsPanelPercent: state.config.settingsPanelPercent,
  };
  if (state.title && state.title.length > 0) {
    known[FOXGLOVE_PANEL_TITLE_KEY] = state.title;
  }
  return mergeWithExtras(state.extras, known);
}

export const urdfDebugFoxgloveAdapter: PanelFoxgloveAdapter<UrdfDebugConfig> = {
  internalType: 'UrdfDebug',
  foxgloveTypes: ['UrdfDebug'],
  defaultFoxgloveType: 'UrdfDebug',
  fromConfig,
  toConfig,
};

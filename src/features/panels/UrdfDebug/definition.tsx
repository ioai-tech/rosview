import { lazy } from 'react';
import type { PanelDefinition } from '../framework/types';
import { PanelSuspense } from '../framework/panelSuspense';
import {
  FileInput,
  SettingsField,
  SettingsSection,
  SettingsSwitch,
  SettingsText,
  TopicAutocomplete,
} from '../framework/settings';
import { defaultUrdfDebugConfig, type UrdfDebugConfig } from './defaults';
import { parseUrdfDebugConfig } from './schema';

const UrdfDebugPanel = lazy(async () => {
  const m = await import('./Component');
  return { default: m.UrdfDebugPanel };
});

export const urdfDebugPanelDefinition: PanelDefinition<UrdfDebugConfig> = {
  type: 'UrdfDebug',
  defaultTitle: 'URDF Debug',
  createDefaultConfig: defaultUrdfDebugConfig,
  configSchema: { version: 1, parse: parseUrdfDebugConfig },
  schemaSupport: {
    supportedSchemas: ['sensor_msgs/msg/JointState'],
  },
  render: ({ player, panelId, config, setConfig }) => (
    <PanelSuspense>
      <UrdfDebugPanel player={player} panelId={panelId} config={config} setConfig={setConfig} />
    </PanelSuspense>
  ),
  renderSettings: ({ config, setConfig, topics }) => (
    <div className="space-y-2">
      <SettingsSection title="Source">
        <SettingsField label="JointState topic">
          <TopicAutocomplete
            value={config.jointStateTopic}
            onChange={(jointStateTopic) => setConfig({ ...config, jointStateTopic })}
            topics={topics}
            typeIncludes={['sensor_msgs/msg/JointState']}
            placeholder="/joint_states"
          />
        </SettingsField>
        <SettingsField label="Frame prefix">
          <SettingsText
            value={config.framePrefix}
            onChange={(framePrefix) => setConfig({ ...config, framePrefix })}
          />
        </SettingsField>
      </SettingsSection>
      <SettingsSection title="Display">
        <SettingsField label="Show grid" orientation="row">
          <SettingsSwitch
            checked={config.showGrid}
            onChange={(showGrid) => setConfig({ ...config, showGrid })}
          />
        </SettingsField>
        <SettingsField label="Show axes" orientation="row">
          <SettingsSwitch
            checked={config.showAxes}
            onChange={(showAxes) => setConfig({ ...config, showAxes })}
          />
        </SettingsField>
        <SettingsField label="Rotate mesh visuals" orientation="row">
          <SettingsSwitch
            checked={config.rotateMeshVisuals}
            onChange={(rotateMeshVisuals) => setConfig({ ...config, rotateMeshVisuals })}
          />
        </SettingsField>
      </SettingsSection>
      <SettingsSection title="URDF file">
        <SettingsField label="Upload URDF XML">
          <FileInput
            accept=".urdf,.xml,application/xml,text/xml"
            label={config.urdfFileContent ? 'Replace URDF…' : 'Choose URDF…'}
            onRead={(text, file) =>
              setConfig({
                ...config,
                urdfFileContent: text,
                urdfFileName: file.name,
              })
            }
          />
        </SettingsField>
      </SettingsSection>
    </div>
  ),
};

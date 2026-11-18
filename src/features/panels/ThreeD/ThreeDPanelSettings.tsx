import React from 'react';
import { useIntl } from 'react-intl';
import type { PanelSettingsContext } from '../framework/types';
import {
  FileInput,
  SettingsField,
  SettingsNumber,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
  SettingsText,
  SettingsTextArea,
  TopicAutocomplete,
  UrlInput,
} from '../framework/settings';
import type { ThreeDConfig, UrdfSourceType } from './defaults';

export function ThreeDPanelSettings({
  config,
  setConfig,
  topics,
}: PanelSettingsContext<ThreeDConfig>): React.ReactNode {
  const { formatMessage } = useIntl();
  const { urdf } = config;
  const preview = urdf.fileContent ? urdf.fileContent.slice(0, 4000) : '';

  const urdfSourceOptions = [
    {
      value: 'topic' as const,
      label: formatMessage({ id: 'panels.threeD.settings.enum.urdfSource.topic' }),
    },
    { value: 'url' as const, label: formatMessage({ id: 'panels.threeD.settings.enum.urdfSource.url' }) },
    {
      value: 'file' as const,
      label: formatMessage({ id: 'panels.threeD.settings.enum.urdfSource.file' }),
    },
  ];

  const skeletonStyleOptions = [
    {
      value: 'stick' as const,
      label: formatMessage({ id: 'panels.threeD.settings.enum.skeletonStyle.stick' }),
    },
    {
      value: 'line' as const,
      label: formatMessage({ id: 'panels.threeD.settings.enum.skeletonStyle.line' }),
    },
  ];

  return (
    <div className="space-y-2">
      <SettingsSection title={formatMessage({ id: 'panels.threeD.settings.section.display' })}>
        <SettingsField
          label={formatMessage({ id: 'panels.threeD.settings.field.showGrid' })}
          orientation="row"
        >
          <SettingsSwitch
            checked={config.showGrid}
            onChange={(showGrid) => setConfig({ ...config, showGrid })}
          />
        </SettingsField>
        <SettingsField
          label={formatMessage({ id: 'panels.threeD.settings.field.showAxes' })}
          orientation="row"
        >
          <SettingsSwitch
            checked={config.showAxes}
            onChange={(showAxes) => setConfig({ ...config, showAxes })}
          />
        </SettingsField>
        <SettingsField
          label={formatMessage({ id: 'panels.threeD.settings.field.showPlaceholder' })}
          orientation="row"
        >
          <SettingsSwitch
            checked={config.showPlaceholder}
            onChange={(showPlaceholder) => setConfig({ ...config, showPlaceholder })}
          />
        </SettingsField>
        <SettingsField
          label={formatMessage({ id: 'panels.threeD.settings.field.pointSize' }, { n: config.pointSize.toFixed(3) })}
          help={formatMessage({ id: 'panels.threeD.settings.field.pointSize.help' })}
        >
          <SettingsNumber
            value={config.pointSize}
            min={0.002}
            max={0.2}
            step={0.002}
            onChange={(pointSize) => setConfig({ ...config, pointSize })}
          />
        </SettingsField>
        <SettingsField
          label={formatMessage({ id: 'panels.threeD.settings.field.followFrame' })}
          help={formatMessage({ id: 'panels.threeD.settings.field.followFrame.help' })}
        >
          <SettingsText
            value={config.followFrame}
            placeholder="head_left"
            onChange={(followFrame) => setConfig({ ...config, followFrame: followFrame.trim() })}
          />
        </SettingsField>
      </SettingsSection>

      <SettingsSection
        title={formatMessage({ id: 'panels.threeD.settings.section.urdf' })}
        description={formatMessage({ id: 'panels.threeD.settings.section.urdf.description' })}
      >
        <SettingsField label={formatMessage({ id: 'panels.threeD.settings.field.urdfSource' })}>
          <SettingsSelect<UrdfSourceType>
            value={urdf.sourceType}
            options={urdfSourceOptions}
            onChange={(sourceType) =>
              setConfig({
                ...config,
                urdf: { ...urdf, sourceType },
              })
            }
          />
        </SettingsField>

        {urdf.sourceType === 'topic' && (
          <SettingsField
            label={formatMessage({ id: 'panels.threeD.settings.field.urdfTopic.label' })}
            help={formatMessage({ id: 'panels.threeD.settings.field.urdfTopic.help' })}
          >
            <TopicAutocomplete
              value={urdf.topic}
              onChange={(topic) => setConfig({ ...config, urdf: { ...urdf, topic } })}
              topics={topics}
              nameIncludes="robot_description"
              placeholder="/robot_description"
            />
          </SettingsField>
        )}

        {urdf.sourceType === 'url' && (
          <SettingsField
            label={formatMessage({ id: 'panels.threeD.settings.field.urdfUrl.label' })}
            help={formatMessage({ id: 'panels.threeD.settings.field.urdfUrl.help' })}
          >
            <UrlInput
              value={urdf.url}
              onChange={(url) => setConfig({ ...config, urdf: { ...urdf, url } })}
              placeholder="https://example.com/robot.urdf"
            />
          </SettingsField>
        )}

        {urdf.sourceType === 'file' && (
          <>
            <SettingsField label={formatMessage({ id: 'panels.threeD.settings.field.uploadUrdf' })}>
              <FileInput
                accept=".urdf,.xml,application/xml,text/xml"
                label={
                  urdf.fileContent
                    ? formatMessage({ id: 'panels.threeD.settings.field.fileInput.replace' })
                    : formatMessage({ id: 'panels.threeD.settings.field.fileInput.choose' })
                }
                onRead={(text) => setConfig({ ...config, urdf: { ...urdf, fileContent: text } })}
              />
            </SettingsField>
            {urdf.fileContent.length > 0 && (
              <SettingsField
                label={formatMessage(
                  { id: 'panels.threeD.settings.field.urdfPreview' },
                  { n: urdf.fileContent.length.toLocaleString() },
                )}
                help={formatMessage({ id: 'panels.threeD.settings.field.urdfPreview.help' })}
              >
                <SettingsTextArea
                  value={preview}
                  onChange={() => {
                    /* preview is read-only; ignore edits */
                  }}
                  rows={8}
                  disabled
                />
              </SettingsField>
            )}
          </>
        )}

      </SettingsSection>
      <SettingsSection
        title={formatMessage({ id: 'panels.threeD.settings.section.topics' })}
        description={formatMessage({ id: 'panels.threeD.settings.section.topics.description' })}
      >
        <SettingsField label={formatMessage({ id: 'panels.threeD.settings.field.topicSettings' })}>
          <SettingsTextArea
            value={config.topicSettings
              .map((entry) => `${entry.topic} ${entry.renderMode} ${entry.color}`)
              .join('\n')}
            onChange={(raw) => {
              const topicSettings = raw
                .split('\n')
                .map((line) => line.trim())
                .filter(Boolean)
                .map((line) => {
                  const [topic, renderModeRaw, color] = line.split(/\s+/);
                  const renderMode = [
                    'auto',
                    'path',
                    'pose',
                    'marker',
                    'laserScan',
                    'depth',
                    'skeleton',
                  ].includes(renderModeRaw ?? '')
                    ? (renderModeRaw as import('./defaults').ThreeDTopicRenderMode)
                    : 'auto';
                  return {
                    topic: topic ?? '',
                    enabled: true,
                    renderMode,
                    color: color ?? '#38bdf8',
                  };
                })
                .filter((entry) => entry.topic.length > 0);
              setConfig({ ...config, topicSettings });
            }}
            rows={7}
            placeholder="/planned_path path #38bdf8"
          />
        </SettingsField>
      </SettingsSection>
      <SettingsSection
        title={formatMessage({ id: 'panels.threeD.settings.section.bvh' })}
        description={formatMessage({ id: 'panels.threeD.settings.section.bvh.description' })}
      >
        <SettingsField
          label={formatMessage({ id: 'panels.threeD.settings.field.skeletonEnabled' })}
          orientation="row"
        >
          <SettingsSwitch
            checked={config.skeleton.enabled}
            onChange={(enabled) => setConfig({ ...config, skeleton: { ...config.skeleton, enabled } })}
          />
        </SettingsField>
        <SettingsField label={formatMessage({ id: 'panels.threeD.settings.field.skeletonStyle' })}>
          <SettingsSelect<'line' | 'stick'>
            value={config.skeleton.renderMode}
            options={skeletonStyleOptions}
            onChange={(renderMode) => setConfig({ ...config, skeleton: { ...config.skeleton, renderMode } })}
          />
        </SettingsField>
        <SettingsField
          label={formatMessage(
            { id: 'panels.threeD.settings.field.skeletonScale' },
            { n: config.skeleton.scale.toFixed(4) },
          )}
          help={formatMessage({ id: 'panels.threeD.settings.field.skeletonScale.help' })}
        >
          <SettingsNumber
            value={config.skeleton.scale}
            min={0.0001}
            max={10}
            step={0.0001}
            onChange={(scale) => setConfig({ ...config, skeleton: { ...config.skeleton, scale } })}
          />
        </SettingsField>
        <SettingsField
          label={formatMessage({ id: 'panels.threeD.settings.field.yUpToZUp' })}
          orientation="row"
        >
          <SettingsSwitch
            checked={config.skeleton.yUpToZUp}
            onChange={(yUpToZUp) => setConfig({ ...config, skeleton: { ...config.skeleton, yUpToZUp } })}
          />
        </SettingsField>
        <SettingsField
          label={formatMessage({ id: 'panels.threeD.settings.field.flipYAfterConversion' })}
          orientation="row"
        >
          <SettingsSwitch
            checked={config.skeleton.flipY}
            onChange={(flipY) => setConfig({ ...config, skeleton: { ...config.skeleton, flipY } })}
          />
        </SettingsField>
        <SettingsField label={formatMessage({ id: 'panels.threeD.settings.field.skeletonColor' })}>
          <SettingsText
            value={config.skeleton.color}
            onChange={(color) => setConfig({ ...config, skeleton: { ...config.skeleton, color } })}
            placeholder="#22c55e"
          />
        </SettingsField>
      </SettingsSection>
    </div>
  );
}

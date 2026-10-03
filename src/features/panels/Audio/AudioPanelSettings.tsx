import React from 'react';
import { useIntl } from 'react-intl';
import type { TopicInfo } from '@/core/types/ros';
import type { PanelSettingsContext } from '../framework/types';
import {
  SettingsField,
  SettingsNumber,
  SettingsSection,
  SettingsSwitch,
  TopicAutocomplete,
} from '../framework/settings';
import {
  isAudioPanelMainTopicSchema,
  isAudioCommonInfoSchema,
} from '@/shared/ros/rosMessageTypes';
import type { AudioConfig } from './defaults';

function filterMainAudioTopics(topics: ReadonlyArray<TopicInfo>): TopicInfo[] {
  return topics.filter((t) => isAudioPanelMainTopicSchema(t.type));
}

function filterInfoTopics(topics: ReadonlyArray<TopicInfo>): TopicInfo[] {
  return topics.filter((t) => isAudioCommonInfoSchema(t.type));
}

export function AudioPanelSettings({
  config,
  setConfig,
  topics,
}: PanelSettingsContext<AudioConfig>): React.ReactNode {
  const { formatMessage } = useIntl();
  return (
    <div className="space-y-2">
      <SettingsSection title={formatMessage({ id: 'panels.audio.settings.section.source' })}>
        <SettingsField
          label={formatMessage({ id: 'panels.audio.settings.field.audioTopic.label' })}
          help={formatMessage({ id: 'panels.audio.settings.field.audioTopic.help' })}
        >
          <TopicAutocomplete
            value={config.topic}
            onChange={(topic) => setConfig({ ...config, topic })}
            topics={filterMainAudioTopics(topics)}
            placeholder={formatMessage({ id: 'panels.audio.settings.field.audioTopic.placeholder' })}
          />
        </SettingsField>
        <SettingsField
          label={formatMessage({ id: 'panels.audio.settings.field.audioInfoTopic.label' })}
          help={formatMessage({ id: 'panels.audio.settings.field.audioInfoTopic.help' })}
        >
          <TopicAutocomplete
            value={config.audioInfoTopic}
            onChange={(audioInfoTopic) => setConfig({ ...config, audioInfoTopic })}
            topics={filterInfoTopics(topics)}
            placeholder={formatMessage({ id: 'panels.audio.settings.field.audioInfoTopic.placeholder' })}
          />
        </SettingsField>
      </SettingsSection>
      <SettingsSection title={formatMessage({ id: 'panels.audio.settings.section.defaults' })}>
        <SettingsField
          label={formatMessage(
            { id: 'panels.audio.settings.field.defaultSampleRate' },
            { rate: config.defaultSampleRate },
          )}
        >
          <SettingsNumber
            value={config.defaultSampleRate}
            min={8000}
            max={192000}
            step={1000}
            onChange={(defaultSampleRate) => setConfig({ ...config, defaultSampleRate })}
          />
        </SettingsField>
        <SettingsField
          label={formatMessage({ id: 'panels.audio.settings.field.defaultChannels' }, { n: config.defaultChannels })}
        >
          <SettingsNumber
            value={config.defaultChannels}
            min={1}
            max={32}
            step={1}
            onChange={(defaultChannels) => setConfig({ ...config, defaultChannels })}
          />
        </SettingsField>
        <SettingsField
          label={formatMessage({ id: 'panels.audio.settings.field.defaultSampleFormat.label' })}
          help={formatMessage({ id: 'panels.audio.settings.field.defaultSampleFormat.help' })}
        >
          <input
            type="text"
            value={config.defaultSampleFormat}
            onChange={(e) => setConfig({ ...config, defaultSampleFormat: e.target.value })}
            className="w-full border border-input rounded-sm bg-background px-2 py-1 text-xs font-mono"
          />
        </SettingsField>
      </SettingsSection>
      <SettingsSection title={formatMessage({ id: 'panels.audio.settings.section.playback' })}>
        <SettingsField
          label={formatMessage({ id: 'panels.audio.settings.field.volume' }, { pct: Math.round(config.volume * 100) })}
        >
          <SettingsNumber
            value={config.volume}
            min={0}
            max={1}
            step={0.05}
            onChange={(volume) => setConfig({ ...config, volume })}
          />
        </SettingsField>
        <SettingsField label={formatMessage({ id: 'panels.audio.settings.field.mute' })} orientation="row">
          <SettingsSwitch checked={config.mute} onChange={(mute) => setConfig({ ...config, mute })} />
        </SettingsField>
      </SettingsSection>
      <SettingsSection title={formatMessage({ id: 'panels.audio.settings.section.display' })}>
        <SettingsField label={formatMessage({ id: 'panels.audio.settings.field.waveformWindow' })}>
          <SettingsNumber
            value={config.waveformWindowSec}
            min={0.5}
            max={30}
            step={0.5}
            onChange={(waveformWindowSec) => setConfig({ ...config, waveformWindowSec })}
          />
        </SettingsField>
        <SettingsField label={formatMessage({ id: 'panels.audio.settings.field.waveformColor' })}>
          <input
            type="color"
            value={config.waveformColor.startsWith('#') ? config.waveformColor : '#22c55e'}
            onChange={(e) => setConfig({ ...config, waveformColor: e.target.value })}
            className="h-8 w-full max-w-24 rounded border border-input bg-background"
          />
        </SettingsField>
      </SettingsSection>
    </div>
  );
}

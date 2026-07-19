import React, { useMemo } from 'react';
import { useIntl } from 'react-intl';
import type { ImageColorMode } from './core/imageColorMode';
import type { PanelSettingsContext } from '../framework/types';
import {
  SettingsField,
  SettingsSection,
  SettingsSelect,
  SettingsSlider,
  SettingsSwitch,
  SettingsText,
  TopicAutocomplete,
} from '../framework/settings';
import { messageBus } from '@/core/pipeline/messageBus';
import { useTopicSeq } from '@/core/pipeline/useMessageBus';
import { isRawImageMessage, isRawImageTopicSchema, isCompressedImageMessage, depthEncodingFromFormat, IMAGE_PANEL_TOPIC_INCLUDES } from './core/imageTypes';
import { applyDepthTopicPreset, defaultDepthMaxValue, defaultDepthMinValue } from './core/depthColorDefaults';
import type { ImageConfig } from './defaults';
import { isImageAnnotationsSchema } from './core/imageAnnotations';

const DEPTH_ENCODINGS = new Set(['mono16', '16uc1', '32fc1']);

/**
 * Raw encodings that have direct colour in the pixel data — no colormap needed,
 * but showing the Color section still makes sense for the `rgba-fields` mode.
 */
const COLOUR_ENCODINGS = new Set(['rgb8', 'bgr8', 'rgba8', 'bgra8', 'mono8', '8uc1']);

/** Slider bounds per depth encoding. */
function depthSliderBounds(encoding: string): { min: number; max: number } {
  const lower = encoding.trim().toLowerCase();
  if (lower === '32fc1') {
    return { min: 0, max: 10 };
  }
  return { min: 0, max: 65535 };
}

/** Hook: returns the normalised encoding string for the last message on a topic, or null. */
function useLastFrameEncoding(topic: string): string | null {
  const seq = useTopicSeq(topic);
  void seq;
  if (!topic) return null;
  const event = messageBus.getLastMessage(topic);
  if (!event) return null;
  const msg = event.message;
  if (isRawImageMessage(msg)) {
    return msg.encoding.trim().toLowerCase();
  }
  if (isCompressedImageMessage(msg)) {
    return depthEncodingFromFormat(msg.format);
  }
  return null;
}


export function ImagePanelSettings({
  config,
  setConfig,
  topics,
}: PanelSettingsContext<ImageConfig>): React.ReactNode {
  const { formatMessage } = useIntl();
  const fitModeOptions = useMemo(
    () =>
      [
        { value: 'contain' as const, label: formatMessage({ id: 'panels.image.settings.enum.fitMode.contain' }) },
        { value: 'cover' as const, label: formatMessage({ id: 'panels.image.settings.enum.fitMode.cover' }) },
      ] as const,
    [formatMessage],
  );
  const colorModeOptions = useMemo(
    (): { value: ImageColorMode; label: string }[] => [
      { value: 'colormap', label: formatMessage({ id: 'panels.image.settings.enum.colorMode.colormap' }) },
      { value: 'gradient', label: formatMessage({ id: 'panels.image.settings.enum.colorMode.gradient' }) },
      { value: 'flat', label: formatMessage({ id: 'panels.image.settings.enum.colorMode.flat' }) },
      { value: 'rgb', label: formatMessage({ id: 'panels.image.settings.enum.colorMode.rgb' }) },
      { value: 'rgba', label: formatMessage({ id: 'panels.image.settings.enum.colorMode.rgba' }) },
      { value: 'rgba-fields', label: formatMessage({ id: 'panels.image.settings.enum.colorMode.rgbaFields' }) },
    ],
    [formatMessage],
  );
  const colorMapOptions = useMemo(
    () => [
      { value: 'turbo', label: formatMessage({ id: 'panels.image.settings.enum.colorMap.turbo' }) },
      { value: 'rainbow', label: formatMessage({ id: 'panels.image.settings.enum.colorMap.rainbow' }) },
    ],
    [formatMessage],
  );

  const selectedTopicInfo = useMemo(
    () => topics.find((t) => t.name === config.topic),
    [topics, config.topic],
  );
  const topicSchemaIsRawImage = Boolean(selectedTopicInfo && isRawImageTopicSchema(selectedTopicInfo.type));

  const lastEncoding = useLastFrameEncoding(config.topic);
  const isDepthEncoding = lastEncoding != null && DEPTH_ENCODINGS.has(lastEncoding);
  const isColourEncoding = lastEncoding != null && COLOUR_ENCODINGS.has(lastEncoding);
  /** Prefer schema so switching compressed → raw depth updates the panel before any frame is cached. */
  const showColorSection = topicSchemaIsRawImage || lastEncoding != null;
  const awaitingRawFrame = topicSchemaIsRawImage && lastEncoding == null;
  const showColormapOptions = isDepthEncoding || awaitingRawFrame;
  const encodingForDepthSliders = isDepthEncoding && lastEncoding ? lastEncoding : awaitingRawFrame ? 'mono16' : null;
  const sliderBounds =
    encodingForDepthSliders != null && DEPTH_ENCODINGS.has(encodingForDepthSliders)
      ? depthSliderBounds(encodingForDepthSliders)
      : { min: 0, max: 65535 };
  const sliderDefaultMax =
    encodingForDepthSliders != null
      ? defaultDepthMaxValue(encodingForDepthSliders, config.topic)
      : sliderBounds.max;
  const sliderDefaultMin =
    encodingForDepthSliders != null
      ? defaultDepthMinValue(encodingForDepthSliders, config.topic)
      : sliderBounds.min;

  const applyTopicChange = (topic: string) => {
    setConfig(applyDepthTopicPreset(topic, config));
  };

  return (
    <div className="space-y-2">
        <SettingsSection title={formatMessage({ id: 'panels.image.settings.section.source' })}>
          <SettingsField
            label={formatMessage({ id: 'panels.image.settings.field.topic.label' })}
            help={formatMessage({ id: 'panels.image.settings.field.topic.help' })}
          >
            <TopicAutocomplete
              value={config.topic}
              onChange={applyTopicChange}
              topics={topics}
              typeIncludes={[...IMAGE_PANEL_TOPIC_INCLUDES]}
              placeholder={formatMessage({ id: 'panels.image.settings.field.topic.placeholder' })}
            />
          </SettingsField>
          <SettingsField
            label={formatMessage({ id: 'panels.image.settings.field.annotationTopic.label' })}
            help={formatMessage({ id: 'panels.image.settings.field.annotationTopic.help' })}
          >
            <TopicAutocomplete
              value={config.annotationTopic}
              onChange={(annotationTopic) => setConfig({ ...config, annotationTopic })}
              topics={topics}
              topicTypeMatches={isImageAnnotationsSchema}
              placeholder={formatMessage({
                id: 'panels.image.settings.field.annotationTopic.placeholder',
              })}
            />
          </SettingsField>
        </SettingsSection>

        <SettingsSection title={formatMessage({ id: 'panels.image.settings.section.display' })}>
          <SettingsField
            label={formatMessage({ id: 'panels.image.settings.field.showStatusText' })}
            orientation="row"
          >
            <SettingsSwitch
              checked={config.showStatusText}
              onChange={(showStatusText) => setConfig({ ...config, showStatusText })}
            />
          </SettingsField>
          <SettingsField label={formatMessage({ id: 'panels.image.settings.field.backgroundColor' })}>
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={config.backgroundColor}
                onChange={(e) => setConfig({ ...config, backgroundColor: e.target.value })}
                className="h-7 w-10 shrink-0 cursor-pointer rounded border border-input bg-background p-0.5"
              />
              <SettingsText
                value={config.backgroundColor}
                onChange={(backgroundColor) => setConfig({ ...config, backgroundColor })}
                placeholder="#000000"
              />
            </div>
          </SettingsField>
          <SettingsField label={formatMessage({ id: 'panels.image.settings.field.fitMode' })}>
            <SettingsSelect
              value={config.fitMode}
              options={fitModeOptions}
              onChange={(fitMode) =>
                setConfig({ ...config, fitMode: fitMode === 'cover' ? 'cover' : 'contain' })
              }
            />
          </SettingsField>
          <SettingsField label={formatMessage({ id: 'panels.image.settings.field.smoothing' })} orientation="row">
            <SettingsSwitch
              checked={config.smoothing}
              onChange={(smoothing) => setConfig({ ...config, smoothing })}
            />
          </SettingsField>
        </SettingsSection>

        <SettingsSection title={formatMessage({ id: 'panels.image.settings.section.transform' })}>
          <SettingsField label={formatMessage({ id: 'panels.image.settings.field.flipHorizontal' })} orientation="row">
            <SettingsSwitch
              checked={config.flipHorizontal}
              onChange={(flipHorizontal) => setConfig({ ...config, flipHorizontal })}
            />
          </SettingsField>
          <SettingsField label={formatMessage({ id: 'panels.image.settings.field.flipVertical' })} orientation="row">
            <SettingsSwitch
              checked={config.flipVertical}
              onChange={(flipVertical) => setConfig({ ...config, flipVertical })}
            />
          </SettingsField>
          <SettingsField
            label={formatMessage({ id: 'panels.image.settings.field.rotation' })}
            help={formatMessage({ id: 'panels.image.settings.field.rotation.help' })}
          >
            <SettingsSlider
              value={config.rotation}
              onChange={(rotation) => setConfig({ ...config, rotation })}
              min={0}
              max={360}
              step={1}
            />
          </SettingsField>
        </SettingsSection>

        {showColorSection && (
          <SettingsSection title={formatMessage({ id: 'panels.image.settings.section.color' })}>
            {awaitingRawFrame && (
              <div className="text-[10px] text-muted-foreground px-0.5">
                {formatMessage({ id: 'panels.image.settings.colorHint.encodingPending' })}
              </div>
            )}
            {isColourEncoding && !isDepthEncoding && (
              <div className="text-[10px] text-muted-foreground px-0.5">
                {formatMessage({ id: 'panels.image.settings.colorHint.directRgb' }, { encoding: lastEncoding ?? '' })}
              </div>
            )}
            {showColormapOptions && (
              <>
                <SettingsField label={formatMessage({ id: 'panels.image.settings.field.colorMode' })}>
                  <SettingsSelect
                    value={config.colorMode}
                    options={colorModeOptions}
                    onChange={(colorMode) => setConfig({ ...config, colorMode })}
                  />
                </SettingsField>
                {config.colorMode === 'flat' && (
                  <SettingsField label={formatMessage({ id: 'panels.image.settings.field.flatColor' })}>
                    <div className="flex items-center gap-2">
                      <input
                        type="color"
                        value={config.flatColor}
                        onChange={(e) => setConfig({ ...config, flatColor: e.target.value })}
                        className="h-7 w-10 shrink-0 cursor-pointer rounded border border-input bg-background p-0.5"
                      />
                      <SettingsText
                        value={config.flatColor}
                        onChange={(flatColor) => setConfig({ ...config, flatColor })}
                        placeholder="#ffffff"
                      />
                    </div>
                  </SettingsField>
                )}
                {config.colorMode === 'gradient' && (
                  <>
                    <SettingsField label={formatMessage({ id: 'panels.image.settings.field.gradientStart' })}>
                      <div className="flex items-center gap-2">
                        <input
                          type="color"
                          value={config.gradient[0]}
                          onChange={(e) => setConfig({ ...config, gradient: [e.target.value, config.gradient[1]] })}
                          className="h-7 w-10 shrink-0 cursor-pointer rounded border border-input bg-background p-0.5"
                        />
                        <SettingsText
                          value={config.gradient[0]}
                          onChange={(c0) => setConfig({ ...config, gradient: [c0, config.gradient[1]] })}
                          placeholder="#000000"
                        />
                      </div>
                    </SettingsField>
                    <SettingsField label={formatMessage({ id: 'panels.image.settings.field.gradientEnd' })}>
                      <div className="flex items-center gap-2">
                        <input
                          type="color"
                          value={config.gradient[1]}
                          onChange={(e) => setConfig({ ...config, gradient: [config.gradient[0], e.target.value] })}
                          className="h-7 w-10 shrink-0 cursor-pointer rounded border border-input bg-background p-0.5"
                        />
                        <SettingsText
                          value={config.gradient[1]}
                          onChange={(c1) => setConfig({ ...config, gradient: [config.gradient[0], c1] })}
                          placeholder="#ffffff"
                        />
                      </div>
                    </SettingsField>
                  </>
                )}
                {config.colorMode === 'colormap' && (
                  <SettingsField label={formatMessage({ id: 'panels.image.settings.field.colormap' })}>
                    <SettingsSelect
                      value={config.colorMap}
                      options={colorMapOptions}
                      onChange={(colorMap) =>
                        setConfig({ ...config, colorMap: colorMap === 'rainbow' ? 'rainbow' : 'turbo' })
                      }
                    />
                  </SettingsField>
                )}
                {(config.colorMode === 'colormap' || config.colorMode === 'rgb') && (
                  <SettingsField
                    label={formatMessage({ id: 'panels.image.settings.field.opacity' })}
                    help={formatMessage({ id: 'panels.image.settings.field.opacity.help' })}
                  >
                    <SettingsSlider
                      value={config.explicitAlpha}
                      onChange={(explicitAlpha) =>
                        setConfig({ ...config, explicitAlpha: Math.max(0, Math.min(1, explicitAlpha)) })
                      }
                      min={0}
                      max={1}
                      step={0.01}
                    />
                  </SettingsField>
                )}
                {(config.colorMode === 'gradient' || config.colorMode === 'colormap') && (
                  <>
                    <SettingsField
                      label={formatMessage({ id: 'panels.image.settings.field.minValue' })}
                      help={formatMessage(
                        { id: 'panels.image.settings.field.minValue.help' },
                        { min: sliderBounds.min, max: sliderBounds.max },
                      )}
                    >
                      <SettingsSlider
                        value={config.minValue ?? sliderDefaultMin}
                        onChange={(minValue) => setConfig({ ...config, minValue })}
                        min={sliderBounds.min}
                        max={sliderBounds.max}
                        step={encodingForDepthSliders === '32fc1' ? 0.01 : 1}
                      />
                    </SettingsField>
                    <SettingsField
                      label={formatMessage({ id: 'panels.image.settings.field.maxValue' })}
                      help={formatMessage(
                        { id: 'panels.image.settings.field.maxValue.help' },
                        { min: sliderBounds.min, max: sliderBounds.max },
                      )}
                    >
                      <SettingsSlider
                        value={config.maxValue ?? sliderDefaultMax}
                        onChange={(maxValue) => setConfig({ ...config, maxValue })}
                        min={sliderBounds.min}
                        max={sliderBounds.max}
                        step={encodingForDepthSliders === '32fc1' ? 0.01 : 1}
                      />
                    </SettingsField>
                  </>
                )}
              </>
            )}
          </SettingsSection>
        )}
      </div>
  );
}

import {
  collectExtras,
  FOXGLOVE_PANEL_TITLE_KEY,
  mergeWithExtras,
  type FoxgloveAdapterDecoded,
  type FoxgloveAdapterState,
  type FoxgloveConfig,
  type PanelFoxgloveAdapter,
} from '../framework/foxgloveAdapter';
import { type ImageConfig } from './defaults';
import { parseImageConfig } from './schema';

/**
 * Handles both Foxglove `Image` and `Canvas` panels. Canvas is Foxglove's
 * hardware-accelerated compressed-image viewer; we render it with the same
 * Image panel, but the `defaultFoxgloveType` stays `Image` so panels
 * originated in our UI export as `Image`. When the imported id is `Canvas!...`
 * the caller preserves that on the panel state so re-export keeps `Canvas`.
 */

const KNOWN_KEYS = [
  'topic',
  'topicPath',
  'annotationTopic',
  'annotationVisible',
  'meshTopic',
  'meshVisible',
  'backgroundColor',
  'showStatusText',
  'fitMode',
  'smoothing',
  'flipHorizontal',
  'flipVertical',
  'rotation',
  'colorMode',
  'colorMap',
  'gradient',
  'flatColor',
  'explicitAlpha',
  'minValue',
  'maxValue',
] as const;

function fromConfig(config: FoxgloveConfig): FoxgloveAdapterDecoded<ImageConfig> {
  const merged: FoxgloveConfig = { ...config };
  if (typeof merged.topicPath === 'string' && typeof merged.topic !== 'string') {
    merged.topic = merged.topicPath;
  }
  const title = typeof config[FOXGLOVE_PANEL_TITLE_KEY] === 'string'
    ? (config[FOXGLOVE_PANEL_TITLE_KEY])
    : undefined;
  return {
    config: parseImageConfig(merged),
    extras: collectExtras(config, KNOWN_KEYS),
    title,
  };
}

function toConfigForFoxgloveType(
  foxgloveType: string,
  state: FoxgloveAdapterState<ImageConfig>,
): FoxgloveConfig {
  const c = state.config;
  const known: FoxgloveConfig = {
    ...(foxgloveType === 'Canvas'
      ? { topicPath: c.topic }
      : { topic: c.topic }),
    backgroundColor: c.backgroundColor,
    annotationTopic: c.annotationTopic,
    annotationVisible: c.annotationVisible,
    meshTopic: c.meshTopic,
    meshVisible: c.meshVisible,
    showStatusText: c.showStatusText,
    fitMode: c.fitMode,
    smoothing: c.smoothing,
    flipHorizontal: c.flipHorizontal,
    flipVertical: c.flipVertical,
    rotation: c.rotation,
    colorMode: c.colorMode,
    colorMap: c.colorMap,
    gradient: c.gradient,
    flatColor: c.flatColor,
    explicitAlpha: c.explicitAlpha,
    minValue: c.minValue,
    maxValue: c.maxValue,
  };
  if (state.title && state.title.length > 0) {
    known[FOXGLOVE_PANEL_TITLE_KEY] = state.title;
  }
  return mergeWithExtras(state.extras, known);
}

export const imageFoxgloveAdapter: PanelFoxgloveAdapter<ImageConfig> = {
  internalType: 'Image',
  foxgloveTypes: ['Image', 'Canvas'],
  defaultFoxgloveType: 'Image',
  fromConfig,
  toConfig: (state) => toConfigForFoxgloveType('Image', state),
};

export const canvasFoxgloveAdapter: PanelFoxgloveAdapter<ImageConfig> = {
  internalType: 'Image',
  foxgloveTypes: ['Canvas'],
  defaultFoxgloveType: 'Canvas',
  fromConfig,
  toConfig: (state) => toConfigForFoxgloveType('Canvas', state),
};

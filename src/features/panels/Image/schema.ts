import type { ImageColorMode } from './core/imageColorMode';
import { isRecord } from '../framework/types';
import { defaultImageConfig, type ImageConfig } from './defaults';

const COLOR_MODES: ReadonlySet<string> = new Set([
  'flat',
  'gradient',
  'colormap',
  'rgb',
  'rgba',
  'rgba-fields',
]);

function parseRotation(input: unknown): number {
  const base = defaultImageConfig().rotation;
  const n = typeof input === 'number' ? input : Number(input);
  if (!Number.isFinite(n)) {
    return base;
  }
  let r = n % 360;
  if (r < 0) {
    r += 360;
  }
  return Math.round(r * 1000) / 1000;
}

function parseColorMode(input: unknown): ImageColorMode {
  if (typeof input === 'string' && COLOR_MODES.has(input)) {
    return input as ImageColorMode;
  }
  return defaultImageConfig().colorMode;
}

function parseGradient(input: unknown): [string, string] {
  const base = defaultImageConfig().gradient;
  if (!Array.isArray(input) || input.length < 2) {
    return base;
  }
  const a = typeof input[0] === 'string' ? input[0] : base[0];
  const b = typeof input[1] === 'string' ? input[1] : base[1];
  return [a, b];
}

function parseOptionalFiniteNumber(input: unknown): number | undefined {
  if (input === null || input === undefined || input === '') {
    return undefined;
  }
  const n = typeof input === 'number' ? input : Number(input);
  return Number.isFinite(n) ? n : undefined;
}

export function parseImageConfig(input: unknown): ImageConfig {
  const base = defaultImageConfig();
  if (!isRecord(input)) return base;

  return {
    topic: typeof input.topic === 'string' ? input.topic : base.topic,
    annotationTopic:
      typeof input.annotationTopic === 'string' ? input.annotationTopic : base.annotationTopic,
    meshTopic: typeof input.meshTopic === 'string' ? input.meshTopic : base.meshTopic,
    backgroundColor:
      typeof input.backgroundColor === 'string' ? input.backgroundColor : base.backgroundColor,
    showStatusText:
      typeof input.showStatusText === 'boolean' ? input.showStatusText : base.showStatusText,
    fitMode: input.fitMode === 'cover' ? 'cover' : 'contain',
    smoothing: typeof input.smoothing === 'boolean' ? input.smoothing : base.smoothing,
    flipHorizontal: typeof input.flipHorizontal === 'boolean' ? input.flipHorizontal : base.flipHorizontal,
    flipVertical: typeof input.flipVertical === 'boolean' ? input.flipVertical : base.flipVertical,
    rotation: parseRotation(input.rotation),
    colorMode: parseColorMode(input.colorMode),
    colorMap: input.colorMap === 'rainbow' ? 'rainbow' : 'turbo',
    gradient: parseGradient(input.gradient),
    flatColor: typeof input.flatColor === 'string' ? input.flatColor : base.flatColor,
    explicitAlpha:
      typeof input.explicitAlpha === 'number' && Number.isFinite(input.explicitAlpha)
        ? Math.max(0, Math.min(1, input.explicitAlpha))
        : base.explicitAlpha,
    minValue: parseOptionalFiniteNumber(input.minValue),
    maxValue: parseOptionalFiniteNumber(input.maxValue),
  };
}

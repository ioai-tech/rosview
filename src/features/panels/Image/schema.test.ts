import { describe, expect, it } from 'vitest';
import { parseImageConfig } from './schema';
import { defaultImageConfig } from './defaults';

describe('parseImageConfig', () => {
  it('returns defaults for empty input', () => {
    const config = parseImageConfig({});
    const defaults = defaultImageConfig();
    expect(config).toEqual(defaults);
  });

  it('parses backgroundColor', () => {
    const config = parseImageConfig({ backgroundColor: '#ff0000' });
    expect(config.backgroundColor).toBe('#ff0000');
  });

  it('falls back to default backgroundColor for invalid input', () => {
    const config = parseImageConfig({ backgroundColor: 42 });
    expect(config.backgroundColor).toBe(defaultImageConfig().backgroundColor);
  });

  it('parses an explicit foxglove.ImageAnnotations topic', () => {
    expect(parseImageConfig({
      annotationTopic: '/warehouse/front_camera/annotations',
    }).annotationTopic).toBe('/warehouse/front_camera/annotations');
  });

  it('parses an explicit foxglove.SceneUpdate mesh topic', () => {
    expect(parseImageConfig({ meshTopic: '/warehouse/safety_zones' }).meshTopic).toBe(
      '/warehouse/safety_zones',
    );
  });

  it('does not expose removed overlay/annotation fields from legacy input', () => {
    const config = parseImageConfig({
      overlays: [{ topic: '/x', opacity: 1, blendMode: 'alpha', enabled: true }],
      annotationTopics: ['/a'],
      syncTimestamps: true,
      annotationSyncToleranceMs: 500,
    });
    expect(Object.keys(config)).not.toContain('overlays');
    expect(Object.keys(config)).not.toContain('annotationTopics');
    expect(Object.keys(config)).not.toContain('syncTimestamps');
    expect(Object.keys(config)).not.toContain('annotationSyncToleranceMs');
  });

  it('does not expose removed fields (calibrationTopic, showPixelInspector, showTimestamp, colorField)', () => {
    const config = parseImageConfig({
      calibrationTopic: '/cam/info',
      showPixelInspector: false,
      showTimestamp: true,
      colorField: 'depth',
    });
    expect(Object.keys(config).includes('calibrationTopic')).toBe(false);
    expect(Object.keys(config).includes('showPixelInspector')).toBe(false);
    expect(Object.keys(config).includes('showTimestamp')).toBe(false);
    expect(Object.keys(config).includes('colorField')).toBe(false);
  });

  it('parses minValue and maxValue as optional numbers', () => {
    const config = parseImageConfig({ minValue: 100, maxValue: 5000 });
    expect(config.minValue).toBe(100);
    expect(config.maxValue).toBe(5000);
  });

  it('returns undefined for minValue/maxValue when empty string provided', () => {
    const config = parseImageConfig({ minValue: '', maxValue: null });
    expect(config.minValue).toBeUndefined();
    expect(config.maxValue).toBeUndefined();
  });

  it('parses gradient as tuple', () => {
    const config = parseImageConfig({ gradient: ['#aabbcc', '#ddeeff'] });
    expect(config.gradient).toEqual(['#aabbcc', '#ddeeff']);
  });

  it('falls back to default gradient for invalid input', () => {
    const config = parseImageConfig({ gradient: 'notarray' });
    expect(config.gradient).toEqual(defaultImageConfig().gradient);
  });

  it('parses rotation correctly', () => {
    expect(parseImageConfig({ rotation: 90 }).rotation).toBe(90);
    expect(parseImageConfig({ rotation: 180 }).rotation).toBe(180);
    expect(parseImageConfig({ rotation: 270 }).rotation).toBe(270);
    expect(parseImageConfig({ rotation: 45 }).rotation).toBe(45);
    expect(parseImageConfig({ rotation: 33.5 }).rotation).toBe(33.5);
    expect(parseImageConfig({ rotation: 450 }).rotation).toBe(90);
    expect(parseImageConfig({ rotation: -90 }).rotation).toBe(270);
    expect(parseImageConfig({ rotation: 'invalid' }).rotation).toBe(defaultImageConfig().rotation);
  });
});

import { describe, expect, it } from 'vitest';
import { buildPlotTooltipRows, displaySeriesLabels, formatPlotValue } from './plotSeriesDisplay';

describe('displaySeriesLabels', () => {
  it('uses joint names when one field is plotted', () => {
    expect(displaySeriesLabels(['position[0] (proximal_pitch)', 'position[1] (elbow)'])).toEqual([
      'proximal_pitch',
      'elbow',
    ]);
  });
  it('appends the field when several fields are plotted', () => {
    expect(displaySeriesLabels(['position[0] (a)', 'velocity[0] (a)'])).toEqual([
      'a · position',
      'a · velocity',
    ]);
  });
  it('names known fields in the UI language and keeps other fields as they are', () => {
    const zh = { position: '位置', velocity: '速度', effort: '力矩' };
    expect(displaySeriesLabels(['position[0] (a)', 'velocity[0] (a)', 'accel[0] (a)'], zh)).toEqual([
      'a · 位置',
      'a · 速度',
      'a · accel',
    ]);
    // One field: the joint name alone, as without field labels.
    expect(displaySeriesLabels(['position[0] (a)'], zh)).toEqual(['a']);
  });
  it('leaves unnamed labels untouched', () => {
    expect(displaySeriesLabels(['position[0]', '/t · x'])).toEqual(['position[0]', '/t · x']);
  });
});

describe('formatPlotValue', () => {
  it('limits precision and switches to exponent for extremes', () => {
    expect(formatPlotValue(1.234567)).toBe('1.2346');
    expect(formatPlotValue(0)).toBe('0');
    expect(formatPlotValue(0.00001234)).toBe('1.234e-5');
  });
});

describe('buildPlotTooltipRows', () => {
  const series = [
    { label: 'a', color: '#1', unit: 'rad', show: true },
    { label: 'b', color: '#2', show: false },
    { label: 'c', color: '#3', show: true },
  ];
  it('lists visible series with values and units, skipping gaps', () => {
    const data = [[0, 1], [0.5, 1.5], [9, 9], [null, 2]];
    expect(buildPlotTooltipRows(data, 0, series)).toEqual([{ color: '#1', label: 'a', value: '0.5 rad' }]);
    expect(buildPlotTooltipRows(data, 1, series)).toEqual([
      { color: '#1', label: 'a', value: '1.5 rad' },
      { color: '#3', label: 'c', value: '2' },
    ]);
  });
});

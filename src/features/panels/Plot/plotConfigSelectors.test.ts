import { describe, expect, it } from 'vitest';
import { defaultPlotConfig, createPlotSeries } from './defaults';
import {
  hasConfiguredPlotPaths,
  hasEnabledPlotPaths,
  plotDataConfigKey,
  plotEnabledSeriesIds,
  plotEnabledSeriesKey,
  plotSeriesVisualKey,
  selectActivePlotTopics,
} from './plotConfigSelectors';
import type { TopicInfo } from '@/core/types/ros';

const topics: TopicInfo[] = [
  { name: '/a', type: 'std_msgs/msg/Float64', schemaName: 'std_msgs/msg/Float64' },
  { name: '/b', type: 'std_msgs/msg/Float64', schemaName: 'std_msgs/msg/Float64' },
];
const topicByName = new Map(topics.map((t) => [t.name, t]));

describe('plotDataConfigKey', () => {
  it('does not change when only series.enabled toggles', () => {
    const base = defaultPlotConfig();
    const a = {
      ...base,
      series: [createPlotSeries({ id: 's1', topic: '/a', path: 'data', enabled: true })],
    };
    const b = { ...a, series: [{ ...a.series[0], enabled: false }] };
    expect(plotDataConfigKey(a)).toBe(plotDataConfigKey(b));
  });

  it('changes when topic or path changes', () => {
    const base = defaultPlotConfig();
    const a = {
      ...base,
      series: [createPlotSeries({ id: 's1', topic: '/a', path: 'data' })],
    };
    const b = { ...a, series: [{ ...a.series[0], topic: '/b' }] };
    expect(plotDataConfigKey(a)).not.toBe(plotDataConfigKey(b));
  });
});

describe('plotEnabledSeriesKey / plotEnabledSeriesIds', () => {
  it('reflects only enabled series', () => {
    const base = defaultPlotConfig();
    const config = {
      ...base,
      series: [
        createPlotSeries({ id: 's1', topic: '/a', path: 'data', enabled: true }),
        createPlotSeries({ id: 's2', topic: '/b', path: 'data', enabled: false }),
        createPlotSeries({ id: 's3', topic: '/a', path: 'data', enabled: true }),
      ],
    };
    expect(plotEnabledSeriesKey(config)).toBe('s1|s3');
    expect([...plotEnabledSeriesIds(config)].sort()).toEqual(['s1', 's3']);
  });

  it('changes when series.enabled toggles', () => {
    const base = defaultPlotConfig();
    const a = {
      ...base,
      series: [createPlotSeries({ id: 's1', topic: '/a', path: 'data', enabled: true })],
    };
    const b = { ...a, series: [{ ...a.series[0], enabled: false }] };
    expect(plotEnabledSeriesKey(a)).not.toBe(plotEnabledSeriesKey(b));
  });
});

describe('plotSeriesVisualKey', () => {
  it('changes when line style or size changes but data key does not', () => {
    const base = defaultPlotConfig();
    const a = {
      ...base,
      series: [createPlotSeries({ id: 's1', topic: '/a', path: 'data', lineStyle: 'solid', lineSize: 1.5 })],
    };
    const b = { ...a, series: [{ ...a.series[0], lineStyle: 'dashed' as const }] };
    const c = { ...a, series: [{ ...a.series[0], lineSize: 3 }] };
    expect(plotSeriesVisualKey(a)).not.toBe(plotSeriesVisualKey(b));
    expect(plotSeriesVisualKey(a)).not.toBe(plotSeriesVisualKey(c));
    // Visual-only changes must never trigger a range re-read.
    expect(plotDataConfigKey(a)).toBe(plotDataConfigKey(b));
    expect(plotDataConfigKey(a)).toBe(plotDataConfigKey(c));
  });

  it('changes when color or label changes', () => {
    const base = defaultPlotConfig();
    const a = {
      ...base,
      series: [createPlotSeries({ id: 's1', topic: '/a', path: 'data', color: '#111', label: 'A' })],
    };
    const b = { ...a, series: [{ ...a.series[0], color: '#222' }] };
    const c = { ...a, series: [{ ...a.series[0], label: 'B' }] };
    expect(plotSeriesVisualKey(a)).not.toBe(plotSeriesVisualKey(b));
    expect(plotSeriesVisualKey(a)).not.toBe(plotSeriesVisualKey(c));
  });
});

describe('legend visibility vs range read', () => {
  it('does not change active topics key or plotDataConfigKey when hiddenLegendKeys toggles', () => {
    const base = defaultPlotConfig();
    const config = {
      ...base,
      series: [
        createPlotSeries({ id: 's1', topic: '/a', path: 'data', enabled: true }),
        createPlotSeries({ id: 's2', topic: '/b', path: 'data', enabled: true }),
      ],
    };
    const hidden = { ...config, hiddenLegendKeys: ['s1'] };
    const topicsKey = (c: typeof config) => selectActivePlotTopics(c, topicByName).join('\n');
    expect(topicsKey(config)).toBe(topicsKey(hidden));
    expect(plotDataConfigKey(config)).toBe(plotDataConfigKey(hidden));
  });
});

describe('selectActivePlotTopics', () => {
  it('includes topics for disabled series too (so toggling does not refetch)', () => {
    const base = defaultPlotConfig();
    const config = {
      ...base,
      series: [
        createPlotSeries({ id: 's1', topic: '/a', path: 'data', enabled: true }),
        createPlotSeries({ id: 's2', topic: '/b', path: 'data', enabled: false }),
      ],
    };
    expect(selectActivePlotTopics(config, topicByName)).toEqual(['/a', '/b']);
  });

  it('still excludes series with no topic or empty path', () => {
    const base = defaultPlotConfig();
    const config = {
      ...base,
      series: [
        createPlotSeries({ id: 's1', topic: '/a', path: 'data', enabled: false }),
        createPlotSeries({ id: 's2', topic: '', path: 'data' }),
        createPlotSeries({ id: 's3', topic: '/b', path: '   ' }),
      ],
    };
    expect(selectActivePlotTopics(config, topicByName)).toEqual(['/a']);
  });
});

describe('hasConfiguredPlotPaths', () => {
  it('returns true even when only disabled series exist', () => {
    const base = defaultPlotConfig();
    const config = {
      ...base,
      series: [createPlotSeries({ id: 's1', topic: '/a', path: 'data', enabled: false })],
    };
    expect(hasConfiguredPlotPaths(config)).toBe(true);
    expect(hasEnabledPlotPaths(config)).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import type { MessageEvent } from '@/core/types/ros';
import { buildPlotDataset } from './datasets';
import { defaultPlotConfig } from './defaults';
import { PlotDatasetAccumulator } from './plotDatasetAccumulator';

function event(topic: string, sec: number, message: unknown, schemaName = 'std_msgs/msg/Float64MultiArray'): MessageEvent {
  return {
    topic,
    receiveTime: { sec, nsec: 0 },
    publishTime: { sec, nsec: 0 },
    message,
    schemaName,
  };
}

function buildIncremental(
  events: MessageEvent[],
  config: ReturnType<typeof defaultPlotConfig>,
): ReturnType<PlotDatasetAccumulator['buildDataset']> {
  const accumulator = new PlotDatasetAccumulator(config);
  accumulator.append(events.slice(0, 1));
  accumulator.append(events.slice(1));
  return accumulator.buildDataset();
}

describe('PlotDatasetAccumulator', () => {
  it('matches buildPlotDataset for timestamp series', () => {
    const config = {
      ...defaultPlotConfig(),
      downsampleMode: 'none' as const,
      series: [{
        ...defaultPlotConfig().series[0],
        id: 's1',
        topic: '/array',
        path: 'data[:]',
        timestampMode: 'receiveTime' as const,
      }],
    };
    const events = [
      event('/array', 1, { data: [1, 2] }),
      event('/array', 2, { data: [3, 4] }),
    ];

    expect(buildIncremental(events, config)).toEqual(buildPlotDataset(events, config));
  });

  it('matches buildPlotDataset for custom x/y paths', () => {
    const config = {
      ...defaultPlotConfig(),
      xAxisMode: 'custom' as const,
      downsampleMode: 'none' as const,
      series: [{
        ...defaultPlotConfig().series[0],
        id: 's1',
        topic: '/scan',
        xAxisPath: 'x[:]',
        path: 'y[:]',
      }],
    };
    const events = [
      event('/scan', 1, { x: [10, 20], y: [5, 6] }),
      event('/scan', 2, { x: [30, 40], y: [7, 8] }),
    ];

    expect(buildIncremental(events, config)).toEqual(buildPlotDataset(events, config));
  });

  it('uses only the latest message in index mode', () => {
    const config = {
      ...defaultPlotConfig(),
      xAxisMode: 'index' as const,
      downsampleMode: 'none' as const,
      series: [{
        ...defaultPlotConfig().series[0],
        id: 's1',
        topic: '/array',
        path: 'data[:]',
      }],
    };
    const events = [
      event('/array', 1, { data: [1, 2] }),
      event('/array', 2, { data: [3, 4] }),
    ];

    expect(buildIncremental(events, config)).toEqual(buildPlotDataset(events, config));
  });

  it('uses only the latest curve in currentCustom mode', () => {
    const config = {
      ...defaultPlotConfig(),
      xAxisMode: 'currentCustom' as const,
      downsampleMode: 'none' as const,
      series: [{
        ...defaultPlotConfig().series[0],
        id: 's1',
        topic: '/scan',
        xAxisPath: 'x[:]',
        path: 'y[:]',
      }],
    };
    const events = [
      event('/scan', 1, { x: [10, 20], y: [5, 6] }),
      event('/scan', 2, { x: [30, 40], y: [7, 8] }),
    ];

    expect(buildIncremental(events, config)).toEqual(buildPlotDataset(events, config));
  });

  it('keeps derivative behavior aligned with one-shot builds', () => {
    const config = {
      ...defaultPlotConfig(),
      downsampleMode: 'none' as const,
      series: [{
        ...defaultPlotConfig().series[0],
        id: 's1',
        topic: '/value',
        path: 'data@derivative',
        timestampMode: 'receiveTime' as const,
      }],
    };
    const events = [
      event('/value', 1, { data: 1 }, 'std_msgs/msg/Float64'),
      event('/value', 2, { data: 3 }, 'std_msgs/msg/Float64'),
      event('/value', 4, { data: 7 }, 'std_msgs/msg/Float64'),
    ];

    expect(buildIncremental(events, config)).toEqual(buildPlotDataset(events, config));
  });

  it('ingests data for disabled series so toggling visibility does not require re-fetch', () => {
    const baseSeries = defaultPlotConfig().series[0];
    const config = {
      ...defaultPlotConfig(),
      downsampleMode: 'none' as const,
      series: [
        { ...baseSeries, id: 's1', topic: '/a', path: 'data', timestampMode: 'receiveTime' as const, enabled: true },
        { ...baseSeries, id: 's2', topic: '/b', path: 'data', timestampMode: 'receiveTime' as const, enabled: false, label: 'B' },
      ],
    };
    const events = [
      event('/a', 1, { data: 11 }, 'std_msgs/msg/Float64'),
      event('/b', 1, { data: 21 }, 'std_msgs/msg/Float64'),
      event('/a', 2, { data: 12 }, 'std_msgs/msg/Float64'),
      event('/b', 2, { data: 22 }, 'std_msgs/msg/Float64'),
    ];

    const accumulator = new PlotDatasetAccumulator(config);
    accumulator.append(events);

    // With default (no override), only s1 is enabled in config -> only s1 series in output.
    const onlyEnabled = accumulator.buildDataset();
    expect(onlyEnabled.series.map((s) => s.key.startsWith('s1:') ? 's1' : 's2')).toEqual(['s1']);

    // Re-build with s2 also enabled — buckets are already accumulated, no re-ingest.
    const both = accumulator.buildDataset(new Set(['s1', 's2']));
    const seriesIds = both.series.map((s) => s.key.startsWith('s1:') ? 's1' : 's2').sort();
    expect(seriesIds).toEqual(['s1', 's2']);

    // Re-build with only s2 enabled — visibility flip with no re-ingest.
    const onlyS2 = accumulator.buildDataset(new Set(['s2']));
    expect(onlyS2.series.map((s) => s.key.startsWith('s2:') ? 's2' : 's1')).toEqual(['s2']);
  });

  it('applies live visual config (line style/size/color) at build time without re-ingest', () => {
    const baseSeries = defaultPlotConfig().series[0];
    const config = {
      ...defaultPlotConfig(),
      downsampleMode: 'none' as const,
      series: [
        {
          ...baseSeries,
          id: 's1',
          topic: '/a',
          path: 'data',
          timestampMode: 'receiveTime' as const,
          lineStyle: 'solid' as const,
          lineSize: 1.5,
          color: '#111',
        },
      ],
    };
    const events = [
      event('/a', 1, { data: 1 }, 'std_msgs/msg/Float64'),
      event('/a', 2, { data: 2 }, 'std_msgs/msg/Float64'),
    ];

    const accumulator = new PlotDatasetAccumulator(config);
    accumulator.append(events);

    // Build with a live config carrying updated visuals (no new data appended).
    const liveConfig = {
      ...config,
      series: [{ ...config.series[0], lineStyle: 'dashed' as const, lineSize: 4, color: '#abcdef' }],
    };
    const dataset = accumulator.buildDataset(new Set(['s1']), liveConfig);

    expect(dataset.series[0].lineStyle).toBe('dashed');
    expect(dataset.series[0].lineSize).toBe(4);
    expect(dataset.series[0].color).toBe('#abcdef');
  });
});

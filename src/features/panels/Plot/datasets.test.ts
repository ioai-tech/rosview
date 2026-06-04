import { describe, expect, it } from 'vitest';
import type { MessageEvent } from '@/core/types/ros';
import { buildPlotDataset } from './datasets';
import { defaultPlotConfig } from './defaults';

function event(topic: string, sec: number, message: unknown, schemaName = 'std_msgs/msg/Float64MultiArray'): MessageEvent {
  return {
    topic,
    receiveTime: { sec, nsec: 0 },
    publishTime: { sec, nsec: 0 },
    message,
    schemaName,
  };
}

describe('buildPlotDataset', () => {
  it('builds timestamp datasets for Float64MultiArray slices before playback', () => {
    const config = {
      ...defaultPlotConfig(),
      series: [{
        ...defaultPlotConfig().series[0],
        id: 's1',
        topic: '/array',
        path: 'data[:]',
        timestampMode: 'receiveTime' as const,
      }],
    };
    const dataset = buildPlotDataset(
      [
        event('/array', 1, { data: [1, 2] }),
        event('/array', 2, { data: [3, 4] }),
      ],
      config,
    );
    expect(dataset.series.map((series) => series.label)).toEqual([
      'data[0]',
      'data[1]',
    ]);
    expect(dataset.data[0]).toEqual([1, 2]);
    expect(dataset.data[1]).toEqual([1, 3]);
    expect(dataset.data[2]).toEqual([2, 4]);
  });

  it('builds JointState datasets using joint names', () => {
    const config = {
      ...defaultPlotConfig(),
      series: [{
        ...defaultPlotConfig().series[0],
        id: 'joints',
        topic: '/joint_states',
        path: 'position[:]',
        timestampMode: 'receiveTime' as const,
      }],
    };
    const dataset = buildPlotDataset(
      [
        event('/joint_states', 1, { name: ['a', 'b'], position: [0.1, 0.2] }, 'sensor_msgs/msg/JointState'),
        event('/joint_states', 2, { name: ['a', 'b'], position: [0.3, 0.4] }, 'sensor_msgs/msg/JointState'),
      ],
      config,
    );
    expect(dataset.series.map((series) => series.label)).toEqual([
      'position[0] (a)',
      'position[1] (b)',
    ]);
    expect(dataset.data[1]).toEqual([0.1, 0.3]);
    expect(dataset.data[2]).toEqual([0.2, 0.4]);
  });

  it('builds bounded JointState slices with Foxglove inclusive bounds', () => {
    const config = {
      ...defaultPlotConfig(),
      series: [{
        ...defaultPlotConfig().series[0],
        id: 'joints',
        topic: '/joint_states',
        path: 'position[1:2]',
        timestampMode: 'receiveTime' as const,
      }],
    };
    const dataset = buildPlotDataset(
      [
        event('/joint_states', 1, { name: ['a', 'b', 'c'], position: [0.1, 0.2, 0.3] }, 'sensor_msgs/msg/JointState'),
      ],
      config,
    );
    expect(dataset.series.map((series) => series.label)).toEqual([
      'position[1] (b)',
      'position[2] (c)',
    ]);
    expect(dataset.data.length).toBe(3);
  });

  it('uses only the latest message in index mode', () => {
    const config = {
      ...defaultPlotConfig(),
      xAxisMode: 'index' as const,
      series: [{
        ...defaultPlotConfig().series[0],
        id: 's1',
        topic: '/array',
        path: 'data[:]',
      }],
    };
    const dataset = buildPlotDataset(
      [
        event('/array', 1, { data: [1, 2] }),
        event('/array', 2, { data: [3, 4] }),
      ],
      config,
    );
    expect(dataset.data[0]).toEqual([0, 1]);
    expect(dataset.data[1]).toEqual([3, null]);
    expect(dataset.data[2]).toEqual([null, 4]);
  });

  it('pairs custom x and y arrays', () => {
    const config = {
      ...defaultPlotConfig(),
      xAxisMode: 'custom' as const,
      series: [{
        ...defaultPlotConfig().series[0],
        id: 's1',
        topic: '/scan',
        xAxisPath: 'x[:]',
        path: 'y[:]',
      }],
    };
    const dataset = buildPlotDataset([event('/scan', 1, { x: [10, 20], y: [5, 6] })], config);
    expect(dataset.data[0]).toEqual([10, 20]);
    expect(dataset.data[1]).toEqual([5, 6]);
  });

  it('derives values without appending seek backfill into existing history', () => {
    const config = {
      ...defaultPlotConfig(),
      series: [{
        ...defaultPlotConfig().series[0],
        id: 's1',
        topic: '/value',
        path: 'data@derivative',
        timestampMode: 'receiveTime' as const,
      }],
    };
    const dataset = buildPlotDataset(
      [
        event('/value', 1, { data: 1 }),
        event('/value', 3, { data: 5 }),
      ],
      config,
    );
    expect(dataset.data[0]).toEqual([3]);
    expect(dataset.data[1]).toEqual([2]);
  });

  it('assigns distinct palette colors when one series expands to multiple buckets', () => {
    const config = {
      ...defaultPlotConfig(),
      series: [{
        ...defaultPlotConfig().series[0],
        id: 'joints',
        topic: '/joint_states',
        path: 'position[:]',
        color: '#000000',
        timestampMode: 'receiveTime' as const,
      }],
    };
    const dataset = buildPlotDataset(
      [event('/joint_states', 1, { name: ['a', 'b'], position: [0.1, 0.2] }, 'sensor_msgs/msg/JointState')],
      config,
    );
    expect(dataset.series[0]?.color).not.toBe(dataset.series[1]?.color);
    expect(dataset.series[0]?.color).not.toBe('#000000');
  });

  it('keeps multi-series JointState lines continuous under downsampling', () => {
    const config = {
      ...defaultPlotConfig(),
      maxPoints: 50,
      downsampleMode: 'minMaxLast' as const,
      series: [{
        ...defaultPlotConfig().series[0],
        id: 'joints',
        topic: '/joint_states',
        path: 'position[:]',
        timestampMode: 'receiveTime' as const,
      }],
    };
    const events = Array.from({ length: 200 }, (_, index) =>
      event('/joint_states', index, { name: ['a', 'b'], position: [index, index * 2] }, 'sensor_msgs/msg/JointState'),
    );
    const dataset = buildPlotDataset(events, config);
    for (let seriesIndex = 1; seriesIndex < dataset.data.length; seriesIndex++) {
      const values = dataset.data[seriesIndex] as Array<number | null>;
      const nonNullIndices = values.flatMap((value, index) => (value != null ? [index] : []));
      for (let index = 1; index < nonNullIndices.length; index++) {
        const curr = nonNullIndices[index];
        const prev = nonNullIndices[index - 1];
        if (curr === undefined || prev === undefined) {
          throw new Error('expected consecutive non-null indices');
        }
        expect(curr - prev).toBe(1);
      }
    }
  });

  it('preserves each series timeline when multiple topics are overlaid', () => {
    const config = {
      ...defaultPlotConfig(),
      maxPoints: 50,
      downsampleMode: 'minMaxLast' as const,
      series: [
        {
          ...defaultPlotConfig().series[0],
          id: 's1',
          topic: '/cmd',
          path: 'data',
          timestampMode: 'receiveTime' as const,
        },
        {
          ...defaultPlotConfig().series[0],
          id: 's2',
          topic: '/state',
          path: 'data',
          timestampMode: 'receiveTime' as const,
        },
      ],
    };
    const events = [
      ...Array.from({ length: 100 }, (_, index) => event('/cmd', index, { data: index })),
      ...Array.from({ length: 100 }, (_, index) => event('/state', index + 0.5, { data: index * 10 })),
    ];
    const dataset = buildPlotDataset(events, config);
    const xValues = dataset.data[0] as number[];
    for (let seriesIndex = 1; seriesIndex < dataset.data.length; seriesIndex++) {
      const yValues = dataset.data[seriesIndex] as Array<number | null>;
      const native = xValues.flatMap((x, index) => {
        const y = yValues[index];
        return y != null ? [{ x, y }] : [];
      });
      for (let index = 1; index < native.length; index++) {
        const curr = native[index];
        const prev = native[index - 1];
        if (!curr || !prev) {
          throw new Error('expected consecutive native points');
        }
        expect(curr.x).toBeGreaterThan(prev.x);
      }
      expect(native.length).toBeGreaterThan(1);
    }
  });

  it('falls back to receiveTime when header stamp is outside the log window', () => {
    const logStart = { sec: 1_735_689_600, nsec: 0 };
    const logEnd = { sec: 1_735_689_654, nsec: 0 };
    const config = {
      ...defaultPlotConfig(),
      series: [{
        ...defaultPlotConfig().series[0],
        id: 'joints',
        topic: '/joint_states',
        path: 'position[0]',
        timestampMode: 'headerStamp' as const,
      }],
    };
    const dataset = buildPlotDataset(
      [{
        topic: '/joint_states',
        receiveTime: { sec: 1_735_689_610, nsec: 0 },
        publishTime: { sec: 1_735_689_610, nsec: 0 },
        message: {
          header: { stamp: { sec: 0, nsec: 0 } },
          name: ['a'],
          position: [1.5],
        },
        schemaName: 'sensor_msgs/msg/JointState',
      }],
      config,
      { logStart, logEnd },
    );
    expect(dataset.data[0]).toEqual([1_735_689_610]);
    expect(dataset.data[1]).toEqual([1.5]);
    expect(dataset.pointCount).toBe(1);
  });

  it('overlays two different topics on the same chart', () => {
    const config = {
      ...defaultPlotConfig(),
      series: [
        {
          ...defaultPlotConfig().series[0],
          id: 's1',
          topic: '/joint_cmd',
          path: 'position[0]',
          color: '#3b82f6',
          timestampMode: 'receiveTime' as const,
        },
        {
          ...defaultPlotConfig().series[0],
          id: 's2',
          topic: '/joint_states',
          path: 'position[0]',
          color: '#ef4444',
          timestampMode: 'receiveTime' as const,
        },
      ],
    };
    const joint = 'sensor_msgs/msg/JointState';
    const dataset = buildPlotDataset(
      [
        event('/joint_cmd', 1, { name: ['a'], position: [1] }, joint),
        event('/joint_cmd', 2, { name: ['a'], position: [2] }, joint),
        event('/joint_states', 1, { name: ['a'], position: [10] }, joint),
        event('/joint_states', 2, { name: ['a'], position: [20] }, joint),
      ],
      config,
    );
    expect(dataset.series).toHaveLength(2);
    expect(dataset.series.map((s) => s.label)).toEqual([
      '/joint_cmd · position[0]',
      '/joint_states · position[0]',
    ]);
    expect(dataset.data[0]).toEqual([1, 2]);
    expect(dataset.data[1]).toEqual([1, 2]);
    expect(dataset.data[2]).toEqual([10, 20]);
    expect(dataset.pointCount).toBe(4);
  });

  it('forces downsampling for non-indexed sources via options', () => {
    const config = {
      ...defaultPlotConfig(),
      downsampleMode: 'none' as const,
      maxPoints: 100,
      series: [{
        ...defaultPlotConfig().series[0],
        id: 's1',
        topic: '/value',
        path: 'data',
        timestampMode: 'receiveTime' as const,
      }],
    };
    const events = Array.from({ length: 500 }, (_, index) =>
      event('/value', index, { data: index }),
    );
    const dataset = buildPlotDataset(events, config, {
      forceDownsample: true,
      extraWarnings: [{ kind: 'downsampleLimited' }],
    });
    expect(dataset.warnings.some((w) => w.kind === 'downsampleLimited')).toBe(true);
    expect((dataset.data[0] as number[]).length).toBeLessThanOrEqual(100);
  });
});

import { describe, expect, it } from 'vitest';
import type { ParsedChannel } from './parseChannel';
import { McapIndexedIterableSource } from './McapIndexedIterableSource';
import { scanDataQualityFromSource } from '@/infra/quality/scanRunner';

function toStamp(ns: bigint): { sec: number; nsec: number } {
  return {
    sec: Number(ns / 1_000_000_000n),
    nsec: Number(ns % 1_000_000_000n),
  };
}

type RawMsg = {
  channelId: number;
  logTime: bigint;
  publishTime: bigint;
  data: Uint8Array;
  sequence?: number;
  includeHeader?: boolean;
};

function createSourceForMessages(messages: RawMsg[], channels: Array<{ id: number; topic: string }>) {
  let decodeIndex = 0;
  const reader = {
    channelsById: new Map(
      channels.map((channel) => [
        channel.id,
        {
          ...channel,
          schemaId: 1,
          messageEncoding: 'cdr',
          metadata: new Map<string, string>(),
        },
      ]),
    ),
    schemasById: new Map([
      [
        1,
        {
          name: 'sensor_msgs/msg/CompressedImage',
          encoding: 'ros2msg',
          data: new Uint8Array(),
        },
      ],
    ]),
    statistics: {
      channelMessageCounts: new Map(channels.map((channel) => [channel.id, BigInt(messages.length)])),
    },
    readMessages: async function* () {
      for (const message of messages) {
        yield message;
      }
    },
  };
  const source = new McapIndexedIterableSource(reader as never);
  type SourceChannels = { _channelsById: Map<number, ParsedChannel> };
  (source as unknown as SourceChannels)._channelsById = new Map(
    channels.map((channel) => [
      channel.id,
      {
        deserialize: () => {
          const raw = messages[decodeIndex++];
          if (raw.includeHeader === false) return {};
          return {
            header: {
              stamp: toStamp(raw.publishTime),
            },
          };
        },
        datatypes: new Map(),
      },
    ]),
  );
  return source;
}

async function scanSource(
  source: McapIndexedIterableSource,
  topic: string | string[],
  totalMessages: number,
) {
  const topics = Array.isArray(topic) ? topic : [topic];
  return await scanDataQualityFromSource(source, {
    topics: topics.map((name) => ({ name, type: name.includes('joint') ? 'sensor_msgs/msg/JointState' : 'sensor_msgs/msg/CompressedImage', messageCount: totalMessages })),
    datatypes: {},
    start: { sec: 0, nsec: 0 },
    end: { sec: 10, nsec: 0 },
    publishersByTopic: {},
    topicStats: Object.fromEntries(topics.map((name) => [name, { messageCount: totalMessages, frequency: 0 }])),
    problems: [],
  });
}

describe('McapIndexedIterableSource data quality scanning', () => {
  it('detects header clock rollback with evidence window', async () => {
    const source = createSourceForMessages(
      [
        {
          channelId: 1,
          logTime: 1_000_000_000n,
          publishTime: 900_000_000n,
          data: new Uint8Array([1]),
          sequence: 1,
        },
        {
          channelId: 1,
          logTime: 1_050_000_000n,
          publishTime: 950_000_000n,
          data: new Uint8Array([2]),
          sequence: 2,
        },
        {
          channelId: 1,
          logTime: 1_100_000_000n,
          publishTime: 930_000_000n,
          data: new Uint8Array([3]),
          sequence: 3,
        },
      ],
      [{ id: 1, topic: '/camera/top/image/compressed' }],
    );

    const report = await scanSource(source, '/camera/top/image/compressed', 3);
    expect(report.status).toBe('ready');
    expect(report.issueCounts.timestamp_rollback).toBeGreaterThanOrEqual(1);
    const rollbackRange = report.ranges.find(
      (range) => range.type === 'timestamp_rollback' && range.clockSource === 'header',
    );
    expect(rollbackRange).toBeDefined();
    expect(rollbackRange?.summaryStats?.rollbackDepthNs).toBeDefined();
  });

  it('detects header stamp gaps above twice the topic average interval', async () => {
    const source = createSourceForMessages(
      [
        {
          channelId: 1,
          logTime: 2_000_000_000n,
          publishTime: 1_900_000_000n,
          data: new Uint8Array([1]),
          sequence: 1,
        },
        {
          channelId: 1,
          logTime: 2_040_000_000n,
          publishTime: 1_940_000_000n,
          data: new Uint8Array([2]),
          sequence: 2,
        },
        {
          channelId: 1,
          logTime: 2_080_000_000n,
          publishTime: 1_980_000_000n,
          data: new Uint8Array([3]),
          sequence: 3,
        },
        {
          channelId: 1,
          logTime: 2_120_000_000n,
          publishTime: 2_020_000_000n,
          data: new Uint8Array([4]),
          sequence: 4,
        },
        {
          channelId: 1,
          logTime: 2_160_000_000n,
          publishTime: 2_060_000_000n,
          data: new Uint8Array([5]),
          sequence: 5,
        },
        {
          channelId: 1,
          logTime: 2_200_000_000n,
          publishTime: 2_100_000_000n,
          data: new Uint8Array([6]),
          sequence: 6,
        },
        {
          channelId: 1,
          logTime: 2_320_000_000n,
          publishTime: 2_220_000_000n,
          data: new Uint8Array([5]),
          sequence: 7,
        },
        {
          channelId: 1,
          logTime: 2_360_000_000n,
          publishTime: 2_260_000_000n,
          data: new Uint8Array([6]),
          sequence: 8,
        },
      ],
      [{ id: 1, topic: '/camera/left/image/compressed' }],
    );

    const report = await scanSource(source, '/camera/left/image/compressed', 8);
    expect(report.issueCounts.topic_frame_drop).toBeGreaterThanOrEqual(1);
    const gapRange = report.ranges.find((range) => range.type === 'topic_frame_drop');
    expect(gapRange?.summaryStats?.maxDeviationRatio).toBeGreaterThan(2);
    expect(gapRange?.summaryStats?.estimatedDropCount).toBeDefined();
  });

  it('does not report early gaps before enough baseline intervals are collected', async () => {
    const source = createSourceForMessages(
      [
        { channelId: 1, logTime: 1_000_000_000n, publishTime: 1_000_000_000n, data: new Uint8Array([1]) },
        { channelId: 1, logTime: 1_040_000_000n, publishTime: 1_040_000_000n, data: new Uint8Array([2]) },
        { channelId: 1, logTime: 1_080_000_000n, publishTime: 1_080_000_000n, data: new Uint8Array([3]) },
        { channelId: 1, logTime: 1_240_000_000n, publishTime: 1_240_000_000n, data: new Uint8Array([4]) },
        { channelId: 1, logTime: 1_280_000_000n, publishTime: 1_280_000_000n, data: new Uint8Array([5]) },
      ],
      [{ id: 1, topic: '/camera/warmup/image/compressed' }],
    );

    const report = await scanSource(source, '/camera/warmup/image/compressed', 5);
    expect(report.issueCounts.topic_frame_drop).toBe(0);
  });

  it('does not report frame gaps for transform topics', async () => {
    const source = createSourceForMessages(
      [
        { channelId: 1, logTime: 1_000_000_000n, publishTime: 1_000_000_000n, data: new Uint8Array([1]) },
        { channelId: 1, logTime: 1_010_000_000n, publishTime: 1_010_000_000n, data: new Uint8Array([2]) },
        { channelId: 1, logTime: 1_020_000_000n, publishTime: 1_020_000_000n, data: new Uint8Array([3]) },
        { channelId: 1, logTime: 1_030_000_000n, publishTime: 1_030_000_000n, data: new Uint8Array([4]) },
        { channelId: 1, logTime: 1_040_000_000n, publishTime: 1_040_000_000n, data: new Uint8Array([5]) },
        { channelId: 1, logTime: 1_050_000_000n, publishTime: 1_050_000_000n, data: new Uint8Array([6]) },
        { channelId: 1, logTime: 1_080_000_000n, publishTime: 1_080_000_000n, data: new Uint8Array([7]) },
      ],
      [{ id: 1, topic: '/tf' }],
    );

    const report = await scanSource(source, '/tf', 7);
    expect(report.issueCounts.topic_frame_drop).toBe(0);
    expect(report.ranges).toHaveLength(0);
  });

  it('ignores header stamp gaps at or below twice the topic average interval', async () => {
    const source = createSourceForMessages(
      [
        {
          channelId: 1,
          logTime: 1_000_000_000n,
          publishTime: 1_000_000_000n,
          data: new Uint8Array([1]),
        },
        {
          channelId: 1,
          logTime: 1_033_333_333n,
          publishTime: 1_033_333_333n,
          data: new Uint8Array([2]),
        },
        {
          channelId: 1,
          logTime: 1_066_666_666n,
          publishTime: 1_066_666_666n,
          data: new Uint8Array([3]),
        },
        {
          channelId: 1,
          logTime: 1_100_000_000n,
          publishTime: 1_100_000_000n,
          data: new Uint8Array([4]),
        },
        {
          channelId: 1,
          logTime: 1_166_666_666n,
          publishTime: 1_166_666_666n,
          data: new Uint8Array([5]),
        },
      ],
      [{ id: 1, topic: '/camera/front/image/compressed' }],
    );

    const report = await scanSource(source, '/camera/front/image/compressed', 5);
    expect(report.issueCounts.topic_frame_drop).toBe(0);
    expect(report.issueCounts.timestamp_rollback).toBe(0);
  });

  it('does not detect receive-time gaps when header stamps stay regular', async () => {
    const source = createSourceForMessages(
      [
        {
          channelId: 1,
          logTime: 1_000_000_000n,
          publishTime: 1_000_000_000n,
          data: new Uint8Array([1]),
        },
        {
          channelId: 1,
          logTime: 1_010_000_000n,
          publishTime: 1_010_000_000n,
          data: new Uint8Array([2]),
        },
        {
          channelId: 1,
          logTime: 1_020_000_000n,
          publishTime: 1_020_000_000n,
          data: new Uint8Array([3]),
        },
        {
          channelId: 1,
          logTime: 1_040_400_000n,
          publishTime: 1_030_000_000n,
          data: new Uint8Array([4]),
        },
      ],
      [{ id: 1, topic: '/imu/data' }],
    );

    const report = await scanSource(source, '/imu/data', 4);
    expect(report.issueCounts.topic_frame_drop).toBe(0);
    expect(report.ranges).toHaveLength(0);
  });

  it('skips messages without header stamps', async () => {
    const source = createSourceForMessages(
      [
        { channelId: 1, logTime: 1_000_000_000n, publishTime: 1_000_000_000n, data: new Uint8Array([1]), includeHeader: false },
        { channelId: 1, logTime: 1_030_000_000n, publishTime: 900_000_000n, data: new Uint8Array([2]), includeHeader: false },
        { channelId: 1, logTime: 1_300_000_000n, publishTime: 1_300_000_000n, data: new Uint8Array([3]), includeHeader: false },
      ],
      [{ id: 1, topic: '/camera/front/image/compressed' }],
    );

    const report = await scanSource(source, '/camera/front/image/compressed', 3);
    expect(report.ranges).toHaveLength(0);
    expect(report.issueCounts.timestamp_rollback).toBe(0);
    expect(report.issueCounts.topic_frame_drop).toBe(0);
  });
});

describe('McapIndexedIterableSource initialize', () => {
  it('keeps unsupported schema channels visible with a warning', async () => {
    const reader = {
      chunkIndexes: [
        {
          messageStartTime: 0n,
          messageEndTime: 1_000_000_000n,
          messageIndexOffsets: new Map<number, bigint>([[1, 0n]]),
        },
      ],
      channelsById: new Map([
        [
          1,
          {
            id: 1,
            topic: '/camera/head/color',
            schemaId: 1,
            messageEncoding: 'cdr',
            metadata: new Map<string, string>(),
          },
        ],
      ]),
      schemasById: new Map([
        [
          1,
          {
            name: '/camera/head/color_schema',
            encoding: 'jsonschema',
            data: new TextEncoder().encode('{"type":"object"}'),
          },
        ],
      ]),
      statistics: {
        channelMessageCounts: new Map([[1, 10n]]),
      },
      readMessages: async function* () {},
    };
    const source = new McapIndexedIterableSource(reader as never);
    const init = await source.initialize();
    expect(init.topics.map((topic) => topic.name)).toEqual(['/camera/head/color']);
    expect(init.problems.some((problem) => /jsonschema|ros2msg|cdr/i.test(problem.message))).toBe(true);
    expect(init.topicStats['/camera/head/color']?.messageCount).toBe(10);
  });
});

describe('McapIndexedIterableSource backfill', () => {
  /** A reader whose per-topic lookups wait until the test releases them. */
  function slowReader(topics: string[]) {
    const channels = topics.map((topic, index) => ({ id: index + 1, topic }));
    const gates = new Map<string, () => void>();
    let active = 0;
    let maxActive = 0;
    const reader = {
      channelsById: new Map(
        channels.map((channel) => [
          channel.id,
          { ...channel, schemaId: 1, messageEncoding: 'cdr', metadata: new Map<string, string>() },
        ]),
      ),
      schemasById: new Map([[1, { name: 'std_msgs/msg/String', encoding: 'ros2msg', data: new Uint8Array() }]]),
      statistics: { channelMessageCounts: new Map() },
      readMessages: async function* ({ topics: wanted }: { topics: string[] }) {
        const channel = channels.find((c) => c.topic === wanted[0])!;
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise<void>((resolve) => gates.set(channel.topic, resolve));
        active -= 1;
        yield { channelId: channel.id, logTime: 1n, publishTime: 1n, data: new Uint8Array() };
      },
    };
    const source = new McapIndexedIterableSource(reader as never);
    (source as unknown as { _channelsById: Map<number, ParsedChannel> })._channelsById = new Map(
      channels.map((channel) => [channel.id, { deserialize: () => ({}), datatypes: new Map() }]),
    );
    return { source, gates, maxActive: () => maxActive };
  }

  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('reads a bounded number of topics at once, hands each over as it is read, and stops when told', async () => {
    const topics = Array.from({ length: 10 }, (_, i) => `/t${i}`);
    const { source, gates, maxActive } = slowReader(topics);
    const handed: string[] = [];
    let keepGoing = true;
    const done = source.getBackfillMessages({ time: { sec: 1, nsec: 0 }, topics }, (topic, messages) => {
      handed.push(`${topic}:${messages.length}`);
      return keepGoing;
    });
    await tick();
    // In order, at most four at once: a layout with many topics holds a few decompressed chunks.
    expect([...gates.keys()]).toEqual(['/t0', '/t1', '/t2', '/t3']);
    gates.get('/t2')!();
    await tick();
    expect(handed).toEqual(['/t2:1']);
    expect([...gates.keys()]).toContain('/t4');

    keepGoing = false;
    gates.get('/t0')!();
    await tick();
    for (const topic of ['/t1', '/t3', '/t4']) gates.get(topic)!();
    // The caller moved on: no topic after /t4 is read, and nothing is returned twice.
    await expect(done).resolves.toEqual([]);
    expect(gates.has('/t5')).toBe(false);
    expect(maxActive()).toBe(4);
  });

  it('hands a topic that cannot be read over as failed and still reads the rest of the frame', async () => {
    const topics = Array.from({ length: 8 }, (_, i) => `/t${i}`);
    const { source, gates } = slowReader(topics);
    const stall = Object.assign(new Error('No data arrived from the server for 20 s'), { name: 'RangeStallError' });
    const reader = (source as unknown as { _reader: { readMessages: (args: { topics: string[] }) => AsyncGenerator } })._reader;
    const read = reader.readMessages.bind(reader);
    reader.readMessages = (args) => {
      if (args.topics[0] === '/t1') {
        return (async function* () {
          await tick();
          if (stall) throw stall;
          yield undefined;
        })();
      }
      return read(args);
    };
    const handed: Array<[string, number, string | undefined]> = [];
    const done = source.getBackfillMessages({ time: { sec: 1, nsec: 0 }, topics }, (topic, messages, error) => {
      handed.push([topic, messages.length, error?.name]);
      return true;
    });
    for (let i = 0; i < 20 && gates.size < 7; i++) {
      await tick();
      for (const release of gates.values()) release();
    }
    await expect(done).resolves.toEqual([]);
    expect(handed).toContainEqual(['/t1', 0, 'RangeStallError']);
    expect(handed.filter(([, count]) => count === 1).map(([topic]) => topic).sort()).toEqual(
      ['/t0', '/t2', '/t3', '/t4', '/t5', '/t6', '/t7'],
    );
  });

  it('returns every topic at the end without a callback', async () => {
    const topics = ['/a', '/b'];
    const { source, gates } = slowReader(topics);
    const done = source.getBackfillMessages({ time: { sec: 1, nsec: 0 }, topics });
    await tick();
    gates.get('/b')!();
    gates.get('/a')!();
    expect((await done).map((message) => message.topic)).toEqual(['/a', '/b']);
  });
});

describe('McapIndexedIterableSource read boundaries', () => {
  /** Chunks as [startSec, endSec, channel ids]; channel 1 is /joints, 2 is /camera. */
  function sourceWithChunks(chunks: Array<[number, number, number[]]>) {
    const reader = {
      chunkIndexes: chunks.map(([start, end, ids]) => ({
        messageStartTime: BigInt(Math.round(start * 1e9)),
        messageEndTime: BigInt(Math.round(end * 1e9)),
        messageIndexOffsets: new Map(ids.map((id) => [id, 0n] as [number, bigint])),
      })),
      channelsById: new Map([
        [1, { id: 1, topic: '/joints', schemaId: 1, messageEncoding: 'cdr', metadata: new Map<string, string>() }],
        [2, { id: 2, topic: '/camera', schemaId: 1, messageEncoding: 'cdr', metadata: new Map<string, string>() }],
      ]),
      schemasById: new Map(),
      readMessages: async function* () {},
    };
    return new McapIndexedIterableSource(reader as never);
  }
  const sec = (t: { sec: number; nsec: number }) => t.sec + t.nsec / 1e9;

  it('cuts the range at each chunk that holds the topics, keeps overlapping chunks together and cuts touching ones', async () => {
    const source = sourceWithChunks([
      [0, 1, [1, 2]],
      [1, 2, [1, 2]], // touches the previous one: cut at 1
      [2.5, 4, [1]],
      [3, 3.5, [1]], // inside the previous one: no cut
      [5, 6, [2]], // not /joints
      [7, 8, [1]],
    ]);
    const boundaries = await source.getReadBoundaries({
      start: { sec: 0, nsec: 500_000_000 },
      end: { sec: 10, nsec: 0 },
      topics: ['/joints'],
    });
    expect(boundaries?.map(sec)).toEqual([0.5, 1, 2.5, 7]);
  });

  it('has no boundaries without topics or for an empty range', async () => {
    const source = sourceWithChunks([[0, 1, [1]]]);
    expect(await source.getReadBoundaries({ start: { sec: 0, nsec: 0 }, end: { sec: 1, nsec: 0 }, topics: [] })).toBeUndefined();
    expect(await source.getReadBoundaries({ start: { sec: 2, nsec: 0 }, end: { sec: 1, nsec: 0 }, topics: ['/joints'] })).toBeUndefined();
  });
});

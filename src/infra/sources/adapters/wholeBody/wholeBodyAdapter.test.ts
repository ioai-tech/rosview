import { describe, expect, it } from 'vitest';
import type { Initialization, MessageEvent, Time } from '@/core/types/ros';
import type { IIterableSource } from '../../IIterableSource';
import type { MessageIteratorArgs } from '@/infra/workers/types';
import { fromNano } from '@/shared/utils/time';
import { G1_29DOF_JOINT_NAMES } from './schemas';
import { withBuiltinTopicAdapters } from '..';

const JPEG_BYTES = [0xff, 0xd8, 0xff, 0xdb, 0x00, 0x01];
const JPEG_BASE64 = btoa(String.fromCharCode(...JPEG_BYTES));

function frame(idx: number) {
  return {
    idx,
    colors: {
      color_0: { channels: 3, data: JPEG_BASE64, encoding: 'jpeg', height: 480, width: 1280 },
    },
    depths: {},
    states: {
      robot_q_current: [1, 2, 3, 1, 0, 0, 0, ...G1_29DOF_JOINT_NAMES.map((_, i) => i / 10 + idx)],
      dex3_q: [0.5, 0.6],
      dex3_dq: [0, 0],
    },
    actions: { frame: [0.1, 0.2] },
    dex3: { joint_names: ['left_hand_thumb_0_joint', 'right_hand_thumb_0_joint'] },
  };
}

function eventAt(topic: string, ns: bigint, message: unknown, schemaName: string): MessageEvent {
  const time = fromNano(ns);
  return { topic, receiveTime: time, publishTime: time, message, schemaName };
}

/** In-memory inner source holding one frame topic and one plain topic. */
function innerSource(): IIterableSource & { lastArgs?: MessageIteratorArgs } {
  const events = [
    eventAt('/whole_body/frame', 100n, frame(0), 'whole_body.frame'),
    eventAt('/dex3/frame', 150n, { v: 1 }, 'unitree.dex3.frame'),
    eventAt('/whole_body/frame', 200n, frame(1), 'whole_body.frame'),
  ];
  const at = (t: Time) => BigInt(t.sec) * 1_000_000_000n + BigInt(t.nsec);
  const source: IIterableSource & { lastArgs?: MessageIteratorArgs } = {
    initialize: () =>
      Promise.resolve<Initialization>({
        topics: [
          { name: '/whole_body/frame', type: 'whole_body.frame' },
          { name: '/dex3/frame', type: 'unitree.dex3.frame' },
        ],
        datatypes: {},
        start: fromNano(100n),
        end: fromNano(200n),
        publishersByTopic: {},
        topicStats: { '/whole_body/frame': { messageCount: 2, frequency: 10 } },
        problems: [],
      }),
    async *messageIterator(args) {
      source.lastArgs = args;
      for (const event of events) {
        if (args.topics.includes(event.topic)) yield await Promise.resolve(event);
      }
    },
    getBackfillMessages: (args) =>
      Promise.resolve(
        args.topics.flatMap((topic) => {
          const candidates = events.filter((e) => e.topic === topic && at(e.receiveTime) <= at(args.time));
          const first = events.find((e) => e.topic === topic);
          const hit = candidates[candidates.length - 1] ?? first;
          return hit ? [hit] : [];
        }),
      ),
  };
  return source;
}

async function collect(iter: AsyncIterableIterator<MessageEvent>): Promise<MessageEvent[]> {
  const out: MessageEvent[] = [];
  for await (const event of iter) out.push(event);
  return out;
}

describe('whole-body topic adapters', () => {
  it('derives image, joint state and base pose topics', async () => {
    const source = withBuiltinTopicAdapters(innerSource());
    const init = await source.initialize();
    expect(init.topics).toEqual(
      expect.arrayContaining([
        { name: '/whole_body/colors/color_0', type: 'sensor_msgs/msg/CompressedImage' },
        { name: '/whole_body/joint_states', type: 'sensor_msgs/msg/JointState' },
        { name: '/whole_body/base_pose', type: 'geometry_msgs/msg/PoseStamped' },
      ]),
    );
    expect(init.topicStats['/whole_body/colors/color_0'].messageCount).toBe(2);
    expect(init.datatypes['sensor_msgs/msg/CompressedImage']).toBeDefined();
  });

  it('expands only the requested topics and reads the frame once', async () => {
    const inner = innerSource();
    const source = withBuiltinTopicAdapters(inner);
    const init = await source.initialize();
    const events = await collect(
      source.messageIterator({
        startTime: init.start,
        topics: ['/whole_body/colors/color_0', '/whole_body/joint_states', '/dex3/frame'],
      }),
    );
    expect(inner.lastArgs?.topics).toEqual(['/whole_body/frame', '/dex3/frame']);
    expect(events.map((e) => e.topic)).toEqual([
      '/whole_body/colors/color_0',
      '/whole_body/joint_states',
      '/dex3/frame',
      '/whole_body/colors/color_0',
      '/whole_body/joint_states',
    ]);

    const image = events[0].message as { format: string; data: Uint8Array; header: { frame_id: string } };
    expect(image.format).toBe('jpeg');
    expect(Array.from(image.data)).toEqual(JPEG_BYTES);
    expect(image.header.frame_id).toBe('color_0');
    expect(events[0].schemaName).toBe('sensor_msgs/msg/CompressedImage');

    const joints = events[1].message as { name: string[]; position: number[] };
    expect(joints.name).toEqual([...G1_29DOF_JOINT_NAMES, 'left_hand_thumb_0_joint', 'right_hand_thumb_0_joint']);
    expect(joints.position).toHaveLength(31);
    expect(joints.position[0]).toBe(0);
    expect(joints.position.slice(-2)).toEqual([0.5, 0.6]);
  });

  it('strips base64 payloads from the original frame topic', async () => {
    const source = withBuiltinTopicAdapters(innerSource());
    const init = await source.initialize();
    const [first] = await collect(source.messageIterator({ startTime: init.start, topics: ['/whole_body/frame'] }));
    const message = first.message as ReturnType<typeof frame>;
    expect(message.colors.color_0.data).toBe(`<jpeg base64, ${JPEG_BASE64.length} chars>`);
    expect(message.states.dex3_q).toEqual([0.5, 0.6]);
  });

  it('maps derived topics for backfill', async () => {
    const source = withBuiltinTopicAdapters(innerSource());
    await source.initialize();
    const events = await source.getBackfillMessages({
      time: fromNano(250n),
      topics: ['/whole_body/base_pose'],
    });
    expect(events).toHaveLength(1);
    expect(events[0].message).toMatchObject({
      header: { frame_id: 'world' },
      pose: { position: { x: 1, y: 2, z: 3 }, orientation: { x: 0, y: 0, z: 0, w: 1 } },
    });
  });

  it('maps derived topics for adjacent-message stepping', async () => {
    const inner = innerSource();
    const calls: string[][] = [];
    inner.getAdjacentMessage = (args) => {
      calls.push(args.topics);
      return Promise.resolve(eventAt('/whole_body/frame', 200n, frame(1), 'whole_body.frame'));
    };
    const source = withBuiltinTopicAdapters(inner);
    await source.initialize();
    const next = await source.getAdjacentMessage({
      time: fromNano(100n),
      topics: ['/whole_body/colors/color_0'],
      direction: 'next',
    });
    expect(calls).toEqual([['/whole_body/frame']]);
    expect(next?.topic).toBe('/whole_body/colors/color_0');
  });

  it('emits raw depth as sensor_msgs/Image and falls back to generic joint names', async () => {
    const inner = innerSource();
    const depth = new Uint8Array(4 * 2 * 2);
    const custom = {
      colors: {},
      depths: {
        depth_0: { channels: 1, width: 4, height: 2, encoding: 'raw', data: btoa(String.fromCharCode(...depth)) },
      },
      states: { robot_q_current: [0.1, 0.2, 0.3] },
    };
    const events = [eventAt('/robot/frame', 100n, custom, 'whole_body.frame')];
    inner.initialize = async () => ({
      ...(await innerSource().initialize()),
      topics: [{ name: '/robot/frame', type: 'whole_body.frame' }],
    });
    inner.getBackfillMessages = () => Promise.resolve(events);
    inner.messageIterator = async function* () {
      yield* events;
    };

    const source = withBuiltinTopicAdapters(inner);
    const init = await source.initialize();
    expect(init.topics.map((t) => [t.name, t.type])).toEqual([
      ['/robot/frame', 'whole_body.frame'],
      ['/robot/depths/depth_0', 'sensor_msgs/msg/Image'],
      ['/robot/joint_states', 'sensor_msgs/msg/JointState'],
    ]);

    const [image, joints] = await collect(
      source.messageIterator({ startTime: init.start, topics: ['/robot/depths/depth_0', '/robot/joint_states'] }),
    );
    expect(image.schemaName).toBe('sensor_msgs/msg/Image');
    expect(image.message).toMatchObject({ width: 4, height: 2, encoding: '16UC1', step: 8 });
    expect(joints.message).toMatchObject({
      name: ['robot_q_current_0', 'robot_q_current_1', 'robot_q_current_2'],
      position: [0.1, 0.2, 0.3],
    });
  });

  it('splits dex3 hand frames into state and command joint states', async () => {
    const inner = innerSource();
    const side = (sign: number) => ({
      state: { position: [1, 2, 3, 4, 5, 6, 7].map((v) => v * sign), velocity: [0, 0, 0, 0, 0, 0, 0] },
      command: { position: [0, 0, 0, 0, 0, 0, 0], velocity: [0, 0, 0, 0, 0, 0, 0], tau: [9, 9, 9, 9, 9, 9, 9] },
    });
    const events = [eventAt('/dex3/frame', 100n, { left: side(1), right: side(-1) }, 'unitree.dex3.frame')];
    inner.getBackfillMessages = () => Promise.resolve(events);
    inner.messageIterator = async function* () {
      yield* events;
    };
    inner.initialize = async () => ({
      ...(await innerSource().initialize()),
      topics: [{ name: '/dex3/frame', type: 'unitree.dex3.frame' }],
    });
    const source = withBuiltinTopicAdapters(inner);
    const init = await source.initialize();
    expect(init.topics.map((t) => t.name)).toEqual(['/dex3/frame', '/dex3/state', '/dex3/command']);

    const [state, command] = await collect(
      source.messageIterator({ startTime: init.start, topics: ['/dex3/state', '/dex3/command'] }),
    );
    expect(state.message).toMatchObject({
      name: expect.arrayContaining(['left_hand_thumb_0_joint', 'right_hand_index_1_joint']) as unknown,
      position: [1, 2, 3, 4, 5, 6, 7, -1, -2, -3, -4, -5, -6, -7],
    });
    expect((state.message as { name: string[] }).name).toHaveLength(14);
    expect((command.message as { effort: number[] }).effort).toEqual(new Array(14).fill(9));
  });

  it('hints at a dex3 sidecar file only when hand data is missing', async () => {
    const meta = { info: { dex3: { sidecar: 'episode_0003.dex3.mcap' } }, text: {} };
    const sourceWith = (topics: Array<{ name: string; type: string }>) => {
      const inner = innerSource();
      inner.initialize = async () => ({ ...(await innerSource().initialize()), topics });
      inner.getBackfillMessages = () => Promise.resolve([eventAt('/episode/meta', 100n, meta, 'whole_body.meta')]);
      return withBuiltinTopicAdapters(inner);
    };
    const missing = await sourceWith([{ name: '/episode/meta', type: 'whole_body.meta' }]).initialize();
    expect(missing.problems).toEqual([expect.objectContaining({ message: expect.stringContaining('episode_0003.dex3.mcap') as unknown })]);

    const present = await sourceWith([
      { name: '/episode/meta', type: 'whole_body.meta' },
      { name: '/dex3/frame', type: 'unitree.dex3.frame' },
    ]).initialize();
    expect(present.problems).toEqual([]);
  });

  it('warns about nanosecond timestamps that lost JSON precision', async () => {
    const inner = innerSource();
    inner.getBackfillMessages = () =>
      Promise.resolve([eventAt('/whole_body/frame', 100n, { ...frame(0), sample_time_ns: 1794223925884797000 }, 'whole_body.frame')]);
    const init = await withBuiltinTopicAdapters(inner).initialize();
    expect(init.problems).toEqual([expect.objectContaining({ message: expect.stringContaining('sample_time_ns') as unknown })]);
  });

  it('passes through sources without adapted topics', async () => {
    const plain: IIterableSource = {
      ...innerSource(),
      initialize: async () => ({
        ...(await innerSource().initialize()),
        topics: [{ name: '/chatter', type: 'std_msgs/msg/String' }],
      }),
    };
    const source = withBuiltinTopicAdapters(plain);
    const init = await source.initialize();
    expect(init.topics).toEqual([{ name: '/chatter', type: 'std_msgs/msg/String' }]);
    expect(init.problems).toEqual([]);
  });
});

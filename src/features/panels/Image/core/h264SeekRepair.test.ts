import { describe, expect, it } from 'vitest';
import type { Player } from '@/core/types/player';
import type { MessageEvent as RosMessageEvent } from '@/core/types/ros';
import {
  H264_SEEK_MAX_FRAMES,
  dedupeH264MessageEventsByReceiveTime,
  executeH264Bootstrap,
  findLatestH264KeyFrameIndex,
  mergeH264BootstrapWithLiveFrames,
  repairH264Seek,
  selectH264BootstrapFrames,
  selectH264SeekRepairFrames,
} from './h264SeekRepair';

const keyChunk = new Uint8Array([0, 0, 0, 1, 0x67, 1, 2, 0, 0, 1, 0x65, 3, 4]);
const deltaChunk = new Uint8Array([0, 0, 1, 0x41, 9, 9]);
const spsChunk = new Uint8Array([0, 0, 1, 0x67, 0x42, 0, 0x1e]);
const ppsChunk = new Uint8Array([0, 0, 1, 0x68, 0xce, 0x3c]);
const idrChunk = new Uint8Array([0, 0, 1, 0x65, 3, 4]);

function makeEvent(
  sec: number,
  data: Uint8Array,
  format = 'h264',
  nsec = 0,
): RosMessageEvent {
  const receiveTime = { sec, nsec };
  return {
    topic: '/camera/video',
    receiveTime,
    publishTime: receiveTime,
    message: { format, data },
    schemaName: 'foxglove_msgs/msg/CompressedVideo',
  };
}

function makeFileStartGopMessages(): RosMessageEvent[] {
  return [
    makeEvent(0, deltaChunk, 'h264', 0),
    makeEvent(0, keyChunk, 'h264', 33_378_000),
    makeEvent(0, deltaChunk, 'h264', 66_600_000),
  ];
}

describe('h264SeekRepair', () => {
  it('selectH264BootstrapFrames uses the first IDR when the playhead is before it', () => {
    const messages = makeFileStartGopMessages();

    expect(selectH264SeekRepairFrames(messages, { sec: 0, nsec: 0 })).toEqual([]);

    const bootstrap = selectH264BootstrapFrames(messages, { sec: 0, nsec: 0 });
    expect(bootstrap).toHaveLength(1);
    expect(bootstrap[0]?.receiveTime.nsec).toBe(33_378_000);
  });

  it('selects the 33ms IDR GOP at file start for an early playhead target', () => {
    const messages = makeFileStartGopMessages();

    const repair = selectH264SeekRepairFrames(messages, { sec: 0, nsec: 66_600_000 });

    expect(repair).toHaveLength(2);
    expect(repair[0]?.receiveTime.nsec).toBe(33_378_000);
    expect(repair[1]?.receiveTime.nsec).toBe(66_600_000);
  });

  it('findLatestH264KeyFrameIndex returns the last keyframe index', () => {
    const messages = [makeEvent(1, keyChunk), makeEvent(2, deltaChunk), makeEvent(3, deltaChunk)];
    expect(findLatestH264KeyFrameIndex(messages)).toBe(0);
  });

  it('does not treat standalone SPS/PPS packets as random-access points', () => {
    const messages = [
      makeEvent(1, idrChunk),
      makeEvent(2, deltaChunk),
      makeEvent(3, spsChunk),
      makeEvent(4, ppsChunk),
    ];
    expect(findLatestH264KeyFrameIndex(messages)).toBe(0);
    expect(findLatestH264KeyFrameIndex([makeEvent(1, spsChunk), makeEvent(2, ppsChunk)])).toBe(-1);
  });

  it('selectH264SeekRepairFrames returns frames from keyframe through target time', () => {
    const messages = [
      makeEvent(1, keyChunk),
      makeEvent(2, deltaChunk),
      makeEvent(3, deltaChunk),
      makeEvent(4, deltaChunk),
    ];
    const repair = selectH264SeekRepairFrames(messages, { sec: 3, nsec: 0 });

    expect(repair).toHaveLength(3);
    expect(repair.map((event) => event.receiveTime.sec)).toEqual([1, 2, 3]);
  });

  it('selectH264SeekRepairFrames ignores messages after the target time', () => {
    const messages = [
      makeEvent(1, keyChunk),
      makeEvent(2, deltaChunk),
      makeEvent(4, deltaChunk),
    ];
    const repair = selectH264SeekRepairFrames(messages, { sec: 2, nsec: 0 });

    expect(repair).toHaveLength(2);
    expect(repair.map((event) => event.receiveTime.sec)).toEqual([1, 2]);
  });

  it('returns empty when no keyframe exists in the window', () => {
    const messages = [makeEvent(1, deltaChunk), makeEvent(2, deltaChunk)];
    expect(selectH264SeekRepairFrames(messages, { sec: 2, nsec: 0 })).toEqual([]);
  });

  it('prepends ordered split SPS/PPS packets to the selected IDR GOP', () => {
    const messages = [
      makeEvent(1, spsChunk),
      makeEvent(2, ppsChunk),
      makeEvent(3, idrChunk),
      makeEvent(4, deltaChunk),
    ];

    const repair = selectH264SeekRepairFrames(messages, { sec: 4, nsec: 0 });

    expect(repair.map((event) => event.receiveTime.sec)).toEqual([1, 2, 3, 4]);
  });

  it('skips the older GOP only at the latest real IDR boundary', () => {
    const messages = [
      makeEvent(1, spsChunk),
      makeEvent(2, ppsChunk),
      makeEvent(3, idrChunk),
      makeEvent(4, deltaChunk),
      makeEvent(5, spsChunk),
      makeEvent(6, ppsChunk),
      makeEvent(7, idrChunk),
      makeEvent(8, deltaChunk),
    ];

    const repair = selectH264SeekRepairFrames(messages, { sec: 8, nsec: 0 });

    expect(repair.map((event) => event.receiveTime.sec)).toEqual([5, 6, 7, 8]);
  });

  it('caps a long GOP at a safe IDR-prefixed decodable prefix', () => {
    const messages = [
      makeEvent(1, spsChunk),
      makeEvent(2, ppsChunk),
      makeEvent(3, idrChunk),
      ...Array.from({ length: 1_000 }, (_, index) => makeEvent(index + 4, deltaChunk)),
    ];

    const repair = selectH264SeekRepairFrames(messages, { sec: 2_000, nsec: 0 });

    expect(repair).toHaveLength(H264_SEEK_MAX_FRAMES);
    expect(repair.slice(0, 3).map((event) => event.receiveTime.sec)).toEqual([1, 2, 3]);
    expect(findLatestH264KeyFrameIndex(repair)).toBe(2);
    expect(repair.at(-1)?.receiveTime.sec).toBe(H264_SEEK_MAX_FRAMES);
  });

  it('posts a single bootstrapH264 message for a long-GOP seek repair', async () => {
    const messages = [
      makeEvent(1, keyChunk),
      ...Array.from({ length: 1_000 }, (_, index) => makeEvent(index + 2, deltaChunk)),
    ];
    const posts: unknown[] = [];
    const worker = {
      postMessage(request: unknown) {
        posts.push(request);
      },
    } as unknown as Worker;
    const player = {
      getMessagesInTimeRange: async () => messages,
    } as unknown as Player;

    await expect(
      repairH264Seek(player, worker, '/camera/video', { sec: 2_000, nsec: 0 }),
    ).resolves.toBe(true);
    expect(posts).toHaveLength(1);
    expect((posts[0] as { type?: string }).type).toBe('bootstrapH264');
    expect((posts[0] as { frames?: unknown[] }).frames).toHaveLength(H264_SEEK_MAX_FRAMES);
  });

  it('keeps range-query payloads borrowed while posting seek-repair frames', async () => {
    const keyPayload = keyChunk.slice();
    const deltaPayload = deltaChunk.slice();
    const messages = [makeEvent(1, keyPayload), makeEvent(2, deltaPayload)];
    const postedFrames: unknown[] = [];
    const worker = {
      postMessage(request: unknown, transfer: Transferable[] = []) {
        const cloned = structuredClone(request, { transfer });
        if ((cloned as { type?: string }).type === 'bootstrapH264') {
          postedFrames.push(...((cloned as { frames?: unknown[] }).frames ?? []));
        }
      },
    } as unknown as Worker;
    const player = {
      getMessagesInTimeRange: async () => messages,
    } as unknown as Player;

    await expect(repairH264Seek(player, worker, '/camera/video', { sec: 2, nsec: 0 })).resolves.toBe(
      true,
    );

    expect(postedFrames).toHaveLength(2);
    expect(Array.from(keyPayload)).toEqual(Array.from(keyChunk));
    expect(Array.from(deltaPayload)).toEqual(Array.from(deltaChunk));
    expect(keyPayload.byteLength).toBeGreaterThan(0);
    expect(deltaPayload.byteLength).toBeGreaterThan(0);
  });

  it('does not post frames when an in-flight repair is aborted', async () => {
    let resolveMessages: ((messages: RosMessageEvent[]) => void) | undefined;
    const messagesPromise = new Promise<RosMessageEvent[]>((resolve) => {
      resolveMessages = resolve;
    });
    const posts: unknown[] = [];
    const worker = {
      postMessage(request: unknown) {
        posts.push(request);
      },
    } as unknown as Worker;
    const player = {
      getMessagesInTimeRange: () => messagesPromise,
    } as unknown as Player;
    const controller = new AbortController();

    const repair = repairH264Seek(player, worker, '/camera/video', { sec: 2, nsec: 0 }, {
      signal: controller.signal,
    });
    controller.abort();
    resolveMessages?.([makeEvent(1, keyChunk), makeEvent(2, deltaChunk)]);

    await expect(repair).resolves.toBe(false);
    expect(posts).toEqual([]);
  });

  it('merges bootstrap and live frames by receive time without duplicates', () => {
    const bootstrap = [makeEvent(1, keyChunk), makeEvent(2, deltaChunk)];
    const live = [makeEvent(2, deltaChunk), makeEvent(3, deltaChunk)];
    const merged = mergeH264BootstrapWithLiveFrames(bootstrap, live);
    expect(merged.map((event) => event.receiveTime.sec)).toEqual([1, 2, 3]);
    expect(merged).toHaveLength(3);
  });

  it('dedupes messages that share the same receive time', () => {
    const duplicate = [makeEvent(1, keyChunk), makeEvent(1, deltaChunk)];
    expect(dedupeH264MessageEventsByReceiveTime(duplicate)).toHaveLength(1);
  });

  it('executeH264Bootstrap rejects batches without an IDR frame', async () => {
    const posts: unknown[] = [];
    const worker = {
      postMessage(request: unknown) {
        posts.push(request);
      },
    } as unknown as Worker;
    const player = {
      getMessagesInTimeRange: async () => [],
    } as unknown as Player;

    await expect(
      executeH264Bootstrap({
        player,
        worker,
        topic: '/camera/video',
        targetTime: { sec: 0, nsec: 0 },
        liveEvents: [makeEvent(0, deltaChunk)],
      }),
    ).resolves.toBe(false);
    expect(posts).toEqual([]);
  });

  it('executeH264Bootstrap uses live frame coverage when bootstrapping before the first IDR', async () => {
    const messages = makeFileStartGopMessages();
    const latestLiveFrame = messages[2];
    if (!latestLiveFrame) {
      throw new Error('expected a third bootstrap message');
    }
    const posts: unknown[] = [];
    const worker = {
      postMessage(request: unknown) {
        posts.push(request);
      },
    } as unknown as Worker;
    const player = {
      getMessagesInTimeRange: async () => messages,
    } as unknown as Player;

    await expect(
      executeH264Bootstrap({
        player,
        worker,
        topic: '/camera/video',
        targetTime: { sec: 0, nsec: 0 },
        liveEvents: [latestLiveFrame],
      }),
    ).resolves.toBe(true);
    expect(posts).toHaveLength(1);
    expect((posts[0] as { frames?: unknown[] }).frames).toHaveLength(2);
  });
});

import { describe, expect, it, vi } from 'vitest';
import type { Initialization, MessageEvent } from '@/core/types/ros';
import type { WorkerSerializedSource } from './WorkerSerializedSource';
import { CombinedSourceProxy, type CombinedSourceMember } from './CombinedSourceProxy';
import { CombinedMessageCursor } from './CombinedMessageCursor';
import type { IMessageCursor } from './types';

function makeInit(overrides: Partial<Initialization> = {}): Initialization {
  return {
    topics: [],
    datatypes: {},
    start: { sec: 0, nsec: 0 },
    end: { sec: 10, nsec: 0 },
    publishersByTopic: {},
    topicStats: {},
    problems: [],
    ...overrides,
  };
}

function msg(topic: string, sec: number): MessageEvent {
  return {
    topic,
    receiveTime: { sec, nsec: 0 },
    publishTime: { sec, nsec: 0 },
    message: {},
    schemaName: 'test/Msg',
  };
}

function makeMockWorkerSource(overrides: Partial<WorkerSerializedSource> = {}): WorkerSerializedSource {
  return {
    initialize: vi.fn(async () => makeInit()),
    getMessageCursor: vi.fn(async (): Promise<IMessageCursor<unknown>> => new CombinedMessageCursor([])),
    getBackfillMessages: vi.fn(async () => []),
    getAdjacentMessage: vi.fn(async () => null),
    preparePlaybackBuffer: vi.fn(async () => ({ ready: true })),
    getLoadProgress: vi.fn(async () => ({ percent: 100, totalBytes: 0, downloadedByteRanges: [], parsedMessageRanges: [] })),
    getTransportDiagnostics: vi.fn(async () => ({
      mode: 'transfer' as const,
      crossOriginIsolated: false,
      binaryPayloadThresholdBytes: 64 * 1024,
      droppedPayloads: 0,
      stalePayloadRefs: 0,
    })),
    startDataQualityScan: vi.fn(async () => {}),
    getDataQualityReport: vi.fn(async () => undefined),
    resolveMessageBatch: vi.fn((batch: MessageEvent[]) => batch),
    resolveMessageForHighFrequencyLane: vi.fn((message: MessageEvent) => message),
    terminate: vi.fn(),
    ...overrides,
  } as unknown as WorkerSerializedSource;
}

function makeMember(label: string, source: WorkerSerializedSource, initArgs: Record<string, unknown> = {}): CombinedSourceMember {
  return { label, source, initArgs };
}

describe('CombinedSourceProxy', () => {
  it('requires at least 2 members', () => {
    expect(() => new CombinedSourceProxy([makeMember('a', makeMockWorkerSource())])).toThrow();
  });

  it('initializes all members in parallel and merges the result', async () => {
    const sourceA = makeMockWorkerSource({
      initialize: vi.fn(async () => makeInit({ topics: [{ name: '/a', type: 'std_msgs/String' }] })),
    });
    const sourceB = makeMockWorkerSource({
      initialize: vi.fn(async () => makeInit({ topics: [{ name: '/b', type: 'std_msgs/String' }] })),
    });
    const proxy = new CombinedSourceProxy([makeMember('a.mcap', sourceA), makeMember('b.mcap', sourceB)]);
    const init = await proxy.initialize({});
    expect(init.topics.map((t) => t.name)).toEqual(['/a', '/b']);
    expect(sourceA.initialize).toHaveBeenCalledTimes(1);
    expect(sourceB.initialize).toHaveBeenCalledTimes(1);
  });

  it('aggregates initialize progress from members', async () => {
    const sourceA = makeMockWorkerSource({
      initialize: vi.fn(async (_args, onProgress) => {
        onProgress?.({ phase: 'downloading', loadedBytes: 10, totalBytes: 40, transferredBytes: 10 });
        return makeInit({ topics: [{ name: '/a', type: 'std_msgs/String' }] });
      }),
    });
    const sourceB = makeMockWorkerSource({
      initialize: vi.fn(async (_args, onProgress) => {
        onProgress?.({ phase: 'downloading', loadedBytes: 20, totalBytes: 60, transferredBytes: 20 });
        return makeInit({ topics: [{ name: '/b', type: 'std_msgs/String' }] });
      }),
    });
    const updates: Array<{ loadedBytes: number; totalBytes: number }> = [];
    const proxy = new CombinedSourceProxy([makeMember('a.mcap', sourceA), makeMember('b.mcap', sourceB)]);
    await proxy.initialize({}, (progress) => {
      updates.push({ loadedBytes: progress.loadedBytes, totalBytes: progress.totalBytes });
    });
    expect(updates.some((update) => update.loadedBytes === 30 && update.totalBytes === 100)).toBe(true);
  });

  it('excludes a member that fails to initialize, terminates its worker, and records a problem', async () => {
    const sourceA = makeMockWorkerSource({
      initialize: vi.fn(async () => makeInit({ topics: [{ name: '/a', type: 'std_msgs/String' }] })),
    });
    const sourceB = makeMockWorkerSource({
      initialize: vi.fn(async () => {
        throw new Error('corrupt file');
      }),
    });
    const proxy = new CombinedSourceProxy([makeMember('a.mcap', sourceA), makeMember('broken.bag', sourceB)]);
    const init = await proxy.initialize({});
    expect(init.topics.map((t) => t.name)).toEqual(['/a']);
    expect(init.problems.some((p) => p.message.includes('broken.bag'))).toBe(true);
    expect(sourceB.terminate).toHaveBeenCalledTimes(1);
    expect(sourceA.terminate).not.toHaveBeenCalled();
  });

  it('throws when every member fails to initialize', async () => {
    const sourceA = makeMockWorkerSource({ initialize: vi.fn(async () => Promise.reject(new Error('bad a'))) });
    const sourceB = makeMockWorkerSource({ initialize: vi.fn(async () => Promise.reject(new Error('bad b'))) });
    const proxy = new CombinedSourceProxy([makeMember('a', sourceA), makeMember('b', sourceB)]);
    await expect(proxy.initialize({})).rejects.toThrow();
  });

  it('getMessageCursor only fans out to members that own the requested topics', async () => {
    const sourceA = makeMockWorkerSource({
      initialize: vi.fn(async () => makeInit({ topics: [{ name: '/a', type: 'std_msgs/String' }] })),
    });
    const sourceB = makeMockWorkerSource({
      initialize: vi.fn(async () => makeInit({ topics: [{ name: '/b', type: 'std_msgs/String' }] })),
    });
    const proxy = new CombinedSourceProxy([makeMember('a', sourceA), makeMember('b', sourceB)]);
    await proxy.initialize({});
    await proxy.getMessageCursor({ startTime: { sec: 0, nsec: 0 }, topics: ['/a'] });
    expect(sourceA.getMessageCursor).toHaveBeenCalledTimes(1);
    expect(sourceB.getMessageCursor).not.toHaveBeenCalled();
  });

  it('getBackfillMessages merges results and dedupes same-named topics by latest receiveTime', async () => {
    const sourceA = makeMockWorkerSource({
      initialize: vi.fn(async () => makeInit({ topics: [{ name: '/tf', type: 'tf2_msgs/TFMessage' }] })),
      getBackfillMessages: vi.fn(async () => [msg('/tf', 3)]),
    });
    const sourceB = makeMockWorkerSource({
      initialize: vi.fn(async () => makeInit({ topics: [{ name: '/tf', type: 'tf2_msgs/TFMessage' }] })),
      getBackfillMessages: vi.fn(async () => [msg('/tf', 5)]),
    });
    const proxy = new CombinedSourceProxy([makeMember('a', sourceA), makeMember('b', sourceB)]);
    await proxy.initialize({});
    const backfilled = await proxy.getBackfillMessages({ time: { sec: 10, nsec: 0 }, topics: ['/tf'] });
    expect(backfilled).toHaveLength(1);
    expect(backfilled[0].receiveTime.sec).toBe(5);
  });

  it('routes resolveMessageBatch to the member that produced each message', async () => {
    const sourceA = makeMockWorkerSource({
      initialize: vi.fn(async () => makeInit({ topics: [{ name: '/a', type: 'std_msgs/String' }] })),
      resolveMessageBatch: vi.fn((batch: MessageEvent[]) => batch.map((m) => ({ ...m, schemaName: 'resolved-by-a' }))),
    });
    const sourceB = makeMockWorkerSource({
      initialize: vi.fn(async () => makeInit({ topics: [{ name: '/b', type: 'std_msgs/String' }] })),
      resolveMessageBatch: vi.fn((batch: MessageEvent[]) => batch.map((m) => ({ ...m, schemaName: 'resolved-by-b' }))),
    });
    const proxy = new CombinedSourceProxy([makeMember('a', sourceA), makeMember('b', sourceB)]);
    await proxy.initialize({});

    const cursorA = await sourceA.getMessageCursor({ startTime: { sec: 0, nsec: 0 }, topics: ['/a'] });
    void cursorA;
    // Build a merged batch the way CombinedMessageCursor would tag it, by
    // going through getMessageCursor + nextBatch on mocked child cursors.
    const childA: IMessageCursor<unknown> = {
      next: async () => ({ done: true, value: undefined }),
      nextBatch: async () => [msg('/a', 1)],
      end: async () => {},
    };
    const childB: IMessageCursor<unknown> = {
      next: async () => ({ done: true, value: undefined }),
      nextBatch: async () => [msg('/b', 2)],
      end: async () => {},
    };
    (sourceA.getMessageCursor as ReturnType<typeof vi.fn>).mockResolvedValueOnce(childA);
    (sourceB.getMessageCursor as ReturnType<typeof vi.fn>).mockResolvedValueOnce(childB);

    const cursor = await proxy.getMessageCursor({ startTime: { sec: 0, nsec: 0 }, topics: ['/a', '/b'] });
    const batch = await cursor.nextBatch(1000);
    const resolved = proxy.resolveMessageBatch(batch);
    const bySchema = new Map(resolved.map((m) => [m.topic, m.schemaName]));
    expect(bySchema.get('/a')).toBe('resolved-by-a');
    expect(bySchema.get('/b')).toBe('resolved-by-b');
    expect(sourceA.resolveMessageBatch).toHaveBeenCalledTimes(1);
    expect(sourceB.resolveMessageBatch).toHaveBeenCalledTimes(1);
  });

  it('terminate() terminates every member, including ones excluded from the merge', async () => {
    const sourceA = makeMockWorkerSource();
    const sourceB = makeMockWorkerSource();
    const proxy = new CombinedSourceProxy([makeMember('a', sourceA), makeMember('b', sourceB)]);
    proxy.terminate();
    expect(sourceA.terminate).toHaveBeenCalledTimes(1);
    expect(sourceB.terminate).toHaveBeenCalledTimes(1);
  });
});

import { describe, expect, it, vi } from 'vitest';

// The worker module exposes itself over Comlink when loaded; a test drives the class directly.
vi.mock('comlink', async (importOriginal) => ({
  ...(await importOriginal<typeof import('comlink')>()),
  expose: vi.fn(),
}));

const { McapWorkerImpl } = await import('./mcap.worker');

const MIB = 1024 * 1024;
const SEC = 1_000_000_000n;

/** A remote recording of ten 1 s chunks of 1 MiB each, nothing cached yet. */
function remoteWorker() {
  const worker = new McapWorkerImpl();
  const prefetch = vi.fn();
  const chunks = Array.from({ length: 10 }, (_, i) => ({
    byteRange: { start: i * MIB, end: (i + 1) * MIB },
    timeRange: { start: { sec: i, nsec: 0 }, end: { sec: i + 1, nsec: 0 } },
    startNs: BigInt(i) * SEC,
    endNs: BigInt(i + 1) * SEC - 1n,
  }));
  const source = {
    initialize: vi.fn(),
    messageIterator: vi.fn(async function* () {}),
    getBackfillMessages: vi.fn(async () => []),
  };
  Object.assign(worker as unknown as Record<string, unknown>, {
    _source: source,
    _cachedReadable: {
      prefetch,
      getDownloadedRanges: () => [],
      refreshRanges: vi.fn(async () => undefined),
      size: async () => 10 * MIB,
    },
    _totalBytes: 10 * MIB,
    _chunkCoverage: chunks,
    _prefetchAnchor: { sec: 0, nsec: 0 },
  });
  return { worker, prefetch, source };
}

describe('mcap worker read-ahead', () => {
  it('reads no further than the frame while paused: backfill and panel range scans start no read-ahead', async () => {
    const { worker, prefetch, source } = remoteWorker();
    const onTopic = vi.fn(() => true);
    await worker.getBackfillMessages({ time: { sec: 2, nsec: 0 }, topics: ['/camera'] }, onTopic);
    expect(source.getBackfillMessages).toHaveBeenCalledWith(
      { time: { sec: 2, nsec: 0 }, topics: ['/camera'] },
      onTopic,
    );
    const cursor = await worker.getMessageCursor({
      startTime: { sec: 1, nsec: 0 },
      endTime: { sec: 6, nsec: 0 },
      topics: ['/joint_states'],
    });
    await cursor.end();
    expect(prefetch).not.toHaveBeenCalled();
  });

  it('starts read-ahead with playback: the open-ended playback cursor and preparePlaybackBuffer', async () => {
    const { worker, prefetch } = remoteWorker();
    const cursor = await worker.getMessageCursor({ startTime: { sec: 2, nsec: 0 }, topics: ['/camera'] });
    await cursor.end();
    expect(prefetch).toHaveBeenCalledTimes(1);
    // Each chunk of the next 5 s at the playhead, by its own byte range (adjacent ones merged).
    expect(prefetch.mock.calls[0][0]).toEqual([{ start: 2 * MIB, end: 8 * MIB }]);

    await worker.preparePlaybackBuffer({ time: { sec: 4, nsec: 0 }, topics: ['/camera'], minAheadMs: 2_000 });
    expect(prefetch).toHaveBeenCalledTimes(2);
    expect(prefetch.mock.calls[1][0]).toEqual([{ start: 4 * MIB, end: 7 * MIB }]);
  });
});

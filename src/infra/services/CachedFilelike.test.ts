import EventEmitter from 'eventemitter3';
import { describe, expect, it, vi } from 'vitest';

import CachedFilelike, { type FileStream, type FileStreamEvents } from './CachedFilelike';

class TestStream extends EventEmitter<FileStreamEvents> implements FileStream {
  public destroyed = false;
  public destroy = vi.fn(() => {
    this.destroyed = true;
  });

  public emitData(data: number[]): void {
    this.emit('data', new Uint8Array(data));
  }

  public emitProgress(received: number, total: number): void {
    this.emit('progress', received, total);
  }
}

class TestFileReader {
  public streams: Array<TestStream & { offset: number; length: number }> = [];

  public async open(): Promise<{ size: number }> {
    return { size: 32 };
  }

  public fetch(offset: number, length: number): FileStream {
    const stream = new TestStream() as TestStream & { offset: number; length: number };
    stream.offset = offset;
    stream.length = length;
    this.streams.push(stream);
    return stream;
  }
}

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('CachedFilelike prefetch', () => {
  it('fills the cache without a foreground read request', async () => {
    const reader = new TestFileReader();
    const filelike = new CachedFilelike({ fileReader: reader, cacheSizeInBytes: 32, fetchBlockSizeInBytes: 4 });

    filelike.prefetch(8, 4);
    await flushAsyncWork();

    expect(reader.streams).toHaveLength(1);
    expect(reader.streams[0].offset).toBe(8);
    expect(reader.streams[0].length).toBe(4);

    reader.streams[0].emitData([1, 2, 3, 4]);
    const data = await filelike.read(8, 4);

    expect(Array.from(data)).toEqual([1, 2, 3, 4]);
  });

  it('lets foreground reads interrupt an active prefetch', async () => {
    const reader = new TestFileReader();
    const filelike = new CachedFilelike({ fileReader: reader, cacheSizeInBytes: 32, fetchBlockSizeInBytes: 4 });

    filelike.prefetch(16, 4);
    await flushAsyncWork();
    expect(reader.streams).toHaveLength(1);

    const readPromise = filelike.read(0, 4);
    await flushAsyncWork();

    expect(reader.streams[0].destroyed).toBe(true);
    expect(reader.streams).toHaveLength(2);
    expect(reader.streams[1].offset).toBe(0);

    reader.streams[1].emitData([5, 6, 7, 8]);
    await expect(readPromise).resolves.toEqual(new Uint8Array([5, 6, 7, 8]));
  });

  it('extends a matching active prefetch instead of restarting it', async () => {
    const reader = new TestFileReader();
    const filelike = new CachedFilelike({ fileReader: reader, cacheSizeInBytes: 32, fetchBlockSizeInBytes: 4 });

    filelike.prefetch(0, 4, { replace: true });
    await flushAsyncWork();
    expect(reader.streams).toHaveLength(1);

    filelike.prefetch(0, 8, { replace: true });
    await flushAsyncWork();

    expect(reader.streams).toHaveLength(1);
    expect(reader.streams[0].destroyed).toBe(false);

    reader.streams[0].emitData([1, 2, 3, 4]);
    await flushAsyncWork();

    expect(reader.streams).toHaveLength(2);
    expect(reader.streams[1].offset).toBe(4);
    expect(reader.streams[1].length).toBe(4);
  });

  it('fetches aligned blocks for small foreground reads', async () => {
    const reader = new TestFileReader();
    const filelike = new CachedFilelike({ fileReader: reader, cacheSizeInBytes: 32, fetchBlockSizeInBytes: 8 });

    const firstRead = filelike.read(3, 1);
    await flushAsyncWork();

    expect(reader.streams).toHaveLength(1);
    expect(reader.streams[0].offset).toBe(0);
    expect(reader.streams[0].length).toBe(8);

    reader.streams[0].emitData([0, 1, 2, 3, 4, 5, 6, 7]);
    await expect(firstRead).resolves.toEqual(new Uint8Array([3]));

    const secondRead = await filelike.read(7, 1);
    expect(secondRead).toEqual(new Uint8Array([7]));
    expect(reader.streams).toHaveLength(1);
  });

  it('continues an overlapping prefetch when a foreground read needs the same block', async () => {
    const reader = new TestFileReader();
    const filelike = new CachedFilelike({ fileReader: reader, cacheSizeInBytes: 32, fetchBlockSizeInBytes: 8 });

    filelike.prefetch(2, 1);
    await flushAsyncWork();
    expect(reader.streams).toHaveLength(1);
    expect(reader.streams[0].offset).toBe(0);
    expect(reader.streams[0].length).toBe(8);

    const readPromise = filelike.read(3, 1);
    await flushAsyncWork();

    expect(reader.streams).toHaveLength(1);
    expect(reader.streams[0].destroyed).toBe(false);

    reader.streams[0].emitData([0, 1, 2, 3, 4, 5, 6, 7]);
    await expect(readPromise).resolves.toEqual(new Uint8Array([3]));
  });
});

// Regression tests for a bug where a remote `Filelike` adapter with a mismatched (async/bigint)
// `size()` caused `read(offset, NaN)` calls to hang forever while `CachedFilelike` kept
// re-fetching an already-downloaded ~50MiB block on a loop, with no error ever surfacing. See
// `remoteBagReadable.test.ts` for the corresponding regression test at the adapter boundary.
describe('CachedFilelike input validation', () => {
  it('rejects non-finite read lengths synchronously instead of enqueueing an unsatisfiable request', async () => {
    const reader = new TestFileReader();
    const filelike = new CachedFilelike({ fileReader: reader, cacheSizeInBytes: 32, fetchBlockSizeInBytes: 8 });

    expect(() => filelike.read(4, NaN)).toThrow(/invalid input/);
    expect(() => filelike.read(NaN, 4)).toThrow(/invalid input/);
    expect(() => filelike.read(0, Infinity)).toThrow(/invalid input/);
    await flushAsyncWork();

    // No fetch should ever be scheduled for an unsatisfiable range.
    expect(reader.streams).toHaveLength(0);
  });

  it('rejects negative or non-integer offsets/lengths', () => {
    const reader = new TestFileReader();
    const filelike = new CachedFilelike({ fileReader: reader, cacheSizeInBytes: 32 });

    expect(() => filelike.read(-1, 4)).toThrow(/invalid input/);
    expect(() => filelike.read(0, -4)).toThrow(/invalid input/);
    expect(() => filelike.read(1.5, 4)).toThrow(/invalid input/);
  });

  it('silently drops malformed prefetch requests instead of scheduling a fetch', async () => {
    const reader = new TestFileReader();
    const filelike = new CachedFilelike({ fileReader: reader, cacheSizeInBytes: 32, fetchBlockSizeInBytes: 8 });

    filelike.prefetch(4, NaN);
    filelike.prefetch(-1, 4);
    filelike.prefetch(1.5, 4);
    await flushAsyncWork();

    expect(reader.streams).toHaveLength(0);
  });
});

describe('CachedFilelike download progress', () => {
  it('forwards stream progress to onDownloadProgress', async () => {
    const reader = new TestFileReader();
    const updates: Array<{ loadedBytes: number; totalBytes: number; transferredBytes: number }> = [];
    const filelike = new CachedFilelike({
      fileReader: reader,
      cacheSizeInBytes: 32,
      fetchBlockSizeInBytes: 8,
      onDownloadProgress: (info) => updates.push({ ...info }),
    });

    const readPromise = filelike.read(0, 8);
    await flushAsyncWork();
    expect(reader.streams).toHaveLength(1);

    reader.streams[0].emitProgress(4, 8);
    reader.streams[0].emitData([0, 1, 2, 3, 4, 5, 6, 7]);
    await readPromise;

    expect(updates.some((update) => update.loadedBytes === 4 && update.totalBytes === 8)).toBe(true);
    expect(updates[0].transferredBytes).toBeGreaterThan(0);
  });
});

describe('CachedFilelike avoids re-fetching already-satisfied ranges', () => {
  it('does not issue a second fetch for a block that is already fully downloaded', async () => {
    const reader = new TestFileReader();
    const filelike = new CachedFilelike({ fileReader: reader, cacheSizeInBytes: 32, fetchBlockSizeInBytes: 8 });

    const firstRead = filelike.read(0, 8);
    await flushAsyncWork();
    expect(reader.streams).toHaveLength(1);

    reader.streams[0].emitData([0, 1, 2, 3, 4, 5, 6, 7]);
    await expect(firstRead).resolves.toEqual(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]));

    // Requesting the exact same already-downloaded range again must be served from cache,
    // not trigger a new HTTP-equivalent fetch.
    const secondRead = await filelike.read(0, 8);
    expect(secondRead).toEqual(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]));
    expect(reader.streams).toHaveLength(1);
  });
});

describe('CachedFilelike bounded error retries', () => {
  it('gives up after a bounded number of consecutive errors, even when failures are spaced beyond the 100ms rapid-fault window', async () => {
    let now = 0;
    const dateNowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const reader = new TestFileReader();
      const filelike = new CachedFilelike({ fileReader: reader, cacheSizeInBytes: 32, fetchBlockSizeInBytes: 8 });

      const readPromise = filelike.read(0, 8);
      await flushAsyncWork();

      let settled = false;
      void readPromise.catch(() => {
        settled = true;
      });

      for (let i = 0; i < 20 && !settled; i++) {
        const stream = reader.streams[reader.streams.length - 1];
        now += 200; // well beyond the old 100ms rapid-double-fault window
        stream.emit('error', new Error(`boom ${i}`));
        await flushAsyncWork();
      }

      await expect(readPromise).rejects.toThrow(/giving up/);
      // The retry budget must be small and bounded — not "keep retrying forever".
      expect(reader.streams.length).toBeLessThan(20);
    } finally {
      dateNowSpy.mockRestore();
    }
  });
});

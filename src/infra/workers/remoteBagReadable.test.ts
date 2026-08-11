import { describe, expect, it } from 'vitest';

import { buildRemoteBagReadable, type AsyncByteRangeSource } from './remoteBagReadable';

/** Minimal `CachedFilelike`-shaped stub: async `size()`, async `read()`. */
class TestAsyncByteRangeSource implements AsyncByteRangeSource {
  constructor(private readonly totalBytes: number) {}

  async size(): Promise<number> {
    return this.totalBytes;
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    return new Uint8Array(length).fill(offset % 256);
  }
}

describe('buildRemoteBagReadable', () => {
  it('exposes size() synchronously as a plain number, matching @foxglove/rosbag Filelike', async () => {
    const readable = await buildRemoteBagReadable(new TestAsyncByteRangeSource(1234));

    // `Filelike.size()` must be callable without `await` and must not be a `Promise` or
    // `bigint` — @foxglove/rosbag calls it directly, e.g. `this._file.size() - fileOffset`.
    // Regression test for the bug where `size` was `async () => BigInt(await source.size())`:
    // that turned every un-awaited `size() - offset` into `NaN`, which made `CachedFilelike`
    // re-fetch the same block forever because a `NaN`-bounded read can never be satisfied.
    const size = readable.size();
    expect(typeof size).toBe('number');
    expect(size).toBe(1234);

    // The exact arithmetic @foxglove/rosbag performs when reading the connections/chunk
    // index (`this._file.size() - fileOffset`) must be a finite number, never `NaN`.
    const fileOffset = 100;
    expect(Number.isFinite(readable.size() - fileOffset)).toBe(true);
    expect(readable.size() - fileOffset).toBe(1134);
  });

  it('only resolves the underlying async size() once, then reuses it synchronously', async () => {
    let sizeCalls = 0;
    const source: AsyncByteRangeSource = {
      size: async () => {
        sizeCalls += 1;
        return 42;
      },
      read: async (_offset, length) => new Uint8Array(length),
    };

    const readable = await buildRemoteBagReadable(source);
    expect(readable.size()).toBe(42);
    expect(readable.size()).toBe(42);
    expect(readable.size()).toBe(42);
    expect(sizeCalls).toBe(1);
  });

  it('forwards read() to the underlying source', async () => {
    const readable = await buildRemoteBagReadable(new TestAsyncByteRangeSource(10));
    const data = await readable.read(3, 4);
    expect(data).toEqual(new Uint8Array([3, 3, 3, 3]));
  });
});

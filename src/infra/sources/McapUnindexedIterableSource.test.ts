import { McapIndexedReader, McapWriter } from '@mcap/core';
import type { IWritable } from '@mcap/core';
import { describe, expect, it } from 'vitest';
import type { MessageEvent } from '@/core/types/ros';
import { fromNano } from '@/shared/utils/time';
import { McapUnindexedIterableSource, type McapIndexCache, type SerializedMcapIndex } from './McapUnindexedIterableSource';

class MemoryWritable implements IWritable {
  private _chunks: Uint8Array[] = [];
  private _size = 0;
  position(): bigint {
    return BigInt(this._size);
  }
  write(buffer: Uint8Array): Promise<void> {
    this._chunks.push(buffer.slice());
    this._size += buffer.byteLength;
    return Promise.resolve();
  }
  bytes(): Uint8Array {
    const out = new Uint8Array(this._size);
    let offset = 0;
    for (const chunk of this._chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out;
  }
}

function readableFor(bytes: Uint8Array) {
  return {
    size: () => Promise.resolve(BigInt(bytes.byteLength)),
    read: (offset: bigint, length: bigint) =>
      Promise.resolve(bytes.slice(Number(offset), Number(offset + length))),
  };
}

const encoder = new TextEncoder();

/** Writes an MCAP with no summary indexes, like a streaming recorder. */
async function writeUnindexedMcap(
  messages: Array<{ topic: string; logTimeNs: bigint; payload: unknown }>,
  useChunks: boolean,
  compressChunk?: (data: Uint8Array) => { compression: string; compressedData: Uint8Array },
): Promise<Uint8Array> {
  const writable = new MemoryWritable();
  const writer = new McapWriter({
    writable,
    useChunks,
    chunkSize: 64,
    useStatistics: false,
    useSummaryOffsets: false,
    useChunkIndex: false,
    useMessageIndex: false,
    useAttachmentIndex: false,
    useMetadataIndex: false,
    repeatSchemas: false,
    repeatChannels: false,
    compressChunk,
  });
  await writer.start({ profile: 'test', library: 'test' });
  const channelIds = new Map<string, number>();
  for (const message of messages) {
    let channelId = channelIds.get(message.topic);
    if (channelId == undefined) {
      const schemaId = await writer.registerSchema({
        name: `${message.topic.slice(1)}.type`,
        encoding: 'jsonschema',
        data: encoder.encode('{"type":"object"}'),
      });
      channelId = await writer.registerChannel({
        topic: message.topic,
        schemaId,
        messageEncoding: 'json',
        metadata: new Map(),
      });
      channelIds.set(message.topic, channelId);
    }
    await writer.addMessage({
      channelId,
      sequence: 0,
      logTime: message.logTimeNs,
      publishTime: message.logTimeNs,
      data: encoder.encode(JSON.stringify(message.payload)),
    });
  }
  await writer.end();
  return writable.bytes();
}

const SAMPLE = [
  { topic: '/a', logTimeNs: 1_000n, payload: { v: 1 } },
  { topic: '/b', logTimeNs: 1_500n, payload: { v: 2 } },
  // Out of order on purpose: the source must sort by log time.
  { topic: '/a', logTimeNs: 3_000n, payload: { v: 4 } },
  { topic: '/a', logTimeNs: 2_000n, payload: { v: 3 } },
];

async function collect(iter: AsyncIterableIterator<MessageEvent>): Promise<MessageEvent[]> {
  const out: MessageEvent[] = [];
  for await (const event of iter) out.push(event);
  return out;
}

describe('McapUnindexedIterableSource', () => {
  it.each([false, true])('indexes and reads an unindexed file (chunks=%s)', async (useChunks) => {
    const bytes = await writeUnindexedMcap(SAMPLE, useChunks);
    await expect(McapIndexedReader.Initialize({ readable: readableFor(bytes) })).rejects.toThrow();

    const source = new McapUnindexedIterableSource(readableFor(bytes));
    const init = await source.initialize();
    expect(init.start).toEqual(fromNano(1_000n));
    expect(init.end).toEqual(fromNano(3_000n));
    expect(init.topics).toEqual([
      { name: '/a', type: 'a.type' },
      { name: '/b', type: 'b.type' },
    ]);
    expect(init.topicStats['/a'].messageCount).toBe(3);
    expect(init.problems).toEqual([]);

    const all = await collect(source.messageIterator({ startTime: init.start, topics: ['/a', '/b'] }));
    expect(all.map((e) => (e.message as { v: number }).v)).toEqual([1, 2, 3, 4]);

    const ranged = await collect(
      source.messageIterator({ startTime: fromNano(1_200n), endTime: fromNano(2_000n), topics: ['/a'] }),
    );
    expect(ranged.map((e) => (e.message as { v: number }).v)).toEqual([3]);

    const backfill = await source.getBackfillMessages({ time: fromNano(2_500n), topics: ['/a', '/b'] });
    expect(backfill.map((e) => [e.topic, (e.message as { v: number }).v])).toEqual([
      ['/a', 3],
      ['/b', 2],
    ]);
    // Before the first message: fall forward to it.
    const early = await source.getBackfillMessages({ time: fromNano(0n), topics: ['/a'] });
    expect((early[0].message as { v: number }).v).toBe(1);

    const next = await source.getAdjacentMessage({ time: fromNano(1_000n), topics: ['/a', '/b'], direction: 'next' });
    expect(next?.topic).toBe('/b');
    const prev = await source.getAdjacentMessage({ time: fromNano(2_000n), topics: ['/a', '/b'], direction: 'prev' });
    expect(prev?.topic).toBe('/b');
  });

  it('decompresses chunks with the provided handlers', async () => {
    // Toy "compression": reverse the bytes, so a missing handler can't accidentally pass.
    const reverse = (data: Uint8Array) => data.slice().reverse();
    const bytes = await writeUnindexedMcap(SAMPLE, true, (data) => ({
      compression: 'reverse',
      compressedData: reverse(data),
    }));

    const source = new McapUnindexedIterableSource(readableFor(bytes), {
      decompressHandlers: { reverse: (data) => reverse(data) },
    });
    const init = await source.initialize();
    expect(init.topicStats['/a'].messageCount).toBe(3);
    const all = await collect(source.messageIterator({ startTime: init.start, topics: ['/a', '/b'] }));
    expect(all.map((e) => (e.message as { v: number }).v)).toEqual([1, 2, 3, 4]);

    const withoutHandler = new McapUnindexedIterableSource(readableFor(bytes));
    await expect(withoutHandler.initialize()).rejects.toThrow(/reverse/);
  });

  it('reports scan progress up to the file size', async () => {
    const bytes = await writeUnindexedMcap(SAMPLE, false);
    const progress: number[] = [];
    const source = new McapUnindexedIterableSource(readableFor(bytes), {
      onProgress: ({ scannedBytes, totalBytes }) => {
        expect(totalBytes).toBe(bytes.byteLength);
        progress.push(scannedBytes);
      },
    });
    await source.initialize();
    expect(progress[progress.length - 1]).toBe(bytes.byteLength);
  });

  it('reads payloads larger than the scan window', async () => {
    const big = 'x'.repeat(9 * 1024 * 1024);
    const bytes = await writeUnindexedMcap(
      [
        { topic: '/big', logTimeNs: 1n, payload: { big } },
        { topic: '/small', logTimeNs: 2n, payload: { v: 1 } },
      ],
      false,
    );
    const source = new McapUnindexedIterableSource(readableFor(bytes));
    const init = await source.initialize();
    const all = await collect(source.messageIterator({ startTime: init.start, topics: ['/big', '/small'] }));
    expect((all[0].message as { big: string }).big.length).toBe(big.length);
    expect(all[1].message).toEqual({ v: 1 });
  });

  it('reports truncation and keeps messages before the cut', async () => {
    const bytes = await writeUnindexedMcap(SAMPLE, false);
    const fourthMessage = await writeUnindexedMcap(SAMPLE.slice(0, 3), false);
    // Cut in the middle of the last message record.
    const truncated = bytes.slice(0, fourthMessage.byteLength - 20);
    const source = new McapUnindexedIterableSource(readableFor(truncated));
    const init = await source.initialize();
    expect(init.problems).toHaveLength(1);
    const all = await collect(source.messageIterator({ startTime: init.start, topics: ['/a', '/b'] }));
    expect(all.length).toBeGreaterThan(0);
    expect(all.length).toBeLessThan(SAMPLE.length);
  });

  it('reuses a cached index and rescans when the file changes', async () => {
    const store = new Map<string, SerializedMcapIndex>();
    const cache: McapIndexCache = {
      get: (key) => Promise.resolve(store.has(key) ? structuredClone(store.get(key)) : undefined),
      set: (key, index) => {
        store.set(key, structuredClone(index));
        return Promise.resolve();
      },
    };
    const countingReadable = (bytes: Uint8Array) => {
      const inner = readableFor(bytes);
      const counter = { bytesRead: 0 };
      return {
        counter,
        readable: {
          size: inner.size,
          read: (offset: bigint, length: bigint) => {
            counter.bytesRead += Number(length);
            return inner.read(offset, length);
          },
        },
      };
    };
    const big = 'x'.repeat(64 * 1024);
    const messages = [...SAMPLE, { topic: '/b', logTimeNs: 4_000n, payload: { big } }];
    const bytes = await writeUnindexedMcap(messages, false);

    const first = countingReadable(bytes);
    await new McapUnindexedIterableSource(first.readable, { indexCache: { cache, key: 'k' } }).initialize();
    expect(store.has('k')).toBe(true);
    expect(first.counter.bytesRead).toBeGreaterThanOrEqual(bytes.byteLength);

    const second = countingReadable(bytes);
    const cached = new McapUnindexedIterableSource(second.readable, { indexCache: { cache, key: 'k' } });
    const init = await cached.initialize();
    // Only the head/tail fingerprint is read.
    expect(second.counter.bytesRead).toBeLessThanOrEqual(8192);
    expect(init.topicStats['/a'].messageCount).toBe(3);
    const all = await collect(cached.messageIterator({ startTime: init.start, topics: ['/a', '/b'] }));
    expect(all.map((e) => (e.message as { v?: number }).v)).toEqual([1, 2, 3, 4, undefined]);

    // Same key, different content: the fingerprint misses and the file is rescanned.
    const changed = await writeUnindexedMcap(SAMPLE.slice(0, 2), false);
    const third = countingReadable(changed);
    const rescanned = await new McapUnindexedIterableSource(third.readable, {
      indexCache: { cache, key: 'k' },
    }).initialize();
    expect(rescanned.topicStats['/a'].messageCount).toBe(1);
  });

  it('rejects non-MCAP data', async () => {
    const source = new McapUnindexedIterableSource(readableFor(encoder.encode('not an mcap file')));
    await expect(source.initialize()).rejects.toThrow(/magic/);
  });
});

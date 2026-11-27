import { describe, expect, it } from 'vitest';

import type { MessageEvent } from '@/core/types/ros';
import { MessageCursor } from './MessageCursor';
import { createSharedPayloadRingConfig, SharedPayloadRing } from './sharedPayloadRing';
import { isSharedPayloadRef } from './transport';

function message(sec: number): MessageEvent<{ value: number }> {
  return {
    topic: '/topic',
    receiveTime: { sec, nsec: 0 },
    publishTime: { sec, nsec: 0 },
    message: { value: sec },
    schemaName: 'schema',
  };
}

function imageMessage(sec: number, data: Uint8Array): MessageEvent<{ data: Uint8Array; format: string }> {
  return {
    topic: '/camera/image/compressed',
    receiveTime: { sec, nsec: 0 },
    publishTime: { sec, nsec: 0 },
    message: { format: 'jpeg', data },
    schemaName: 'sensor_msgs/msg/CompressedImage',
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('MessageCursor', () => {
  it('fills the worker-side queue in the background', async () => {
    const gates = [deferred<IteratorResult<MessageEvent>>(), deferred<IteratorResult<MessageEvent>>()];
    let calls = 0;
    const iterator: AsyncIterableIterator<MessageEvent> = {
      async next() {
        const gate = gates[calls++];
        if (!gate) {
          return { done: true, value: undefined };
        }
        return await gate.promise;
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };

    const cursor = new MessageCursor(iterator, {
      mode: 'comlink',
      binaryPayloadThresholdBytes: 64 * 1024,
    });

    gates[0].resolve({ done: false, value: message(0) });
    await flushAsyncWork();
    gates[1].resolve({ done: false, value: message(1) });
    await flushAsyncWork();

    const batch = await cursor.nextBatch(1000);

    expect(calls).toBeGreaterThanOrEqual(2);
    expect(
      batch.map((event) => (event.message as { value: number }).value),
    ).toEqual([0, 1]);

    await cursor.end();
  });

  it('writes SAB payload refs only when messages are returned to the main thread', async () => {
    const ringConfig = createSharedPayloadRingConfig(8, 4);
    const ringReader = new SharedPayloadRing(ringConfig);
    let nextSec = 0;
    const iterator: AsyncIterableIterator<MessageEvent> = {
      async next() {
        if (nextSec >= 4) {
          return { done: true, value: undefined };
        }
        const value = imageMessage(nextSec, new Uint8Array([nextSec, nextSec + 1, nextSec + 2, nextSec + 3]));
        nextSec += 1;
        return { done: false, value };
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };

    const cursor = new MessageCursor(iterator, {
      mode: 'sab',
      binaryPayloadThresholdBytes: 1,
      payloadRing: ringConfig,
    });
    await flushAsyncWork();

    expect(Atomics.load(new Int32Array(ringConfig.control), 0)).toBe(0);

    const batch = await cursor.nextBatch(10_000);
    expect(batch).toHaveLength(4);
    for (let i = 0; i < batch.length; i++) {
      const data = (batch[i].message as { data: unknown }).data;
      expect(isSharedPayloadRef(data)).toBe(true);
      if (!isSharedPayloadRef(data)) {
        throw new Error('Expected SAB payload ref');
      }
      expect(Array.from(ringReader.read(data)!)).toEqual([i, i + 1, i + 2, i + 3]);
    }

    await cursor.end();
  });

  it('coalesces latest-only topics before writing SAB payload refs', async () => {
    const ringConfig = createSharedPayloadRingConfig(16, 4);
    const ringReader = new SharedPayloadRing(ringConfig);
    let nextSec = 0;
    const iterator: AsyncIterableIterator<MessageEvent> = {
      async next() {
        if (nextSec >= 4) {
          return { done: true, value: undefined };
        }
        const value = imageMessage(nextSec, new Uint8Array([nextSec, nextSec + 1, nextSec + 2, nextSec + 3]));
        nextSec += 1;
        return { done: false, value };
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };

    const cursor = new MessageCursor(
      iterator,
      {
        mode: 'sab',
        binaryPayloadThresholdBytes: 1,
        payloadRing: ringConfig,
        latestOnlyTopics: ['/camera/image/compressed'],
      },
    );
    await flushAsyncWork();

    const batch = await cursor.nextBatch(10_000);

    expect(batch).toHaveLength(1);
    const data = (batch[0].message as { data: unknown }).data;
    expect(isSharedPayloadRef(data)).toBe(true);
    if (!isSharedPayloadRef(data)) {
      throw new Error('Expected SAB payload ref');
    }
    expect(Array.from(ringReader.read(data)!)).toEqual([3, 4, 5, 6]);
    expect(Atomics.load(new Int32Array(ringConfig.control), 0)).toBe(1);

    await cursor.end();
  });

  it('does not return messages beyond an explicit batch end time', async () => {
    let nextSec = 0;
    const iterator: AsyncIterableIterator<MessageEvent> = {
      async next() {
        if (nextSec >= 4) {
          return { done: true, value: undefined };
        }
        const value = message(nextSec);
        nextSec += 1;
        return { done: false, value };
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };

    const cursor = new MessageCursor(iterator, {
      mode: 'comlink',
      binaryPayloadThresholdBytes: 64 * 1024,
    });
    await flushAsyncWork();

    const firstBatch = await cursor.nextBatch(10_000, { endTime: { sec: 1, nsec: 0 } });
    expect(firstBatch.map((event) => (event.message as { value: number }).value)).toEqual([0, 1]);

    const secondBatch = await cursor.nextBatch(10_000, { endTime: { sec: 3, nsec: 0 } });
    expect(secondBatch.map((event) => (event.message as { value: number }).value)).toEqual([2, 3]);

    await cursor.end();
  });

  it('compacts sliced binary payloads backed by a large shared chunk buffer for zero-copy transfer', async () => {
    const sharedChunk = new Uint8Array(64 * 1024);
    sharedChunk.set([10, 20, 30, 40], 1024);
    const slice = new Uint8Array(sharedChunk.buffer, 1024, 4);
    let sent = false;
    const iterator: AsyncIterableIterator<MessageEvent> = {
      async next() {
        if (sent) return { done: true, value: undefined };
        sent = true;
        return { done: false, value: imageMessage(0, slice) };
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };

    const cursor = new MessageCursor(iterator, {
      mode: 'transfer',
      binaryPayloadThresholdBytes: 64 * 1024,
    });
    await flushAsyncWork();

    const batch = await cursor.nextBatch(10_000);
    expect(batch).toHaveLength(1);
    const data = (batch[0].message as { data: Uint8Array }).data;
    expect(data).toBeInstanceOf(Uint8Array);
    expect(Array.from(data)).toEqual([10, 20, 30, 40]);
    expect(data.byteOffset).toBe(0);
    expect(data.buffer.byteLength).toBe(4);
    expect(data.buffer).not.toBe(sharedChunk.buffer);

    await cursor.end();
  });
});

describe('MessageCursor range scans', () => {
  function slowIterator(firstAfterMs: number, messages: MessageEvent[]): AsyncIterableIterator<MessageEvent> {
    let index = 0;
    return {
      async next() {
        if (index === 0) await new Promise((resolve) => setTimeout(resolve, firstAfterMs));
        const value = messages[index++];
        return value ? { done: false, value } : { done: true, value: undefined };
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
  }

  it('without waitForData an empty batch only means nothing was read yet', async () => {
    const cursor = new MessageCursor(slowIterator(200, [message(1)]), { mode: 'comlink', binaryPayloadThresholdBytes: 64 * 1024 });
    expect(await cursor.nextBatch(1000)).toEqual([]);
    await cursor.end();
  });

  it('with waitForData it waits for the first message of a slow (remote) read', async () => {
    const cursor = new MessageCursor(slowIterator(200, [message(1), message(2)]), {
      mode: 'comlink',
      binaryPayloadThresholdBytes: 64 * 1024,
    });
    const seen: number[] = [];
    for (;;) {
      const batch = await cursor.nextBatch(86_400_000, { waitForData: true });
      if (batch.length === 0) break; // exhausted, never "not read yet"
      seen.push(...batch.map((m) => m.receiveTime.sec));
    }
    expect(seen).toEqual([1, 2]);
    await cursor.end();
  });

  it('end() releases a batch waiting for data', async () => {
    const cursor = new MessageCursor(slowIterator(10_000, [message(1)]), {
      mode: 'comlink',
      binaryPayloadThresholdBytes: 64 * 1024,
    });
    const pending = cursor.nextBatch(86_400_000, { waitForData: true });
    void cursor.end();
    expect(await pending).toEqual([]);
  });
});

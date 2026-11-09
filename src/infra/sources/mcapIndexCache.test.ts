import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { createIndexedDbMcapIndexCache } from './mcapIndexCache';
import type { SerializedMcapIndex } from './McapUnindexedIterableSource';

function index(fingerprint: string): SerializedMcapIndex {
  return {
    version: 1,
    fingerprint,
    schemas: [{ id: 1, name: 's', encoding: 'jsonschema', data: new Uint8Array([1, 2]) }],
    channels: [{ id: 1, schemaId: 1, topic: '/a', messageEncoding: 'json', metadata: [['k', 'v']] }],
    chunks: [],
    problems: [],
    messages: {
      channelId: Uint16Array.of(1),
      logTime: BigUint64Array.of(5n),
      publishTime: BigUint64Array.of(5n),
      offset: Float64Array.of(100),
      length: Uint32Array.of(10),
      chunk: Int32Array.of(-1),
    },
  };
}

describe('createIndexedDbMcapIndexCache', () => {
  it('returns undefined without IndexedDB', () => {
    expect(createIndexedDbMcapIndexCache(undefined)).toBeUndefined();
  });

  it('round-trips an index including typed arrays', async () => {
    const cache = createIndexedDbMcapIndexCache(new IDBFactory())!;
    expect(await cache.get('missing')).toBeUndefined();
    await cache.set('a', index('fp-a'));
    const restored = await cache.get('a');
    expect(restored?.fingerprint).toBe('fp-a');
    expect(restored?.messages.logTime).toEqual(BigUint64Array.of(5n));
    expect(restored?.channels[0].metadata).toEqual([['k', 'v']]);
  });

  it('evicts the oldest entries beyond the cap', async () => {
    const cache = createIndexedDbMcapIndexCache(new IDBFactory())!;
    for (let i = 0; i < 20; i++) {
      await cache.set(`k${i}`, index(`fp${i}`));
      // Distinct `updatedAt` values keep eviction order deterministic.
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    expect(await cache.get('k0')).toBeUndefined();
    expect(await cache.get('k3')).toBeUndefined();
    expect((await cache.get('k4'))?.fingerprint).toBe('fp4');
    expect((await cache.get('k19'))?.fingerprint).toBe('fp19');
  });
});

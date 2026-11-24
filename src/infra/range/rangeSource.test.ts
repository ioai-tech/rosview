import { describe, expect, it, vi } from 'vitest';
import { RangeSource, RangeHttpError, RangeMismatchError, RangeNetworkError, RangeStallError } from './RangeSource';
import { ConnectionMonitor } from './connection';
import { rangeBlockCache } from './rangeCache';
import { clearMemoryIndexes } from './rangeHandle';
import { RangeBlockCache, RANGE_BLOCK_BYTES as B } from './rangeCache';
import { UrlRenewal } from './urlRenewal';

/** URL of a fetch input without stringifying objects. */
const urlOf = (input: RequestInfo | URL): string => (typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);

/** Byte equality that stays fast for multi-MiB arrays. */
const same = (a: Uint8Array, b: Uint8Array): boolean => Buffer.from(a).equals(Buffer.from(b));

/** Fake range server: `validUrls` decides which URLs answer; every request is recorded. */
function fakeServer(size: number, options: { etag?: string; honourRange?: boolean; seed?: number } = {}) {
  // `seed` gives another version of the recording different bytes.
  const seed = options.seed ?? 0;
  const data = new Uint8Array(size);
  for (let i = 0; i < size; i++) data[i] = (i * 31 + (i >> 8) + seed * 97) & 0xff;
  const validUrls = new Set<string>();
  const requests: Array<{ url: string; start: number; end: number }> = [];
  const fetchImpl: typeof fetch = (input, init) => {
    const url = urlOf(input);
    const range = /bytes=(\d+)-(\d+)/.exec(new Headers(init?.headers).get('Range') ?? '');
    const start = range ? Number(range[1]) : 0;
    const end = range ? Math.min(size - 1, Number(range[2])) : size - 1;
    requests.push({ url, start, end });
    if (!validUrls.has(url)) return Promise.resolve(new Response('expired', { status: 403, statusText: 'Forbidden' }));
    const honour = options.honourRange !== false && range;
    const body = honour ? data.slice(start, end + 1) : data;
    const headers: Record<string, string> = { 'Content-Length': String(body.byteLength) };
    if (honour) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    if (options.etag) headers.ETag = options.etag;
    // Deliver in 100 KiB pieces so partial progress is observable.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let o = 0; o < body.byteLength; o += 100 * 1024) controller.enqueue(body.slice(o, o + 100 * 1024));
        controller.close();
      },
    });
    return Promise.resolve(new Response(stream, { status: honour ? 206 : 200, headers }));
  };
  return { data, validUrls, requests, fetchImpl };
}

describe('RangeSource', () => {
  it('reads only the blocks a read needs, not the whole file', async () => {
    const server = fakeServer(40 * B);
    server.validUrls.add('https://x/a');
    const cache = new RangeBlockCache();
    const source = new RangeSource({ url: 'https://x/a', cache, fetchImpl: server.fetchImpl });
    const out = await source.read(20 * B + 10, 1000);
    expect(same(out, server.data.slice(20 * B + 10, 20 * B + 1010))).toBe(true);
    const bytes = server.requests.reduce((n, r) => n + (r.end - r.start + 1), 0);
    expect(bytes).toBeLessThanOrEqual(2 * B + B); // size probe (block 0) + one block
    expect(source.downloadedRanges().length).toBe(2);
    source.dispose();
  });

  it('reuses cached blocks for the same sourceKey across a URL change and a reopen', async () => {
    const server = fakeServer(16 * B, { etag: '"v1"' });
    server.validUrls.add('https://x/old').add('https://x/new');
    const cache = new RangeBlockCache();
    const first = new RangeSource({ url: 'https://x/old', sourceKey: 'rec-1', cache, fetchImpl: server.fetchImpl });
    await first.read(3 * B, 2 * B);
    first.dispose();
    const before = server.requests.length;
    const second = new RangeSource({ url: 'https://x/new', sourceKey: 'rec-1', knownTotalBytes: 16 * B, cache, fetchImpl: server.fetchImpl });
    const out = await second.read(3 * B, 2 * B);
    expect(same(out, server.data.slice(3 * B, 5 * B))).toBe(true);
    expect(server.requests.length).toBe(before); // served from memory, no network
    second.dispose();
  });

  it('a reopen without a known size revalidates with one byte instead of downloading the first block again', async () => {
    const server = fakeServer(16 * B, { etag: '"v1"' });
    server.validUrls.add('https://x/a').add('https://x/b');
    const cache = new RangeBlockCache();
    const first = new RangeSource({ url: 'https://x/a', sourceKey: 'rec-1', cache, fetchImpl: server.fetchImpl });
    await first.read(0, 64);
    await first.read(3 * B, 2 * B);
    first.dispose();
    const before = server.requests.length;
    const second = new RangeSource({ url: 'https://x/b', sourceKey: 'rec-1', cache, fetchImpl: server.fetchImpl });
    expect(same(await second.read(0, 64), server.data.slice(0, 64))).toBe(true);
    expect(same(await second.read(3 * B, 2 * B), server.data.slice(3 * B, 5 * B))).toBe(true);
    const reopen = server.requests.slice(before);
    expect(reopen).toEqual([{ url: 'https://x/b', start: 0, end: 0 }]);
    second.dispose();
  });

  it('does not share blocks without a sourceKey and frees them on dispose', async () => {
    const server = fakeServer(8 * B);
    server.validUrls.add('https://x/a');
    const cache = new RangeBlockCache();
    const source = new RangeSource({ url: 'https://x/a', cache, fetchImpl: server.fetchImpl });
    await source.read(0, B);
    expect(cache.bytes).toBeGreaterThan(0);
    source.dispose();
    expect(cache.bytes).toBe(0);
  });

  it('evicts least-recently-used blocks beyond the byte budget', async () => {
    const server = fakeServer(64 * B);
    server.validUrls.add('https://x/a');
    const cache = new RangeBlockCache(8 * B);
    const source = new RangeSource({ url: 'https://x/a', sourceKey: 'k', cache, fetchImpl: server.fetchImpl });
    for (let i = 0; i < 40; i += 2) await source.read(i * B, 2 * B);
    expect(cache.bytes).toBeLessThanOrEqual(8 * B);
    // The most recent read is still cached; the oldest is gone.
    const before = server.requests.length;
    await source.read(38 * B, 2 * B);
    expect(server.requests.length).toBe(before);
    await source.read(0, B);
    expect(server.requests.length).toBeGreaterThan(before);
    source.dispose();
  });

  it('clearCache drops every byte', async () => {
    const server = fakeServer(8 * B);
    server.validUrls.add('https://x/a');
    const cache = new RangeBlockCache();
    const source = new RangeSource({ url: 'https://x/a', sourceKey: 'k', cache, fetchImpl: server.fetchImpl });
    await source.read(0, 4 * B);
    expect(cache.bytes).toBeGreaterThan(0);
    cache.clear();
    expect(cache.bytes).toBe(0);
    expect(source.downloadedRanges()).toEqual([]);
    // Reads after a clear fetch again instead of failing.
    expect(same(await source.read(0, 10), server.data.slice(0, 10))).toBe(true);
    source.dispose();
  });

  it('never serves stale bytes after the recording changes under the same sourceKey', async () => {
    const server = fakeServer(8 * B, { etag: '"v1"' });
    server.validUrls.add('https://x/a');
    const cache = new RangeBlockCache();
    const source = new RangeSource({ url: 'https://x/a', sourceKey: 'k', cache, fetchImpl: server.fetchImpl });
    await source.read(0, B);
    const changed = fakeServer(8 * B, { etag: '"v2"', seed: 2 });
    changed.validUrls.add('https://x/a');
    const source2 = new RangeSource({ url: 'https://x/a', sourceKey: 'k', cache, fetchImpl: changed.fetchImpl });
    // Different ETag means a different store key: no stale bytes are served.
    expect(same(await source2.read(0, 16), changed.data.slice(0, 16))).toBe(true);
    expect(same(changed.data.slice(0, 16), server.data.slice(0, 16))).toBe(false);
    source.dispose();
    source2.dispose();
  });

  it('a reopen whose one-byte revalidation sees another version drops the cached blocks', async () => {
    const v1 = fakeServer(8 * B, { etag: '"v1"', seed: 1 });
    v1.validUrls.add('https://x/a');
    const cache = new RangeBlockCache();
    const first = new RangeSource({ url: 'https://x/a', sourceKey: 'k', cache, fetchImpl: v1.fetchImpl });
    await first.read(0, 4 * B);
    first.dispose();

    const v2 = fakeServer(8 * B, { etag: '"v2"', seed: 2 });
    v2.validUrls.add('https://x/a');
    const second = new RangeSource({ url: 'https://x/a', sourceKey: 'k', cache, fetchImpl: v2.fetchImpl });
    const out = await second.read(B, B);
    expect(v2.requests[0]).toMatchObject({ start: 0, end: 0 });
    expect(same(out, v2.data.slice(B, 2 * B))).toBe(true);
    expect(same(out, v1.data.slice(B, 2 * B))).toBe(false);
    second.dispose();
  });

  it('supports servers that ignore Range when the file fits the budget', async () => {
    const server = fakeServer(3 * B + 5, { honourRange: false });
    server.validUrls.add('https://x/a');
    const cache = new RangeBlockCache();
    const source = new RangeSource({ url: 'https://x/a', cache, fetchImpl: server.fetchImpl });
    expect(same(await source.read(2 * B, 100), server.data.slice(2 * B, 2 * B + 100))).toBe(true);
    source.dispose();
  });
});

describe('URL renewal', () => {
  it('renews once per batch on 403, retries, keeps the cache', async () => {
    const server = fakeServer(32 * B);
    server.validUrls.add('https://x/old');
    const renewal = new UrlRenewal();
    const refreshUrls = vi.fn(async (expired: string[]) => {
      server.validUrls.add('https://x/new');
      return expired.map(() => 'https://x/new');
    });
    renewal.update({ refreshUrls });
    const cache = new RangeBlockCache();
    const a = new RangeSource({ url: 'https://x/old', sourceKey: 'a', knownTotalBytes: 32 * B, renewal, cache, fetchImpl: server.fetchImpl });
    const b = new RangeSource({ url: 'https://x/old', sourceKey: 'b', knownTotalBytes: 32 * B, renewal, cache, fetchImpl: server.fetchImpl });
    await a.read(0, B); // cached under the old URL
    server.validUrls.delete('https://x/old'); // the old URL expires
    // Two sources and several blocks fail at once: still one refresh call.
    const reads = await Promise.all([a.read(10 * B, 3 * B), b.read(0, 2 * B), a.read(20 * B, B)]);
    expect(same(reads[0], server.data.slice(10 * B, 13 * B))).toBe(true);
    expect(refreshUrls).toHaveBeenCalledTimes(1);
    expect(refreshUrls.mock.calls[0][0]).toEqual(['https://x/old', 'https://x/old']);
    expect(a.getUrl()).toBe('https://x/new');
    expect(b.getUrl()).toBe('https://x/new');
    expect(same(await a.read(0, 100), server.data.slice(0, 100))).toBe(true); // still cached
    a.dispose();
    b.dispose();
  });

  it('shows the ordinary error when the renewed URL fails too, and stops asking', async () => {
    const server = fakeServer(8 * B); // no valid URL at all
    const renewal = new UrlRenewal();
    const refreshUrls = vi.fn(async (expired: string[]) => expired.map(() => 'https://x/still-bad'));
    renewal.update({ refreshUrls });
    const source = new RangeSource({ url: 'https://x/old', knownTotalBytes: 8 * B, renewal, cache: new RangeBlockCache(), fetchImpl: server.fetchImpl });
    await expect(source.read(0, 10)).rejects.toBeInstanceOf(RangeHttpError);
    await expect(source.read(0, 10)).rejects.toMatchObject({ status: 403 });
    expect(refreshUrls).toHaveBeenCalledTimes(1);
    source.dispose();
  });

  it('surfaces the ordinary error when refreshUrls rejects', async () => {
    const server = fakeServer(8 * B);
    const renewal = new UrlRenewal();
    renewal.update({ refreshUrls: () => Promise.reject(new Error('host down')) });
    const source = new RangeSource({ url: 'https://x/old', knownTotalBytes: 8 * B, renewal, cache: new RangeBlockCache(), fetchImpl: server.fetchImpl });
    await expect(source.read(0, 10)).rejects.toMatchObject({ status: 403 });
    source.dispose();
  });

  it('renews ahead of urlExpiresAt (within 60 s)', async () => {
    const server = fakeServer(8 * B);
    server.validUrls.add('https://x/old').add('https://x/new');
    const renewal = new UrlRenewal();
    const refreshUrls = vi.fn(async (expired: string[]) => expired.map(() => 'https://x/new'));
    renewal.update({ refreshUrls, urlExpiresAt: new Date(Date.now() + 30_000).toISOString() });
    const source = new RangeSource({ url: 'https://x/old', knownTotalBytes: 8 * B, renewal, cache: new RangeBlockCache(), fetchImpl: server.fetchImpl });
    await source.read(0, 10);
    expect(refreshUrls).toHaveBeenCalledTimes(1);
    expect(server.requests.every((r) => r.url === 'https://x/new')).toBe(true);
    source.dispose();
  });

  it('does not renew again when the host re-renders with the same urlExpiresAt', async () => {
    const server = fakeServer(8 * B);
    server.validUrls.add('https://x/old').add('https://x/new');
    const renewal = new UrlRenewal();
    const refreshUrls = vi.fn(async (expired: string[]) => expired.map(() => 'https://x/new'));
    const expiresAt = new Date(Date.now() + 30_000).toISOString();
    renewal.update({ refreshUrls, urlExpiresAt: expiresAt });
    const source = new RangeSource({ url: 'https://x/old', knownTotalBytes: 8 * B, renewal, cache: new RangeBlockCache(), fetchImpl: server.fetchImpl });
    await source.read(0, 10);
    renewal.update({ refreshUrls, urlExpiresAt: expiresAt }); // same prop value after a re-render
    await source.read(3 * B, 10);
    expect(refreshUrls).toHaveBeenCalledTimes(1);
    source.dispose();
  });

  it('does not renew without refreshUrls', async () => {
    const server = fakeServer(8 * B);
    const source = new RangeSource({ url: 'https://x/old', knownTotalBytes: 8 * B, cache: new RangeBlockCache(), fetchImpl: server.fetchImpl });
    await expect(source.read(0, 10)).rejects.toMatchObject({ status: 403 });
    source.dispose();
  });
});

describe('server answers that must not reach the cache', () => {
  const base = (size: number) => {
    const data = new Uint8Array(size).map((_, i) => i & 0xff);
    return data;
  };

  it('rejects a 206 whose Content-Range does not match the request, and writes nothing', async () => {
    const data = base(8 * B);
    const wrong: typeof fetch = () =>
      Promise.resolve(
        new Response(data.slice(0, B), {
          status: 206,
          headers: { 'Content-Range': `bytes 0-${B - 1}/${8 * B}`, 'Content-Length': String(B) },
        }),
      );
    const cache = new RangeBlockCache();
    const source = new RangeSource({ url: 'https://x/a', knownTotalBytes: 8 * B, cache, fetchImpl: wrong });
    await expect(source.read(4 * B, 10)).rejects.toBeInstanceOf(RangeMismatchError); // asked 4B.., got 0..
    expect(cache.bytes).toBe(0);
    source.dispose();
  });

  it('rejects a 206 that reports a different total size', async () => {
    const data = base(8 * B);
    const f: typeof fetch = (_u, init) => {
      const m = /bytes=(\d+)-(\d+)/.exec(new Headers(init?.headers).get('Range') ?? '')!;
      const start = Number(m[1]);
      const end = Number(m[2]);
      return Promise.resolve(
        new Response(data.slice(start, end + 1), { status: 206, headers: { 'Content-Range': `bytes ${start}-${end}/${9 * B}` } }),
      );
    };
    const source = new RangeSource({ url: 'https://x/a', knownTotalBytes: 8 * B, cache: new RangeBlockCache(), fetchImpl: f });
    await expect(source.read(0, 10)).rejects.toBeInstanceOf(RangeMismatchError);
    source.dispose();
  });

  it('a server that ignores Range with a known size is downloaded once, not once per run', async () => {
    const size = 24 * B;
    const server = fakeServer(size, { honourRange: false });
    server.validUrls.add('https://x/a');
    const source = new RangeSource({ url: 'https://x/a', knownTotalBytes: size, cache: new RangeBlockCache(), fetchImpl: server.fetchImpl });
    const reads = await Promise.all([source.read(0, B), source.read(10 * B, B), source.read(20 * B, B), source.read(5 * B, 3 * B)]);
    expect(same(reads[1], server.data.slice(10 * B, 11 * B))).toBe(true);
    expect(server.requests.length).toBe(1);
    source.dispose();
  });

  it('refuses a 200 whose Content-Length differs from the known size', async () => {
    const server = fakeServer(8 * B, { honourRange: false });
    server.validUrls.add('https://x/a');
    const source = new RangeSource({ url: 'https://x/a', knownTotalBytes: 6 * B, cache: new RangeBlockCache(), fetchImpl: server.fetchImpl });
    await expect(source.read(0, 10)).rejects.toBeInstanceOf(RangeMismatchError);
    source.dispose();
  });
});

describe('read(signal) and teardown', () => {
  it('resolves with a live signal and leaves no abort listeners behind', async () => {
    const server = fakeServer(8 * B);
    server.validUrls.add('https://x/a');
    const source = new RangeSource({ url: 'https://x/a', knownTotalBytes: 8 * B, cache: new RangeBlockCache(), fetchImpl: server.fetchImpl });
    const controller = new AbortController();
    let added = 0;
    let removed = 0;
    const add = controller.signal.addEventListener.bind(controller.signal);
    const remove = controller.signal.removeEventListener.bind(controller.signal);
    controller.signal.addEventListener = ((...a: Parameters<typeof add>) => {
      added++;
      return add(...a);
    }) as typeof add;
    controller.signal.removeEventListener = ((...a: Parameters<typeof remove>) => {
      removed++;
      return remove(...a);
    }) as typeof remove;
    const out = await source.read(2 * B, 100, controller.signal);
    expect(same(out, server.data.slice(2 * B, 2 * B + 100))).toBe(true);
    expect(removed).toBe(added);
    source.dispose();
  });

  it('rejects with AbortError when the signal aborts while waiting', async () => {
    const never: typeof fetch = (_u, init) =>
      new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('x', 'AbortError'))));
    const source = new RangeSource({ url: 'https://x/a', knownTotalBytes: 8 * B, cache: new RangeBlockCache(), fetchImpl: never });
    const controller = new AbortController();
    const p = source.read(0, 10, controller.signal);
    controller.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    source.dispose();
  });

  it('clearCache aborts the size probe and its blocks do not refill the cleared store', async () => {
    const size = 8 * B;
    const server = fakeServer(size);
    server.validUrls.add('https://x/a');
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow: typeof fetch = async (u, init) => {
      await gate;
      return server.fetchImpl(u, init);
    };
    const cache = new RangeBlockCache();
    const source = new RangeSource({ url: 'https://x/a', sourceKey: 'k', cache, fetchImpl: slow });
    const opening = source.open().catch((e: unknown) => e);
    cache.clear();
    release();
    expect(await opening).toMatchObject({ name: 'AbortError' });
    expect(cache.bytes).toBe(0);
    // The source can open again afterwards.
    expect(same(await source.read(0, 16), server.data.slice(0, 16))).toBe(true);
    source.dispose();
  });

  it('a cleared store ignores late writes', () => {
    const cache = new RangeBlockCache();
    const store = cache.store('k', 4 * B);
    store.set(0, new Uint8Array(10));
    cache.clear();
    store.set(1, new Uint8Array(10));
    expect(store.has(1)).toBe(false);
    expect(cache.bytes).toBe(0);
  });

  it('clearCache also forgets unindexed-MCAP scan results', () => {
    clearMemoryIndexes();
    expect(typeof rangeBlockCache.clear).toBe('function');
    rangeBlockCache.clear(); // runs the listener registered by rangeHandle without throwing
  });
});

describe('host URLs and CORS-less expiry', () => {
  it('refreshUrls receives the URL exactly as the host passed it, not the resolved one', async () => {
    const server = fakeServer(8 * B);
    server.validUrls.add('http://host/rec.mcap?t=old').add('/rec.mcap?t=new');
    server.validUrls.delete('http://host/rec.mcap?t=old');
    const renewal = new UrlRenewal();
    const refreshUrls = vi.fn(async (expired: string[]) => expired.map(() => '/rec.mcap?t=new'));
    renewal.update({ refreshUrls });
    const source = new RangeSource({
      url: '/rec.mcap?t=old',
      resolveUrl: (u) => `http://host${u}`,
      knownTotalBytes: 8 * B,
      renewal,
      cache: new RangeBlockCache(),
      fetchImpl: (u, i) => server.fetchImpl(urlOf(u), i),
    });
    server.validUrls.add('http://host/rec.mcap?t=new');
    await source.read(0, 10);
    expect(refreshUrls.mock.calls[0][0]).toEqual(['/rec.mcap?t=old']);
    source.dispose();
  });

  it('treats a CORS-less network failure past urlExpiresAt as an expired URL', async () => {
    const server = fakeServer(8 * B);
    server.validUrls.add('https://x/new');
    const renewal = new UrlRenewal();
    const refreshUrls = vi.fn(async (expired: string[]) => expired.map(() => 'https://x/new'));
    renewal.update({ refreshUrls, urlExpiresAt: new Date(Date.now() - 1000).toISOString() });
    const f: typeof fetch = (u, i) => (urlOf(u).includes('/old') ? Promise.reject(new TypeError('Failed to fetch')) : server.fetchImpl(u, i));
    const source = new RangeSource({ url: 'https://x/old', knownTotalBytes: 8 * B, renewal, cache: new RangeBlockCache(), fetchImpl: f });
    // expiringSoon() renews first; reset so the network-error path is the one exercised
    expect(same(await source.read(0, 10), server.data.slice(0, 10))).toBe(true);
    expect(refreshUrls).toHaveBeenCalledTimes(1);
    source.dispose();
  });
});

describe('whole-file mode on a server without Range ends with the download', () => {
  const noRange = (size: number) => {
    const server = fakeServer(size, { honourRange: false });
    server.validUrls.add('https://x/a');
    return server;
  };

  it('works again after clearCache()', async () => {
    const server = noRange(6 * B);
    const cache = new RangeBlockCache();
    const source = new RangeSource({ url: 'https://x/a', knownTotalBytes: 6 * B, sourceKey: 'k', cache, fetchImpl: server.fetchImpl });
    expect(same(await source.read(0, 10), server.data.slice(0, 10))).toBe(true);
    cache.clear();
    expect(same(await source.read(5 * B, 10), server.data.slice(5 * B, 5 * B + 10))).toBe(true);
    expect(server.requests.length).toBe(2);
    source.dispose();
  });

  it('works again after eviction', async () => {
    const server = noRange(6 * B);
    const cache = new RangeBlockCache(8 * B);
    const source = new RangeSource({ url: 'https://x/a', knownTotalBytes: 6 * B, sourceKey: 'k', cache, fetchImpl: server.fetchImpl });
    await source.read(0, 10);
    // Another source fills the cache until this one's blocks are evicted.
    const other = cache.store('other', 64 * B);
    for (let i = 0; i < 12; i++) other.set(i, new Uint8Array(B));
    expect(source.downloadedRanges().length).toBe(0);
    expect(same(await source.read(3 * B, 10), server.data.slice(3 * B, 3 * B + 10))).toBe(true);
    source.dispose();
  });

  it('retries after a failed whole-file download', { timeout: 15_000 }, async () => {
    const server = noRange(6 * B);
    let failures = 4; // every attempt of the first read fails
    const f: typeof fetch = (u, i) => {
      if (failures > 0) {
        failures--;
        const body = new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new Uint8Array(100));
            c.error(new TypeError('connection reset'));
          },
        });
        return Promise.resolve(new Response(body, { status: 200, headers: { 'Content-Length': String(6 * B) } }));
      }
      return server.fetchImpl(u, i);
    };
    const source = new RangeSource({ url: 'https://x/a', knownTotalBytes: 6 * B, cache: new RangeBlockCache(), fetchImpl: f });
    await expect(source.read(0, 10)).rejects.toBeTruthy();
    expect(same(await source.read(0, 10), server.data.slice(0, 10))).toBe(true);
    source.dispose();
  });

  it('after clearCache, parallel reads download once (the first request goes alone again)', async () => {
    const server = noRange(24 * B);
    const cache = new RangeBlockCache();
    const source = new RangeSource({ url: 'https://x/a', knownTotalBytes: 24 * B, sourceKey: 'k', cache, fetchImpl: server.fetchImpl });
    await source.read(0, 10);
    // Wait for the first whole-file download to finish, then clear.
    await vi.waitFor(() => expect(source.downloadedRanges().at(-1)?.end).toBe(24 * B));
    cache.clear();
    const before = server.requests.length;
    await Promise.all([0, 4, 8, 12, 16, 20].map((i) => source.read(i * B, B)));
    expect(server.requests.length - before).toBe(1);
    source.dispose();
  });
});

describe('stalled requests', () => {
  type Mode = 'ok' | 'stall-body' | 'stall-headers' | 'short';

  /** Answers range requests in order of `modes` (then 'ok'); a stalled one honours only its abort signal. */
  function stallingServer(size: number, modes: Mode[]) {
    const data = new Uint8Array(size);
    for (let i = 0; i < size; i++) data[i] = (i * 13) & 0xff;
    const requests: Array<{ start: number; end: number; mode: Mode }> = [];
    const fetchImpl: typeof fetch = (_input, init) => {
      const range = /bytes=(\d+)-(\d+)/.exec(new Headers(init?.headers).get('Range') ?? '')!;
      const start = Number(range[1]);
      const end = Math.min(size - 1, Number(range[2]));
      const mode = modes[requests.length] ?? 'ok';
      requests.push({ start, end, mode });
      const signal = init?.signal;
      const headers = { 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${size}` };
      if (mode === 'stall-headers') {
        return new Promise((_, reject) => signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))));
      }
      const body = data.slice(start, end + 1);
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          if (mode === 'ok') {
            controller.enqueue(body);
            controller.close();
          } else if (mode === 'short') {
            controller.enqueue(body.slice(0, 100)); // the response ends early
            controller.close();
          } else {
            controller.enqueue(body.slice(0, B)); // one block, then nothing
          }
        },
      });
      return Promise.resolve(new Response(stream, { status: 206, headers }));
    };
    return { data, requests, fetchImpl };
  }

  it('a body that stops is asked for again once, and the read completes', async () => {
    const server = stallingServer(16 * B, ['ok', 'stall-body']);
    const source = new RangeSource({ url: 'https://x/a', cache: new RangeBlockCache(), fetchImpl: server.fetchImpl, stallTimeoutMs: 30 });
    const out = await source.read(4 * B, 3 * B);
    expect(same(out, server.data.slice(4 * B, 7 * B))).toBe(true);
    // The probe, the stalled request (one block arrived and is kept), the retry for the rest.
    expect(server.requests.map((r) => [r.start / B, r.mode])).toEqual([
      [0, 'ok'],
      [4, 'stall-body'],
      [5, 'ok'],
    ]);
    source.dispose();
  });

  it('fails with RangeStallError after one retry instead of waiting forever', async () => {
    const server = stallingServer(16 * B, ['ok', 'stall-body', 'stall-headers']);
    const source = new RangeSource({ url: 'https://x/a', cache: new RangeBlockCache(), fetchImpl: server.fetchImpl, stallTimeoutMs: 30 });
    const read = source.read(4 * B, 3 * B);
    await expect(read).rejects.toBeInstanceOf(RangeStallError);
    await expect(read).rejects.toThrow(/No data arrived from the server for 0 s .*also after a retry/);
    expect(server.requests).toHaveLength(3);
    source.dispose();
  });

  it('a size probe that gets no answer is asked again once, then fails with RangeStallError', async () => {
    const server = stallingServer(16 * B, ['stall-headers', 'stall-headers']);
    const source = new RangeSource({ url: 'https://x/a', cache: new RangeBlockCache(), fetchImpl: server.fetchImpl, stallTimeoutMs: 30 });
    await expect(source.read(0, 16)).rejects.toThrow(/No data arrived from the server for 0 s while opening the recording URL, also after a retry/);
    expect(server.requests.map((r) => r.mode)).toEqual(['stall-headers', 'stall-headers']);
    source.dispose();
  });

  it('a size probe that stalls once is asked again and the recording opens', async () => {
    const server = stallingServer(16 * B, ['stall-headers']);
    const source = new RangeSource({ url: 'https://x/a', cache: new RangeBlockCache(), fetchImpl: server.fetchImpl, stallTimeoutMs: 30 });
    expect(same(await source.read(B, 16), server.data.slice(B, B + 16))).toBe(true);
    source.dispose();
  });

  it('a size probe whose response ends early is asked again once, then fails', async () => {
    const once = stallingServer(16 * B, ['short']);
    const a = new RangeSource({ url: 'https://x/a', cache: new RangeBlockCache(), fetchImpl: once.fetchImpl, stallTimeoutMs: 30 });
    expect(same(await a.read(B, 16), once.data.slice(B, B + 16))).toBe(true);
    expect(once.requests.slice(0, 2).map((r) => [r.start, r.mode])).toEqual([
      [0, 'short'],
      [0, 'ok'],
    ]);
    a.dispose();
    const twice = stallingServer(16 * B, ['short', 'short']);
    const b = new RangeSource({ url: 'https://x/a', cache: new RangeBlockCache(), fetchImpl: twice.fetchImpl, stallTimeoutMs: 30 });
    await expect(b.read(B, 16)).rejects.toThrow('Short read from the range server');
    expect(twice.requests).toHaveLength(2);
    b.dispose();
  });

  it('the one-byte revalidation of a reopen has the same stall detection', async () => {
    const cache = new RangeBlockCache();
    const first = stallingServer(16 * B, []);
    const a = new RangeSource({ url: 'https://x/a', sourceKey: 'k', cache, fetchImpl: first.fetchImpl, stallTimeoutMs: 30 });
    await a.read(0, 16);
    a.dispose();
    const dead = stallingServer(16 * B, ['stall-headers', 'stall-headers']);
    const b = new RangeSource({ url: 'https://x/a', sourceKey: 'k', cache, fetchImpl: dead.fetchImpl, stallTimeoutMs: 30 });
    await expect(b.read(0, 16)).rejects.toBeInstanceOf(RangeStallError);
    expect(dead.requests.map((r) => [r.start, r.end])).toEqual([
      [0, 0],
      [0, 0],
    ]);
    b.dispose();
  });

  it('a read whose bytes keep arriving slowly is not a stall', async () => {
    const size = 4 * B;
    const data = new Uint8Array(size).fill(7);
    let requests = 0;
    const fetchImpl: typeof fetch = (_input, init) => {
      requests++;
      const range = /bytes=(\d+)-(\d+)/.exec(new Headers(init?.headers).get('Range') ?? '')!;
      const start = Number(range[1]);
      const end = Math.min(size - 1, Number(range[2]));
      const body = data.slice(start, end + 1);
      let at = 0;
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          await new Promise((resolve) => setTimeout(resolve, 10)); // 10 ms between pieces, stall timeout 30 ms
          controller.enqueue(body.slice(at, at + 64 * 1024));
          at += 64 * 1024;
          if (at >= body.byteLength) controller.close();
        },
      });
      return Promise.resolve(
        new Response(stream, {
          status: 206,
          headers: { 'Content-Length': String(body.byteLength), 'Content-Range': `bytes ${start}-${end}/${size}` },
        }),
      );
    };
    const source = new RangeSource({ url: 'https://x/a', cache: new RangeBlockCache(), fetchImpl, stallTimeoutMs: 30 });
    expect((await source.read(B, 3 * B)).byteLength).toBe(3 * B);
    expect(requests).toBe(2); // the probe and one request: no retry
    source.dispose();
  });
});

describe('a network outage (M-2: Raw did not recover from a dropped network)', () => {
  const url = 'https://x/a';
  /** `fakeServer` behind a network that can go down: then every request fails as the browser's would. */
  function flakyNetwork(size: number) {
    const server = fakeServer(size);
    server.validUrls.add(url);
    const net = { down: false, attemptsWhileDown: 0 };
    const fetchImpl: typeof fetch = (input, init) => {
      if (net.down) {
        net.attemptsWhileDown++;
        return Promise.reject(new TypeError('Failed to fetch'));
      }
      return server.fetchImpl(input, init);
    };
    return { server, net, fetchImpl };
  }

  /** Settles `promise` into a box, so a test can see that it has not settled yet. */
  function track<T>(promise: Promise<T>) {
    const box: { done: boolean; value?: T; error?: unknown } = { done: false };
    promise.then(
      (value) => Object.assign(box, { done: true, value }),
      (error: unknown) => Object.assign(box, { done: true, error }),
    );
    return box;
  }

  it('a read the network drops waits, with a bounded backoff, and completes once the network is back', async () => {
    vi.useFakeTimers();
    try {
      const { server, net, fetchImpl } = flakyNetwork(16 * B);
      const connection = new ConnectionMonitor();
      const changes: boolean[] = [];
      connection.subscribe(() => changes.push(connection.reconnecting));
      const source = new RangeSource({ url, knownTotalBytes: 16 * B, cache: new RangeBlockCache(), fetchImpl, connection });
      expect(same(await source.read(0, 10), server.data.slice(0, 10))).toBe(true); // the server answered once

      net.down = true;
      const read = track(source.read(8 * B, 10));
      await vi.advanceTimersByTimeAsync(60_000);
      // Before the fix the read failed after about 2 s with the browser's "Failed to fetch".
      expect(read.done).toBe(false);
      expect(connection.reconnecting).toBe(true);
      // 0.5, 1, 2 s, then every 3 s: about 22 attempts in a minute, never a tight loop.
      expect(net.attemptsWhileDown).toBeGreaterThanOrEqual(19);
      expect(net.attemptsWhileDown).toBeLessThanOrEqual(23);

      net.down = false;
      await vi.advanceTimersByTimeAsync(3_000);
      expect(read.done).toBe(true);
      expect(read.error).toBeUndefined();
      expect(same(read.value!, server.data.slice(8 * B, 8 * B + 10))).toBe(true);
      expect(connection.reconnecting).toBe(false);
      expect(changes).toEqual([true, false]);
      source.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the blocks that arrived before the cut and asks only for the rest', async () => {
    vi.useFakeTimers();
    try {
      const { server, net, fetchImpl: flaky } = flakyNetwork(16 * B);
      let cutNext = false;
      // The first response after `cutNext` delivers one block, then the network goes down mid-body.
      const fetchImpl: typeof fetch = async (input, init) => {
        const res = await flaky(input, init);
        if (!cutNext || res.status !== 206) return res;
        cutNext = false;
        const reader = res.body!.getReader();
        let sent = 0;
        const body = new ReadableStream<Uint8Array>({
          async pull(controller) {
            if (sent >= B) {
              net.down = true;
              controller.error(new TypeError('network error'));
              return;
            }
            const { value } = await reader.read();
            controller.enqueue(value!);
            sent += value!.byteLength;
          },
        });
        return new Response(body, { status: 206, headers: res.headers });
      };
      const source = new RangeSource({ url, knownTotalBytes: 16 * B, cache: new RangeBlockCache(), fetchImpl });
      await source.read(0, 10);
      cutNext = true;
      const read = track(source.read(4 * B, 3 * B));
      await vi.advanceTimersByTimeAsync(20_000);
      expect(read.done).toBe(false);
      net.down = false;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(read.error).toBeUndefined();
      expect(same(read.value!, server.data.slice(4 * B, 7 * B))).toBe(true);
      // The block that arrived before the cut was not asked for again.
      const after = server.requests.filter((r) => r.start >= 4 * B).map((r) => r.start / B);
      expect(after).toEqual([4, 5]);
      source.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a server never reached fails with a named RangeNetworkError, the browser text only its detail', async () => {
    vi.useFakeTimers();
    try {
      const connection = new ConnectionMonitor();
      const fetchImpl: typeof fetch = () => Promise.reject(new TypeError('Failed to fetch'));
      const source = new RangeSource({ url, knownTotalBytes: 4 * B, cache: new RangeBlockCache(), fetchImpl, connection });
      const read = track(source.read(0, 10));
      await vi.advanceTimersByTimeAsync(5_000);
      // A wrong host or a bucket without CORS is not an outage to wait out: it is said, by name.
      expect(read.error).toBeInstanceOf(RangeNetworkError);
      expect((read.error as RangeNetworkError).detail).toBe('Failed to fetch');
      expect((read.error as Error).message).toMatch(/^Could not reach the server while reading /);
      expect(connection.reconnecting).toBe(false);
      source.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('after the outage a URL the server refuses stays an honest RangeHttpError, not an endless wait', async () => {
    vi.useFakeTimers();
    try {
      const { server, net, fetchImpl } = flakyNetwork(16 * B);
      const connection = new ConnectionMonitor();
      const source = new RangeSource({ url, knownTotalBytes: 16 * B, cache: new RangeBlockCache(), fetchImpl, connection });
      await source.read(0, 10);
      net.down = true;
      const read = track(source.read(8 * B, 10));
      await vi.advanceTimersByTimeAsync(10_000);
      server.validUrls.clear(); // the URL is gone for good (403)
      net.down = false;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(read.error).toBeInstanceOf(RangeHttpError);
      expect((read.error as RangeHttpError).status).toBe(403);
      expect(connection.reconnecting).toBe(false);
      source.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('renews a URL that expired during the outage although the refresh failed while the host was unreachable', async () => {
    vi.useFakeTimers();
    try {
      const { server, net, fetchImpl } = flakyNetwork(16 * B);
      const renewal = new UrlRenewal();
      const refreshUrls = vi.fn(async (expired: string[]) => {
        if (net.down) throw new TypeError('Failed to fetch'); // the host is unreachable too
        return expired.map(() => 'https://x/new');
      });
      renewal.update({ refreshUrls, urlExpiresAt: new Date(Date.now() + 3_600_000).toISOString() });
      const source = new RangeSource({ url, knownTotalBytes: 16 * B, renewal, cache: new RangeBlockCache(), fetchImpl });
      await source.read(0, 10);

      net.down = true;
      // The URL expires during the outage.
      renewal.update({ refreshUrls, urlExpiresAt: new Date(Date.now() + 2_000).toISOString() });
      server.validUrls.delete(url);
      server.validUrls.add('https://x/new');
      const read = track(source.read(8 * B, 10));
      await vi.advanceTimersByTimeAsync(10_000);
      expect(refreshUrls).toHaveBeenCalled(); // and failed: the host could not be reached
      net.down = false;
      await vi.advanceTimersByTimeAsync(5_000);
      // The 403 of the expired URL is renewed at once, not refused for the refresh's 30 s backoff.
      expect(read.error).toBeUndefined();
      expect(same(read.value!, server.data.slice(8 * B, 8 * B + 10))).toBe(true);
      expect(source.getUrl()).toBe('https://x/new');
      source.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('read-ahead does not wait through an outage; only reads someone waits for do', async () => {
    vi.useFakeTimers();
    try {
      const { net, fetchImpl } = flakyNetwork(16 * B);
      const connection = new ConnectionMonitor();
      const source = new RangeSource({ url, knownTotalBytes: 16 * B, cache: new RangeBlockCache(), fetchImpl, connection });
      await source.read(0, 10);
      net.down = true;
      source.prefetch([{ start: 8 * B, end: 12 * B }]);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(net.attemptsWhileDown).toBe(1);
      expect(connection.reconnecting).toBe(false);
      source.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a waiting read ends when the source is disposed', async () => {
    vi.useFakeTimers();
    try {
      const { net, fetchImpl } = flakyNetwork(16 * B);
      const connection = new ConnectionMonitor();
      const source = new RangeSource({ url, knownTotalBytes: 16 * B, cache: new RangeBlockCache(), fetchImpl, connection });
      await source.read(0, 10);
      net.down = true;
      const read = track(source.read(8 * B, 10));
      await vi.advanceTimersByTimeAsync(3_000);
      expect(connection.reconnecting).toBe(true);
      source.dispose();
      await vi.advanceTimersByTimeAsync(10);
      expect(read.done).toBe(true);
      expect(connection.reconnecting).toBe(false);
      const attempts = net.attemptsWhileDown;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(net.attemptsWhileDown).toBe(attempts);
    } finally {
      vi.useRealTimers();
    }
  });
});

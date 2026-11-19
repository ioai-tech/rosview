/**
 * In-memory, page-lifetime-only block cache for remote recordings.
 *
 * Recording bytes never leave this module's memory: there is deliberately no
 * IndexedDB / Cache Storage / OPFS persistence, so cached bytes cannot outlive the page, a
 * logout, a membership removal or an erasure. A host drops them early with `clearCache()`.
 *
 * Blocks are keyed by `<sourceKey>|<size>|<etag>` (never by a signed URL, so a URL refresh keeps
 * the cache) and evicted in least-recently-used order across all sources once the byte budget is
 * exceeded.
 */
import type { Range } from '@/shared/utils/ranges';

export const RANGE_BLOCK_BYTES = 512 * 1024;
export const DEFAULT_RANGE_CACHE_BYTES = 512 * 1024 * 1024;

export class RangeStore {
  readonly key: string;
  readonly size: number;
  /** Server version seen when these blocks were fetched; a different one purges the store. */
  etag?: string;
  #blocks = new Map<number, Uint8Array>();
  #cleared = false;
  #cache: RangeBlockCache;

  constructor(cache: RangeBlockCache, key: string, size: number) {
    this.#cache = cache;
    this.key = key;
    this.size = size;
  }

  get blockCount(): number {
    return Math.ceil(this.size / RANGE_BLOCK_BYTES);
  }

  has(index: number): boolean {
    return this.#blocks.has(index);
  }

  get(index: number): Uint8Array | undefined {
    const block = this.#blocks.get(index);
    if (block) this.#cache._touch(this, index);
    return block;
  }

  set(index: number, data: Uint8Array): void {
    // A store that was cleared or dropped must not be refilled by requests that were in flight.
    if (this.#cleared) return;
    this.#blocks.set(index, data);
    this.#cache._added(this, index, data.byteLength);
  }

  /** @internal */
  _evict(index: number): void {
    this.#blocks.delete(index);
  }

  /** @internal */
  _clear(): void {
    this.#cleared = true;
    this.#blocks.clear();
  }

  /** Cached byte ranges, merged, clamped to the file size. */
  ranges(): Range[] {
    const indices = [...this.#blocks.keys()].sort((a, b) => a - b);
    const out: Range[] = [];
    for (const i of indices) {
      const start = i * RANGE_BLOCK_BYTES;
      const end = Math.min(this.size, start + RANGE_BLOCK_BYTES);
      const last = out[out.length - 1];
      if (last && last.end === start) last.end = end;
      else out.push({ start, end });
    }
    return out;
  }

  cachedBytes(): number {
    let n = 0;
    for (const b of this.#blocks.values()) n += b.byteLength;
    return n;
  }
}

export class RangeBlockCache {
  #maxBytes: number;
  #bytes = 0;
  #stores = new Map<string, RangeStore>();
  /** Recency order: first entry is least recently used. Key: `${storeKey}#${index}`. */
  #lru = new Map<string, { store: RangeStore; index: number; bytes: number }>();
  #clearListeners = new Set<() => void>();

  constructor(maxBytes = DEFAULT_RANGE_CACHE_BYTES) {
    this.#maxBytes = maxBytes;
  }

  setMaxBytes(maxBytes: number): void {
    this.#maxBytes = Math.max(RANGE_BLOCK_BYTES * 4, maxBytes);
    this.#evictOverBudget();
  }

  get maxBytes(): number {
    return this.#maxBytes;
  }

  get bytes(): number {
    return this.#bytes;
  }

  /** The store for a source identity; created empty on first use. */
  store(key: string, size: number): RangeStore {
    let store = this.#stores.get(key);
    if (!store) {
      store = new RangeStore(this, key, size);
      this.#stores.set(key, store);
    }
    return store;
  }

  /**
   * Size of a recording this page already holds the first block of, by its source key (store keys
   * are `<sourceKey>|<size>`); undefined when there is none.
   */
  cachedSize(sourceKey: string): number | undefined {
    const prefix = `${sourceKey}|`;
    let size: number | undefined;
    for (const store of this.#stores.values()) {
      if (store.key.startsWith(prefix) && store.has(0)) size = store.size;
    }
    return size;
  }

  dropStore(store: RangeStore): void {
    for (const [k, entry] of this.#lru) {
      if (entry.store === store) {
        this.#lru.delete(k);
        this.#bytes -= entry.bytes;
      }
    }
    store._clear();
    if (this.#stores.get(store.key) === store) this.#stores.delete(store.key);
  }

  /** Drops every cached byte and tells live sources to abort in-flight work. */
  clear(): void {
    for (const store of this.#stores.values()) store._clear();
    this.#stores.clear();
    this.#lru.clear();
    this.#bytes = 0;
    for (const listener of [...this.#clearListeners]) listener();
  }

  onClear(listener: () => void): () => void {
    this.#clearListeners.add(listener);
    return () => this.#clearListeners.delete(listener);
  }

  /** @internal */
  _touch(store: RangeStore, index: number): void {
    const k = `${store.key}#${index}`;
    const entry = this.#lru.get(k);
    if (entry) {
      this.#lru.delete(k);
      this.#lru.set(k, entry);
    }
  }

  /** @internal */
  _added(store: RangeStore, index: number, bytes: number): void {
    const k = `${store.key}#${index}`;
    const prev = this.#lru.get(k);
    if (prev) {
      this.#bytes -= prev.bytes;
      this.#lru.delete(k);
    }
    this.#lru.set(k, { store, index, bytes });
    this.#bytes += bytes;
    this.#evictOverBudget();
  }

  #evictOverBudget(): void {
    while (this.#bytes > this.#maxBytes) {
      const first = this.#lru.entries().next();
      if (first.done) break;
      const [k, entry] = first.value;
      this.#lru.delete(k);
      this.#bytes -= entry.bytes;
      entry.store._evict(entry.index);
    }
  }
}

/** Shared by every viewer on the page. */
export const rangeBlockCache = new RangeBlockCache();

/**
 * Drops every recording byte RosView holds in memory (all viewers on the page) and aborts
 * in-flight range requests. Hosts call this on logout, membership removal or erasure.
 */
export function clearCache(): void {
  rangeBlockCache.clear();
}

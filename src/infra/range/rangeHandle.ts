/**
 * Bridge between the main-thread `RangeSource` (network + cache) and a data worker.
 * The worker never fetches recording bytes itself; it reads through a `MessagePort`.
 */
import * as Comlink from 'comlink';
import type { Range } from '@/shared/utils/ranges';
import type { RangeProgress, RangeSource } from './RangeSource';
import { rangeBlockCache } from './rangeCache';
import type { McapIndexCache, SerializedMcapIndex } from '@/infra/sources/McapUnindexedIterableSource';

export interface RangeHandleApi {
  open(): Promise<number>;
  read(offset: number, length: number): Promise<Uint8Array>;
  prefetch(ranges: Range[], replace: boolean): Promise<void>;
  ranges(): Promise<Range[]>;
  cachedBytes(): Promise<number>;
  setProgressListener(listener: (p: RangeProgress) => void): Promise<void>;
  /** Current (possibly renewed) URL, for sources that cannot range-read (SQLite db3). */
  getUrl(): Promise<string>;
  renewUrl(failedUrl: string): Promise<string | undefined>;
  indexGet(key: string): Promise<SerializedMcapIndex | undefined>;
  indexSet(key: string, index: SerializedMcapIndex): Promise<void>;
}

/** Page-lifetime, in-memory scan results of unindexed MCAPs (metadata only, no payloads). */
const memoryIndexes = new Map<string, SerializedMcapIndex>();
const MAX_MEMORY_INDEXES = 8;

export function clearMemoryIndexes(): void {
  memoryIndexes.clear();
}

// `clearCache()` also forgets scan results (schemas, channels, message offsets) of unindexed MCAPs.
rangeBlockCache.onClear(clearMemoryIndexes);

export interface ExposedRangeSource {
  port: MessagePort;
  dispose(): void;
}

export function exposeRangeSource(
  source: RangeSource,
  options: { indexKey?: string; renewUrl?: (failedUrl: string) => Promise<string | undefined> } = {},
): ExposedRangeSource {
  const channel = new MessageChannel();
  const api: RangeHandleApi = {
    open: () => source.open(),
    read: async (offset, length) => {
      const data = await source.read(offset, length);
      return Comlink.transfer(data, [data.buffer]);
    },
    prefetch: (ranges, replace) => {
      source.prefetch(ranges, { replace });
      return Promise.resolve();
    },
    ranges: () => Promise.resolve(source.downloadedRanges()),
    cachedBytes: () => Promise.resolve(source.cachedBytes()),
    setProgressListener: (listener) => {
      source.setProgressListener(listener);
      return Promise.resolve();
    },
    getUrl: () => Promise.resolve(source.getUrl()),
    renewUrl: (failedUrl) => options.renewUrl?.(failedUrl) ?? Promise.resolve(undefined),
    indexGet: (key) => Promise.resolve(memoryIndexes.get(`${options.indexKey ?? ''}|${key}`)),
    indexSet: (key, index) => {
      const k = `${options.indexKey ?? ''}|${key}`;
      memoryIndexes.delete(k);
      memoryIndexes.set(k, index);
      while (memoryIndexes.size > MAX_MEMORY_INDEXES) memoryIndexes.delete(memoryIndexes.keys().next().value as string);
      return Promise.resolve();
    },
  };
  Comlink.expose(api, channel.port1);
  return {
    port: channel.port2,
    dispose: () => {
      source.dispose();
      channel.port1.close();
    },
  };
}

/** Worker-side view of a range handle with the byte-source shape the readers expect. */
export class RemoteRangeFile {
  #remote: Comlink.Remote<RangeHandleApi>;
  #size?: number;
  #ranges: Range[] = [];
  #refreshing?: Promise<void>;
  #lastRefresh = 0;

  constructor(port: MessagePort) {
    this.#remote = Comlink.wrap<RangeHandleApi>(port);
  }

  get remote(): Comlink.Remote<RangeHandleApi> {
    return this.#remote;
  }

  async size(): Promise<number> {
    this.#size ??= await this.#remote.open();
    return this.#size;
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    await this.size();
    const data = await this.#remote.read(offset, length);
    void this.refreshRanges();
    return data;
  }

  prefetch(ranges: Range[], options?: { replace?: boolean }): void {
    void this.#remote.prefetch(ranges, options?.replace === true).then(() => this.refreshRanges(true));
  }

  /** Last known cached ranges (refreshed in the background; call `refreshRanges(true)` for a fresh view). */
  getDownloadedRanges(): Range[] {
    return this.#ranges;
  }

  refreshRanges(force = false): Promise<void> {
    if (this.#refreshing) return this.#refreshing;
    if (!force && Date.now() - this.#lastRefresh < 250) return Promise.resolve();
    this.#refreshing = this.#remote
      .ranges()
      .then((r) => {
        this.#ranges = r;
        this.#lastRefresh = Date.now();
      })
      .finally(() => {
        this.#refreshing = undefined;
      });
    return this.#refreshing;
  }

  async setProgressListener(listener: (p: RangeProgress) => void): Promise<void> {
    await this.#remote.setProgressListener(Comlink.proxy(listener));
  }

  /** `McapIndexCache` backed by the main thread's in-memory map (no IndexedDB). */
  indexCache(): McapIndexCache {
    return {
      get: (key) => this.#remote.indexGet(key),
      set: (key, index) => this.#remote.indexSet(key, index),
    };
  }
}

export function isMessagePort(value: unknown): value is MessagePort {
  return typeof MessagePort !== 'undefined' && value instanceof MessagePort;
}

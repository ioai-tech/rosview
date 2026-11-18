/**
 * Streaming byte-range reader for one remote recording (main thread).
 *
 * Reads only the 512 KiB blocks a caller needs, as small parallel Range requests, and commits
 * each block to the in-memory page-lifetime cache the moment it has arrived, so the first chunk
 * of an indexed MCAP is usable after a few hundred milliseconds rather than after a 50 MiB
 * transfer. Demand reads (a decoder waiting for a chunk) pre-empt read-ahead; read-ahead that
 * no longer matches the playhead is aborted. URLs may be renewed mid-session (see `UrlRenewal`).
 */
import type { Range } from '@/shared/utils/ranges';
import { RANGE_BLOCK_BYTES as B, rangeBlockCache, type RangeBlockCache, type RangeStore } from './rangeCache';
import type { RenewableUrl, UrlRenewal } from './urlRenewal';

export class RangeHttpError extends Error {
  readonly status: number;
  /** The URL that was refused (not logged: it may be a signed URL). */
  readonly url: string;
  constructor(message: string, status: number, url = '') {
    super(message);
    this.name = 'RangeHttpError';
    this.status = status;
    this.url = url;
  }
}

export type RangeProgress = { loadedBytes: number; totalBytes: number; transferredBytes: number };

export interface RangeSourceOptions {
  url: string;
  /** Host-stable identity of the recording (never the signed URL). Enables cache reuse across opens. */
  sourceKey?: string;
  knownTotalBytes?: number;
  renewal?: UrlRenewal;
  cache?: RangeBlockCache;
  fetchImpl?: typeof fetch;
}

const MAX_RUN_BLOCKS = 8; // 4 MiB per request
const MAX_PARALLEL = 6;
const PREFETCH_PARALLEL = 2;
const PREFETCH_RUN_BLOCKS = 4; // 2 MiB: bounds what an abort wastes
/** Read-ahead waits this long after the last demand read, so a seek owns the link. */
const PREFETCH_QUIET_MS = 120;
const MAX_ATTEMPTS = 4;
const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (e: unknown) => void;
}

interface Run {
  first: number;
  last: number;
  kind: 'demand' | 'prefetch';
  controller: AbortController;
  deferreds: Map<number, Deferred>;
}

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  promise.catch(() => undefined); // background read-ahead failures are not unhandled rejections
  return { promise, resolve, reject };
}

function abortError(): Error {
  const e = new Error('Aborted');
  e.name = 'AbortError';
  return e;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(abortError());
      },
      { once: true },
    );
  });
}

let anonymousCounter = 0;

export class RangeSource implements RenewableUrl {
  #url: string;
  #sourceKey?: string;
  #known?: number;
  #renewal?: UrlRenewal;
  #cache: RangeBlockCache;
  #fetch: typeof fetch;
  #anonId = `anon:${++anonymousCounter}`;

  #size = 0;
  #etag?: string;
  #storeKey = '';
  #opening?: Promise<number>;
  #disposed = false;
  #unregister?: () => void;
  #unlistenClear: () => void;

  #queue: Run[] = [];
  #active = new Set<Run>();
  #blockRun = new Map<number, Run>();
  #transferred = 0;
  #progress?: (p: RangeProgress) => void;
  #progressTimer?: ReturnType<typeof setTimeout>;
  #lastProgressAt = 0;
  #lastDemandAt = 0;
  #pumpTimer?: ReturnType<typeof setTimeout>;

  constructor(options: RangeSourceOptions) {
    this.#url = options.url;
    this.#sourceKey = options.sourceKey || undefined;
    this.#known =
      typeof options.knownTotalBytes === 'number' && Number.isFinite(options.knownTotalBytes) && options.knownTotalBytes > 0
        ? Math.floor(options.knownTotalBytes)
        : undefined;
    this.#renewal = options.renewal;
    this.#cache = options.cache ?? rangeBlockCache;
    this.#fetch = options.fetchImpl ?? ((...a) => fetch(...a));
    this.#unregister = this.#renewal?.register(this);
    this.#unlistenClear = this.#cache.onClear(() => this.#abortAll());
  }

  getUrl(): string {
    return this.#url;
  }

  setUrl(url: string): void {
    this.#url = url;
  }

  setProgressListener(listener: ((p: RangeProgress) => void) | undefined): void {
    this.#progress = listener;
  }

  /** Resolves the file size (one request unless the host passed it). */
  open(): Promise<number> {
    this.#opening ??= this.#open();
    return this.#opening;
  }

  async #open(): Promise<number> {
    if (this.#known != undefined) {
      this.#attachStore(this.#known);
      return this.#size;
    }
    const controller = new AbortController();
    const res = await this.#request(0, B - 1, controller.signal);
    const total = this.#parseTotal(res);
    if (!(total > 0)) {
      await res.body?.cancel().catch(() => undefined);
      throw new Error(
        `Could not determine the file size of ${this.#describe()} (no Content-Range or Content-Length). ` +
          'The server or bucket CORS rule must expose Content-Range, Content-Length and Accept-Ranges.',
      );
    }
    this.#etag = res.headers.get('ETag') ?? undefined;
    this.#attachStore(total);
    const run: Run = { first: 0, last: 0, kind: 'demand', controller, deferreds: new Map() };
    await this.#consume(res, run, 0);
    return this.#size;
  }

  #describe(): string {
    return this.#sourceKey ?? 'the recording URL';
  }

  #parseTotal(res: Response): number {
    if (res.status === 206) {
      const m = /\/(\d+)\s*$/.exec(res.headers.get('Content-Range') ?? '');
      return m ? parseInt(m[1], 10) : 0;
    }
    const cl = Number(res.headers.get('Content-Length') ?? '');
    return Number.isFinite(cl) ? cl : 0;
  }

  #attachStore(size: number): void {
    this.#size = size;
    this.#storeKey = this.#sourceKey ? `${this.#sourceKey}|${size}` : this.#anonId;
  }

  get #store(): RangeStore {
    return this.#cache.store(this.#storeKey, this.#size);
  }

  size(): number {
    return this.#size;
  }

  /** Cached byte ranges of this source. */
  downloadedRanges(): Range[] {
    return this.#size > 0 ? this.#store.ranges() : [];
  }

  /** Bytes currently held for this source. */
  cachedBytes(): number {
    return this.#size > 0 ? this.#store.cachedBytes() : 0;
  }

  get transferredBytes(): number {
    return this.#transferred;
  }

  async read(offset: number, length: number, signal?: AbortSignal): Promise<Uint8Array> {
    if (length <= 0) return new Uint8Array(0);
    if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < 0) {
      throw new Error(`RangeSource#read invalid input: offset=${offset}, length=${length}`);
    }
    await this.open();
    if (offset + length > this.#size) throw new Error('RangeSource#read past the end of the file');
    const first = Math.floor(offset / B);
    const last = Math.floor((offset + length - 1) / B);
    for (let attempt = 0; attempt < 3; attempt++) {
      if (signal?.aborted) throw abortError();
      const waits = this.#ensure(first, last, 'demand');
      if (waits.length > 0) {
        await Promise.all(signal ? [...waits, new Promise<never>((_, rej) => signal.addEventListener('abort', () => rej(abortError()), { once: true }))] : waits);
      }
      const out = this.#assemble(offset, length, first, last);
      if (out) return out;
      // A block was evicted between arrival and assembly (tiny cache): fetch again.
    }
    throw new Error('RangeSource#read: the cache budget is too small for this read');
  }

  #assemble(offset: number, length: number, first: number, last: number): Uint8Array | undefined {
    const store = this.#store;
    const out = new Uint8Array(length);
    let at = 0;
    for (let i = first; i <= last; i++) {
      const block = store.get(i);
      if (!block) return undefined;
      const blockStart = i * B;
      const from = Math.max(offset, blockStart) - blockStart;
      const to = Math.min(offset + length, blockStart + block.byteLength) - blockStart;
      out.set(block.subarray(from, to), at);
      at += to - from;
    }
    return out;
  }

  /** Read-ahead. `replace` drops queued / in-flight read-ahead that no longer matches the playhead. */
  prefetch(offset: number, length: number, options?: { replace?: boolean }): void {
    if (this.#disposed || length <= 0 || this.#size <= 0 || offset >= this.#size) return;
    const end = Math.min(this.#size, offset + Math.min(length, this.#cache.maxBytes / 2));
    const first = Math.floor(offset / B);
    const last = Math.floor((end - 1) / B);
    if (options?.replace) {
      // A moved read-ahead anchor means a seek or a cursor restart: its demand reads follow
      // within milliseconds and must own the link, so read-ahead starts only after a quiet gap.
      this.#lastDemandAt = Date.now();
      this.#queue = this.#queue.filter((run) => {
        if (run.kind !== 'prefetch') return true;
        this.#dropRun(run, abortError());
        return false;
      });
      for (const run of [...this.#active]) {
        if (run.kind === 'prefetch' && (run.last < first || run.first > last)) this.#abortRun(run);
      }
    }
    void this.#ensure(first, last, 'prefetch');
  }

  /** Returns the promises a caller must await; empty when everything is cached. */
  #ensure(first: number, last: number, kind: 'demand' | 'prefetch'): Promise<void>[] {
    const store = this.#store;
    const waits: Promise<void>[] = [];
    const missing: number[] = [];
    for (let i = first; i <= last; i++) {
      if (store.has(i)) continue;
      const run = this.#blockRun.get(i);
      if (run) {
        if (kind === 'demand' && run.kind === 'prefetch') this.#promote(run);
        waits.push(run.deferreds.get(i)!.promise);
      } else {
        missing.push(i);
      }
    }
    let created = false;
    const maxRun = kind === 'prefetch' ? PREFETCH_RUN_BLOCKS : MAX_RUN_BLOCKS;
    for (let k = 0; k < missing.length; ) {
      let j = k;
      while (j + 1 < missing.length && missing[j + 1] === missing[j] + 1 && j + 1 - k < maxRun) j++;
      const run: Run = { first: missing[k], last: missing[j], kind, controller: new AbortController(), deferreds: new Map() };
      for (let i = run.first; i <= run.last; i++) {
        const d = deferred();
        run.deferreds.set(i, d);
        this.#blockRun.set(i, run);
        waits.push(d.promise);
      }
      if (kind === 'demand') {
        const firstPrefetch = this.#queue.findIndex((r) => r.kind === 'prefetch');
        this.#queue.splice(firstPrefetch < 0 ? this.#queue.length : firstPrefetch, 0, run);
      } else {
        this.#queue.push(run);
      }
      created = true;
      k = j + 1;
    }
    if (kind === 'demand') this.#lastDemandAt = Date.now();
    if (created && kind === 'demand') {
      // The link is shared: in-flight read-ahead yields to a read someone is waiting for.
      for (const run of [...this.#active]) if (run.kind === 'prefetch') this.#abortRun(run);
    }
    this.#pump();
    return waits;
  }

  #promote(run: Run): void {
    run.kind = 'demand';
    const at = this.#queue.indexOf(run);
    if (at >= 0) {
      this.#queue.splice(at, 1);
      const firstPrefetch = this.#queue.findIndex((r) => r.kind === 'prefetch');
      this.#queue.splice(firstPrefetch < 0 ? this.#queue.length : firstPrefetch, 0, run);
    }
  }

  #pump(): void {
    if (this.#disposed) return;
    for (;;) {
      if (this.#active.size >= MAX_PARALLEL) return;
      const demandQueued = this.#queue.some((r) => r.kind === 'demand');
      let next: Run | undefined;
      if (demandQueued) {
        next = this.#queue.find((r) => r.kind === 'demand');
      } else if (this.#queue.length > 0) {
        const demandActive = [...this.#active].some((r) => r.kind === 'demand');
        const quietFor = Date.now() - this.#lastDemandAt;
        if (demandActive || quietFor < PREFETCH_QUIET_MS) {
          this.#pumpTimer ??= setTimeout(() => {
            this.#pumpTimer = undefined;
            this.#pump();
          }, Math.max(20, PREFETCH_QUIET_MS - quietFor));
          return;
        }
        const prefetchActive = [...this.#active].filter((r) => r.kind === 'prefetch').length;
        if (prefetchActive < PREFETCH_PARALLEL) next = this.#queue.find((r) => r.kind === 'prefetch');
      }
      if (!next) return;
      this.#queue.splice(this.#queue.indexOf(next), 1);
      this.#active.add(next);
      void this.#execute(next);
    }
  }

  #abortRun(run: Run): void {
    run.controller.abort();
    this.#dropRun(run, abortError());
  }

  #dropRun(run: Run, reason: unknown): void {
    for (const [i, d] of run.deferreds) {
      if (this.#blockRun.get(i) === run) this.#blockRun.delete(i);
      d.reject(reason);
    }
    run.deferreds.clear();
  }

  #abortAll(): void {
    for (const run of [...this.#active]) this.#abortRun(run);
    for (const run of this.#queue) this.#dropRun(run, abortError());
    this.#queue = [];
  }

  async #execute(run: Run): Promise<void> {
    let next = run.first;
    let attempt = 0;
    try {
      for (;;) {
        try {
          const end = Math.min(this.#size, (run.last + 1) * B) - 1;
          const res = await this.#request(next * B, end, run.controller.signal);
          next = await this.#consume(res, run, next);
          if (next > run.last) break;
          throw new Error('Short read from the range server');
        } catch (err) {
          if (run.controller.signal.aborted) throw abortError();
          const status = err instanceof RangeHttpError ? err.status : 0;
          if (status !== 0 && !RETRYABLE.has(status)) throw err;
          if (++attempt >= MAX_ATTEMPTS) throw err;
          await sleep(300 * 2 ** (attempt - 1), run.controller.signal);
          // resume from the first block not yet committed
          while (next <= run.last && this.#store.has(next)) next++;
          if (next > run.last) break;
        }
      }
    } catch (err) {
      this.#dropRun(run, err);
    } finally {
      this.#active.delete(run);
      this.#dropRun(run, new Error('Range request ended early'));
      this.#pump();
    }
  }

  /**
   * One ranged GET. A 401 / 403 asks the renewal for fresh URLs and retries once; every other
   * failure throws `RangeHttpError` (the caller decides about retrying transient statuses).
   */
  async #request(start: number, end: number, signal: AbortSignal): Promise<Response> {
    if (this.#renewal?.expiringSoon()) await this.#renewal.renew(this, this.#url);
    for (let renewed = false; ; ) {
      const current = this.#url;
      let res: Response;
      try {
        res = await this.#fetch(current, { headers: { Range: `bytes=${start}-${end}` }, signal });
      } catch (err) {
        if (signal.aborted) throw abortError();
        throw err;
      }
      if (res.status === 206 || res.status === 200) return res;
      await res.body?.cancel().catch(() => undefined);
      if ((res.status === 401 || res.status === 403) && this.#renewal && !renewed) {
        renewed = true;
        if (await this.#renewal.renew(this, current)) continue;
      }
      if (res.status === 416) throw new RangeHttpError('Requested range not satisfiable', 416, current);
      throw new RangeHttpError(`Failed to read bytes ${start}-${end}: ${res.status} ${res.statusText}`.trim(), res.status, current);
    }
  }

  /** Streams a response into the cache block by block; returns the next uncommitted block index. */
  async #consume(res: Response, run: Run, firstBlock: number): Promise<number> {
    const etag = res.headers.get('ETag') ?? undefined;
    if (etag) {
      if (this.#etag && etag !== this.#etag) {
        // The recording changed while this viewer had it open: never mix versions.
        this.#cache.dropStore(this.#store);
        throw new Error('The recording changed on the server while it was open (ETag mismatch).');
      }
      this.#etag = etag;
      const known = this.#store;
      if (known.etag && known.etag !== etag) {
        // A previous open cached another version under the same key: start clean.
        this.#cache.dropStore(known);
      }
      this.#store.etag = etag;
    }
    const whole = res.status === 200;
    if (whole && this.#size > this.#cache.maxBytes) {
      await res.body?.cancel().catch(() => undefined);
      throw new Error('The server ignored the Range header and the recording is larger than the cache budget.');
    }
    // A 200 carries the whole file from byte 0; a 206 starts at the requested block.
    let blockIndex = whole ? 0 : firstBlock;
    const store = this.#store;
    const limitBlock = whole ? store.blockCount - 1 : Math.max(run.last, firstBlock);
    const buf = new Uint8Array(B);
    let filled = 0;
    const push = (chunk: Uint8Array): void => {
      let at = 0;
      while (at < chunk.byteLength && blockIndex <= limitBlock) {
        const want = Math.min(B, this.#size - blockIndex * B);
        const take = Math.min(want - filled, chunk.byteLength - at);
        buf.set(chunk.subarray(at, at + take), filled);
        filled += take;
        at += take;
        if (filled === want) {
          store.set(blockIndex, buf.slice(0, want));
          run.deferreds.get(blockIndex)?.resolve();
          if (this.#blockRun.get(blockIndex) === run) this.#blockRun.delete(blockIndex);
          blockIndex++;
          filled = 0;
          this.#emitProgress();
        }
      }
    };
    const body = res.body;
    if (!body) {
      const all = new Uint8Array(await res.arrayBuffer());
      this.#transferred += all.byteLength;
      push(all);
      return blockIndex;
    }
    const reader = body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        this.#transferred += value.byteLength;
        push(value);
        if (blockIndex > limitBlock) {
          await reader.cancel().catch(() => undefined);
          break;
        }
      }
    } finally {
      reader.releaseLock();
    }
    return blockIndex;
  }

  #emitProgress(): void {
    if (!this.#progress) return;
    const now = Date.now();
    const emit = (): void => {
      this.#progressTimer = undefined;
      this.#lastProgressAt = Date.now();
      this.#progress?.({ loadedBytes: this.cachedBytes(), totalBytes: this.#size, transferredBytes: this.#transferred });
    };
    if (now - this.#lastProgressAt >= 150) emit();
    else this.#progressTimer ??= setTimeout(emit, 150);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#abortAll();
    clearTimeout(this.#progressTimer);
    clearTimeout(this.#pumpTimer);
    this.#unregister?.();
    this.#unlistenClear();
    if (!this.#sourceKey && this.#size > 0) this.#cache.dropStore(this.#store);
  }
}

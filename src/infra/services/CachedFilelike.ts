import VirtualLRUBuffer from '@/shared/utils/VirtualLRUBuffer';
import { missingRanges, type Range } from '@/shared/utils/ranges';
import type { Readable } from '@/core/types/player';
import EventEmitter from "eventemitter3";

export type FileStreamEvents = {
  data: (chunk: Uint8Array) => void;
  progress: (received: number, total: number) => void;
  error: (err: Error) => void;
};

export type DownloadProgressInfo = {
  loadedBytes: number;
  totalBytes: number;
  transferredBytes: number;
};

export interface FileStream extends EventEmitter<FileStreamEvents> {
  destroy: () => void;
}

export interface FileReader {
  open(): Promise<{ size: number }>;
  fetch(offset: number, length: number): FileStream;
}

const CACHE_BLOCK_SIZE = 1024 * 1024 * 50; // 50MiB blocks
const DEFAULT_MAX_REQUEST_SIZE = CACHE_BLOCK_SIZE * 2;

/**
 * Max consecutive fetch failures for the *same* logical block before giving up and rejecting
 * pending reads. Previously the only give-up condition was "two errors within 100ms of each
 * other", which never triggers against a server/network that fails slowly-but-persistently
 * (RTT > 100ms) — that failure mode retried forever. This bound guarantees termination
 * regardless of error timing.
 */
const MAX_CONSECUTIVE_BLOCK_ERRORS = 6;

function isFiniteNonNegativeInteger(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

export default class CachedFilelike implements Readable {
  #fileReader: FileReader;
  #cacheSizeInBytes: number = Infinity;
  #maxRequestSizeInBytes: number = DEFAULT_MAX_REQUEST_SIZE;
  #fetchBlockSizeInBytes: number = CACHE_BLOCK_SIZE;
  #preferCacheViews = false;
  #fileSize?: number;
  #virtualBuffer: VirtualLRUBuffer;
  #closed: boolean = false;
  #keepReconnectingCallback?: (reconnecting: boolean) => void;
  #onDownloadProgress?: (info: DownloadProgressInfo) => void;
  #transferredBytes = 0;
  #currentRequestReceived = 0;

  #currentConnection: { stream: FileStream; remainingRange: Range; kind: "read" | "prefetch" } | undefined;

  #readRequests: {
    range: Range;
    resolve: (_: Uint8Array) => void;
    reject: (_: Error) => void;
    requestTime: number;
  }[] = [];
  #prefetchRequests: Range[] = [];

  #lastErrorTime?: number;
  #consecutiveBlockErrorCount: number = 0;

  public constructor(options: {
    fileReader: FileReader;
    cacheSizeInBytes?: number;
    fetchBlockSizeInBytes?: number;
    maxRequestSizeInBytes?: number;
    preferCacheViews?: boolean;
    keepReconnectingCallback?: (reconnecting: boolean) => void;
    onDownloadProgress?: (info: DownloadProgressInfo) => void;
  }) {
    this.#fileReader = options.fileReader;
    this.#cacheSizeInBytes = options.cacheSizeInBytes ?? this.#cacheSizeInBytes;
    this.#maxRequestSizeInBytes = Math.max(
      1,
      Math.min(
        options.maxRequestSizeInBytes ?? DEFAULT_MAX_REQUEST_SIZE,
        Number.isFinite(this.#cacheSizeInBytes) ? this.#cacheSizeInBytes : DEFAULT_MAX_REQUEST_SIZE,
      ),
    );
    this.#fetchBlockSizeInBytes = Math.max(
      1,
      Math.min(options.fetchBlockSizeInBytes ?? CACHE_BLOCK_SIZE, this.#maxRequestSizeInBytes),
    );
    this.#preferCacheViews = options.preferCacheViews ?? false;
    this.#keepReconnectingCallback = options.keepReconnectingCallback;
    this.#onDownloadProgress = options.onDownloadProgress;
    this.#virtualBuffer = new VirtualLRUBuffer({ size: 0 });
  }

  public async open(): Promise<void> {
    if (this.#fileSize != undefined) {
      return;
    }
    const { size } = await this.#fileReader.open();
    this.#fileSize = size;
    if (this.#cacheSizeInBytes >= size) {
      this.#virtualBuffer = new VirtualLRUBuffer({ size, blockSize: CACHE_BLOCK_SIZE });
    } else {
      this.#virtualBuffer = new VirtualLRUBuffer({
        size,
        blockSize: CACHE_BLOCK_SIZE,
        numberOfBlocks: Math.ceil(this.#cacheSizeInBytes / CACHE_BLOCK_SIZE) + 2,
      });
    }
  }

  public async size(): Promise<number> {
    await this.open();
    if (this.#fileSize == undefined) {
      throw new Error("CachedFilelike failed to get file size");
    }
    return this.#fileSize;
  }

  public getDownloadedRanges(): Range[] {
    return this.#virtualBuffer.getRangesWithData().map((range) => ({ ...range }));
  }

  public hasData(offset: number, length: number): boolean {
    return length <= 0 || this.#virtualBuffer.hasData(offset, offset + length);
  }

  public read(offset: number, length: number): Promise<Uint8Array> {
    if (length === 0) {
      return Promise.resolve(new Uint8Array());
    }

    // Fail fast on non-finite / negative / non-integer offsets or lengths (e.g. `NaN` from a
    // caller doing arithmetic on an un-awaited `Promise`). Without this guard, a `NaN` `end`
    // silently turns into a `read()` that can never be satisfied — `hasData()` is never true
    // for a `NaN` bound — while the block-alignment logic keeps computing a plausible-looking,
    // finite fetch range from the (valid) `start` and re-requesting it forever. See
    // `bag.worker.ts`'s remote `Filelike.size()` adapter for the real-world case this fixes.
    if (
      !isFiniteNonNegativeInteger(offset) ||
      !isFiniteNonNegativeInteger(length)
    ) {
      throw new Error(
        `CachedFilelike#read invalid input: offset=${offset}, length=${length} (must be finite non-negative integers)`,
      );
    }

    const range = { start: offset, end: offset + length };

    if (length > this.#cacheSizeInBytes) {
      throw new Error(`Requested more data than cache size: ${length} > ${this.#cacheSizeInBytes}`);
    }

    return new Promise((resolve, reject) => {
      this.open()
        .then(async () => {
          const size = await this.size();
          if (range.end > size) {
            reject(new Error(`CachedFilelike#read past size`));
            return;
          }

          this.#readRequests.push({ range, resolve, reject, requestTime: Date.now() });
          this.#updateState();
        })
        .catch((err: unknown) => {
          reject(err instanceof Error ? err : new Error(String(err)));
        });
    });
  }

  public prefetch(offset: number, length: number, options?: { replace?: boolean }): void {
    if (length <= 0 || this.#closed) {
      return;
    }
    // Best-effort: silently drop malformed prefetch requests rather than let a `NaN`/negative
    // bound reach the same range-alignment code path that `read()` guards against above.
    if (
      !isFiniteNonNegativeInteger(offset) ||
      !isFiniteNonNegativeInteger(length) ||
      length > this.#cacheSizeInBytes
    ) {
      return;
    }

    const range = { start: offset, end: offset + length };

    void this.open()
      .then(async () => {
        const size = await this.size();
        if (range.end > size || this.#virtualBuffer.hasData(range.start, range.end)) {
          return;
        }
        if (options?.replace === true) {
          const currentPrefetch = this.#currentConnection?.kind === "prefetch" ? this.#currentConnection : undefined;
          const currentPrefetchMatches =
            currentPrefetch != undefined &&
            this.#rangeOverlaps(range, currentPrefetch.remainingRange);
          this.#prefetchRequests = [];
          if (currentPrefetch && !currentPrefetchMatches) {
            currentPrefetch.stream.destroy();
            this.#currentConnection = undefined;
          }
        }
        if (this.#prefetchRequests.some((queued) => queued.start === range.start && queued.end === range.end)) {
          return;
        }
        this.#prefetchRequests.push(range);
        this.#updateState();
      })
      .catch((err) => {
        console.warn("CachedFilelike: prefetch skipped", err);
      });
  }

  #updateState(): void {
    if (this.#closed) {
      return;
    }

    this.#readRequests = this.#readRequests.filter(({ range, resolve, reject }) => {
      // Second line of defense: `read()` already rejects non-finite ranges synchronously, but
      // reject here too in case a request ever reaches the queue some other way — an
      // unsatisfiable range must never sit in the queue silently forever.
      if (!Number.isFinite(range.start) || !Number.isFinite(range.end)) {
        reject(new Error(`CachedFilelike: unsatisfiable range [${range.start}, ${range.end})`));
        return false;
      }
      if (!this.#virtualBuffer.hasData(range.start, range.end)) {
        return true;
      }

      const buffer = this.#preferCacheViews
        ? this.#virtualBuffer.viewOrSlice(range.start, range.end)
        : this.#virtualBuffer.slice(range.start, range.end);

      resolve(buffer);
      return false;
    });

    if (this.#fileSize === undefined) return;
    const size = this.#fileSize;

    this.#prefetchRequests = this.#prefetchRequests.filter(
      (range) => !this.#virtualBuffer.hasData(range.start, range.end),
    );
    const firstReadRange = this.#readRequests[0]?.range;
    if (
      firstReadRange &&
      this.#currentConnection?.kind === "prefetch" &&
      !this.#rangeOverlaps(firstReadRange, this.#currentConnection.remainingRange)
    ) {
      this.#currentConnection.stream.destroy();
      this.#currentConnection = undefined;
    }

    if (!this.#currentConnection && firstReadRange) {
      const readFetchRange = this.#getNextFixedFetchRange(firstReadRange, size);
      if (readFetchRange) {
        this.#setConnection(readFetchRange, "read");
        return;
      }
    }

    if (!this.#currentConnection && this.#readRequests.length === 0) {
      const prefetchRange = this.#prefetchRequests[0];
      if (prefetchRange) {
        const prefetchFetchRange = this.#getNextFixedFetchRange(prefetchRange, size);
        if (prefetchFetchRange) {
          this.#setConnection(prefetchFetchRange, "prefetch");
          return;
        }
      }
    }
  }

  #getNextFixedFetchRange(queryRange: Range, fileSize: number): Range | undefined {
    if (!Number.isFinite(queryRange.start) || !Number.isFinite(queryRange.end)) {
      // Never schedule a fetch from a non-finite range: `#alignToFetchBlock` would otherwise
      // happily derive a plausible, finite block from `queryRange.start` alone and re-fetch it
      // forever, since the (bogus) query range itself can never be marked satisfied.
      return undefined;
    }
    if (queryRange.start >= fileSize) {
      return undefined;
    }
    const bounded = { start: queryRange.start, end: Math.min(queryRange.end, fileSize) };
    const missing = missingRanges(bounded, this.#coveredOrInFlightRanges())[0];
    if (!missing) {
      return undefined;
    }
    return this.#alignToFetchBlock(missing, fileSize);
  }

  #alignToFetchBlock(range: Range, fileSize: number): Range {
    const blockSize = this.#fetchBlockSizeInBytes;
    const start = Math.floor(range.start / blockSize) * blockSize;
    const end = Math.min(fileSize, start + blockSize);
    return { start, end };
  }

  #coveredOrInFlightRanges(): Range[] {
    const ranges = this.#virtualBuffer.getRangesWithData().map((range) => ({ ...range }));
    if (this.#currentConnection) {
      ranges.push({ ...this.#currentConnection.remainingRange });
    }
    return this.#mergeRanges(ranges);
  }

  #mergeRanges(ranges: Range[]): Range[] {
    const sorted = ranges
      .filter((range) => range.end > range.start)
      .sort((a, b) => a.start - b.start || a.end - b.end);
    const merged: Range[] = [];
    for (const range of sorted) {
      const previous = merged[merged.length - 1];
      if (!previous || range.start > previous.end) {
        merged.push({ ...range });
      } else {
        previous.end = Math.max(previous.end, range.end);
      }
    }
    return merged;
  }

  #rangeOverlaps(a: Range, b: Range): boolean {
    return a.start < b.end && b.start < a.end;
  }

  #setConnection(range: Range, kind: "read" | "prefetch"): void {
    if (this.#currentConnection) {
      const currentConnection = this.#currentConnection;
      currentConnection.stream.destroy();
    }

    const stream = this.#fileReader.fetch(range.start, range.end - range.start);
    this.#currentConnection = { stream, remainingRange: range, kind };
    this.#currentRequestReceived = 0;
    const requestTotal = range.end - range.start;

    stream.on("progress", (received: number, total: number) => {
      const currentConnection = this.#currentConnection;
      if (!currentConnection || stream !== currentConnection.stream) {
        return;
      }
      const safeReceived = Math.max(0, received);
      const delta = safeReceived - this.#currentRequestReceived;
      if (delta > 0) {
        this.#transferredBytes += delta;
        this.#currentRequestReceived = safeReceived;
      }
      this.#reportDownloadProgress(safeReceived, total > 0 ? total : requestTotal);
    });

    stream.on("error", (error: Error) => {
      console.error(`Connection error @ ${range.start}-${range.end}:`, error);
      const currentConnection = this.#currentConnection;
      if (!currentConnection || stream !== currentConnection.stream) {
        return;
      }

      // Bounded regardless of `keepReconnectingCallback` and independent of the "two errors
      // within 100ms" heuristic below, which never trips against a slowly-but-persistently
      // failing server/network (RTT > 100ms) — that combination used to retry forever.
      this.#consecutiveBlockErrorCount += 1;
      const exhaustedRetryBudget = this.#consecutiveBlockErrorCount >= MAX_CONSECUTIVE_BLOCK_ERRORS;
      const rapidDoubleFault =
        !this.#keepReconnectingCallback &&
        this.#lastErrorTime != undefined &&
        Date.now() - this.#lastErrorTime < 100;

      if (exhaustedRetryBudget || rapidDoubleFault) {
        this.#closed = true;
        const failure = exhaustedRetryBudget
          ? new Error(
              `CachedFilelike: giving up on ${range.start}-${range.end} after ${this.#consecutiveBlockErrorCount} consecutive errors: ${error.message}`,
            )
          : error;
        for (const request of this.#readRequests) {
          request.reject(failure);
        }
        return;
      }

      if (this.#keepReconnectingCallback && this.#lastErrorTime == undefined) {
        this.#keepReconnectingCallback(true);
      }

      this.#lastErrorTime = Date.now();
      currentConnection.stream.destroy();
      this.#currentConnection = undefined;
      this.#updateState();
    });

    let bytesRead = 0;
    stream.on("data", (chunk: Uint8Array) => {
      const currentConnection = this.#currentConnection;
      if (!currentConnection || stream !== currentConnection.stream) {
        return;
      }

      this.#consecutiveBlockErrorCount = 0;
      if (this.#lastErrorTime != undefined) {
        this.#lastErrorTime = undefined;
        if (this.#keepReconnectingCallback) {
          this.#keepReconnectingCallback(false);
        }
      }

      this.#virtualBuffer.copyFrom(chunk, currentConnection.remainingRange.start);
      bytesRead += chunk.byteLength;
      if (this.#currentRequestReceived === 0 && chunk.byteLength > 0) {
        this.#transferredBytes += chunk.byteLength;
        this.#reportDownloadProgress(bytesRead, requestTotal);
      }

      if (this.#virtualBuffer.hasData(range.start, range.end)) {
        stream.destroy();
        this.#currentConnection = undefined;
      } else {
        this.#currentConnection = {
          stream,
          remainingRange: { start: range.start + bytesRead, end: range.end },
          kind,
        };
      }

      this.#updateState();
    });
  }

  #reportDownloadProgress(loadedBytes: number, totalBytes: number): void {
    this.#onDownloadProgress?.({
      loadedBytes,
      totalBytes,
      transferredBytes: this.#transferredBytes,
    });
  }
}

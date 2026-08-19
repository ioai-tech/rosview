import * as Comlink from "comlink";
import { BlobReadable } from "@mcap/browser";
import { McapIndexedReader } from "@mcap/core";
import type { IReadable } from "@mcap/core";
import type { Initialization, MessageEvent, TimeRange } from '@/core/types/ros';
import type {
  IWorkerSerializedSourceWorker,
  MessageIteratorArgs,
  GetBackfillMessagesArgs,
  GetAdjacentMessageArgs,
  IMessageCursor,
  PlaybackBufferStatus,
  PreparePlaybackBufferArgs,
  SourceInitProgressCallback,
} from "./types";
import { McapIndexedIterableSource } from '@/infra/sources/McapIndexedIterableSource';
import { loadDecompressHandlers } from '@/infra/sources/decompressHandlers';
import { MessageCursor } from "./MessageCursor";
import { HttpFileReader } from '@/infra/services/HttpFileReader';
import CachedFilelike from '@/infra/services/CachedFilelike';
import { resolveWorkerHttpUrl } from '@/shared/utils/resolveWorkerHttpUrl';
import type { LoadProgress } from "./types";
import type { TransportDiagnostics, WorkerTransportConfig } from "./transport";
import { SharedPayloadRing } from "./sharedPayloadRing";
import { resolveRemoteCacheBytes } from './remoteCacheConfig';
import { fromNano, toNano } from '@/shared/utils/time';
import type { Range } from '@/shared/utils/ranges';
import { compactTimeRanges, inferProgressTimeRangeCompaction } from '@/shared/utils/timeRanges';
import { workerPerf } from './workerPerf';
import { DataQualityScanController } from './dataQualityScanController';
import { trackInitProgress } from './throttledInitProgress';
import {
  getPlayableTimeRanges,
  isByteRangeCovered,
  type ChunkCoverage,
} from './playableTimeRanges';

type IndexedChunkCoverage = ChunkCoverage;

const MIB = 1024 * 1024;
const PREFETCH_CACHE_FRACTION = 0.75;
const MIN_PREFETCH_BYTES = 64 * MIB;
const MAX_PREFETCH_BYTES = 768 * MIB;
const MAX_PREFETCH_HORIZON_NS = 15_000_000_000n;
const MAX_CONTIGUOUS_CHUNK_GAP_NS = 750_000_000n;
const DEFAULT_PREFETCH_AHEAD_MS = 5_000;
const PLAYBACK_CURSOR_BUFFER_AHEAD_MS = 1_500;

class McapWorkerImpl implements IWorkerSerializedSourceWorker {
  private _source?: McapIndexedIterableSource;
  private _cachedReadable?: CachedFilelike;
  private _initialization?: Initialization;
  private _chunkCoverage: IndexedChunkCoverage[] = [];
  private _totalBytes = 0;
  private _remoteCacheBytes = 0;
  private _prefetchAnchor?: TimeRange["start"];
  private _transportConfig: WorkerTransportConfig = {
    mode: "comlink",
    binaryPayloadThresholdBytes: 64 * 1024,
  };
  private _qualityScan = new DataQualityScanController();

  async initialize(
    args: Record<string, unknown>,
    onProgress?: SourceInitProgressCallback,
  ): Promise<Initialization> {
    workerPerf.configure({
      enabled: args.workerPerf === true,
      label: "mcap",
    });
    console.debug("McapWorker: initialize starting", args);
    const report = trackInitProgress(onProgress);
    try {
      let rawReadable: IReadable;
      const url = typeof args.url === 'string' ? args.url : undefined;
      const file = args.file instanceof Blob ? args.file : undefined;
      report({ phase: "connecting", loadedBytes: 0, totalBytes: 0 });
      if (url) {
        const knownRaw = args.knownTotalBytes;
        const knownTotalBytes =
          typeof knownRaw === 'number' &&
          Number.isFinite(knownRaw) &&
          knownRaw > 0
            ? Math.floor(knownRaw)
            : undefined;
        const fileReader = new HttpFileReader(
          resolveWorkerHttpUrl(url),
          knownTotalBytes != null ? { knownTotalBytes } : undefined,
        );
        this._remoteCacheBytes = resolveRemoteCacheBytes();
        const cachedReadable = new CachedFilelike({
          fileReader,
          cacheSizeInBytes: this._remoteCacheBytes,
          preferCacheViews: true,
          onDownloadProgress: (info) => {
            report({
              phase: "downloading",
              loadedBytes: info.loadedBytes,
              totalBytes: info.totalBytes,
              transferredBytes: info.transferredBytes,
            });
          },
        });
        this._cachedReadable = cachedReadable;
        rawReadable = {
          size: async () => BigInt(await cachedReadable.size()),
          read: async (offset: bigint, length: bigint) =>
            await cachedReadable.read(Number(offset), Number(length)),
        };
      } else if (file) {
        rawReadable = new BlobReadable(file);
        this._cachedReadable = undefined;
        this._totalBytes = file.size;
      } else {
        throw new Error("McapWorker: neither url nor file provided");
      }

      const zstdWasmBinary = args.zstdWasmBinary;
      if (!(zstdWasmBinary instanceof ArrayBuffer)) {
        throw new Error(
          "McapWorker: zstdWasmBinary required (pass wasm bytes from main thread for inline workers)",
        );
      }

      const decompressHandlers = await workerPerf.timeAsync(
        "initialize.loadDecompressHandlers",
        () => loadDecompressHandlers({ wasmBinary: zstdWasmBinary }),
      );
      
      const mcapReadable = {
        size: async () => await rawReadable.size(),
        read: async (offset: bigint, length: bigint) => {
          const byteLength = Number(length);
          return await workerPerf.timeAsync<Uint8Array>(
            "mcapReadable.read",
            async () => await rawReadable.read(offset, length),
            byteLength,
          );
        }
      };

      const reader = await workerPerf.timeAsync(
        "initialize.McapIndexedReader",
        () => McapIndexedReader.Initialize({
          readable: mcapReadable,
          decompressHandlers,
        }),
      );
      report({ phase: "opening" });
      this._source = new McapIndexedIterableSource(reader);
      const init = await workerPerf.timeAsync(
        "initialize.source",
        () => this._source!.initialize(),
      );
      this._initialization = init;
      this._qualityScan.initialize(this._source, init, args.autoDataQualityScan === true);
      this._chunkCoverage = workerPerf.time("initialize.chunkCoverage", () => {
        const chunksByOffset = [...reader.chunkIndexes].sort((a, b) =>
          a.chunkStartOffset < b.chunkStartOffset ? -1 : a.chunkStartOffset > b.chunkStartOffset ? 1 : 0,
        );
        return chunksByOffset
          .map((chunk, index) => {
            const chunkEnd = chunk.chunkStartOffset + chunk.chunkLength;
            const nextChunkStart = chunksByOffset[index + 1]?.chunkStartOffset;
            return {
              byteRange: {
                start: Number(chunk.chunkStartOffset),
                end: Number(nextChunkStart != undefined && nextChunkStart > chunkEnd ? nextChunkStart : chunkEnd),
              },
              timeRange: {
                start: fromNano(chunk.messageStartTime),
                end: fromNano(chunk.messageEndTime),
              },
              startNs: chunk.messageStartTime,
              endNs: chunk.messageEndTime,
            };
          })
          .sort((a, b) => (a.startNs < b.startNs ? -1 : a.startNs > b.startNs ? 1 : 0));
      });
      if (this._cachedReadable) {
        this._totalBytes = await this._cachedReadable.size();
        this._prefetchAnchor = init.start;
        this._scheduleTimePrefixPrefetch();
      }
      workerPerf.flushMaybe(true);
      return init;
    } catch (err) {
      console.error("McapWorker: initialize failed", err);
      throw err;
    }
  }

  configureTransport(config: WorkerTransportConfig): Promise<void> {
    this._transportConfig = config;
    return Promise.resolve();
  }

  getMessageCursor(args: MessageIteratorArgs): Promise<IMessageCursor<unknown>> {
    if (!this._source) throw new Error("Not initialized");
    this._prefetchAnchor = args.startTime;
    this._scheduleTimePrefixPrefetch();
    const iterator = this._source.messageIterator(args);
    const cursorOptions = {
      ...this._transportConfig,
      latestOnlyTopics: args.latestOnlyTopics,
      ...(args.endTime == undefined ? { maxBufferDurationMs: PLAYBACK_CURSOR_BUFFER_AHEAD_MS } : {}),
    };
    return Promise.resolve(Comlink.proxy(new MessageCursor(iterator, cursorOptions)));
  }

  async getBackfillMessages(args: GetBackfillMessagesArgs): Promise<MessageEvent[]> {
    if (!this._source) throw new Error("Not initialized");
    this._prefetchAnchor = args.time;
    this._scheduleTimePrefixPrefetch();
    return await this._source.getBackfillMessages(args);
  }

  async getAdjacentMessage(args: GetAdjacentMessageArgs): Promise<MessageEvent | null> {
    if (!this._source) throw new Error("Not initialized");
    return (await this._source.getAdjacentMessage?.(args)) ?? null;
  }

  preparePlaybackBuffer(args: PreparePlaybackBufferArgs): Promise<PlaybackBufferStatus> {
    if (!this._cachedReadable) {
      return Promise.resolve({ ready: true });
    }

    this._prefetchAnchor = args.time;
    return Promise.resolve(this._scheduleTimePrefixPrefetch(args.time, args.minAheadMs));
  }

  async getLoadProgress(): Promise<LoadProgress> {
    if (this._cachedReadable) {
      const bufferStatus = this._scheduleTimePrefixPrefetch(this._prefetchAnchor, DEFAULT_PREFETCH_AHEAD_MS);
      const downloadedByteRanges = this._cachedReadable.getDownloadedRanges();
      const loadedBytes = downloadedByteRanges.reduce((sum, range) => sum + (range.end - range.start), 0);
      const totalBytes = this._totalBytes || (await this._cachedReadable.size());
      const percent = totalBytes > 0 ? Math.min(100, (loadedBytes / totalBytes) * 100) : 0;
      const coveredChunkRanges = getPlayableTimeRanges(
        this._chunkCoverage,
        downloadedByteRanges,
        MAX_CONTIGUOUS_CHUNK_GAP_NS,
      );
      const parsedMessageRanges = compactTimeRanges(
        coveredChunkRanges,
        inferProgressTimeRangeCompaction(
          coveredChunkRanges,
          this._initialization == undefined
            ? undefined
            : { start: this._initialization.start, end: this._initialization.end },
        ),
      );
      return {
        downloadedByteRanges,
        totalBytes,
        percent,
        parsedMessageRanges,
        bufferedAheadMs: bufferStatus.bufferedAheadMs,
      };
    }
    const totalBytes = this._totalBytes;
    if (totalBytes <= 0) {
      return { downloadedByteRanges: [], totalBytes: 0, percent: 0, parsedMessageRanges: [] };
    }
    return {
      downloadedByteRanges: [{ start: 0, end: totalBytes }],
      totalBytes,
      percent: 100,
      parsedMessageRanges:
        this._initialization == undefined
          ? []
          : [{ start: this._initialization.start, end: this._initialization.end }],
    };
  }

  getTransportDiagnostics(): Promise<TransportDiagnostics> {
    let droppedPayloads = 0;
    const ring = this._transportConfig.payloadRing;
    if (this._transportConfig.mode === "sab" && this._transportConfig.payloadRing) {
      droppedPayloads = new SharedPayloadRing(this._transportConfig.payloadRing).droppedPayloads();
    }
    return Promise.resolve({
      mode: this._transportConfig.mode,
      binaryPayloadThresholdBytes: this._transportConfig.binaryPayloadThresholdBytes,
      sharedPayloadRing: ring
        ? {
            slotCount: ring.slotCount,
            slotSizeBytes: ring.slotSizeBytes,
            totalBytes: ring.slotCount * ring.slotSizeBytes,
          }
        : undefined,
      droppedPayloads,
      stalePayloadRefs: 0,
    });
  }

  getDataQualityReport() {
    return Promise.resolve(this._qualityScan.getReport());
  }

  startDataQualityScan(): Promise<void> {
    return this._qualityScan.start();
  }

  private _scheduleTimePrefixPrefetch(
    anchor: TimeRange["start"] | undefined = this._prefetchAnchor,
    minAheadMs = DEFAULT_PREFETCH_AHEAD_MS,
  ): PlaybackBufferStatus {
    if (!this._cachedReadable || !anchor || this._chunkCoverage.length === 0) {
      return { ready: true };
    }

    const anchorNs = toNano(anchor);
    const plan = this._buildPlaybackBufferPlan(anchorNs, minAheadMs);
    if (!plan) {
      return { ready: true };
    }

    const downloadedByteRanges = this._cachedReadable.getDownloadedRanges();
    const ready = isByteRangeCovered(plan.byteRange, downloadedByteRanges);
    if (!ready) {
      this._cachedReadable.prefetch(plan.byteRange.start, plan.byteRange.end - plan.byteRange.start, {
        replace: true,
      });
    }
    return {
      ready,
      bufferedUntil: fromNano(plan.endNs),
      bufferedAheadMs: Math.max(0, Number(plan.endNs - anchorNs) / 1_000_000),
    };
  }

  private _buildPlaybackBufferPlan(
    anchorNs: bigint,
    minAheadMs: number,
  ): { byteRange: Range; endNs: bigint } | undefined {
    const targetNs = anchorNs + BigInt(Math.max(1, Math.round(minAheadMs))) * 1_000_000n;
    const horizonEndNs = anchorNs + MAX_PREFETCH_HORIZON_NS;
    const targetBytes = this._inferPrefetchTargetBytes();
    const firstIndex = this._chunkCoverage.findIndex((chunk) => chunk.endNs >= anchorNs);
    if (firstIndex < 0) {
      return undefined;
    }

    let byteStart: number | undefined;
    let byteEnd = 0;
    let contiguousEndNs = anchorNs;
    let includedEndNs = anchorNs;

    for (let index = firstIndex; index < this._chunkCoverage.length; index++) {
      const chunk = this._chunkCoverage[index];
      if (chunk.startNs > horizonEndNs) break;
      if (chunk.startNs > contiguousEndNs + MAX_CONTIGUOUS_CHUNK_GAP_NS) break;

      byteStart = byteStart == undefined ? chunk.byteRange.start : Math.min(byteStart, chunk.byteRange.start);
      byteEnd = Math.max(byteEnd, chunk.byteRange.end);
      if (chunk.endNs > contiguousEndNs) {
        contiguousEndNs = chunk.endNs;
      }
      if (chunk.endNs > includedEndNs) {
        includedEndNs = chunk.endNs;
      }

      const byteLength = byteEnd - byteStart;
      if (includedEndNs >= targetNs || byteLength >= targetBytes) {
        break;
      }
    }

    if (byteStart == undefined || byteEnd <= byteStart) {
      return undefined;
    }
    return { byteRange: { start: byteStart, end: byteEnd }, endNs: includedEndNs };
  }

  private _inferPrefetchTargetBytes(): number {
    const cacheBytes = this._remoteCacheBytes > 0 ? this._remoteCacheBytes : 512 * MIB;
    const target = Math.floor(cacheBytes * PREFETCH_CACHE_FRACTION);
    return Math.max(MIN_PREFETCH_BYTES, Math.min(MAX_PREFETCH_BYTES, target));
  }
}

Comlink.expose(new McapWorkerImpl());

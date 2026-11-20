import * as Comlink from "comlink";
import { withBackfillCallback } from './backfillCallback';
import { BlobReadable } from "@mcap/browser";
import { McapIndexedReader } from "@mcap/core";
import type { IReadable } from "@mcap/core";
import type { Initialization, MessageEvent, Time, TimeRange } from '@/core/types/ros';
import type {
  BackfillTopicCallback,
  IWorkerSerializedSourceWorker,
  MessageIteratorArgs,
  GetBackfillMessagesArgs,
  GetAdjacentMessageArgs,
  ReadBoundariesArgs,
  IMessageCursor,
  PlaybackBufferStatus,
  PreparePlaybackBufferArgs,
  SourceInitProgressCallback,
} from "./types";
import type { IIterableSource } from '@/infra/sources/IIterableSource';
import { McapIndexedIterableSource } from '@/infra/sources/McapIndexedIterableSource';
import { McapUnindexedIterableSource } from '@/infra/sources/McapUnindexedIterableSource';
import { createIndexedDbMcapIndexCache } from '@/infra/sources/mcapIndexCache';
import { withBuiltinTopicAdapters } from '@/infra/sources/adapters';
import { loadDecompressHandlers } from '@/infra/sources/decompressHandlers';
import { MessageCursor } from "./MessageCursor";
import { RemoteRangeFile, isMessagePort } from '@/infra/range/rangeHandle';
import type { LoadProgress } from "./types";
import type { TransportDiagnostics, WorkerTransportConfig } from "./transport";
import { SharedPayloadRing } from "./sharedPayloadRing";
import { resolveRemoteCacheBytes } from './remoteCacheConfig';
import { fromNano, toNano } from '@/shared/utils/time';
import { compactTimeRanges, inferProgressTimeRangeCompaction } from '@/shared/utils/timeRanges';
import { workerPerf } from './workerPerf';
import { DataQualityScanController } from './dataQualityScanController';
import { trackInitProgress } from './throttledInitProgress';
import {
  getPlayableTimeRanges,
  isByteRangeCovered,
  type ChunkCoverage,
} from './playableTimeRanges';
import { planPlaybackBuffer, type PlaybackBufferPlan } from './playbackBufferPlan';

type IndexedChunkCoverage = ChunkCoverage;

const MIB = 1024 * 1024;
const PREFETCH_CACHE_FRACTION = 0.75;
const MIN_PREFETCH_BYTES = 64 * MIB;
const MAX_PREFETCH_BYTES = 768 * MIB;
const MAX_PREFETCH_HORIZON_NS = 15_000_000_000n;
const MAX_CONTIGUOUS_CHUNK_GAP_NS = 750_000_000n;
const DEFAULT_PREFETCH_AHEAD_MS = 5_000;
const PLAYBACK_CURSOR_BUFFER_AHEAD_MS = 1_500;

export class McapWorkerImpl implements IWorkerSerializedSourceWorker {
  private _source?: IIterableSource;
  private _cachedReadable?: RemoteRangeFile;
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
    console.debug("McapWorker: initialize starting", Object.keys(args));
    const report = trackInitProgress(onProgress);
    try {
      let rawReadable: IReadable;
      const url = typeof args.url === 'string' ? args.url : undefined;
      const file = args.file instanceof Blob ? args.file : undefined;
      report({ phase: "connecting", loadedBytes: 0, totalBytes: 0 });
      let indexing = false;
      const rangePort = args.rangePort;
      if (isMessagePort(rangePort)) {
        const remoteFile = new RemoteRangeFile(rangePort);
        this._remoteCacheBytes = typeof args.rangeCacheBytes === 'number' ? args.rangeCacheBytes : resolveRemoteCacheBytes();
        await remoteFile.setProgressListener((info) => {
          // While indexing an unindexed file the scan reports its own (whole-file) progress.
          if (indexing) return;
          report({
            phase: "downloading",
            loadedBytes: info.loadedBytes,
            totalBytes: info.totalBytes,
            transferredBytes: info.transferredBytes,
          });
        });
        this._cachedReadable = remoteFile;
        rawReadable = {
          size: async () => BigInt(await remoteFile.size()),
          read: async (offset: bigint, length: bigint) =>
            await remoteFile.read(Number(offset), Number(length)),
        };
      } else if (url) {
        throw new Error("McapWorker: a remote recording needs a range handle (rangePort)");
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

      let reader: McapIndexedReader | undefined;
      let baseSource: IIterableSource;
      try {
        reader = await workerPerf.timeAsync(
          "initialize.McapIndexedReader",
          () => McapIndexedReader.Initialize({
            readable: mcapReadable,
            decompressHandlers,
          }),
        );
        baseSource = new McapIndexedIterableSource(reader);
      } catch (indexedErr) {
        // No summary / chunk index (streamed or truncated recording): index the data section ourselves.
        console.info("McapWorker: indexed read failed, scanning unindexed MCAP", indexedErr);
        indexing = true;
        // A remote recording's scan result lives in main-thread memory only (page lifetime);
        // IndexedDB persistence is kept for local files in the standalone app.
        const indexCache = this._cachedReadable
          ? this._cachedReadable.indexCache()
          : args.persistIndex === false
            ? undefined
            : createIndexedDbMcapIndexCache();
        const cacheKey = this._cachedReadable
          ? `${await this._cachedReadable.size()}`
          : file instanceof File
            ? `file:${file.name}:${file.size}:${file.lastModified}`
            : undefined;
        baseSource = new McapUnindexedIterableSource(mcapReadable, {
          decompressHandlers,
          indexCache: indexCache && cacheKey ? { cache: indexCache, key: cacheKey } : undefined,
          onProgress: ({ scannedBytes, totalBytes }) =>
            report({ phase: "indexing", loadedBytes: scannedBytes, totalBytes }),
        });
      }
      report({ phase: "opening" });
      const source = withBuiltinTopicAdapters(baseSource);
      this._source = source;
      const init = await workerPerf.timeAsync(
        "initialize.source",
        () => source.initialize(),
      );
      indexing = false;
      this._initialization = init;
      this._qualityScan.initialize(this._source, init, args.autoDataQualityScan === true);
      this._chunkCoverage = workerPerf.time("initialize.chunkCoverage", () => {
        if (!reader) return [];
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
        // No read-ahead yet: a paused viewer reads only what its frame needs (backfill demand
        // reads). Read-ahead starts with playback (`preparePlaybackBuffer`, the playback cursor).
        this._prefetchAnchor = init.start;
      }
      workerPerf.flushMaybe(true);
      return this._cachedReadable ? { ...init, remoteRangeBacked: true } : init;
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
    if (args.endTime == undefined) {
      // The playback cursor (open-ended). Range scans for panels pass an end time and never
      // move the playback read-ahead.
      this._prefetchAnchor = args.startTime;
      this._scheduleTimePrefixPrefetch();
    }
    const iterator = this._source.messageIterator(args);
    const cursorOptions = {
      ...this._transportConfig,
      latestOnlyTopics: args.latestOnlyTopics,
      ...(args.endTime == undefined ? { maxBufferDurationMs: PLAYBACK_CURSOR_BUFFER_AHEAD_MS } : {}),
    };
    return Promise.resolve(Comlink.proxy(new MessageCursor(iterator, cursorOptions)));
  }

  async getBackfillMessages(args: GetBackfillMessagesArgs, onTopic?: BackfillTopicCallback): Promise<MessageEvent[]> {
    if (!this._source) throw new Error("Not initialized");
    // Backfill serves a frame at `time` (paused, seek, step): it reads what that frame needs, on
    // demand, and starts no read-ahead.
    this._prefetchAnchor = args.time;
    const source = this._source;
    return await withBackfillCallback(onTopic, (callback) => source.getBackfillMessages(args, callback));
  }

  async getAdjacentMessage(args: GetAdjacentMessageArgs): Promise<MessageEvent | null> {
    if (!this._source) throw new Error("Not initialized");
    return (await this._source.getAdjacentMessage?.(args)) ?? null;
  }

  async getReadBoundaries(args: ReadBoundariesArgs): Promise<Time[] | undefined> {
    if (!this._source) throw new Error("Not initialized");
    return await this._source.getReadBoundaries?.(args);
  }

  async preparePlaybackBuffer(args: PreparePlaybackBufferArgs): Promise<PlaybackBufferStatus> {
    if (!this._cachedReadable) {
      return { ready: true };
    }

    this._prefetchAnchor = args.time;
    await this._cachedReadable.refreshRanges(true);
    return this._scheduleTimePrefixPrefetch(args.time, args.minAheadMs);
  }

  async getLoadProgress(): Promise<LoadProgress> {
    if (this._cachedReadable) {
      await this._cachedReadable.refreshRanges(true);
      const bufferStatus = this._playbackBufferStatus(this._prefetchAnchor, DEFAULT_PREFETCH_AHEAD_MS);
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

  private _playbackBufferStatus(
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
    const ready = plan.byteRanges.every((range) => isByteRangeCovered(range, downloadedByteRanges));
    return {
      ready,
      bufferedUntil: fromNano(plan.endNs),
      bufferedAheadMs: Math.max(0, Number(plan.endNs - anchorNs) / 1_000_000),
    };
  }

  private _scheduleTimePrefixPrefetch(
    anchor: TimeRange["start"] | undefined = this._prefetchAnchor,
    minAheadMs = DEFAULT_PREFETCH_AHEAD_MS,
  ): PlaybackBufferStatus {
    const status = this._playbackBufferStatus(anchor, minAheadMs);
    if (!this._cachedReadable || !anchor || status.ready) {
      return status;
    }

    const anchorNs = toNano(anchor);
    const plan = this._buildPlaybackBufferPlan(anchorNs, minAheadMs);
    if (!plan) {
      return status;
    }
    this._cachedReadable.prefetch(plan.byteRanges, { replace: true });
    return status;
  }

  private _buildPlaybackBufferPlan(anchorNs: bigint, minAheadMs: number): PlaybackBufferPlan | undefined {
    return planPlaybackBuffer(this._chunkCoverage, anchorNs, minAheadMs, {
      targetBytes: this._inferPrefetchTargetBytes(),
      horizonNs: MAX_PREFETCH_HORIZON_NS,
    });
  }

  private _inferPrefetchTargetBytes(): number {
    const cacheBytes = this._remoteCacheBytes > 0 ? this._remoteCacheBytes : 512 * MIB;
    const target = Math.floor(cacheBytes * PREFETCH_CACHE_FRACTION);
    return Math.max(MIN_PREFETCH_BYTES, Math.min(MAX_PREFETCH_BYTES, target));
  }
}

Comlink.expose(new McapWorkerImpl());

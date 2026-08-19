import * as Comlink from "comlink";
import type { Initialization, MessageEvent } from '@/core/types/ros';
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
import { BagIterableSource } from '@/infra/sources/BagIterableSource';
import { MessageCursor } from "./MessageCursor";
import { HttpFileReader } from '@/infra/services/HttpFileReader';
import CachedFilelike from '@/infra/services/CachedFilelike';
import { resolveWorkerHttpUrl } from '@/shared/utils/resolveWorkerHttpUrl';
import type { LoadProgress } from "./types";
import type { TransportDiagnostics, WorkerTransportConfig } from "./transport";
import { SharedPayloadRing } from "./sharedPayloadRing";
import { resolveRemoteCacheBytes } from './remoteCacheConfig';
import { DataQualityScanController } from './dataQualityScanController';
import { trackInitProgress } from './throttledInitProgress';
import { buildRemoteBagReadable, type SyncSizeBagReadable } from './remoteBagReadable';

class BagWorker implements IWorkerSerializedSourceWorker {
  private _source?: BagIterableSource;
  private _cachedReadable?: CachedFilelike;
  private _initialization?: Initialization;
  private _totalBytes = 0;
  private _transportConfig: WorkerTransportConfig = {
    mode: "comlink",
    binaryPayloadThresholdBytes: 64 * 1024,
  };
  private _qualityScan = new DataQualityScanController();

  async initialize(
    args: Record<string, unknown>,
    onProgress?: SourceInitProgressCallback,
  ): Promise<Initialization> {
    const report = trackInitProgress(onProgress);
    report({ phase: "connecting", loadedBytes: 0, totalBytes: 0 });
    const url = typeof args.url === 'string' ? args.url : undefined;
    const file = args.file instanceof Blob ? args.file : undefined;
    let sourceArgs:
      | { type: 'remote'; readable: SyncSizeBagReadable }
      | { type: 'file'; file: Blob };
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
      const readable = new CachedFilelike({
        fileReader,
        cacheSizeInBytes: resolveRemoteCacheBytes(),
        onDownloadProgress: (info) => {
          report({
            phase: "downloading",
            loadedBytes: info.loadedBytes,
            totalBytes: info.totalBytes,
            transferredBytes: info.transferredBytes,
          });
        },
      });
      this._cachedReadable = readable;
      const bagReadable = await buildRemoteBagReadable(readable);
      sourceArgs = { type: "remote", readable: bagReadable };
    } else if (file) {
      this._cachedReadable = undefined;
      this._totalBytes = file.size;
      sourceArgs = { type: "file", file };
    } else {
      throw new Error("Invalid arguments for BagWorker");
    }

    const zstdWasmBinary = args.zstdWasmBinary;
    if (!(zstdWasmBinary instanceof ArrayBuffer)) {
      throw new Error(
        "BagWorker: zstdWasmBinary required (pass wasm bytes from main thread for inline workers)",
      );
    }

    report({ phase: "opening" });
    this._source = new BagIterableSource(sourceArgs, { wasmBinary: zstdWasmBinary });
    const init = await this._source.initialize();
    this._initialization = init;
    this._qualityScan.initialize(this._source, init, args.autoDataQualityScan === true);
    if (this._cachedReadable) {
      this._totalBytes = await this._cachedReadable.size();
    }
    return init;
  }

  getMessageCursor(args: MessageIteratorArgs): Promise<IMessageCursor<unknown>> {
    if (!this._source) throw new Error("Not initialized");

    const iterator = this._source.messageIterator(args);
    return Promise.resolve(Comlink.proxy(new MessageCursor(iterator, {
      ...this._transportConfig,
      latestOnlyTopics: args.latestOnlyTopics,
    })));
  }

  async getBackfillMessages(args: GetBackfillMessagesArgs): Promise<MessageEvent[]> {
    if (!this._source) throw new Error("Not initialized");
    return await this._source.getBackfillMessages(args);
  }

  async getAdjacentMessage(args: GetAdjacentMessageArgs): Promise<MessageEvent | null> {
    if (!this._source) throw new Error("Not initialized");
    return (await this._source.getAdjacentMessage?.(args)) ?? null;
  }

  preparePlaybackBuffer(_args: PreparePlaybackBufferArgs): Promise<PlaybackBufferStatus> {
    return Promise.resolve({ ready: true });
  }

  async getLoadProgress(): Promise<LoadProgress> {
    if (this._cachedReadable) {
      const downloadedByteRanges = this._cachedReadable.getDownloadedRanges();
      const loadedBytes = downloadedByteRanges.reduce((sum, range) => sum + (range.end - range.start), 0);
      const totalBytes = this._totalBytes || (await this._cachedReadable.size());
      const percent = totalBytes > 0 ? Math.min(100, (loadedBytes / totalBytes) * 100) : 0;
      return {
        downloadedByteRanges,
        totalBytes,
        percent,
        parsedMessageRanges:
          percent >= 100 && this._initialization != undefined
            ? [{ start: this._initialization.start, end: this._initialization.end }]
            : [],
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

  configureTransport(config: WorkerTransportConfig): Promise<void> {
    this._transportConfig = config;
    return Promise.resolve();
  }

  startDataQualityScan(): Promise<void> {
    return this._qualityScan.start();
  }

  getDataQualityReport() {
    return Promise.resolve(this._qualityScan.getReport());
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
}

Comlink.expose(new BagWorker());

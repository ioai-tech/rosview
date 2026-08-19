import * as Comlink from "comlink";
import type { Initialization } from "@/core/types/ros";
import type {
  GetAdjacentMessageArgs,
  GetBackfillMessagesArgs,
  IMessageCursor,
  IWorkerSerializedSourceWorker,
  LoadProgress,
  MessageIteratorArgs,
  PlaybackBufferStatus,
  PreparePlaybackBufferArgs,
  SourceInitProgressCallback,
} from "./types";
import type { TransportDiagnostics, WorkerTransportConfig } from "./transport";
import { SharedPayloadRing } from "./sharedPayloadRing";
import { MessageCursor } from "./MessageCursor";
import { BvhIterableSource } from "@/infra/sources/bvh/BvhIterableSource";
import { resolveWorkerHttpUrl } from "@/shared/utils/resolveWorkerHttpUrl";
import { DataQualityScanController } from './dataQualityScanController';

class BvhWorkerImpl implements IWorkerSerializedSourceWorker {
  private _source?: BvhIterableSource;
  private _initialization?: Initialization;
  private _transportConfig: WorkerTransportConfig = {
    mode: "comlink",
    binaryPayloadThresholdBytes: 64 * 1024,
  };
  private _totalBytes = 0;
  private _qualityScan = new DataQualityScanController();

  async initialize(
    args: { url?: string; file?: Blob; autoDataQualityScan?: boolean },
    onProgress?: SourceInitProgressCallback,
  ): Promise<Initialization> {
    onProgress?.({ phase: "connecting", loadedBytes: 0, totalBytes: 0 });
    let text: string;
    if (args.file) {
      this._totalBytes = args.file.size;
      text = await args.file.text();
    } else if (args.url) {
      const response = await fetch(resolveWorkerHttpUrl(args.url));
      if (!response.ok) {
        throw new Error(`Failed to fetch BVH: HTTP ${response.status}`);
      }
      text = await response.text();
      this._totalBytes = text.length;
    } else {
      throw new Error("BvhWorker: neither url nor file provided");
    }

    onProgress?.({
      phase: "opening",
      loadedBytes: this._totalBytes,
      totalBytes: this._totalBytes,
      transferredBytes: this._totalBytes,
    });
    this._source = new BvhIterableSource(text, "bvh");
    const init = await this._source.initialize();
    this._initialization = init;
    this._qualityScan.initialize(this._source, init, args.autoDataQualityScan === true);
    return init;
  }

  configureTransport(config: WorkerTransportConfig): Promise<void> {
    this._transportConfig = config;
    return Promise.resolve();
  }

  getMessageCursor(args: MessageIteratorArgs): Promise<IMessageCursor<unknown>> {
    if (!this._source) throw new Error("BvhWorker: not initialized");
    const iterator = this._source.messageIterator(args);
    return Promise.resolve(
      Comlink.proxy(
        new MessageCursor(iterator, {
          ...this._transportConfig,
          latestOnlyTopics: args.latestOnlyTopics,
        }),
      ),
    );
  }

  async getBackfillMessages(args: GetBackfillMessagesArgs) {
    if (!this._source) throw new Error("BvhWorker: not initialized");
    return await this._source.getBackfillMessages(args);
  }

  async getAdjacentMessage(args: GetAdjacentMessageArgs) {
    if (!this._source) throw new Error("BvhWorker: not initialized");
    return (await this._source.getAdjacentMessage?.(args)) ?? null;
  }

  preparePlaybackBuffer(_args: PreparePlaybackBufferArgs): Promise<PlaybackBufferStatus> {
    return Promise.resolve({ ready: true });
  }

  getLoadProgress(): Promise<LoadProgress> {
    const total = this._totalBytes;
    if (total <= 0) {
      return Promise.resolve({
        downloadedByteRanges: [],
        totalBytes: 0,
        percent: 100,
        parsedMessageRanges: [],
      });
    }
    return Promise.resolve({
      downloadedByteRanges: [{ start: 0, end: total }],
      totalBytes: total,
      percent: 100,
      parsedMessageRanges:
        this._initialization == undefined
          ? []
          : [{ start: this._initialization.start, end: this._initialization.end }],
    });
  }

  getDataQualityReport() {
    return Promise.resolve(this._qualityScan.getReport());
  }

  startDataQualityScan(): Promise<void> {
    return this._qualityScan.start();
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

Comlink.expose(new BvhWorkerImpl());

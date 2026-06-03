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
} from "./types";
import { RosDb3IterableSource } from '@/infra/sources/RosDb3IterableSource';
import { MessageCursor } from "./MessageCursor";
import type { LoadProgress } from "./types";
import type { TransportDiagnostics, WorkerTransportConfig } from "./transport";
import { SharedPayloadRing } from "./sharedPayloadRing";
import { DataQualityScanController } from './dataQualityScanController';
import { resolveWorkerHttpUrl } from '@/shared/utils/resolveWorkerHttpUrl';

class Db3Worker implements IWorkerSerializedSourceWorker {
  private _source?: RosDb3IterableSource;
  private _initialization?: Initialization;
  private _totalBytes = 0;
  private _downloadedBytes = 0;
  private _loaded = false;
  private _transportConfig: WorkerTransportConfig = {
    mode: "comlink",
    binaryPayloadThresholdBytes: 64 * 1024,
  };
  private _qualityScan = new DataQualityScanController();

  async initialize(args: Record<string, unknown>): Promise<Initialization> {
    const sqlWasmBinary = args.sqlWasmBinary instanceof ArrayBuffer ? args.sqlWasmBinary : undefined;

    const rawFiles = args.files;
    const file = args.file;
    const files: File[] = Array.isArray(rawFiles)
      ? (rawFiles as unknown[]).filter((f): f is File => f instanceof File)
      : file instanceof File
        ? [file]
        : [];

    if (files.length > 0) {
      // Local file(s): SQLite needs the whole database, so we read directly.
      this._source = new RosDb3IterableSource({ type: "files", files }, { sqlWasmBinary });
      this._totalBytes = files.reduce((sum, f) => sum + f.size, 0);
      this._downloadedBytes = this._totalBytes;
    } else if (typeof args.url === "string" && args.url.length > 0) {
      // Remote URL: db3/SQLite cannot be range-streamed (random access over the
      // whole database), so download the file in full, then open it in memory.
      const knownTotal =
        typeof args.knownTotalBytes === "number" && Number.isFinite(args.knownTotalBytes)
          ? Math.floor(args.knownTotalBytes)
          : 0;
      const data = await this._downloadToBytes(resolveWorkerHttpUrl(args.url), knownTotal);
      this._source = new RosDb3IterableSource({ type: "data", datas: [data] }, { sqlWasmBinary });
      this._totalBytes = data.byteLength;
      this._downloadedBytes = data.byteLength;
    } else {
      throw new Error("Invalid arguments for Db3Worker: provide url or files");
    }

    const init = await this._source.initialize();
    this._initialization = init;
    this._loaded = true;
    this._qualityScan.initialize(this._source, init, args.autoDataQualityScan === true);
    return init;
  }

  private async _downloadToBytes(url: string, knownTotal: number): Promise<Uint8Array> {
    const resp = await fetch(url);
    if (!resp.ok) {
      throw new Error(`Db3Worker: failed to download db3 (${resp.status} ${resp.statusText})`);
    }

    const headerLen = Number(resp.headers.get("content-length") ?? "");
    this._totalBytes = Number.isFinite(headerLen) && headerLen > 0 ? headerLen : knownTotal;
    this._downloadedBytes = 0;

    // Some responses (e.g. opaque/cross-origin without CL) lack a readable
    // stream; fall back to arrayBuffer() in that case.
    if (!resp.body) {
      const buf = new Uint8Array(await resp.arrayBuffer());
      this._totalBytes = buf.byteLength;
      this._downloadedBytes = buf.byteLength;
      return buf;
    }

    const reader = resp.body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        received += value.byteLength;
        this._downloadedBytes = received;
      }
    }

    if (this._totalBytes <= 0) {
      this._totalBytes = received;
    }
    const out = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out;
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

  getLoadProgress(): Promise<LoadProgress> {
    const total = this._totalBytes;
    if (total <= 0) {
      return Promise.resolve({
        downloadedByteRanges: [],
        totalBytes: 0,
        percent: this._loaded ? 100 : 0,
        parsedMessageRanges: [],
      });
    }
    const downloaded = this._loaded ? total : Math.min(this._downloadedBytes, total);
    const percent = this._loaded ? 100 : Math.floor((downloaded / total) * 100);
    return Promise.resolve({
      downloadedByteRanges: downloaded > 0 ? [{ start: 0, end: downloaded }] : [],
      totalBytes: total,
      percent,
      parsedMessageRanges:
        this._initialization == undefined
          ? []
          : [{ start: this._initialization.start, end: this._initialization.end }],
    });
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

Comlink.expose(new Db3Worker());

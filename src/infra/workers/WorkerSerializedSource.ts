import * as Comlink from "comlink";
import type { DataQualityReport, Initialization, MessageEvent } from '@/core/types/ros';
import type {
  IWorkerSerializedSourceWorker,
  MessageIteratorArgs,
  GetBackfillMessagesArgs,
  GetAdjacentMessageArgs,
  IMessageCursor,
  LoadProgress,
  PlaybackBufferStatus,
  PreparePlaybackBufferArgs,
  SourceInitProgressCallback,
} from "./types";
import type { TransportDiagnostics } from "./transport";
import { isSharedPayloadRef } from "./transport";
import { SharedPayloadRing } from "./sharedPayloadRing";
import { createWorkerTransport } from "./transports/createWorkerTransport";
import { SabTransport } from "./transports/SabTransport";
import type { WorkerTransport } from "./transports/BaseWorkerTransport";
import type { ISourceHandle, ResolveHighFrequencyLaneOptions } from "./ISourceHandle";

export class WorkerSourceCancelledError extends Error {
  constructor() {
    super("Worker initialize cancelled");
    this.name = "WorkerSourceCancelledError";
  }
}

export function isWorkerSourceCancelledError(error: unknown): error is WorkerSourceCancelledError {
  return error instanceof WorkerSourceCancelledError;
}

function errorFromUnknown(error: unknown): Error {
  if (error instanceof Error) return error;
  if (typeof error === "string") return new Error(error);
  return new Error("Worker operation failed");
}

export class WorkerSerializedSource implements ISourceHandle {
  private _worker: Worker;
  private _remote: Comlink.Remote<IWorkerSerializedSourceWorker>;
  private _transport: WorkerTransport;
  private _transportConfigured = false;
  private _fallbackReason?: string;
  private _stalePayloadRefs = 0;
  private _ringReader?: SharedPayloadRing;
  private _workerFailure?: Error;
  private _pendingInitializeReject?: (error: Error) => void;

  constructor(worker: Worker) {
    this._worker = worker;
    this._remote = Comlink.wrap<IWorkerSerializedSourceWorker>(this._worker);
    this._transport = createWorkerTransport();
    this._fallbackReason = this._transport.fallbackReason();
    this._worker.addEventListener("error", (event) => {
      this._workerFailure = new Error(event.message || "Worker crashed while loading the recording");
    });
    this._worker.addEventListener("messageerror", () => {
      this._workerFailure = new Error("Worker failed to deserialize a message");
    });
    if (this._transport instanceof SabTransport) {
      this._ringReader = new SharedPayloadRing(this._transport.ringConfig());
    }
  }

  async initialize(
    args: Record<string, unknown>,
    onProgress?: SourceInitProgressCallback,
  ): Promise<Initialization> {
    console.debug("WorkerSerializedSource: calling initialize");
    try {
      // Ensure all objects passed to Comlink are plain objects
      const sanitizedArgs: Record<string, unknown> = {};
      for (const key in args) {
        if (Object.prototype.hasOwnProperty.call(args, key)) {
          const val = args[key];
          if (val instanceof Blob || val instanceof File || typeof val !== 'object' || val === null) {
            sanitizedArgs[key] = val;
          } else {
            // It's a proxy (like our readable), pass as is
            sanitizedArgs[key] = val;
          }
        }
      }
      
      if (!this._transportConfigured) {
        await this._transport.configure(this._remote);
        this._transportConfigured = true;
      }
      const result = await this._raceWorkerFailure(
        this._wrapAbortableInitialize(
          this._remote.initialize(
            sanitizedArgs,
            onProgress ? Comlink.proxy(onProgress) : undefined,
          ),
        ),
      );
      console.debug("WorkerSerializedSource: initialize result received");
      return result;
    } catch (e) {
      console.error("WorkerSerializedSource: initialize failed", e);
      throw e;
    }
  }

  private async _raceWorkerFailure<T>(operation: Promise<T>): Promise<T> {
    if (this._workerFailure) {
      throw this._workerFailure;
    }
    return await new Promise<T>((resolve, reject) => {
      const cleanup = () => {
        this._worker.removeEventListener("error", onError);
        this._worker.removeEventListener("messageerror", onMessageError);
      };
      const onError = (event: ErrorEvent) => {
        cleanup();
        reject(new Error(event.message || "Worker crashed while loading the recording"));
      };
      const onMessageError = () => {
        cleanup();
        reject(new Error("Worker failed to deserialize a message"));
      };
      this._worker.addEventListener("error", onError);
      this._worker.addEventListener("messageerror", onMessageError);
      operation.then(
        (value) => {
          cleanup();
          resolve(value);
        },
        (error: unknown) => {
          cleanup();
          reject(errorFromUnknown(error));
        },
      );
    });
  }

  private _wrapAbortableInitialize<T>(operation: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this._pendingInitializeReject = (error) => {
        reject(error);
      };
      operation.then(
        (value) => {
          this._clearPendingInitialize();
          resolve(value);
        },
        (error: unknown) => {
          this._clearPendingInitialize();
          reject(errorFromUnknown(error));
        },
      );
    });
  }

  private _clearPendingInitialize(): void {
    this._pendingInitializeReject = undefined;
  }

  private _abortPendingInitialize(error: Error): void {
    const reject = this._pendingInitializeReject;
    this._clearPendingInitialize();
    reject?.(error);
  }

  async getMessageCursor(args: MessageIteratorArgs): Promise<IMessageCursor<unknown>> {
    return await this._remote.getMessageCursor(args);
  }

  async getBackfillMessages(args: GetBackfillMessagesArgs): Promise<MessageEvent[]> {
    return await this._remote.getBackfillMessages(args);
  }

  async getAdjacentMessage(args: GetAdjacentMessageArgs): Promise<MessageEvent | null> {
    return await this._remote.getAdjacentMessage(args);
  }

  async preparePlaybackBuffer(args: PreparePlaybackBufferArgs): Promise<PlaybackBufferStatus> {
    return await this._remote.preparePlaybackBuffer(args);
  }

  async getLoadProgress(): Promise<LoadProgress> {
    return await this._remote.getLoadProgress();
  }

  async startDataQualityScan(): Promise<void> {
    return await this._remote.startDataQualityScan();
  }

  async getDataQualityReport(): Promise<DataQualityReport | undefined> {
    return await this._remote.getDataQualityReport();
  }

  resolveMessageBatch(messages: MessageEvent[]): MessageEvent[] {
    if (!this._ringReader) {
      return messages;
    }
    let resolvedBatch: MessageEvent[] | undefined;
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const resolvedPayload = this._resolveSharedPayloadData(msg, "copy");
      if (resolvedPayload === undefined) {
        continue;
      }
      if (!resolvedBatch) {
        resolvedBatch = messages.slice();
      }
      const messageRecord = msg.message as Record<string, unknown>;
      resolvedBatch[i] = {
        ...msg,
        message: {
          ...messageRecord,
          data: resolvedPayload,
        },
      };
    }
    return resolvedBatch ?? messages;
  }

  resolveMessageForHighFrequencyLane(
    message: MessageEvent,
    options: ResolveHighFrequencyLaneOptions = {},
  ): MessageEvent {
    const resolveMode = options.copyPayload ? "copy" : options.preferSharedView ? "view" : "copy";
    const resolvedPayload = this._resolveSharedPayloadData(
      message,
      resolveMode,
    );
    if (resolvedPayload !== undefined) {
      return this._withPayload(message, resolvedPayload);
    }
    if (options.copyPayload) {
      const copiedPayload = this._copyBinaryPayload(message);
      if (copiedPayload !== undefined) {
        return this._withPayload(message, copiedPayload);
      }
    }
    return message;
  }

  async getTransportDiagnostics(): Promise<TransportDiagnostics> {
    const diagnostics = await this._transport.diagnostics(this._remote);
    const ringConfig = this._transport instanceof SabTransport ? this._transport.ringConfig() : undefined;
    return {
      ...diagnostics,
      fallbackReason: diagnostics.fallbackReason ?? this._fallbackReason,
      crossOriginIsolated:
        typeof globalThis.crossOriginIsolated === "boolean"
          ? globalThis.crossOriginIsolated
          : diagnostics.crossOriginIsolated,
      sharedPayloadRing:
        diagnostics.sharedPayloadRing ??
        (ringConfig
          ? {
              slotCount: ringConfig.slotCount,
              slotSizeBytes: ringConfig.slotSizeBytes,
              totalBytes: ringConfig.slotCount * ringConfig.slotSizeBytes,
            }
          : undefined),
      stalePayloadRefs: diagnostics.stalePayloadRefs + this._stalePayloadRefs,
    };
  }

  getTransportMode(): "sab" | "transfer" | "comlink" {
    return this._transport.mode();
  }

  getTransportFallbackReason(): string | undefined {
    return this._fallbackReason;
  }

  terminate(): void {
    this._abortPendingInitialize(new WorkerSourceCancelledError());
    this._worker.terminate();
  }

  private _resolveSharedPayloadData(
    messageEvent: MessageEvent,
    mode: "copy" | "view",
  ): Uint8Array | undefined {
    if (!messageEvent.message || typeof messageEvent.message !== "object") {
      return undefined;
    }
    const messageRecord = messageEvent.message as Record<string, unknown>;
    if (!isSharedPayloadRef(messageRecord.data)) {
      return undefined;
    }
    const ref = messageRecord.data;
    const resolved = mode === "view" ? this._ringReader?.view(ref) : this._ringReader?.read(ref);
    if (!resolved) {
      this._stalePayloadRefs += 1;
      return undefined;
    }
    return resolved;
  }

  private _copyBinaryPayload(messageEvent: MessageEvent): Uint8Array | undefined {
    if (!messageEvent.message || typeof messageEvent.message !== "object") {
      return undefined;
    }
    const messageRecord = messageEvent.message as Record<string, unknown>;
    const data = messageRecord.data;
    if (!(data instanceof Uint8Array)) {
      return undefined;
    }
    const copy = new Uint8Array(data.byteLength);
    copy.set(data);
    return copy;
  }

  private _withPayload(messageEvent: MessageEvent, payload: Uint8Array): MessageEvent {
    const messageRecord = messageEvent.message as Record<string, unknown>;
    return {
      ...messageEvent,
      message: {
        ...messageRecord,
        data: payload,
      },
    };
  }
}

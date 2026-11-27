import type { Remote } from "comlink";
import { createSharedPayloadRingConfig } from "../sharedPayloadRing";
import type { IWorkerSerializedSourceWorker } from "../types";
import type { SharedPayloadRingConfig, TransportDiagnostics } from "../transport";
import type { WorkerTransport } from "./BaseWorkerTransport";

const DEFAULT_RING_BYTES = 384 * 1024 * 1024;
const DEFAULT_SLOT_BYTES = 16 * 1024 * 1024;
/**
 * Reserve the fixed 24-slot 16 MiB SAB ring for truly large payloads (raw
 * images, PointCloud2). Smaller binary payloads such as compressed H.264 IDR
 * frames (70-200 KiB) travel via zero-copy Transferable without risking ring
 * wraparound when multiple cameras emit keyframes or run bootstrap scans.
 */
const DEFAULT_SAB_THRESHOLD_BYTES = 512 * 1024;

export class SabTransport implements WorkerTransport {
  private readonly _ringConfig: SharedPayloadRingConfig;
  private readonly _thresholdBytes: number;

  constructor(
    thresholdBytes = DEFAULT_SAB_THRESHOLD_BYTES,
    totalRingBytes = DEFAULT_RING_BYTES,
    slotBytes = DEFAULT_SLOT_BYTES,
  ) {
    this._thresholdBytes = thresholdBytes;
    this._ringConfig = createSharedPayloadRingConfig(totalRingBytes, slotBytes);
  }

  async configure(remote: Remote<IWorkerSerializedSourceWorker>): Promise<void> {
    await remote.configureTransport({
      mode: "sab",
      binaryPayloadThresholdBytes: this._thresholdBytes,
      payloadRing: this._ringConfig,
    });
  }

  async diagnostics(remote: Remote<IWorkerSerializedSourceWorker>): Promise<TransportDiagnostics> {
    return await remote.getTransportDiagnostics();
  }

  mode(): "sab" {
    return "sab";
  }

  fallbackReason(): string | undefined {
    return undefined;
  }

  ringConfig(): SharedPayloadRingConfig {
    return this._ringConfig;
  }
}


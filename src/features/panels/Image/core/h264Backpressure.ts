export type H264PressureMode = 'normal' | 'degraded' | 'recovery';

export interface H264PressureState {
  mode: H264PressureMode;
  healthySamples: number;
}

export interface H264PressureObservation {
  queueFrames: number;
  queueSpanMs: number;
  decodeMs: number;
  decodeQueueSize: number;
  mediaLagMs: number;
}

/**
 * Hard pending-queue bounds. If the newest complete GOP still exceeds either
 * bound, the worker drops that backlog and waits for the next real IDR.
 */
export const H264_MAX_PENDING_FRAMES = 120;
export const H264_MAX_PENDING_SPAN_MS = 1_000;
export const H264_DECODE_QUEUE_HIGH_WATER = 4;
export const H264_RENDER_INTERVAL_MS = 1000 / 60;
export const H264_PRESSURED_RENDER_INTERVAL_MS = 1000 / 30;
export const H264_OUTPUT_DEADLINE_MS = 120;

const ENTER_DEGRADED = {
  frames: 72,
  spanMs: 350,
  decodeMs: 55,
  // A full bounded decode pipeline is healthy by itself. Only treat the
  // decoder queue as overload when it exceeds the configured feeder bound.
  decodeQueueSize: H264_DECODE_QUEUE_HIGH_WATER * 2,
  mediaLagMs: 350,
};
const ENTER_RECOVERY = {
  frames: 18,
  spanMs: 120,
  decodeMs: 32,
  decodeQueueSize: 1,
  mediaLagMs: 120,
};
const RELAPSE = {
  frames: 40,
  spanMs: 250,
  decodeMs: 45,
  decodeQueueSize: H264_DECODE_QUEUE_HIGH_WATER + 2,
  mediaLagMs: 250,
};
const RECOVERY_SAMPLES = 12;

export function initialH264PressureState(): H264PressureState {
  return { mode: 'normal', healthySamples: 0 };
}

export function isH264HardLimitExceeded(queueFrames: number, queueSpanMs: number): boolean {
  return queueFrames > H264_MAX_PENDING_FRAMES || queueSpanMs > H264_MAX_PENDING_SPAN_MS;
}

/**
 * Hysteretic pressure controller. Queue age is the primary signal while the
 * decode EWMA catches expensive streams before the bounded queue overflows.
 */
export function updateH264Pressure(
  state: H264PressureState,
  observation: H264PressureObservation,
): H264PressureState {
  const overloaded =
    observation.queueFrames >= ENTER_DEGRADED.frames ||
    observation.queueSpanMs >= ENTER_DEGRADED.spanMs ||
    observation.decodeMs >= ENTER_DEGRADED.decodeMs ||
    observation.decodeQueueSize >= ENTER_DEGRADED.decodeQueueSize ||
    observation.mediaLagMs >= ENTER_DEGRADED.mediaLagMs;
  const healthy =
    observation.queueFrames <= ENTER_RECOVERY.frames &&
    observation.queueSpanMs <= ENTER_RECOVERY.spanMs &&
    observation.decodeMs <= ENTER_RECOVERY.decodeMs &&
    observation.decodeQueueSize <= ENTER_RECOVERY.decodeQueueSize &&
    observation.mediaLagMs <= ENTER_RECOVERY.mediaLagMs;
  const relapsed =
    observation.queueFrames >= RELAPSE.frames ||
    observation.queueSpanMs >= RELAPSE.spanMs ||
    observation.decodeMs >= RELAPSE.decodeMs ||
    observation.decodeQueueSize >= RELAPSE.decodeQueueSize ||
    observation.mediaLagMs >= RELAPSE.mediaLagMs;

  if (state.mode === 'normal') {
    return overloaded ? { mode: 'degraded', healthySamples: 0 } : state;
  }
  if (state.mode === 'degraded') {
    return healthy ? { mode: 'recovery', healthySamples: 1 } : state;
  }
  if (relapsed) {
    return { mode: 'degraded', healthySamples: 0 };
  }
  if (!healthy) {
    return { mode: 'recovery', healthySamples: 0 };
  }
  const healthySamples = state.healthySamples + 1;
  return healthySamples >= RECOVERY_SAMPLES
    ? { mode: 'normal', healthySamples: 0 }
    : { mode: 'recovery', healthySamples };
}

export function updateDecodeDurationEwma(previousMs: number, sampleMs: number): number {
  if (!Number.isFinite(sampleMs) || sampleMs < 0) {
    return previousMs;
  }
  return previousMs === 0 ? sampleMs : previousMs * 0.8 + sampleMs * 0.2;
}

export function decodedFrameLatenessMs(playbackTimeNs: bigint | null, frameTimeNs: bigint): number {
  if (playbackTimeNs == null) {
    return 0;
  }
  return Math.max(0, Number(playbackTimeNs - frameTimeNs) / 1_000_000);
}

export function shouldDropDecodedH264Frame(
  playbackTimeNs: bigint | null,
  frameTimeNs: bigint,
  deadlineMs = H264_OUTPUT_DEADLINE_MS,
): boolean {
  return decodedFrameLatenessMs(playbackTimeNs, frameTimeNs) > deadlineMs;
}

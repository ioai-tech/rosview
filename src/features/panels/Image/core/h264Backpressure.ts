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
 * Hard pending-queue bounds. Both bounds describe roughly the same backlog for a
 * 30fps stream (120 frames ≈ 4s), so neither fires long before the other.
 */
export const H264_MAX_PENDING_FRAMES = 120;
export const H264_MAX_PENDING_SPAN_MS = 4_000;
export const H264_DECODE_QUEUE_HIGH_WATER = 4;
export const H264_RENDER_INTERVAL_MS = 1000 / 60;
export const H264_PRESSURED_RENDER_INTERVAL_MS = 1000 / 30;

/** Smallest inter-frame gap that can mark a broken reference chain. */
export const H264_MIN_DISCONTINUITY_GAP_MS = 400;
/** Multiple of the observed frame cadence that still counts as continuous. */
export const H264_DISCONTINUITY_CADENCE_FACTOR = 4;

const ENTER_DEGRADED = {
  frames: 72,
  spanMs: 350,
  decodeMs: 55,
  // A full bounded decode pipeline is healthy by itself. Only treat the
  // decoder queue as overload when it exceeds the configured feeder bound.
  decodeQueueSize: H264_DECODE_QUEUE_HIGH_WATER * 2,
  // Media lag also carries the pipeline's fixed transport latency, which on
  // multi-stream 720p recordings sits in the hundreds of milliseconds. Only
  // treat it as overload once it is far beyond any plausible transport cost.
  mediaLagMs: 1_500,
};
/**
 * Recovery deliberately omits `mediaLagMs`: it is dominated by constant
 * transport latency rather than by overload, so gating recovery on it pins the
 * panel in `degraded` for the whole session (halved render rate, DPR clamped
 * to 1) on any recording whose latency never drops below the bound.
 */
const ENTER_RECOVERY = {
  frames: 18,
  spanMs: 120,
  decodeMs: 32,
  decodeQueueSize: 1,
};
const RELAPSE = {
  frames: 40,
  spanMs: 250,
  decodeMs: 45,
  decodeQueueSize: H264_DECODE_QUEUE_HIGH_WATER + 2,
  mediaLagMs: 1_000,
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
    observation.decodeQueueSize <= ENTER_RECOVERY.decodeQueueSize;
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

/**
 * Newest-wins output policy.
 *
 * The delay between the playhead passing a frame and its `VideoFrame` arriving
 * (player tick, `postMessage`, decode queue, `VideoDecoder`) is a fixed property
 * of the pipeline and routinely reaches several hundred milliseconds when
 * several 720p streams decode at once. Lateness on its own therefore says
 * nothing about whether a frame is worth painting, and discarding late frames
 * against a wall-clock budget strands the canvas on whichever frame happened to
 * beat it — a permanently frozen image with no error.
 *
 * A decoded frame is disposable only when an equal-or-newer decoded frame is
 * already waiting to be painted in its place.
 */
export function isSupersededH264Output(
  candidateTimeNs: bigint,
  pendingTimeNs: bigint | null,
): boolean {
  return pendingTimeNs != null && pendingTimeNs >= candidateTimeNs;
}

/**
 * True when a gap between consecutive frames is too large to be the stream's
 * natural cadence, meaning the reference chain a delta frame depends on was
 * never decoded (forward seek, loop wrap, or a skipped backlog).
 *
 * Returns false while the cadence is still unknown (`frameIntervalMs <= 0`),
 * since a low-rate stream's normal spacing is indistinguishable from a jump
 * until at least one interval has been observed.
 */
export function isH264StreamDiscontinuity(
  gapMs: number,
  frameIntervalMs: number,
  minGapMs = H264_MIN_DISCONTINUITY_GAP_MS,
): boolean {
  if (!Number.isFinite(gapMs) || gapMs <= 0) {
    return false;
  }
  if (!Number.isFinite(frameIntervalMs) || frameIntervalMs <= 0) {
    return false;
  }
  return gapMs > Math.max(minGapMs, frameIntervalMs * H264_DISCONTINUITY_CADENCE_FACTOR);
}

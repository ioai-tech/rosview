/// <reference lib="webworker" />

import type { Time } from '@/core/types/ros';
import { decodeCompressedDepth } from './compressedDepthDecoder';
import { decodeRawImage } from './rawDecoders';
import {
  containsH264IdrNal,
  getH264ChunkType,
  getH264CodecCandidates,
  monotonicH264TimestampUs,
  parseH264SpsCodec,
  scanH264NalTypes,
} from './h264';
import {
  H264_DECODE_QUEUE_HIGH_WATER,
  H264_PRESSURED_RENDER_INTERVAL_MS,
  H264_RENDER_INTERVAL_MS,
  decodedFrameLatenessMs,
  initialH264PressureState,
  isH264HardLimitExceeded,
  isH264StreamDiscontinuity,
  isSupersededH264Output,
  updateDecodeDurationEwma,
  updateH264Pressure,
  type H264PressureState,
} from './h264Backpressure';
import {
  applyH264HardLimit,
  isH264ConfigOnly,
  selectLatestCompleteH264Gop,
  updateH264ConfigPackets,
} from './h264Queue';
import { withTimeout } from './asyncTimeout';
import {
  getCompressedKind,
  isCompressedDepthFormat,
  normalizeCompressedMime,
  type ImageSurfaceStatus,
} from './imageTypes';
import { discardStaleAsyncResult } from './asyncEpoch';
import type {
  ImageRenderOptions,
  ImageRenderMetrics,
  ImageRenderWorkerEvent,
  ImageRenderWorkerRequest,
  ImageViewport,
  ImageWorkerFrameEnvelope,
} from './imageWorkerProtocol';
import type { RawImageDecodeOptions } from './imageColorMode';
import { H264_SEEK_MAX_FRAMES } from './h264SeekRepair';

const DEFAULT_RENDER_OPTIONS: ImageRenderOptions = {
  backgroundColor: '#000000',
  flipHorizontal: false,
  flipVertical: false,
  rotationDeg: 0,
  smoothing: true,
  fitMode: 'contain',
};

function normalizeRotationDeg(deg: number): number {
  const d = ((deg % 360) + 360) % 360;
  return d;
}

/** Axis-aligned bounding size of a `sourceW × sourceH` rectangle rotated by `rotationDeg` (degrees). */
function rotatedAabbSize(sourceWidth: number, sourceHeight: number, rotationDeg: number): { w: number; h: number } {
  const rad = (normalizeRotationDeg(rotationDeg) * Math.PI) / 180;
  const absCos = Math.abs(Math.cos(rad));
  const absSin = Math.abs(Math.sin(rad));
  return {
    w: sourceWidth * absCos + sourceHeight * absSin,
    h: sourceWidth * absSin + sourceHeight * absCos,
  };
}

const DEFAULT_VIEWPORT: ImageViewport = {
  cssWidth: 0,
  cssHeight: 0,
  devicePixelRatio: 1,
};

const OUTPUT_TIMEOUT_MS = 5000;
const METRICS_INTERVAL_MS = 1000;
const H264_RESYNC_COOLDOWN_MS = 200;
/** Minimum spacing between bootstrap requests sent to the panel. */
const H264_BOOTSTRAP_REQUEST_COOLDOWN_MS = 1500;
/**
 * How long the worker waits for an in-band IDR before asking the panel to
 * bootstrap from the nearest preceding one. Streams with a single IDR, or with a
 * keyframe interval of several seconds, would otherwise stay blank indefinitely.
 */
const H264_IDR_WAIT_TIMEOUT_MS = 500;
/** How long a stalled H.264 panel stays silent before reporting the stall. */
const H264_STALL_REPORT_MS = 4000;

// ---------- H.264 decoder ----------

class WorkerH264Decoder {
  #decoder: VideoDecoder | null = null;
  #lastTimestampUs = -1;
  #configuredCodec: string | null = null;
  #streamCodec: string | null = null;
  #generation = 0;
  #submitted = new Map<number, {
    frame: ImageWorkerFrameEnvelope;
    startedAt: number;
    queueDepth: number;
    generation: number;
  }>();
  #callbacks: {
    output: (output: {
      videoFrame: VideoFrame;
      sourceFrame: ImageWorkerFrameEnvelope;
      decodeMs: number;
    }) => void;
    error: (error: Error) => void;
    dequeue: () => void;
  };

  public constructor(
    callbacks: {
      output: (output: {
        videoFrame: VideoFrame;
        sourceFrame: ImageWorkerFrameEnvelope;
        decodeMs: number;
      }) => void;
      error: (error: Error) => void;
      dequeue: () => void;
    },
  ) {
    this.#callbacks = callbacks;
  }

  public dispose(): void {
    this.reset();
    this.#lastTimestampUs = -1;
  }

  public reset(): void {
    this.#generation += 1;
    if (this.#decoder && this.#decoder.state !== 'closed') {
      this.#decoder.close();
    }
    this.#decoder = null;
    this.#configuredCodec = null;
    this.#streamCodec = null;
    this.#submitted.clear();
  }

  public get codec(): string | undefined {
    return this.#configuredCodec ?? undefined;
  }

  public get decodeQueueSize(): number {
    return this.#decoder?.state === 'configured' ? this.#decoder.decodeQueueSize : 0;
  }

  public async submitFrame(
    frame: ImageWorkerFrameEnvelope,
    data: Uint8Array<ArrayBuffer>,
    sortTimeKey: bigint,
  ): Promise<void> {
    if (typeof VideoDecoder === 'undefined') {
      throw new Error('WebCodecs VideoDecoder is not supported');
    }

    const generation = this.#generation;
    await this.#ensureDecoder(data);
    if (generation !== this.#generation) {
      return;
    }
    const decoder = this.#decoder!;
    const timestamp = this.#monotonicTimestampUs(sortTimeKey);
    const hasVcl = scanH264NalTypes(data).some((nalType) => nalType === 1 || nalType === 5);
    if (hasVcl) {
      this.#submitted.set(timestamp, {
        frame,
        startedAt: performance.now(),
        queueDepth: decoder.decodeQueueSize,
        generation,
      });
    }
    try {
      decoder.decode(
        new EncodedVideoChunk({
          type: getH264ChunkType(data),
          timestamp,
          data,
        }),
      );
    } catch (error) {
      this.#submitted.delete(timestamp);
      throw error;
    }
  }

  async #ensureDecoder(data: Uint8Array<ArrayBuffer>): Promise<void> {
    const parsedCodec = parseH264SpsCodec(data);
    if (
      parsedCodec &&
      parsedCodec !== this.#streamCodec &&
      this.#decoder &&
      this.#decoder.state !== 'closed'
    ) {
      this.reset();
    }
    if (this.#decoder && this.#decoder.state !== 'closed') {
      return;
    }

    let supportedConfig: VideoDecoderConfig | null = null;
    for (const codec of getH264CodecCandidates(data)) {
      const candidates: VideoDecoderConfig[] = [
        { codec, hardwareAcceleration: 'prefer-hardware', optimizeForLatency: true },
        { codec, hardwareAcceleration: 'no-preference', optimizeForLatency: true },
      ];
      for (const candidate of candidates) {
        try {
          const support = await VideoDecoder.isConfigSupported(candidate);
          if (support.supported) {
            supportedConfig = support.config ?? candidate;
            break;
          }
        } catch {
          // Some implementations throw for an unsupported acceleration mode.
        }
      }
      if (supportedConfig) {
        break;
      }
    }
    if (!supportedConfig) {
      const parsed = parseH264SpsCodec(data);
      throw new Error(`H.264 codec ${parsed ?? 'fallback candidates'} is not supported`);
    }

    this.#decoder = new VideoDecoder({
      output: (frame) => {
        const submitted = this.#submitted.get(frame.timestamp);
        this.#submitted.delete(frame.timestamp);
        if (!submitted || submitted.generation !== this.#generation) {
          frame.close();
          return;
        }
        this.#callbacks.output({
          videoFrame: frame,
          sourceFrame: submitted.frame,
          // Elapsed time also covers the wait behind frames already queued in
          // the decoder, so amortise it to approximate per-frame decode cost.
          // Without this the sample tracks pipeline latency and permanently
          // reports overload on healthy multi-stream playback.
          decodeMs: (performance.now() - submitted.startedAt) / (submitted.queueDepth + 1),
        });
      },
      error: (error) => {
        this.#callbacks.error(new Error(String(error)));
      },
    });
    this.#decoder.addEventListener('dequeue', this.#callbacks.dequeue);
    try {
      this.#decoder.configure(supportedConfig);
      this.#configuredCodec = supportedConfig.codec;
      this.#streamCodec = parsedCodec;
    } catch (error) {
      this.#decoder.close();
      this.#decoder = null;
      this.#configuredCodec = null;
      throw error;
    }
  }

  #monotonicTimestampUs(timeKey: bigint): number {
    const timestamp = monotonicH264TimestampUs(timeKey, this.#lastTimestampUs);
    this.#lastTimestampUs = timestamp;
    return timestamp;
  }
}

// ---------- Cached frame state ----------

/**
 * Cached state for the last successfully decoded frame.
 * - Raw frames retain the source pixel bytes so rawDecodeOptions changes
 *   can re-decode without a new incoming frame.
 * - Compressed / h264 frames retain an ImageBitmap so renderOptions /
 *   viewport changes can redraw without re-decoding.
 */
type CachedFrame =
  | {
      kind: 'raw';
      width: number;
      height: number;
      encoding: string;
      step: number;
      isBigEndian: boolean;
      data: Uint8Array<ArrayBuffer>;
      receiveTime: Time;
    }
  | {
      kind: 'bitmap';
      width: number;
      height: number;
      encoding: string;
      bitmap: ImageBitmap;
      receiveTime: Time;
    };

// ---------- Main runtime ----------

class ImageRenderWorkerRuntime {
  #canvas: OffscreenCanvas | null = null;
  #ctx: OffscreenCanvasRenderingContext2D | null = null;
  #bufferCanvas = new OffscreenCanvas(1, 1);
  #bufferCtx = this.#bufferCanvas.getContext('2d', { alpha: false });
  #renderOptions: ImageRenderOptions = { ...DEFAULT_RENDER_OPTIONS };
  #viewport: ImageViewport = { ...DEFAULT_VIEWPORT };
  #rawDecodeOptions: Partial<RawImageDecodeOptions> = {};
  #pendingFrame: ImageWorkerFrameEnvelope | null = null;
  #pendingH264Frames: ImageWorkerFrameEnvelope[] = [];
  #isProcessing = false;
  #decoder: WorkerH264Decoder;
  #pendingDecodedH264: {
    videoFrame: VideoFrame;
    sourceFrame: ImageWorkerFrameEnvelope;
  } | null = null;
  #h264RenderTimer: ReturnType<typeof setTimeout> | null = null;
  #lastPostedUiPhase: ImageSurfaceStatus['phase'] = 'idle';
  #haltUntilReset = false;
  /** Reused RGBA buffer for raw frames; resized as needed. */
  #rawRgba: Uint8ClampedArray<ArrayBuffer> | null = null;
  #rawImageData: ImageData | null = null;
  /** MIME keys already probed with ImageDecoder.isTypeSupported. */
  #imageDecoderMimeSupported = new Map<string, boolean>();
  /** The last decoded frame retained for instant-redraw on option changes. */
  #cachedFrame: CachedFrame | null = null;
  #h264Pressure: H264PressureState = initialH264PressureState();
  #h264DecodeMs = 0;
  #h264WaitingForIdr = false;
  #h264WaitingForIdrSince: number | null = null;
  #h264ConfigBeforeIdr: ImageWorkerFrameEnvelope[] = [];
  #h264RecentConfig: ImageWorkerFrameEnvelope[] = [];
  #h264NeedsResync = false;
  /**
   * Leading `#pendingH264Frames` entries that form an in-flight bootstrap GOP.
   * They are a dependency chain that cannot be shortened, so backpressure must
   * never discard them; doing so throws away the only decodable prefix and
   * leaves the panel waiting for a random-access point it already had.
   */
  #h264ProtectedQueueCount = 0;
  #h264LastEnqueuedTimeNs: bigint | null = null;
  #h264FrameIntervalMs = 0;
  #lastH264BootstrapRequestAt = -Infinity;
  /** Wall clock of the last visible H.264 progress, used by the stall watchdog. */
  #h264ProgressAt: number | null = null;
  #h264StallReported = false;
  #lastH264RenderAt = -Infinity;
  #lastH264BitmapAt = -Infinity;
  #droppedH264Frames = 0;
  #renderedH264Frames = 0;
  #h264ResyncCount = 0;
  #lastH264ResyncAt = -Infinity;
  #playbackTimeNs: bigint | null = null;
  #lastDecodedH264TimeNs: bigint | null = null;
  #isPlaying = false;
  #lastMetricsAt = -Infinity;
  #epoch = 0;

  public constructor() {
    if (!this.#bufferCtx) {
      throw new Error('Buffer canvas context is unavailable in worker');
    }
    this.#decoder = new WorkerH264Decoder({
      output: (output) => this.#handleH264Output(output),
      error: (error) => this.#handleH264DecoderError(error),
      dequeue: () => {
        this.#updateH264Pressure();
        void this.#drainLatestFrame();
      },
    });
  }

  public handle(message: ImageRenderWorkerRequest): void {
    switch (message.type) {
      case 'init':
        this.#canvas = message.canvas;
        this.#ctx = message.canvas.getContext('2d', {
          alpha: false,
          desynchronized: true,
        });
        if (!this.#ctx) {
          throw new Error('Canvas 2D context is unavailable in worker');
        }
        this.#applyViewport();
        this.#clearCanvas();
        this.#emitStatus({ phase: 'idle' });
        return;

      case 'viewport':
        this.#viewport = message.viewport;
        this.#applyViewport();
        this.#redrawCachedFrame();
        return;

      case 'renderOptions':
        this.#renderOptions = message.options;
        this.#redrawCachedFrame();
        return;

      case 'rawDecodeOptions':
        this.#rawDecodeOptions = message.options;
        // Re-decode and redraw immediately if we have a cached raw frame.
        this.#redrawRawCached();
        return;

      case 'playback':
        this.#playbackTimeNs = timeToKey(message.currentTime);
        this.#isPlaying = message.isPlaying;
        this.#updateH264Pressure();
        this.#trimPendingH264FramesIfNeeded();
        this.#reportH264StallIfDue();
        this.#emitMetricsIfDue();
        return;

      case 'frame':
        if (this.#haltUntilReset) {
          return;
        }
        this.#enqueueFrame(message.frame);
        if (!this.#isProcessing) {
          void this.#drainLatestFrame();
        }
        return;

      case 'bootstrapH264':
        this.#bootstrapH264(message.frames, message.preserveFrame === true);
        return;

      case 'reset':
        this.#epoch += 1;
        this.#pendingFrame = null;
        this.#pendingH264Frames = [];
        this.#h264ProtectedQueueCount = 0;
        this.#disposePendingH264Output();
        this.#haltUntilReset = false;
        this.#resetH264RuntimeState();
        this.#decoder.reset();
        this.#disposeAuxiliaryDecodeState();
        if (!message.preserveFrame) {
          this.#disposeCachedBitmap();
          this.#cachedFrame = null;
          this.#clearCanvas();
          this.#emitStatus({ phase: 'idle' });
        }
        return;

      case 'dispose':
        this.#epoch += 1;
        this.#pendingFrame = null;
        this.#pendingH264Frames = [];
        this.#h264ProtectedQueueCount = 0;
        this.#disposePendingH264Output();
        this.#haltUntilReset = false;
        this.#decoder.dispose();
        this.#disposeAuxiliaryDecodeState();
        this.#disposeCachedBitmap();
        this.#cachedFrame = null;
        self.close();
        return;
    }
  }

  #bootstrapH264(frames: ImageWorkerFrameEnvelope[], preserveFrame: boolean): void {
    this.#epoch += 1;
    this.#pendingFrame = null;
    this.#pendingH264Frames = [];
    this.#h264ProtectedQueueCount = 0;
    this.#disposePendingH264Output();
    this.#haltUntilReset = false;
    this.#resetH264RuntimeState();
    this.#decoder.reset();
    if (!preserveFrame) {
      this.#disposeCachedBitmap();
      this.#cachedFrame = null;
      this.#clearCanvas();
      this.#emitStatus({ phase: 'idle' });
    }

    const h264Frames = frames.filter(isH264Frame).slice(0, H264_SEEK_MAX_FRAMES);
    if (h264Frames.length === 0 || !h264Frames.some((frame) => containsH264IdrNal(frame.data))) {
      this.#beginWaitForH264Idr();
      this.#emitMetricsIfDue(true);
      return;
    }

    for (const frame of h264Frames) {
      this.#enqueueH264Frame(frame, { applyBackpressure: false });
    }
    this.#h264ProtectedQueueCount = this.#pendingH264Frames.length;

    this.#emitMetricsIfDue(true);
    if (!this.#isProcessing) {
      void this.#drainLatestFrame();
    }
  }

  #enqueueH264Frame(
    frame: ImageWorkerFrameEnvelope,
    options: { applyBackpressure?: boolean } = {},
  ): void {
    const live = options.applyBackpressure !== false;
    this.#h264RecentConfig = updateH264ConfigPackets(this.#h264RecentConfig, frame);
    if (live) {
      this.#trackH264Cadence(frame);
    }
    if (this.#h264WaitingForIdr && !containsH264IdrNal(frame.data)) {
      if (isH264ConfigOnly(frame.data)) {
        this.#h264ConfigBeforeIdr = updateH264ConfigPackets(
          this.#h264ConfigBeforeIdr,
          frame,
        );
        return;
      }
      this.#droppedH264Frames += 1;
      if (live) {
        this.#requestH264BootstrapIfIdrWaitStalled();
        this.#emitMetricsIfDue();
      }
      return;
    }
    if (containsH264IdrNal(frame.data)) {
      this.#clearWaitForH264Idr();
      if (this.#h264ConfigBeforeIdr.length > 0) {
        this.#pendingH264Frames.push(...this.#h264ConfigBeforeIdr);
        this.#h264ConfigBeforeIdr = [];
      }
    }
    this.#pendingH264Frames.push(frame);
    if (live) {
      this.#updateH264Pressure();
      this.#trimPendingH264FramesIfNeeded();
      this.#emitMetricsIfDue();
    }
  }

  /**
   * Track the stream's frame cadence and detect breaks in it. A delta frame that
   * follows a gap references pictures this decoder never saw (forward seek, loop
   * wrap, or a skipped backlog), so it must not be fed to the decoder.
   */
  #trackH264Cadence(frame: ImageWorkerFrameEnvelope): void {
    const frameTimeNs = timeToKey(frame.receiveTime);
    const previousNs = this.#h264LastEnqueuedTimeNs;
    this.#h264LastEnqueuedTimeNs = frameTimeNs;
    if (previousNs == null) {
      // Arm the stall watchdog from the first live frame.
      this.#h264ProgressAt ??= performance.now();
      return;
    }
    const gapMs = Number(frameTimeNs - previousNs) / 1_000_000;
    if (gapMs <= 0) {
      return;
    }
    if (
      !containsH264IdrNal(frame.data) &&
      isH264StreamDiscontinuity(gapMs, this.#h264FrameIntervalMs)
    ) {
      this.#droppedH264Frames += this.#pendingH264Frames.length;
      this.#pendingH264Frames = [];
      this.#h264ProtectedQueueCount = 0;
      this.#beginWaitForH264Idr();
      this.#resyncH264Decoder();
      this.#requestH264Bootstrap();
      // Leave the cadence estimate untouched so the jump does not become the
      // baseline for the next continuity check.
      return;
    }
    this.#h264FrameIntervalMs = updateDecodeDurationEwma(this.#h264FrameIntervalMs, gapMs);
  }

  #beginWaitForH264Idr(): void {
    this.#h264WaitingForIdr = true;
    this.#h264WaitingForIdrSince = performance.now();
    this.#h264ConfigBeforeIdr = [...this.#h264RecentConfig];
  }

  #clearWaitForH264Idr(): void {
    this.#h264WaitingForIdr = false;
    this.#h264WaitingForIdrSince = null;
  }

  /**
   * Ask the panel for a bootstrap batch starting at the nearest *preceding* IDR.
   * Waiting for the next in-band IDR is not a recovery: recordings exist whose
   * keyframe interval is several seconds, and others carry exactly one IDR for
   * the whole file, so the wait can never end.
   */
  #requestH264Bootstrap(): void {
    const now = performance.now();
    if (now - this.#lastH264BootstrapRequestAt < H264_BOOTSTRAP_REQUEST_COOLDOWN_MS) {
      return;
    }
    this.#lastH264BootstrapRequestAt = now;
    workerScope.postMessage({ type: 'needsBootstrap' } satisfies ImageRenderWorkerEvent);
  }

  #requestH264BootstrapIfIdrWaitStalled(): void {
    const since = this.#h264WaitingForIdrSince;
    if (since == null || performance.now() - since < H264_IDR_WAIT_TIMEOUT_MS) {
      return;
    }
    this.#requestH264Bootstrap();
  }

  /**
   * Surface a stall instead of leaving a silently frozen canvas: every H.264
   * discard path only moves a metrics counter, so without this the panel looks
   * like a still image with no explanation.
   */
  #reportH264StallIfDue(): void {
    const progressAt = this.#h264ProgressAt;
    if (progressAt == null || !this.#isPlaying) {
      return;
    }
    if (performance.now() - progressAt < H264_STALL_REPORT_MS) {
      return;
    }
    if (this.#h264StallReported) {
      return;
    }
    this.#h264StallReported = true;
    console.warn(
      `ImageRenderWorker: no H.264 frame rendered for ${H264_STALL_REPORT_MS}ms ` +
        `(dropped=${this.#droppedH264Frames}, queue=${this.#pendingH264Frames.length}, ` +
        `waitingForIdr=${this.#h264WaitingForIdr})`,
    );
    this.#emitStatus({ phase: 'stalled' });
    this.#requestH264Bootstrap();
  }

  #noteH264Progress(): void {
    this.#h264ProgressAt = performance.now();
    this.#h264StallReported = false;
  }

  #enqueueFrame(frame: ImageWorkerFrameEnvelope): void {
    if (!isH264Frame(frame)) {
      this.#pendingFrame = frame;
      return;
    }
    this.#enqueueH264Frame(frame);
  }

  #trimPendingH264FramesIfNeeded(): void {
    if (this.#h264ProtectedQueueCount > 0) {
      // An in-flight bootstrap GOP is still draining. Its frames are a
      // dependency chain, and a bootstrap batch legitimately exceeds the live
      // queue bounds, so trimming here would discard the decodable prefix that
      // was just fetched.
      return;
    }
    const queueSpanMs = h264QueueSpanMs(this.#pendingH264Frames);
    const hardLimitExceeded = isH264HardLimitExceeded(
      this.#pendingH264Frames.length,
      queueSpanMs,
    );
    const pressureTrim =
      this.#h264Pressure.mode === 'degraded' &&
      (this.#pendingH264Frames.length > 36 || queueSpanMs > 250);
    if (!hardLimitExceeded && !pressureTrim) {
      return;
    }

    const selection = selectLatestCompleteH264Gop(
      this.#pendingH264Frames,
      this.#h264RecentConfig,
    );
    const resyncAllowed =
      hardLimitExceeded ||
      performance.now() - this.#lastH264ResyncAt >= H264_RESYNC_COOLDOWN_MS;
    if (selection.resync && resyncAllowed) {
      this.#pendingH264Frames = selection.frames;
      this.#resyncH264Decoder();
      this.#droppedH264Frames += selection.droppedFrames;
    }

    if (
      isH264HardLimitExceeded(
        this.#pendingH264Frames.length,
        h264QueueSpanMs(this.#pendingH264Frames),
      )
    ) {
      this.#waitForNextH264Idr();
      return;
    }

    if (!selection.resync) {
      // No newer complete GOP exists. Preserve every dependent delta in the
      // current GOP while pressure is soft. The hard-limit branch above drops
      // the complete backlog rather than decoding a truncated dependency chain.
      return;
    }
  }

  #waitForNextH264Idr(): void {
    const plan = applyH264HardLimit(this.#pendingH264Frames, true);
    this.#droppedH264Frames += plan.droppedFrames;
    this.#pendingH264Frames = plan.frames;
    this.#h264ProtectedQueueCount = 0;
    this.#beginWaitForH264Idr();
    this.#resyncH264Decoder();
    this.#updateH264Pressure();
    this.#emitMetricsIfDue(true);
    this.#requestH264Bootstrap();
  }

  #takeNextFrame(): ImageWorkerFrameEnvelope | null {
    const h264Frame = this.#pendingH264Frames.shift();
    if (h264Frame) {
      if (this.#h264ProtectedQueueCount > 0) {
        this.#h264ProtectedQueueCount -= 1;
      }
      return h264Frame;
    }
    const frame = this.#pendingFrame;
    this.#pendingFrame = null;
    return frame;
  }

  async #drainLatestFrame(): Promise<void> {
    if (this.#isProcessing) {
      return;
    }
    this.#isProcessing = true;
    const epoch = this.#epoch;
    try {
      let frame: ImageWorkerFrameEnvelope | null;
      while (true) {
        if (
          this.#pendingH264Frames.length > 0 &&
          this.#decoder.decodeQueueSize >= H264_DECODE_QUEUE_HIGH_WATER
        ) {
          break;
        }
        frame = this.#takeNextFrame();
        if (!frame) {
          break;
        }
        if (epoch !== this.#epoch) {
          break;
        }
        if (isH264Frame(frame) && this.#h264NeedsResync) {
          this.#resyncH264Decoder();
          this.#h264NeedsResync = false;
        }
        await this.#decodeAndRender(frame, epoch);
        if (this.#haltUntilReset) {
          this.#pendingFrame = null;
          this.#pendingH264Frames = [];
          break;
        }
      }
    } finally {
      this.#isProcessing = false;
      if (
        this.#pendingFrame ||
        (this.#pendingH264Frames.length > 0 &&
          this.#decoder.decodeQueueSize < H264_DECODE_QUEUE_HIGH_WATER)
      ) {
        void this.#drainLatestFrame();
      }
    }
  }

  async #decodeAndRender(frame: ImageWorkerFrameEnvelope, epoch: number): Promise<void> {
    this.#emitStatus({ phase: 'decoding', receiveTime: frame.receiveTime });
    try {
      if (frame.kind === 'compressed') {
        const bytes = ensureOwnedBytes(frame.data);
        if (bytes.byteLength === 0) {
          throw new Error(`Compressed image payload is empty: ${frame.format}`);
        }

        // ROS compressedDepth: PNG → 16UC1/32FC1, then same colormap path as RawImage.
        if (isCompressedDepthFormat(frame.format)) {
          const decoded = await decodeCompressedDepth(bytes, frame.format);
          if (epoch !== this.#epoch) {
            return;
          }
          this.#renderRawFrame({
            receiveTime: frame.receiveTime,
            encoding: decoded.encoding,
            width: decoded.width,
            height: decoded.height,
            step: decoded.step,
            isBigEndian: decoded.isBigEndian,
            data: ensureOwnedBytes(decoded.data),
          });
          return;
        }

        const kind = getCompressedKind(frame.format);
        const sortKey = timeToKey(frame.receiveTime);

        if (kind === 'h264') {
          await this.#decoder.submitFrame(frame, bytes, sortKey);
          if (epoch !== this.#epoch) {
            return;
          }
          this.#updateH264Pressure();
          this.#emitMetricsIfDue();
          return;
        }

        const imageSource = await withTimeout(
          this.#decodeCompressed(bytes, frame.format),
          OUTPUT_TIMEOUT_MS,
          `Compressed image decode timed out: ${frame.format}`,
          closeCanvasImageSource,
        );
        if (discardStaleAsyncResult(imageSource, epoch, this.#epoch)) {
          return;
        }
        const width = 'displayWidth' in imageSource ? imageSource.displayWidth : imageSource.width;
        const height = 'displayHeight' in imageSource ? imageSource.displayHeight : imageSource.height;
        let bitmap: ImageBitmap;
        if (isImageBitmap(imageSource)) {
          bitmap = imageSource;
        } else {
          try {
            bitmap = await withTimeout(
              createImageBitmap(imageSource as ImageBitmapSource),
              OUTPUT_TIMEOUT_MS,
              `Compressed image bitmap creation timed out: ${frame.format}`,
              closeImageBitmap,
            );
          } finally {
            closeCanvasImageSource(imageSource);
          }
          if (discardStaleAsyncResult(bitmap, epoch, this.#epoch)) {
            return;
          }
        }
        this.#storeBitmap(bitmap, width, height, frame.format, frame.receiveTime);
        this.#drawBitmap(bitmap, width, height);
        this.#emitStatus({
          phase: 'ready',
          width,
          height,
          encoding: frame.format,
          receiveTime: frame.receiveTime,
        });
        return;
      }

      // Raw frame
      const bytes = ensureOwnedBytes(frame.data);
      this.#renderRawFrame({
        receiveTime: frame.receiveTime,
        encoding: frame.encoding,
        width: frame.width,
        height: frame.height,
        step: frame.step ?? (frame.width * bytesPerPixel(frame.encoding)),
        isBigEndian: frame.isBigEndian ?? false,
        data: bytes,
      });
    } catch (error) {
      if (epoch !== this.#epoch) {
        return;
      }
      if (isH264Frame(frame)) {
        this.#droppedH264Frames += 1;
        this.#handleH264DecoderError(
          error instanceof Error ? error : new Error(String(error)),
        );
        return;
      }
      this.#haltUntilReset = true;
      this.#emitStatus({
        phase: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  #handleH264Output(output: {
    videoFrame: VideoFrame;
    sourceFrame: ImageWorkerFrameEnvelope;
    decodeMs: number;
  }): void {
    const frameTimeNs = timeToKey(output.sourceFrame.receiveTime);
    this.#lastDecodedH264TimeNs = frameTimeNs;
    this.#h264DecodeMs = updateDecodeDurationEwma(this.#h264DecodeMs, output.decodeMs);

    // Newest-wins: the freshest decoded frame always takes the paint slot, so the
    // canvas keeps advancing no matter how far behind the playhead the pipeline
    // runs. Lateness alone is never a reason to discard output.
    const pending = this.#pendingDecodedH264;
    if (pending) {
      if (isSupersededH264Output(frameTimeNs, timeToKey(pending.sourceFrame.receiveTime))) {
        output.videoFrame.close();
        this.#droppedH264Frames += 1;
        this.#updateH264Pressure();
        this.#emitMetricsIfDue();
        return;
      }
      pending.videoFrame.close();
      this.#droppedH264Frames += 1;
    }
    this.#pendingDecodedH264 = {
      videoFrame: output.videoFrame,
      sourceFrame: output.sourceFrame,
    };
    this.#scheduleH264Render();
    this.#updateH264Pressure();
    this.#emitMetricsIfDue();
  }

  #scheduleH264Render(): void {
    if (this.#h264RenderTimer != null || !this.#pendingDecodedH264) {
      return;
    }
    const renderIntervalMs =
      this.#h264Pressure.mode === 'normal'
        ? H264_RENDER_INTERVAL_MS
        : H264_PRESSURED_RENDER_INTERVAL_MS;
    const delayMs = Math.max(
      0,
      renderIntervalMs - (performance.now() - this.#lastH264RenderAt),
    );
    if (delayMs <= 0) {
      void this.#renderPendingH264Output();
      return;
    }
    this.#h264RenderTimer = setTimeout(() => {
      this.#h264RenderTimer = null;
      void this.#renderPendingH264Output();
    }, delayMs);
  }

  async #renderPendingH264Output(): Promise<void> {
    const pending = this.#pendingDecodedH264;
    this.#pendingDecodedH264 = null;
    if (!pending) {
      return;
    }
    const { videoFrame, sourceFrame } = pending;
    const epoch = this.#epoch;
    const now = performance.now();
    try {
      const width = videoFrame.displayWidth || videoFrame.codedWidth;
      const height = videoFrame.displayHeight || videoFrame.codedHeight;
      this.#drawCanvasImageSource(videoFrame, width, height);
      this.#lastH264RenderAt = now;
      this.#renderedH264Frames += 1;
      this.#noteH264Progress();
      this.#emitStatus({
        phase: 'ready',
        width,
        height,
        encoding: sourceFrame.kind === 'compressed' ? sourceFrame.format : 'h264',
        receiveTime: sourceFrame.receiveTime,
      });

      if (this.#h264Pressure.mode === 'normal' && now - this.#lastH264BitmapAt >= 500) {
        try {
          const bitmap = await createImageBitmap(videoFrame);
          if (discardStaleAsyncResult(bitmap, epoch, this.#epoch)) {
            return;
          }
          this.#storeBitmap(
            bitmap,
            width,
            height,
            sourceFrame.kind === 'compressed' ? sourceFrame.format : 'h264',
            sourceFrame.receiveTime,
          );
          this.#lastH264BitmapAt = now;
        } catch {
          // The frame is already visible; resize caching is optional.
        }
      }
    } finally {
      videoFrame.close();
      this.#emitMetricsIfDue();
      if (this.#pendingDecodedH264) {
        this.#scheduleH264Render();
      }
    }
  }

  #handleH264DecoderError(error: Error): void {
    console.warn('ImageRenderWorker: H.264 decode failed', error);
    this.#resyncH264Decoder();
    const recovery = selectLatestCompleteH264Gop(
      this.#pendingH264Frames,
      this.#h264RecentConfig,
      true,
    );
    if (recovery.resync) {
      this.#pendingH264Frames = recovery.frames;
      this.#h264ProtectedQueueCount = 0;
      this.#clearWaitForH264Idr();
      this.#droppedH264Frames += recovery.droppedFrames;
      void this.#drainLatestFrame();
    } else {
      this.#droppedH264Frames += this.#pendingH264Frames.length;
      this.#pendingH264Frames = [];
      this.#h264ProtectedQueueCount = 0;
      this.#beginWaitForH264Idr();
      // Nothing in the queue can restart decoding, and the next in-band IDR may
      // never arrive, so pull a fresh GOP from before the current playhead.
      this.#requestH264Bootstrap();
    }
    if (this.#renderedH264Frames === 0 && !this.#cachedFrame) {
      this.#emitStatus({ phase: 'error', message: error.message });
    }
    this.#emitMetricsIfDue(true);
  }

  #resyncH264Decoder(): void {
    this.#decoder.reset();
    this.#disposePendingH264Output();
    this.#h264NeedsResync = false;
    this.#h264ResyncCount += 1;
    this.#lastH264ResyncAt = performance.now();
  }

  #disposePendingH264Output(): void {
    if (this.#h264RenderTimer != null) {
      clearTimeout(this.#h264RenderTimer);
      this.#h264RenderTimer = null;
    }
    this.#pendingDecodedH264?.videoFrame.close();
    this.#pendingDecodedH264 = null;
  }

  #updateH264Pressure(): void {
    const previousMode = this.#h264Pressure.mode;
    const mediaLagMs =
      !this.#isPlaying || this.#lastDecodedH264TimeNs == null
        ? 0
        : decodedFrameLatenessMs(this.#playbackTimeNs, this.#lastDecodedH264TimeNs);
    this.#h264Pressure = updateH264Pressure(this.#h264Pressure, {
      queueFrames: this.#pendingH264Frames.length,
      queueSpanMs: h264QueueSpanMs(this.#pendingH264Frames),
      decodeMs: this.#h264DecodeMs,
      decodeQueueSize: this.#decoder.decodeQueueSize,
      mediaLagMs,
    });
    if (previousMode !== this.#h264Pressure.mode) {
      this.#emitMetricsIfDue(true);
    }
  }

  #resetH264RuntimeState(): void {
    this.#h264Pressure = initialH264PressureState();
    this.#h264DecodeMs = 0;
    // After close()/configure(), WebCodecs requires the next VCL chunk to be an
    // IDR. Keep recent SPS/PPS so a bare IDR can still reconfigure the decoder.
    this.#beginWaitForH264Idr();
    this.#h264NeedsResync = false;
    this.#h264LastEnqueuedTimeNs = null;
    this.#h264FrameIntervalMs = 0;
    this.#h264ProgressAt = null;
    this.#h264StallReported = false;
    // #lastH264BootstrapRequestAt is intentionally preserved: a bootstrap runs
    // through here, so clearing it would let a bootstrap that fails to produce
    // output immediately request another one.
    this.#lastH264RenderAt = -Infinity;
    this.#lastH264BitmapAt = -Infinity;
    this.#droppedH264Frames = 0;
    this.#renderedH264Frames = 0;
    this.#h264ResyncCount = 0;
    this.#lastH264ResyncAt = -Infinity;
    this.#lastDecodedH264TimeNs = null;
    this.#lastMetricsAt = -Infinity;
  }

  #emitMetricsIfDue(force = false): void {
    const now = performance.now();
    if (!force && now - this.#lastMetricsAt < METRICS_INTERVAL_MS) {
      return;
    }
    this.#lastMetricsAt = now;
    const mediaLagMs =
      this.#lastDecodedH264TimeNs == null
        ? 0
        : decodedFrameLatenessMs(this.#playbackTimeNs, this.#lastDecodedH264TimeNs);
    const metrics: ImageRenderMetrics = {
      pressureMode: this.#h264Pressure.mode,
      queueFrames: this.#pendingH264Frames.length,
      queueSpanMs: h264QueueSpanMs(this.#pendingH264Frames),
      decodeMs: this.#h264DecodeMs,
      droppedFrames: this.#droppedH264Frames,
      renderedFrames: this.#renderedH264Frames,
      decodeQueueSize: this.#decoder.decodeQueueSize,
      mediaLagMs,
      resyncCount: this.#h264ResyncCount,
      waitingForIdr: this.#h264WaitingForIdr,
      codec: this.#decoder.codec,
    };
    workerScope.postMessage({ type: 'metrics', metrics } satisfies ImageRenderWorkerEvent);
  }

  #renderRawFrame(frame: {
    receiveTime: Time;
    encoding: string;
    width: number;
    height: number;
    step: number;
    isBigEndian: boolean;
    data: Uint8Array<ArrayBuffer>;
  }): void {
    const pixelBytes = frame.width * frame.height * 4;
    let rgba = this.#rawRgba;
    if (!rgba || rgba.length !== pixelBytes) {
      rgba = new Uint8ClampedArray(pixelBytes);
      this.#rawRgba = rgba;
    }
    if (!this.#rawImageData || this.#rawImageData.width !== frame.width || this.#rawImageData.height !== frame.height) {
      this.#rawImageData = new ImageData(rgba, frame.width, frame.height);
    }

    decodeRawImage(
      {
        encoding: frame.encoding,
        width: frame.width,
        height: frame.height,
        step: frame.step,
        is_bigendian: frame.isBigEndian,
        data: frame.data,
      },
      rgba,
      this.#rawDecodeOptions,
    );

    this.#disposeCachedBitmap();
    this.#cachedFrame = {
      kind: 'raw',
      width: frame.width,
      height: frame.height,
      encoding: frame.encoding,
      step: frame.step,
      isBigEndian: frame.isBigEndian,
      data: frame.data,
      receiveTime: frame.receiveTime,
    };

    this.#drawRawImageData(frame.width, frame.height);
    this.#emitStatus({
      phase: 'ready',
      width: frame.width,
      height: frame.height,
      encoding: frame.encoding,
      receiveTime: frame.receiveTime,
    });
  }

  /** Re-decode the last raw frame with current rawDecodeOptions and redraw. */
  #redrawRawCached(): void {
    const cached = this.#cachedFrame;
    if (!cached || cached.kind !== 'raw') {
      return;
    }
    const pixelBytes = cached.width * cached.height * 4;
    let rgba = this.#rawRgba;
    if (!rgba || rgba.length !== pixelBytes) {
      rgba = new Uint8ClampedArray(pixelBytes);
      this.#rawRgba = rgba;
    }
    if (!this.#rawImageData || this.#rawImageData.width !== cached.width || this.#rawImageData.height !== cached.height) {
      this.#rawImageData = new ImageData(rgba, cached.width, cached.height);
    }
    try {
      decodeRawImage(
        {
          encoding: cached.encoding,
          width: cached.width,
          height: cached.height,
          step: cached.step,
          is_bigendian: cached.isBigEndian,
          data: cached.data,
        },
        rgba,
        this.#rawDecodeOptions,
      );
      this.#drawRawImageData(cached.width, cached.height);
      this.#emitStatus({
        phase: 'ready',
        width: cached.width,
        height: cached.height,
        encoding: cached.encoding,
        receiveTime: cached.receiveTime,
      });
    } catch {
      // Ignore re-decode errors; the last successful frame is still visible.
    }
  }

  /** Redraw the cached frame with current renderOptions / viewport. */
  #redrawCachedFrame(): void {
    const cached = this.#cachedFrame;
    if (!cached) {
      this.#clearCanvas();
      return;
    }
    if (cached.kind === 'raw') {
      this.#drawRawImageData(cached.width, cached.height);
      this.#emitStatus({
        phase: 'ready',
        width: cached.width,
        height: cached.height,
        encoding: cached.encoding,
        receiveTime: cached.receiveTime,
      });
    } else {
      this.#drawBitmap(cached.bitmap, cached.width, cached.height);
      this.#emitStatus({
        phase: 'ready',
        width: cached.width,
        height: cached.height,
        encoding: cached.encoding,
        receiveTime: cached.receiveTime,
      });
    }
  }

  #storeBitmap(bitmap: ImageBitmap, width: number, height: number, encoding: string, receiveTime: Time): void {
    this.#disposeCachedBitmap();
    this.#cachedFrame = { kind: 'bitmap', width, height, encoding, bitmap, receiveTime };
  }

  #disposeCachedBitmap(): void {
    if (this.#cachedFrame?.kind === 'bitmap') {
      this.#cachedFrame.bitmap.close();
    }
  }

  async #decodeCompressed(
    data: Uint8Array<ArrayBuffer>,
    format: string,
  ): Promise<ImageBitmap | VideoFrame> {
    const mime = normalizeCompressedMime(format, data);
    if (typeof ImageDecoder !== 'undefined') {
      let supported = this.#imageDecoderMimeSupported.get(mime);
      if (supported === undefined) {
        supported = await ImageDecoder.isTypeSupported(mime);
        this.#imageDecoderMimeSupported.set(mime, supported);
      }
      if (supported) {
        const decoder = new ImageDecoder({ type: mime, data });
        try {
          const { image } = await decoder.decode({ frameIndex: 0 });
          return image;
        } finally {
          decoder.close();
        }
      }
    }
    return createImageBitmap(new Blob([data], { type: mime }));
  }

  #disposeAuxiliaryDecodeState(): void {
    this.#imageDecoderMimeSupported.clear();
    this.#rawRgba = null;
    this.#rawImageData = null;
  }

  #emitStatus(status: ImageSurfaceStatus): void {
    if (status.phase === 'decoding') {
      if (this.#lastPostedUiPhase !== 'idle' && this.#lastPostedUiPhase !== 'error') {
        return;
      }
    }
    this.#lastPostedUiPhase = status.phase;
    const event: ImageRenderWorkerEvent = { type: 'status', status };
    workerScope.postMessage(event);
  }

  #drawRawImageData(width: number, height: number): void {
    ensureBufferCanvas(this.#bufferCanvas, width, height);
    this.#bufferCtx!.putImageData(this.#rawImageData!, 0, 0);
    this.#drawCanvasImageSource(this.#bufferCanvas, width, height);
  }

  #drawBitmap(bitmap: ImageBitmap, width: number, height: number): void {
    this.#drawCanvasImageSource(bitmap, width, height);
  }

  #drawCanvasImageSource(source: CanvasImageSource, sourceWidth: number, sourceHeight: number): void {
    this.#applyViewport();
    const ctx = this.#ctx;
    const canvas = this.#canvas;
    if (!ctx || !canvas) {
      return;
    }
    const viewportWidth = this.#viewport.cssWidth || canvas.width / Math.max(1, this.#viewport.devicePixelRatio) || 1;
    const viewportHeight = this.#viewport.cssHeight || canvas.height / Math.max(1, this.#viewport.devicePixelRatio) || 1;
    const rotDeg = normalizeRotationDeg(this.#renderOptions.rotationDeg);
    const { w: logicalWidth, h: logicalHeight } = rotatedAabbSize(sourceWidth, sourceHeight, rotDeg);
    const scale =
      this.#renderOptions.fitMode === 'contain'
        ? Math.min(viewportWidth / logicalWidth, viewportHeight / logicalHeight)
        : Math.max(viewportWidth / logicalWidth, viewportHeight / logicalHeight);
    const drawWidth = Math.max(1, sourceWidth * scale);
    const drawHeight = Math.max(1, sourceHeight * scale);

    ctx.save();
    const renderDpr = this.#renderDevicePixelRatio();
    ctx.setTransform(renderDpr, 0, 0, renderDpr, 0, 0);
    ctx.clearRect(0, 0, viewportWidth, viewportHeight);
    ctx.fillStyle = this.#renderOptions.backgroundColor;
    ctx.fillRect(0, 0, viewportWidth, viewportHeight);
    ctx.imageSmoothingEnabled = this.#renderOptions.smoothing;
    ctx.imageSmoothingQuality =
      this.#renderOptions.smoothing && this.#h264Pressure.mode === 'normal' ? 'high' : 'low';
    ctx.translate(viewportWidth / 2, viewportHeight / 2);
    ctx.rotate((rotDeg * Math.PI) / 180);
    ctx.scale(this.#renderOptions.flipHorizontal ? -1 : 1, this.#renderOptions.flipVertical ? -1 : 1);
    ctx.drawImage(source, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight);
    ctx.restore();
  }

  #applyViewport(): void {
    if (!this.#canvas) {
      return;
    }
    const renderDpr = this.#renderDevicePixelRatio();
    const pixelWidth = Math.max(1, Math.round(Math.max(0, this.#viewport.cssWidth) * renderDpr));
    const pixelHeight = Math.max(1, Math.round(Math.max(0, this.#viewport.cssHeight) * renderDpr));
    if (this.#canvas.width !== pixelWidth) {
      this.#canvas.width = pixelWidth;
    }
    if (this.#canvas.height !== pixelHeight) {
      this.#canvas.height = pixelHeight;
    }
  }

  #renderDevicePixelRatio(): number {
    const dpr = Math.max(1, this.#viewport.devicePixelRatio);
    return this.#h264Pressure.mode === 'normal' ? dpr : Math.min(dpr, 1);
  }

  #clearCanvas(): void {
    if (!this.#ctx || !this.#canvas) {
      return;
    }
    this.#ctx.save();
    this.#ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.#ctx.clearRect(0, 0, this.#canvas.width, this.#canvas.height);
    this.#ctx.fillStyle = this.#renderOptions.backgroundColor;
    this.#ctx.fillRect(0, 0, this.#canvas.width, this.#canvas.height);
    this.#ctx.restore();
  }
}

// ---------- Helpers ----------

function bytesPerPixel(encoding: string): number {
  const lower = encoding.trim().toLowerCase();
  switch (lower) {
    case 'rgb8':
    case 'bgr8':
    case '8uc3':
      return 3;
    case 'rgba8':
    case 'bgra8':
    case '32fc1':
      return 4;
    case 'mono16':
    case '16uc1':
    case 'uyvy':
    case 'yuyv':
    case 'yuv422':
    case 'yuv422_yuy2':
      return 2;
    default:
      return 1;
  }
}

function ensureBufferCanvas(canvas: OffscreenCanvas, width: number, height: number): void {
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
}

function cloneBytes(data: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(new ArrayBuffer(data.byteLength));
  copy.set(data);
  return copy;
}

function ensureOwnedBytes(data: Uint8Array): Uint8Array<ArrayBuffer> {
  if (
    data.buffer instanceof ArrayBuffer &&
    data.byteOffset === 0 &&
    data.byteLength === data.buffer.byteLength
  ) {
    return data as Uint8Array<ArrayBuffer>;
  }
  return cloneBytes(data);
}

function isH264Frame(frame: ImageWorkerFrameEnvelope): boolean {
  return frame.kind === 'compressed' && getCompressedKind(frame.format) === 'h264';
}

function h264QueueSpanMs(frames: ImageWorkerFrameEnvelope[]): number {
  if (frames.length < 2) {
    return 0;
  }
  const first = frames.find(
    (frame) => !isH264Frame(frame) || !isH264ConfigOnly(frame.data),
  );
  const last = frames.findLast(
    (frame) => !isH264Frame(frame) || !isH264ConfigOnly(frame.data),
  );
  if (!first || !last) {
    return 0;
  }
  const spanNs = timeToKey(last.receiveTime) - timeToKey(first.receiveTime);
  return Math.max(0, Number(spanNs) / 1_000_000);
}

function timeToKey(time: Time): bigint {
  return BigInt(time.sec) * 1_000_000_000n + BigInt(time.nsec);
}

function closeCanvasImageSource(source: ImageBitmap | VideoFrame): void {
  source.close();
}

function closeImageBitmap(bitmap: ImageBitmap): void {
  bitmap.close();
}

function isImageBitmap(source: ImageBitmap | VideoFrame): source is ImageBitmap {
  return typeof ImageBitmap !== 'undefined' && source instanceof ImageBitmap;
}

// ---------- Bootstrap ----------

const runtime = new ImageRenderWorkerRuntime();
const workerScope = self as unknown as DedicatedWorkerGlobalScope;

workerScope.onmessage = (event: MessageEvent<ImageRenderWorkerRequest>) => {
  runtime.handle(event.data);
};

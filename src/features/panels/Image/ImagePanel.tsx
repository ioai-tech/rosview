import React, { useEffect, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import type { Player } from '@/core/types/player';
import { useMessagePipeline } from '@/core/pipeline/useMessagePipeline';
import type { MessageEvent as RosMessageEvent } from '@/core/types/ros';
import { scheduleFrame } from '@/shared/utils/rafScheduler';
import { toNano } from '@/shared/utils/time';
import type { RawImageDecodeOptions } from './core/imageColorMode';
import type {
  ImageRenderMetrics,
  ImageRenderOptions,
  ImageRenderWorkerEvent,
  ImageRenderWorkerRequest,
} from './core/imageWorkerProtocol';
import {
  IMAGE_PANEL_TOPIC_INCLUDES,
  topicNeedsOrderedVideoFrames,
  type ImageSurfaceStatus,
} from './core/imageTypes';
import { executeH264Bootstrap } from './core/h264SeekRepair';
import { isH264MessageEvent, toWorkerFrame } from './core/messageFrameAdapter';
import { applyDepthTopicPreset } from './core/depthColorDefaults';
import type { ImageConfig } from './defaults';
import { TopicQuickPicker } from '../framework/TopicQuickPicker';
import { PanelTopicBar } from '../framework/PanelTopicBar';
import ImageRenderWorkerClass from './core/ImageRender.worker.ts?worker&inline';

type ColorOptions = Pick<ImageConfig, 'colorMode' | 'flatColor' | 'gradient' | 'colorMap' | 'explicitAlpha' | 'minValue' | 'maxValue'>;

function configToRawDecodeOptions(opts: ColorOptions): Partial<RawImageDecodeOptions> {
  return {
    colorMode: opts.colorMode,
    flatColor: opts.flatColor,
    gradient: opts.gradient,
    colorMap: opts.colorMap,
    explicitAlpha: opts.explicitAlpha,
    minValue: opts.minValue,
    maxValue: opts.maxValue,
  };
}

export type ImagePanelProps = ImageConfig & {
  player: Player;
  panelId: string;
  setConfig: (next: ImageConfig | ((prev: ImageConfig) => ImageConfig)) => void;
};

export const ImagePanel: React.FC<ImagePanelProps> = (props) => {
  const { formatMessage } = useIntl();
  const isPlaying = useMessagePipeline(
    (state) => state.playerState.activeData?.isPlaying ?? false,
  );
  const {
    player,
    panelId,
    setConfig,
    topic,
    backgroundColor,
    showStatusText,
    fitMode,
    flipHorizontal,
    flipVertical,
    rotation,
    smoothing,
    colorMode,
    colorMap,
    gradient,
    flatColor,
    explicitAlpha,
    minValue,
    maxValue,
  } = props;

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const workerDisposeTimerRef = useRef<number | null>(null);
  const transferredCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const lastPlaybackTimeNsRef = useRef<bigint | null>(null);
  const h264SeekRepairAbortRef = useRef<AbortController | null>(null);
  const lastUiStatusRef = useRef<ImageSurfaceStatus>({ phase: 'idle' });
  const h264OrderedModeRef = useRef(false);
  const h264BootstrapInFlightRef = useRef(false);
  const h264BootstrapGenerationRef = useRef(0);
  const h264BufferedLiveRef = useRef<RosMessageEvent[]>([]);
  const consumerModeRef = useRef<'latest' | 'all'>('latest');
  const [status, setStatus] = useState<ImageSurfaceStatus>({ phase: 'idle' });
  const [metrics, setMetrics] = useState<ImageRenderMetrics | null>(null);
  const imageConsumerId = `${panelId}:image-main`;
  const topicSchema = useMessagePipeline((state) =>
    state.playerState.activeData?.topics.find((entry) => entry.name === topic)?.type ?? '',
  );

  // Worker lifecycle: init on mount, dispose on unmount
  useEffect(() => {
    const canvas = canvasRef.current;
    const viewport = viewportRef.current;
    if (!canvas || !viewport) {
      return;
    }
    if (typeof canvas.transferControlToOffscreen !== 'function') {
      const nextStatus: ImageSurfaceStatus = {
        phase: 'error',
        message: formatMessage({ id: 'panels.image.error.offscreenUnsupported' }),
      };
      lastUiStatusRef.current = nextStatus;
      setStatus(nextStatus);
      return;
    }

    if (workerDisposeTimerRef.current != null) {
      window.clearTimeout(workerDisposeTimerRef.current);
      workerDisposeTimerRef.current = null;
    }

    // Reuse existing worker/offscreen binding across React StrictMode double-mount probe.
    if (workerRef.current && transferredCanvasRef.current && transferredCanvasRef.current !== canvas) {
      workerRef.current.postMessage({ type: 'dispose' } satisfies ImageRenderWorkerRequest);
      workerRef.current.terminate();
      workerRef.current = null;
      transferredCanvasRef.current = null;
    }

    let worker = workerRef.current;
    if (!worker) {
      worker = new ImageRenderWorkerClass();
      workerRef.current = worker;
      const offscreen = canvas.transferControlToOffscreen();
      transferredCanvasRef.current = canvas;
      worker.postMessage(
        {
          type: 'init',
          canvas: offscreen,
        } satisfies ImageRenderWorkerRequest,
        [offscreen],
      );
    }

    worker.onmessage = (event) => {
      const data = event.data as ImageRenderWorkerEvent;
      if (data.type === 'metrics') {
        setMetrics(data.metrics);
        return;
      }
      if (data.type !== 'status') {
        return;
      }
      const nextStatus = data.status;
      if (isUiStatusEqual(lastUiStatusRef.current, nextStatus)) {
        return;
      }
      lastUiStatusRef.current = nextStatus;
      setStatus(nextStatus);
    };

    let lastCssW = -1;
    let lastCssH = -1;
    let lastDpr = -1;
    let cancelScheduledViewport: (() => void) | null = null;

    const applyViewportNow = () => {
      const rect = viewport.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const cssWidth = rect.width;
      const cssHeight = rect.height;
      if (cssWidth === lastCssW && cssHeight === lastCssH && dpr === lastDpr) {
        return;
      }
      lastCssW = cssWidth;
      lastCssH = cssHeight;
      lastDpr = dpr;
      worker.postMessage({
        type: 'viewport',
        viewport: { cssWidth, cssHeight, devicePixelRatio: dpr },
      } satisfies ImageRenderWorkerRequest);
    };

    const scheduleViewport = () => {
      cancelScheduledViewport?.();
      cancelScheduledViewport = scheduleFrame(applyViewportNow);
    };

    applyViewportNow();
    const resizeObserver = new ResizeObserver(scheduleViewport);
    resizeObserver.observe(viewport);
    window.addEventListener('resize', scheduleViewport);

    return () => {
      cancelScheduledViewport?.();
      cancelScheduledViewport = null;
      window.removeEventListener('resize', scheduleViewport);
      resizeObserver.disconnect();
      workerDisposeTimerRef.current = window.setTimeout(() => {
        const activeWorker = workerRef.current;
        if (!activeWorker) return;
        activeWorker.postMessage({ type: 'dispose' } satisfies ImageRenderWorkerRequest);
        activeWorker.terminate();
        workerRef.current = null;
        transferredCanvasRef.current = null;
        lastUiStatusRef.current = { phase: 'idle' };
        setStatus({ phase: 'idle' });
        setMetrics(null);
        workerDisposeTimerRef.current = null;
      }, 0);
    };
  }, [formatMessage]);

  // High-frequency image frames bypass messageBus. Still images/raw frames use
  // latest-only; ordered video codecs use mode=all from registration and bootstrap
  // the nearest decodable GOP before accepting live delta frames.
  useEffect(() => {
    if (!topic) {
      return;
    }
    const worker = workerRef.current;
    if (!worker) {
      return;
    }

    h264OrderedModeRef.current = false;
    h264BootstrapInFlightRef.current = false;
    h264BootstrapGenerationRef.current += 1;
    h264BufferedLiveRef.current = [];
    consumerModeRef.current = 'latest';
    setMetrics(null);
    worker.postMessage({ type: 'reset' } satisfies ImageRenderWorkerRequest);

    const initialOrdered = topicNeedsOrderedVideoFrames(topicSchema);
    if (initialOrdered) {
      h264OrderedModeRef.current = true;
      consumerModeRef.current = 'all';
    }

    const handleH264Frame = (event: RosMessageEvent) => {
      if (h264BootstrapInFlightRef.current) {
        h264BufferedLiveRef.current.push(event);
        return;
      }
      postImageFrame(worker, event);
    };

    const dispatchHighFrequencyBatch = (messages: RosMessageEvent[]) => {
      for (const event of messages) {
        if (isH264MessageEvent(event)) {
          handleH264Frame(event);
        } else {
          postImageFrame(worker, event);
        }
      }
    };

    const runBootstrap = async (
      targetTime: ReturnType<Player['getCurrentTime']>,
      preserveFrame: boolean,
    ) => {
      if (!targetTime) {
        return false;
      }
      const generation = h264BootstrapGenerationRef.current;
      h264BootstrapInFlightRef.current = true;
      h264SeekRepairAbortRef.current?.abort();
      const controller = new AbortController();
      h264SeekRepairAbortRef.current = controller;

      try {
        const success = await executeH264Bootstrap({
          player,
          worker,
          topic,
          targetTime,
          liveEvents: h264BufferedLiveRef.current,
          signal: controller.signal,
          preserveFrame,
        });
        if (controller.signal.aborted || generation !== h264BootstrapGenerationRef.current) {
          return false;
        }
        if (success) {
          h264BufferedLiveRef.current = [];
        }
        return success;
      } finally {
        if (generation === h264BootstrapGenerationRef.current) {
          h264BootstrapInFlightRef.current = false;
        }
        if (h264SeekRepairAbortRef.current === controller) {
          h264SeekRepairAbortRef.current = null;
        }
      }
    };

    const activateH264OrderedMode = async (triggerMessage?: RosMessageEvent) => {
      if (h264OrderedModeRef.current) {
        if (triggerMessage) {
          handleH264Frame(triggerMessage);
        }
        return;
      }

      h264OrderedModeRef.current = true;
      if (triggerMessage) {
        h264BufferedLiveRef.current.push(triggerMessage);
      }

      if (consumerModeRef.current !== 'all') {
        consumerModeRef.current = 'all';
        player.unregisterHighFrequencyConsumer(imageConsumerId);
        player.registerHighFrequencyConsumer(imageConsumerId, {
          topic,
          lane: 'video',
          mode: 'all',
          onMessageBatch: dispatchHighFrequencyBatch,
        });
      }

      const currentTime = player.getCurrentTime();
      if (currentTime) {
        await runBootstrap(currentTime, false);
      }
    };

    const handleMessage = (message: RosMessageEvent) => {
      if (isH264MessageEvent(message)) {
        if (!h264OrderedModeRef.current) {
          void activateH264OrderedMode(message);
          return;
        }
        handleH264Frame(message);
        return;
      }
      postImageFrame(worker, message);
    };

    if (consumerModeRef.current === 'all') {
      player.registerHighFrequencyConsumer(imageConsumerId, {
        topic,
        lane: 'video',
        mode: 'all',
        onMessageBatch: dispatchHighFrequencyBatch,
      });
      const currentTime = player.getCurrentTime();
      if (currentTime) {
        void runBootstrap(currentTime, false);
      }
    } else {
      player.registerHighFrequencyConsumer(imageConsumerId, {
        topic,
        lane: 'video',
        mode: 'latest',
        onLatestMessage: handleMessage,
        onMessageBatch: (messages) => {
          if (h264OrderedModeRef.current) {
            return;
          }
          const latest = messages.at(-1);
          if (latest) {
            handleMessage(latest);
          }
        },
      });
    }

    return () => {
      h264BootstrapGenerationRef.current += 1;
      h264SeekRepairAbortRef.current?.abort();
      h264SeekRepairAbortRef.current = null;
      h264BufferedLiveRef.current = [];
      h264BootstrapInFlightRef.current = false;
      player.unregisterHighFrequencyConsumer(imageConsumerId);
      worker.postMessage({ type: 'reset' } satisfies ImageRenderWorkerRequest);
    };
  }, [imageConsumerId, player, topic, topicSchema]);

  useEffect(() => {
    return () => {
      h264SeekRepairAbortRef.current?.abort();
      h264SeekRepairAbortRef.current = null;
    };
  }, [player, topic]);

  // Keep the worker's media deadline current. On rewind, rebuild H.264 state
  // from the nearest complete random-access point.
  useEffect(() => {
    return player.subscribeCurrentTime((time) => {
      workerRef.current?.postMessage({
        type: 'playback',
        currentTime: time,
        isPlaying,
      } satisfies ImageRenderWorkerRequest);
      const nowNs = toNano(time);
      const previousNs = lastPlaybackTimeNsRef.current;
      if (previousNs != null && nowNs + 5_000_000n < previousNs) {
        h264SeekRepairAbortRef.current?.abort();
        h264SeekRepairAbortRef.current = null;
        const worker = workerRef.current;
        if (worker && topic && h264OrderedModeRef.current) {
          h264BootstrapInFlightRef.current = true;
          h264BufferedLiveRef.current = [];
          const generation = h264BootstrapGenerationRef.current;
          const controller = new AbortController();
          h264SeekRepairAbortRef.current = controller;
          void (async () => {
            try {
              const success = await executeH264Bootstrap({
                player,
                worker,
                topic,
                targetTime: time,
                liveEvents: h264BufferedLiveRef.current,
                signal: controller.signal,
                preserveFrame: true,
              });
              if (
                success &&
                !controller.signal.aborted &&
                generation === h264BootstrapGenerationRef.current
              ) {
                h264BufferedLiveRef.current = [];
              }
            } finally {
              if (generation === h264BootstrapGenerationRef.current) {
                h264BootstrapInFlightRef.current = false;
              }
              if (h264SeekRepairAbortRef.current === controller) {
                h264SeekRepairAbortRef.current = null;
              }
            }
          })();
        } else {
          workerRef.current?.postMessage({ type: 'reset' } satisfies ImageRenderWorkerRequest);
        }
      }
      lastPlaybackTimeNsRef.current = nowNs;
    });
  }, [isPlaying, player, topic]);

  // Send color/depth decode options when they change — triggers immediate redraw in worker
  useEffect(() => {
    const worker = workerRef.current;
    if (!worker) {
      return;
    }
    worker.postMessage({
      type: 'rawDecodeOptions',
      options: configToRawDecodeOptions({
        colorMode,
        colorMap,
        gradient,
        flatColor,
        explicitAlpha,
        minValue,
        maxValue,
      }),
    } satisfies ImageRenderWorkerRequest);
  }, [colorMode, colorMap, gradient, flatColor, explicitAlpha, minValue, maxValue]);

  // Send render options (flip/rotation/smoothing/fitMode) — triggers immediate redraw
  useEffect(() => {
    const worker = workerRef.current;
    if (!worker) {
      return;
    }
    const options: ImageRenderOptions = {
      backgroundColor,
      flipHorizontal,
      flipVertical,
      rotationDeg: rotation,
      smoothing,
      fitMode,
    };
    worker.postMessage({ type: 'renderOptions', options } satisfies ImageRenderWorkerRequest);
  }, [backgroundColor, flipHorizontal, flipVertical, rotation, smoothing, fitMode]);

  const statusText = getStatusText(status);

  return (
    <div
      className="flex flex-col h-full overflow-hidden relative"
      style={{ background: backgroundColor }}
      data-testid="image-panel"
      data-h264-pressure={metrics?.pressureMode}
      data-h264-queue-frames={metrics?.queueFrames}
      data-h264-dropped-frames={metrics?.droppedFrames}
      data-h264-decode-queue={metrics?.decodeQueueSize}
      data-h264-media-lag-ms={metrics?.mediaLagMs}
      data-h264-resync-count={metrics?.resyncCount}
      data-h264-rendered-frames={metrics?.renderedFrames}
    >
      <PanelTopicBar className="border-zinc-800 bg-zinc-950">
        <TopicQuickPicker
          value={topic}
          onChange={(nextTopic) => setConfig((prev) => applyDepthTopicPreset(nextTopic, prev))}
          typeIncludes={[...IMAGE_PANEL_TOPIC_INCLUDES]}
          placeholder={formatMessage({ id: 'panels.framework.topicPicker.imagePlaceholder' })}
          className="min-w-0 flex-1"
          triggerClassName="border-zinc-700 bg-zinc-950 text-zinc-100 hover:bg-zinc-900 hover:text-zinc-50"
        />
      </PanelTopicBar>
      <div
        ref={viewportRef}
        className="flex-1 relative min-h-0 min-w-0 flex items-center justify-center"
      >
        <canvas
          ref={canvasRef}
          className="w-full h-full block"
          data-testid="image-panel-canvas"
        />
        {showStatusText && statusText && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none text-white/40 italic text-xs">
            {statusText}
          </div>
        )}
        {showStatusText && status.phase === 'ready' && status.width && status.height && (
          <div
            className="absolute bottom-0 left-0 right-0 px-2 py-1 text-white/30 text-[10px] font-mono truncate pointer-events-none"
            data-testid="image-panel-status"
          >
            {status.width}x{status.height} {status.encoding ?? ''}
          </div>
        )}
      </div>
    </div>
  );
};

function getStatusText(status: ImageSurfaceStatus): string | null {
  if (status.phase === 'idle') {
    return 'Waiting for image data';
  }
  if (status.phase === 'error') {
    return status.message ?? 'Image decode failed';
  }
  if (status.phase === 'decoding' && !status.width && !status.height) {
    return 'Decoding latest frame...';
  }
  return null;
}

function isUiStatusEqual(a: ImageSurfaceStatus, b: ImageSurfaceStatus): boolean {
  return (
    a.phase === b.phase &&
    a.width === b.width &&
    a.height === b.height &&
    a.encoding === b.encoding &&
    a.message === b.message
  );
}

function postImageFrame(worker: Worker, messageEvent: RosMessageEvent): void {
  // High-frequency consumers receive a payload dedicated to this consumer, so
  // a full-span ArrayBuffer can be handed directly to the render worker.
  const next = toWorkerFrame(messageEvent, { transferOwnership: true });
  if (!next) {
    return;
  }
  worker.postMessage(
    { type: 'frame', frame: next.frame } satisfies ImageRenderWorkerRequest,
    next.transfer,
  );
}

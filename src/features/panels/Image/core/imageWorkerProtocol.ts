import type { Time } from '@/core/types/ros';
import type { RawImageDecodeOptions } from './imageColorMode';
import type { ImageSurfaceStatus } from './imageTypes';
import type { H264PressureMode } from './h264Backpressure';

export interface ImageRenderOptions {
  /** CSS color string (e.g. `#ff0000`) used to fill letterbox/pillarbox and idle canvas. */
  backgroundColor: string;
  flipHorizontal: boolean;
  flipVertical: boolean;
  rotationDeg: number;
  smoothing: boolean;
  fitMode: 'contain' | 'cover';
}

export interface ImageViewport {
  cssWidth: number;
  cssHeight: number;
  devicePixelRatio: number;
}

export type ImageWorkerFrameEnvelope =
  | {
      kind: 'compressed';
      receiveTime: Time;
      format: string;
      data: Uint8Array;
    }
  | {
      kind: 'raw';
      receiveTime: Time;
      encoding: string;
      width: number;
      height: number;
      step?: number;
      isBigEndian?: boolean;
      data: Uint8Array;
    };

export type ImageRenderWorkerRequest =
  | {
      type: 'init';
      canvas: OffscreenCanvas;
    }
  | {
      type: 'viewport';
      viewport: ImageViewport;
    }
  | {
      type: 'renderOptions';
      options: ImageRenderOptions;
    }
  | {
      type: 'rawDecodeOptions';
      options: Partial<RawImageDecodeOptions>;
    }
  | {
      type: 'playback';
      currentTime: Time;
      isPlaying: boolean;
    }
  | {
      type: 'frame';
      frame: ImageWorkerFrameEnvelope;
    }
  | {
      type: 'bootstrapH264';
      frames: ImageWorkerFrameEnvelope[];
      preserveFrame?: boolean;
    }
  | {
      type: 'reset';
      preserveFrame?: boolean;
    }
  | {
      type: 'dispose';
    };

export interface ImageRenderMetrics {
  pressureMode: H264PressureMode;
  queueFrames: number;
  queueSpanMs: number;
  decodeMs: number;
  droppedFrames: number;
  renderedFrames: number;
  decodeQueueSize: number;
  mediaLagMs: number;
  resyncCount: number;
  /** True while every incoming frame is discarded pending a random-access point. */
  waitingForIdr: boolean;
  codec?: string;
}

export type ImageRenderWorkerEvent =
  | {
      type: 'status';
      status: ImageSurfaceStatus;
    }
  | {
      type: 'metrics';
      metrics: ImageRenderMetrics;
    }
  /**
   * The worker cannot resume decoding from the frames it has. The panel should
   * fetch a bootstrap batch starting at the nearest IDR before the playhead.
   * Waiting for the next in-band IDR is not viable: keyframe intervals of
   * several seconds are common and some recordings hold a single IDR.
   */
  | {
      type: 'needsBootstrap';
    };

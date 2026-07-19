import { describe, expect, it } from 'vitest';
import {
  H264_MAX_PENDING_FRAMES,
  H264_MAX_PENDING_SPAN_MS,
  decodedFrameLatenessMs,
  initialH264PressureState,
  isH264HardLimitExceeded,
  shouldDropDecodedH264Frame,
  updateDecodeDurationEwma,
  updateH264Pressure,
} from './h264Backpressure';

const healthy = {
  queueFrames: 2,
  queueSpanMs: 20,
  decodeMs: 10,
  decodeQueueSize: 1,
  mediaLagMs: 20,
};

describe('H.264 adaptive backpressure', () => {
  it('treats frame count and queue span as strict hard bounds', () => {
    expect(isH264HardLimitExceeded(H264_MAX_PENDING_FRAMES, H264_MAX_PENDING_SPAN_MS)).toBe(false);
    expect(isH264HardLimitExceeded(H264_MAX_PENDING_FRAMES + 1, 0)).toBe(true);
    expect(isH264HardLimitExceeded(1, H264_MAX_PENDING_SPAN_MS + 1)).toBe(true);
  });

  it('enters degraded mode from queue time span even below the frame bound', () => {
    const next = updateH264Pressure(initialH264PressureState(), {
      queueFrames: 20,
      queueSpanMs: 400,
      decodeMs: 10,
      decodeQueueSize: 1,
      mediaLagMs: 20,
    });
    expect(next.mode).toBe('degraded');
  });

  it('uses hysteresis before returning to normal', () => {
    let state = updateH264Pressure(initialH264PressureState(), {
      queueFrames: 80,
      queueSpanMs: 500,
      decodeMs: 60,
      decodeQueueSize: 8,
      mediaLagMs: 500,
    });
    state = updateH264Pressure(state, healthy);
    expect(state.mode).toBe('recovery');

    for (let i = 0; i < 10; i++) {
      state = updateH264Pressure(state, healthy);
    }
    expect(state.mode).toBe('recovery');
    state = updateH264Pressure(state, healthy);
    expect(state.mode).toBe('normal');
  });

  it('relapses quickly when recovery pressure rises again', () => {
    let state = { mode: 'degraded' as const, healthySamples: 0 };
    state = updateH264Pressure(state, {
      queueFrames: 0,
      queueSpanMs: 0,
      decodeMs: 5,
      decodeQueueSize: 0,
      mediaLagMs: 0,
    });
    expect(state.mode).toBe('recovery');
    state = updateH264Pressure(state, {
      queueFrames: 45,
      queueSpanMs: 300,
      decodeMs: 20,
      decodeQueueSize: 6,
      mediaLagMs: 300,
    });
    expect(state.mode).toBe('degraded');
  });

  it('smooths decode duration samples', () => {
    expect(updateDecodeDurationEwma(20, 40)).toBe(24);
    expect(updateDecodeDurationEwma(0, 15)).toBe(15);
  });

  it('uses actual media lag instead of playback speed', () => {
    const overloaded = updateH264Pressure(initialH264PressureState(), {
      ...healthy,
      mediaLagMs: 400,
    });
    const capable = updateH264Pressure(initialH264PressureState(), healthy);

    expect(overloaded.mode).toBe('degraded');
    expect(capable.mode).toBe('normal');
  });

  it('drops decoded output only after it misses the media deadline', () => {
    const playback = 1_000_000_000n;
    expect(decodedFrameLatenessMs(playback, 950_000_000n)).toBe(50);
    expect(shouldDropDecodedH264Frame(playback, 900_000_000n)).toBe(false);
    expect(shouldDropDecodedH264Frame(playback, 850_000_000n)).toBe(true);
    expect(shouldDropDecodedH264Frame(null, 0n)).toBe(false);
  });
});

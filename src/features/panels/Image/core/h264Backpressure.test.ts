import { describe, expect, it } from 'vitest';
import {
  H264_MAX_PENDING_FRAMES,
  H264_MAX_PENDING_SPAN_MS,
  decodedFrameLatenessMs,
  initialH264PressureState,
  isH264HardLimitExceeded,
  h264StreamPosition,
  isH264StreamDiscontinuity,
  isSupersededH264Output,
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
      mediaLagMs: 2_000,
    });
    const capable = updateH264Pressure(initialH264PressureState(), healthy);

    expect(overloaded.mode).toBe('degraded');
    expect(capable.mode).toBe('normal');
  });

  it('ignores steady transport latency so a bounded pipeline stays normal', () => {
    // Six 720p streams decode with a few hundred ms of constant transport
    // latency while the queues stay empty. That is not overload.
    const transportLatency = { ...healthy, mediaLagMs: 260 };
    let state = initialH264PressureState();
    for (let i = 0; i < 30; i += 1) {
      state = updateH264Pressure(state, transportLatency);
    }
    expect(state.mode).toBe('normal');
  });

  it('recovers from degraded while transport latency stays high', () => {
    // Regression: gating recovery on media lag pinned the panel in degraded
    // mode for the whole session, permanently halving the render rate.
    let state: ReturnType<typeof updateH264Pressure> = {
      mode: 'degraded',
      healthySamples: 0,
    };
    const laggyButIdle = { ...healthy, mediaLagMs: 260 };
    for (let i = 0; i < 20; i += 1) {
      state = updateH264Pressure(state, laggyButIdle);
    }
    expect(state.mode).toBe('normal');
  });

  it('never discards a decoded frame that nothing newer supersedes', () => {
    // Regression: an absolute output deadline discarded every frame once the
    // pipeline's fixed latency exceeded it, freezing the canvas with no error.
    const playback = 1_000_000_000n;
    expect(decodedFrameLatenessMs(playback, 950_000_000n)).toBe(50);
    expect(decodedFrameLatenessMs(playback, 700_000_000n)).toBe(300);
    expect(isSupersededH264Output(700_000_000n, null)).toBe(false);
    expect(isSupersededH264Output(0n, null)).toBe(false);
  });

  it('discards a decoded frame only for an equal-or-newer pending frame', () => {
    expect(isSupersededH264Output(900_000_000n, 950_000_000n)).toBe(true);
    expect(isSupersededH264Output(900_000_000n, 900_000_000n)).toBe(true);
    expect(isSupersededH264Output(950_000_000n, 900_000_000n)).toBe(false);
  });

  it('treats only gaps beyond the observed cadence as a broken reference chain', () => {
    expect(isH264StreamDiscontinuity(33, 33)).toBe(false);
    expect(isH264StreamDiscontinuity(66, 33)).toBe(false);
    expect(isH264StreamDiscontinuity(5_000, 33)).toBe(true);
    // A low-rate stream's normal spacing must not read as a jump.
    expect(isH264StreamDiscontinuity(500, 500)).toBe(false);
    expect(isH264StreamDiscontinuity(2_100, 500)).toBe(true);
  });

  it('before a cadence is observed, a gap above the minimum is a break (m-5: paused seek)', () => {
    // Opened paused on a keyframe, then seeked forward: one frame decoded, no cadence yet. The
    // delta at the new playhead references frames the decoder never saw.
    expect(isH264StreamDiscontinuity(685_000, 0)).toBe(true);
    expect(isH264StreamDiscontinuity(5_000, 0)).toBe(true);
    expect(isH264StreamDiscontinuity(33, 0)).toBe(false);
    expect(isH264StreamDiscontinuity(400, 0)).toBe(false);
    expect(isH264StreamDiscontinuity(0, 33)).toBe(false);
  });

  it('a repair batch sets where the stream stands and its cadence', () => {
    expect(h264StreamPosition([])).toEqual({ lastTimeNs: null, frameIntervalMs: 0 });
    expect(h264StreamPosition([1_000_000_000n])).toEqual({ lastTimeNs: 1_000_000_000n, frameIntervalMs: 0 });
    // SPS/PPS packets share the keyframe's time; they add no gap.
    const position = h264StreamPosition([3_000_000_000n, 3_000_000_000n, 3_033_000_000n, 3_066_000_000n, 3_099_000_000n]);
    expect(position.lastTimeNs).toBe(3_099_000_000n);
    expect(position.frameIntervalMs).toBeCloseTo(33, 6);
    // A paused forward seek right after the repair is a break; the next frame in order is not.
    expect(isH264StreamDiscontinuity(Number(3_132_000_000n - position.lastTimeNs!) / 1e6, position.frameIntervalMs)).toBe(false);
    expect(isH264StreamDiscontinuity(Number(9_000_000_000n - position.lastTimeNs!) / 1e6, position.frameIntervalMs)).toBe(true);
  });
});

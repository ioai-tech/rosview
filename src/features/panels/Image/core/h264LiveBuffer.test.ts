import { describe, expect, it } from 'vitest';
import type { MessageEvent } from '@/core/types/ros';
import { capH264LiveEvents, snapshotH264LiveEvent } from './h264LiveBuffer';
import { H264_MAX_PENDING_FRAMES } from './h264Backpressure';

function makeEvent(ms: number, data: Uint8Array): MessageEvent {
  return {
    topic: '/camera/h264',
    schemaName: 'foxglove.CompressedVideo',
    receiveTime: { sec: Math.floor(ms / 1000), nsec: (ms % 1000) * 1_000_000 },
    message: {
      format: 'h264',
      data,
    },
  };
}

describe('h264LiveBuffer', () => {
  it('snapshots payload views so later mutation is not visible', () => {
    const backing = new Uint8Array([1, 2, 3, 4]);
    const view = backing.subarray(0);
    const snapshot = snapshotH264LiveEvent(makeEvent(0, view));
    backing.set([9, 9, 9, 9]);
    expect((snapshot.message as { data: Uint8Array }).data).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  it('caps an unbounded live buffer to the pending-frame limit', () => {
    const events = Array.from({ length: H264_MAX_PENDING_FRAMES + 25 }, (_, index) =>
      makeEvent(index * 10, new Uint8Array([index])),
    );
    const capped = capH264LiveEvents(events);
    expect(capped.length).toBe(H264_MAX_PENDING_FRAMES);
    expect(capped[0]?.receiveTime).toEqual(events[25]?.receiveTime);
  });
});

import { describe, expect, it } from 'vitest';
import type { MessageEvent as RosMessageEvent } from '@/core/types/ros';
import { isH264MessageEvent, toWorkerFrame } from './messageFrameAdapter';

const receiveTime = { sec: 10, nsec: 0 };
const publishTime = { sec: 9, nsec: 250 };

function makeCompressedImageEvent(data: Uint8Array, format = 'h264'): RosMessageEvent {
  return {
    topic: '/camera/compressed',
    receiveTime,
    publishTime,
    message: { format, data },
    schemaName: 'sensor_msgs/msg/CompressedImage',
  };
}

function makeCompressedVideoEvent(data: Uint8Array, format = 'h264'): RosMessageEvent {
  return {
    topic: '/camera/video',
    receiveTime,
    publishTime,
    message: {
      timestamp: receiveTime,
      frame_id: 'camera_optical',
      format,
      data,
    },
    schemaName: 'foxglove_msgs/msg/CompressedVideo',
  };
}

describe('messageFrameAdapter', () => {
  it('maps CompressedImage and CompressedVideo h264 payloads to the same worker envelope shape', () => {
    const payload = new Uint8Array([0, 0, 0, 1, 0x65, 1, 2, 3]);
    const fromImage = toWorkerFrame(makeCompressedImageEvent(payload));
    const fromVideo = toWorkerFrame(makeCompressedVideoEvent(payload));

    expect(fromImage).not.toBeNull();
    expect(fromVideo).not.toBeNull();
    expect(fromImage!.frame).toMatchObject({
      kind: 'compressed',
      receiveTime,
      format: 'h264',
      publishTime,
    });
    expect(fromVideo!.frame).toMatchObject({
      kind: 'compressed',
      receiveTime,
      publishTime,
      format: 'h264',
    });
    expect(Array.from(fromImage!.frame.data)).toEqual(Array.from(fromVideo!.frame.data));
  });

  it('detects h264 for both CompressedImage and CompressedVideo', () => {
    const payload = new Uint8Array([1]);
    expect(isH264MessageEvent(makeCompressedImageEvent(payload))).toBe(true);
    expect(isH264MessageEvent(makeCompressedVideoEvent(payload))).toBe(true);
    expect(isH264MessageEvent(makeCompressedVideoEvent(payload, 'vp9'))).toBe(false);
  });

  it('keeps borrowed message payloads intact by default', () => {
    const payload = new Uint8Array([1, 2, 3]);

    const prepared = toWorkerFrame(makeCompressedImageEvent(payload));

    expect(prepared).not.toBeNull();
    expect(prepared!.frame.data).not.toBe(payload);
    expect(prepared!.frame.data.buffer).not.toBe(payload.buffer);
    expect(prepared!.transfer).toEqual([prepared!.frame.data.buffer]);
  });

  it('hands off full-span payloads only when ownership is explicit', () => {
    const payload = new Uint8Array([1, 2, 3]);

    const prepared = toWorkerFrame(makeCompressedImageEvent(payload), { transferOwnership: true });

    expect(prepared).not.toBeNull();
    expect(prepared!.frame.data).toBe(payload);
    expect(prepared!.transfer).toEqual([payload.buffer]);
  });
});

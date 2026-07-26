import { describe, expect, it } from 'vitest';
import {
  depthEncodingFromFormat,
  getCompressedKind,
  isCompressedDepthFormat,
  isCompressedVideoMessage,
  isH264CompressedFrameMessage,
  isImagePanelTopicSchema,
  isRawImageTopicSchema,
  normalizeCompressedMime,
  parseCompressedImageFormat,
  prepareImageWorkerBytes,
  sniffCompressedMime,
  snapshotBytes,
  topicNeedsOrderedVideoFrames,
} from './imageTypes';

describe('snapshotBytes', () => {
  it('reuses a stable full-span Uint8Array', () => {
    const input = new Uint8Array([1, 2, 3]);
    expect(snapshotBytes(input)).toBe(input);
  });

  it('copies SharedArrayBuffer-backed views', () => {
    const shared = new SharedArrayBuffer(4);
    const input = new Uint8Array(shared);
    input.set([4, 5, 6, 7]);

    const snapshot = snapshotBytes(input);

    expect(snapshot).not.toBeNull();
    expect(snapshot).not.toBe(input);
    expect(Array.from(snapshot!)).toEqual([4, 5, 6, 7]);

    input[0] = 9;
    expect(Array.from(snapshot!)).toEqual([4, 5, 6, 7]);
  });

  it('copies sliced views to avoid retaining oversized buffers', () => {
    const input = new Uint8Array(new ArrayBuffer(8), 2, 3);
    input.set([7, 8, 9]);

    const snapshot = snapshotBytes(input);

    expect(snapshot).not.toBeNull();
    expect(snapshot).not.toBe(input);
    expect(Array.from(snapshot!)).toEqual([7, 8, 9]);
  });
});

describe('isRawImageTopicSchema', () => {
  it('accepts ROS 1/2 raw Image schemas', () => {
    expect(isRawImageTopicSchema('sensor_msgs/msg/Image')).toBe(true);
    expect(isRawImageTopicSchema('sensor_msgs/Image')).toBe(true);
  });

  it('rejects CompressedImage', () => {
    expect(isRawImageTopicSchema('sensor_msgs/msg/CompressedImage')).toBe(false);
    expect(isRawImageTopicSchema('sensor_msgs/CompressedImage')).toBe(false);
  });

  it('rejects CompressedVideo', () => {
    expect(isRawImageTopicSchema('foxglove_msgs/msg/CompressedVideo')).toBe(false);
  });

  it('rejects unrelated types', () => {
    expect(isRawImageTopicSchema('')).toBe(false);
    expect(isRawImageTopicSchema('sensor_msgs/msg/CameraInfo')).toBe(false);
  });
});

describe('isCompressedVideoMessage', () => {
  it('accepts foxglove CompressedVideo payloads', () => {
    expect(
      isCompressedVideoMessage({
        timestamp: { sec: 1, nsec: 0 },
        frame_id: 'camera',
        format: 'h264',
        data: new Uint8Array([1, 2, 3]),
      }),
    ).toBe(true);
  });

  it('rejects payloads without binary data', () => {
    expect(isCompressedVideoMessage({ format: 'h264', data: [1, 2, 3] })).toBe(false);
  });
});

describe('isH264CompressedFrameMessage', () => {
  it('recognizes h264 CompressedVideo format tokens', () => {
    expect(
      isH264CompressedFrameMessage({
        format: 'h264',
        data: new Uint8Array([0]),
      }),
    ).toBe(true);
  });

  it('does not treat other CompressedVideo codecs as h264', () => {
    expect(
      isH264CompressedFrameMessage({
        format: 'h265',
        data: new Uint8Array([0]),
      }),
    ).toBe(false);
    expect(getCompressedKind('vp9')).toBeNull();
  });
});

describe('topicNeedsOrderedVideoFrames', () => {
  it('returns true for foxglove CompressedVideo schemas', () => {
    expect(topicNeedsOrderedVideoFrames('foxglove_msgs/msg/CompressedVideo')).toBe(true);
    expect(topicNeedsOrderedVideoFrames('foxglove_msgs/msg/CompressedVideo [ros2msg]')).toBe(true);
  });

  it('returns false for JPEG/raw image schemas', () => {
    expect(topicNeedsOrderedVideoFrames('sensor_msgs/msg/CompressedImage')).toBe(false);
    expect(topicNeedsOrderedVideoFrames('sensor_msgs/msg/Image')).toBe(false);
  });
});

describe('isImagePanelTopicSchema', () => {
  it('accepts raw, compressed image, and compressed video schemas', () => {
    expect(isImagePanelTopicSchema('sensor_msgs/msg/Image')).toBe(true);
    expect(isImagePanelTopicSchema('sensor_msgs/msg/CompressedImage')).toBe(true);
    expect(isImagePanelTopicSchema('foxglove_msgs/msg/CompressedVideo')).toBe(true);
  });

  it('rejects unrelated schemas', () => {
    expect(isImagePanelTopicSchema('sensor_msgs/msg/CameraInfo')).toBe(false);
  });
});

describe('parseCompressedImageFormat', () => {
  it('parses jpeg color transport strings', () => {
    expect(parseCompressedImageFormat('rgb8; jpeg compressed bgr8')).toEqual({
      rawEncoding: 'rgb8',
      transport: 'jpeg compressed bgr8',
      depthCodec: undefined,
      bitmapKind: 'jpeg',
    });
  });

  it('parses compressed depth transport strings', () => {
    expect(parseCompressedImageFormat('16UC1; compressedDepth')).toEqual({
      rawEncoding: '16uc1',
      transport: 'compressedDepth',
      depthCodec: 'png',
      bitmapKind: null,
    });
    expect(parseCompressedImageFormat('32FC1; compressedDepth')).toMatchObject({
      rawEncoding: '32fc1',
      depthCodec: 'png',
    });
    expect(parseCompressedImageFormat('16UC1; compressedDepth rvl')).toMatchObject({
      rawEncoding: '16uc1',
      depthCodec: 'rvl',
    });
  });
});

describe('isCompressedDepthFormat', () => {
  it('recognizes ROS compressed depth formats', () => {
    expect(isCompressedDepthFormat('16UC1; compressedDepth')).toBe(true);
    expect(isCompressedDepthFormat('32FC1; compressedDepth')).toBe(true);
    expect(isCompressedDepthFormat('rgb8; jpeg compressed bgr8')).toBe(false);
  });
});

describe('depthEncodingFromFormat', () => {
  it('returns normalized depth encodings for compressed depth formats', () => {
    expect(depthEncodingFromFormat('16UC1; compressedDepth')).toBe('16uc1');
    expect(depthEncodingFromFormat('32FC1; compressedDepth')).toBe('32fc1');
    expect(depthEncodingFromFormat('rgb8; jpeg compressed bgr8')).toBeNull();
  });
});

describe('sniffCompressedMime', () => {
  it('detects jpeg and png magic bytes', () => {
    expect(sniffCompressedMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(
      sniffCompressedMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    ).toBe('image/png');
  });
});

describe('normalizeCompressedMime', () => {
  it('falls back to JPEG for raw-style format tokens on CompressedImage', () => {
    expect(getCompressedKind('bgr8')).toBeNull();
    expect(normalizeCompressedMime('bgr8', new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(normalizeCompressedMime('rgb8', new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
  });

  it('does not treat compressed depth formats as JPEG', () => {
    expect(() => normalizeCompressedMime('16UC1; compressedDepth')).toThrow(/Compressed depth/);
  });

  it('sniffs PNG when raw encoding token is unknown but payload is PNG', () => {
    expect(
      normalizeCompressedMime('16UC1', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    ).toBe('image/png');
  });

  it('still recognizes explicit codec hints in compound format strings', () => {
    expect(normalizeCompressedMime('rgb8; jpeg compressed bgr8')).toBe('image/jpeg');
    expect(normalizeCompressedMime('image/png')).toBe('image/png');
  });
});

describe('prepareImageWorkerBytes', () => {
  it('copies SharedArrayBuffer-backed views before crossing into the render worker', () => {
    const shared = new SharedArrayBuffer(4);
    const input = new Uint8Array(shared);
    input.set([1, 2, 3, 4]);

    const prepared = prepareImageWorkerBytes(input, { transferOwnership: true });

    expect(prepared).not.toBeNull();
    expect(prepared!.data).not.toBe(input);
    expect(prepared!.data.buffer).not.toBe(shared);
    expect(prepared!.transfer).toEqual([prepared!.data.buffer]);
    expect(Array.from(prepared!.data)).toEqual([1, 2, 3, 4]);

    input[0] = 9;
    expect(prepared!.data[0]).toBe(1);
  });

  it('copies full ArrayBuffer-backed views so worker transfer cannot detach source messages', () => {
    const input = new Uint8Array([1, 2, 3]);

    const prepared = prepareImageWorkerBytes(input);

    expect(prepared).not.toBeNull();
    expect(prepared!.data).not.toBe(input);
    expect(prepared!.data.buffer).not.toBe(input.buffer);
    expect(prepared!.transfer).toEqual([prepared!.data.buffer]);
    expect(Array.from(prepared!.data)).toEqual([1, 2, 3]);
  });

  it('transfers a full ArrayBuffer-backed view when ownership is explicitly handed off', () => {
    const input = new Uint8Array([4, 5, 6]);

    const prepared = prepareImageWorkerBytes(input, { transferOwnership: true });

    expect(prepared).not.toBeNull();
    expect(prepared!.data).toBe(input);
    expect(prepared!.data.buffer).toBe(input.buffer);
    expect(prepared!.transfer).toEqual([input.buffer]);
  });

  it('copies sliced ArrayBuffer-backed views into a compact transfer buffer even with ownership', () => {
    const input = new Uint8Array(new ArrayBuffer(8), 2, 3);
    input.set([7, 8, 9]);

    const prepared = prepareImageWorkerBytes(input, { transferOwnership: true });

    expect(prepared).not.toBeNull();
    expect(prepared!.data).not.toBe(input);
    expect(prepared!.data.byteOffset).toBe(0);
    expect(prepared!.data.byteLength).toBe(3);
    expect(prepared!.transfer).toEqual([prepared!.data.buffer]);
    expect(Array.from(prepared!.data)).toEqual([7, 8, 9]);
  });
});

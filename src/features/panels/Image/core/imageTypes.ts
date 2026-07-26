import type { Time } from '@/core/types/ros';
import {
  matchesRosSchema,
  ROS_MSG_FOXGLOVE_COMPRESSED_VIDEO,
} from '@/shared/ros/rosMessageTypes';

export interface RawImageMessage {
  encoding: string;
  width: number;
  height: number;
  step?: number;
  is_bigendian?: boolean;
  data: Uint8Array;
}

export interface CompressedImageMessage {
  format: string;
  data: Uint8Array;
}

/** foxglove_msgs/msg/CompressedVideo — Annex B H264/H265/VP9/AV1 bitstream chunks. */
export interface CompressedVideoMessage {
  timestamp?: Time;
  frame_id?: string;
  format: string;
  data: Uint8Array;
}

export interface ImageSurfaceStatus {
  phase: 'idle' | 'decoding' | 'ready' | 'error';
  width?: number;
  height?: number;
  encoding?: string;
  receiveTime?: Time;
  message?: string;
}

function isSharedArrayBufferBacked(data: Uint8Array): boolean {
  return typeof globalThis.SharedArrayBuffer !== 'undefined' && data.buffer instanceof globalThis.SharedArrayBuffer;
}

export function snapshotBytes(data: unknown): Uint8Array<ArrayBuffer> | null {
  if (!(data instanceof Uint8Array)) {
    return null;
  }
  if (
    !isSharedArrayBufferBacked(data) &&
    data.byteOffset === 0 &&
    data.byteLength === data.buffer.byteLength
  ) {
    return data as Uint8Array<ArrayBuffer>;
  }
  const copy = new Uint8Array(new ArrayBuffer(data.byteLength));
  copy.set(data);
  return copy;
}

export interface PrepareImageWorkerBytesOptions {
  /**
   * The caller gives the worker exclusive ownership of this payload. Only a
   * full-span ArrayBuffer view can be transferred without first copying.
   */
  transferOwnership?: boolean;
}

export function prepareImageWorkerBytes(
  data: unknown,
  options: PrepareImageWorkerBytesOptions = {},
): { data: Uint8Array; transfer: Transferable[] } | null {
  if (!(data instanceof Uint8Array)) {
    return null;
  }
  if (
    options.transferOwnership === true &&
    data.buffer instanceof ArrayBuffer &&
    data.byteOffset === 0 &&
    data.byteLength === data.buffer.byteLength
  ) {
    return { data, transfer: [data.buffer] };
  }
  // Borrowed payloads must not be detached. SAB-backed views and sliced views
  // may also alias storage that remains in use, so compact-copy them even when
  // ownership transfer was requested.
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  return { data: copy, transfer: [copy.buffer] };
}

export function isCompressedImageMessage(message: unknown): message is CompressedImageMessage {
  return Boolean(
    message &&
      typeof message === 'object' &&
      'format' in message &&
      'data' in message &&
      (message as { data?: unknown }).data instanceof Uint8Array,
  );
}

export function isCompressedVideoMessage(message: unknown): message is CompressedVideoMessage {
  return Boolean(
    message &&
      typeof message === 'object' &&
      'format' in message &&
      'data' in message &&
      (message as { data?: unknown }).data instanceof Uint8Array,
  );
}

export type CompressedFrameMessage = CompressedImageMessage | CompressedVideoMessage;

export function isCompressedFrameMessage(message: unknown): message is CompressedFrameMessage {
  return isCompressedImageMessage(message) || isCompressedVideoMessage(message);
}

export function getCompressedFrameFormat(message: CompressedFrameMessage): string {
  return message.format;
}

export function isH264CompressedFrameMessage(message: unknown): boolean {
  if (!isCompressedFrameMessage(message)) {
    return false;
  }
  return getCompressedKind(getCompressedFrameFormat(message)) === 'h264';
}

export function isRawImageMessage(message: unknown): message is RawImageMessage {
  return Boolean(
    message &&
      typeof message === 'object' &&
      'encoding' in message &&
      'width' in message &&
      'height' in message &&
      'data' in message &&
      (message as { data?: unknown }).data instanceof Uint8Array,
  );
}

/** ROS image_transport / CompressedImage.format tokens we can feed to Blob + createImageBitmap */
export type CompressedImageKind =
  | 'jpeg'
  | 'png'
  | 'webp'
  | 'gif'
  | 'avif'
  | 'bmp'
  | 'h264'
  | null;

export type CompressedDepthCodec = 'png' | 'rvl';

export type DepthImageEncoding = '16uc1' | '32fc1';

export interface ParsedCompressedImageFormat {
  rawEncoding?: string;
  transport?: string;
  depthCodec?: CompressedDepthCodec;
  bitmapKind: CompressedImageKind;
}

const COMPRESSED_KIND_RE = /\b(jpeg|jpg|png|webp|gif|avif|bmp|h264)\b/i;

const RAW_ENCODING_TOKENS = new Set([
  '16uc1',
  '32fc1',
  'mono16',
  'mono8',
  '8uc1',
  'rgb8',
  'bgr8',
  'rgba8',
  'bgra8',
  '8uc3',
]);

function normalizeFormatToken(token: string): string {
  return token.trim().toLowerCase();
}

function depthEncodingFromRawToken(token: string): DepthImageEncoding | null {
  const lower = normalizeFormatToken(token);
  if (lower === '16uc1' || lower === 'mono16') {
    return '16uc1';
  }
  if (lower === '32fc1') {
    return '32fc1';
  }
  return null;
}

function parseCompressedDepthTransport(transport: string): CompressedDepthCodec | undefined {
  const lower = transport.trim().toLowerCase();
  if (!lower.includes('compresseddepth')) {
    return undefined;
  }
  if (/\brvl\b/.test(lower)) {
    return 'rvl';
  }
  return 'png';
}

/**
 * Structured parse of `sensor_msgs/CompressedImage.format`.
 * Handles `rgb8; jpeg compressed bgr8`, `16UC1; compressedDepth`, etc.
 */
export function parseCompressedImageFormat(format: string): ParsedCompressedImageFormat {
  const trimmed = format.trim();
  const parts = trimmed.split(';').map((part) => part.trim()).filter(Boolean);
  const rawEncoding = parts[0] ? normalizeFormatToken(parts[0]) : undefined;
  const transport = parts.length > 1 ? parts.slice(1).join(';').trim() : undefined;
  const depthCodec = transport ? parseCompressedDepthTransport(transport) : undefined;

  return {
    rawEncoding,
    transport,
    depthCodec,
    bitmapKind: getCompressedKind(trimmed),
  };
}

export function isCompressedDepthFormat(format: string): boolean {
  const parsed = parseCompressedImageFormat(format);
  return parsed.depthCodec != null && depthEncodingFromRawToken(parsed.rawEncoding ?? '') != null;
}

export function depthEncodingFromFormat(format: string): DepthImageEncoding | null {
  if (!isCompressedDepthFormat(format)) {
    return null;
  }
  return depthEncodingFromRawToken(parseCompressedImageFormat(format).rawEncoding ?? '');
}

/**
 * Classify `sensor_msgs/CompressedImage.format` for decode routing.
 * Handles `rgb8; jpeg compressed bgr8`, `jpeg`, `image/png`, `h264`, etc.
 */
export function getCompressedKind(format: string): CompressedImageKind {
  const lower = format.trim().toLowerCase();
  if (lower === 'h264' || lower.includes('h264')) {
    return 'h264';
  }
  const m = format.match(COMPRESSED_KIND_RE);
  if (!m || !m[1]) {
    return null;
  }
  const token = m[1].toLowerCase();
  if (token === 'jpg' || token === 'jpeg') {
    return 'jpeg';
  }
  if (token === 'png' || token === 'webp' || token === 'gif' || token === 'avif' || token === 'bmp') {
    return token;
  }
  if (token === 'h264') {
    return 'h264';
  }
  return null;
}

export function sniffCompressedMime(data: Uint8Array): string | null {
  if (data.byteLength >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    data.byteLength >= 8 &&
    data[0] === 0x89 &&
    data[1] === 0x50 &&
    data[2] === 0x4e &&
    data[3] === 0x47 &&
    data[4] === 0x0d &&
    data[5] === 0x0a &&
    data[6] === 0x1a &&
    data[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (
    data.byteLength >= 12 &&
    data[0] === 0x52 &&
    data[1] === 0x49 &&
    data[2] === 0x46 &&
    data[3] === 0x46 &&
    data[8] === 0x57 &&
    data[9] === 0x45 &&
    data[10] === 0x42 &&
    data[11] === 0x50
  ) {
    return 'image/webp';
  }
  return null;
}

export function normalizeCompressedMime(format: string, data?: Uint8Array): string {
  if (isCompressedDepthFormat(format)) {
    throw new Error(`Compressed depth format must not use bitmap MIME routing: ${format}`);
  }

  const kind = getCompressedKind(format);
  if (kind === 'jpeg') {
    return 'image/jpeg';
  }
  if (kind === 'png' || kind === 'webp' || kind === 'gif' || kind === 'avif' || kind === 'bmp') {
    return `image/${kind}`;
  }

  const firstToken = format
    .split(';')[0]
    ?.trim()
    .split(/\s+/)[0]
    ?.toLowerCase();

  if (!firstToken) {
    return data ? sniffCompressedMime(data) ?? 'image/jpeg' : 'image/jpeg';
  }
  if (firstToken.startsWith('image/')) {
    return firstToken;
  }
  if (firstToken === 'jpg') {
    return 'image/jpeg';
  }
  if (RAW_ENCODING_TOKENS.has(firstToken)) {
    const sniffed = data ? sniffCompressedMime(data) : null;
    if (sniffed) {
      return sniffed;
    }
    throw new Error(`Unsupported compressed image format token: ${format}`);
  }
  // Unknown tokens (e.g. `bgr8` mislabeled on CompressedImage): many bags still carry JPEG bytes.
  return data ? sniffCompressedMime(data) ?? 'image/jpeg' : 'image/jpeg';
}

/**
 * Whether a topic schema is ROS `sensor_msgs/Image` (raw), not `CompressedImage`.
 * Used by settings UI so raw/depth controls appear from topic metadata, not only after a frame arrives.
 */
export function isRawImageTopicSchema(schemaName: string): boolean {
  const trimmed = schemaName.trim();
  if (!trimmed) {
    return false;
  }
  const lower = trimmed.toLowerCase();
  if (lower.includes('compressedimage')) {
    return false;
  }
  if (lower.includes('compressedvideo')) {
    return false;
  }
  return /(^|\/)sensor_msgs\/(msg\/)?image$/i.test(trimmed);
}

/** Topic type tokens accepted by the Image panel topic picker. */
export const IMAGE_PANEL_TOPIC_INCLUDES = ['image', 'CompressedImage', 'CompressedVideo'] as const;

/**
 * Whether a topic schema carries ordered video chunks (H264/H265/VP9/AV1) that
 * must not be coalesced to latest-only during playback prefetch.
 */
export function topicNeedsOrderedVideoFrames(schemaName: string): boolean {
  const trimmed = schemaName.trim();
  if (!trimmed) {
    return false;
  }
  if (matchesRosSchema(trimmed, ROS_MSG_FOXGLOVE_COMPRESSED_VIDEO)) {
    return true;
  }
  return trimmed.toLowerCase().includes('compressedvideo');
}

export function isImagePanelTopicSchema(schemaName: string): boolean {
  const lower = schemaName.trim().toLowerCase();
  if (!lower) {
    return false;
  }
  if (isRawImageTopicSchema(schemaName)) {
    return true;
  }
  if (lower.includes('compressedimage')) {
    return true;
  }
  if (lower.includes('compressedvideo')) {
    return true;
  }
  return false;
}

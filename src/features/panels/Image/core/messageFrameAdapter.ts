import type { MessageEvent as RosMessageEvent } from '@/core/types/ros';
import type { ImageWorkerFrameEnvelope } from './imageWorkerProtocol';
import {
  getCompressedFrameFormat,
  isCompressedFrameMessage,
  isH264CompressedFrameMessage,
  isRawImageMessage,
  prepareImageWorkerBytes,
} from './imageTypes';

export type PreparedImageWorkerFrame = {
  frame: ImageWorkerFrameEnvelope;
  transfer: Transferable[];
};

export interface ToWorkerFrameOptions {
  transferOwnership?: boolean;
}

export function toWorkerFrame(
  messageEvent: RosMessageEvent,
  options: ToWorkerFrameOptions = {},
): PreparedImageWorkerFrame | null {
  const message = messageEvent.message;
  if (isCompressedFrameMessage(message)) {
    const payload = prepareImageWorkerBytes(message.data, options);
    if (!payload) {
      return null;
    }
    return {
      frame: {
        kind: 'compressed',
        receiveTime: messageEvent.receiveTime,
        publishTime: messageEvent.publishTime,
        format: getCompressedFrameFormat(message),
        data: payload.data,
      },
      transfer: payload.transfer,
    };
  }
  if (isRawImageMessage(message)) {
    const payload = prepareImageWorkerBytes(message.data, options);
    if (!payload) {
      return null;
    }
    return {
      frame: {
        kind: 'raw',
        receiveTime: messageEvent.receiveTime,
        publishTime: messageEvent.publishTime,
        encoding: message.encoding,
        width: message.width,
        height: message.height,
        step: message.step,
        isBigEndian: message.is_bigendian,
        data: payload.data,
      },
      transfer: payload.transfer,
    };
  }
  return null;
}

export function isH264MessageEvent(messageEvent: RosMessageEvent): boolean {
  return isH264CompressedFrameMessage(messageEvent.message);
}

export function getH264MessagePayload(messageEvent: RosMessageEvent): Uint8Array | null {
  const message = messageEvent.message;
  if (!isCompressedFrameMessage(message)) {
    return null;
  }
  if (!isH264CompressedFrameMessage(message)) {
    return null;
  }
  return message.data;
}

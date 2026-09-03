import type { MessageEvent as RosMessageEvent } from '@/core/types/ros';
import { toNano } from '@/shared/utils/time';
import { H264_MAX_PENDING_FRAMES, H264_MAX_PENDING_SPAN_MS } from './h264Backpressure';
import { isH264MessageEvent } from './messageFrameAdapter';

export function snapshotH264LiveEvent(event: RosMessageEvent): RosMessageEvent {
  const message = event.message;
  if (!message || typeof message !== 'object' || !('data' in message)) {
    return event;
  }
  const data = (message as { data?: unknown }).data;
  if (!(data instanceof Uint8Array)) {
    return event;
  }
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  return {
    ...event,
    message: {
      ...(message as Record<string, unknown>),
      data: copy,
    },
  };
}

export function capH264LiveEvents(events: RosMessageEvent[]): RosMessageEvent[] {
  if (events.length === 0) {
    return events;
  }
  let next = events.length > H264_MAX_PENDING_FRAMES
    ? events.slice(events.length - H264_MAX_PENDING_FRAMES)
    : events;
  const newest = next.at(-1);
  if (!newest) {
    return next;
  }
  const newestNs = toNano(newest.receiveTime);
  const minNs = newestNs - BigInt(H264_MAX_PENDING_SPAN_MS) * 1_000_000n;
  const firstKept = next.findIndex((event) => toNano(event.receiveTime) >= minNs);
  if (firstKept > 0) {
    next = next.slice(firstKept);
  }
  return next;
}

export function pushH264LiveEvent(
  events: RosMessageEvent[],
  event: RosMessageEvent,
): RosMessageEvent[] {
  const next = isH264MessageEvent(event) ? snapshotH264LiveEvent(event) : event;
  events.push(next);
  const capped = capH264LiveEvents(events);
  if (capped !== events) {
    events.length = 0;
    events.push(...capped);
  }
  return events;
}

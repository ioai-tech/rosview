import { rangeQueryCache } from '@/core/analysis/rangeQueryCache';
import type { GetMessagesInTimeRangeArgs, Player } from '@/core/types/player';
import type { MessageEvent, Time } from '@/core/types/ros';
import { fromNano, toNano } from '@/shared/utils/time';

export interface PlotRangeReadProgress {
  completed: number;
  total: number;
  messages: number;
}

export interface PlotRangeReadBatch {
  messages: MessageEvent[];
  progress: PlotRangeReadProgress;
}

export interface PlotRangeReadArgs {
  player: Player;
  start: Time;
  end: Time;
  topics: string[];
  signal?: AbortSignal;
  onProgress?: (progress: PlotRangeReadProgress) => void;
  /** Stop accumulating after this many messages (non-indexed sources). */
  maxMessages?: number;
}

export interface PlotRangeIncrementalReadArgs extends PlotRangeReadArgs {
  onBatch?: (batch: PlotRangeReadBatch) => void;
}

const DEFAULT_SEGMENTS = 24;

function makeSegments(start: Time, end: Time): Array<{ start: Time; end: Time }> {
  const startNs = toNano(start);
  const endNs = toNano(end);
  if (endNs <= startNs) return [{ start, end }];
  const span = endNs - startNs;
  const segmentCount = Number(span) < 10_000_000_000 ? 1 : DEFAULT_SEGMENTS;
  const step = span / BigInt(segmentCount);
  const segments: Array<{ start: Time; end: Time }> = [];
  let cursor = startNs;
  for (let i = 0; i < segmentCount; i++) {
    const segmentEnd = i === segmentCount - 1 ? endNs : cursor + step;
    segments.push({ start: fromNano(cursor), end: fromNano(segmentEnd) });
    cursor = segmentEnd + 1n;
  }
  return segments;
}

function messageKey(event: MessageEvent): string {
  const receive = toNano(event.receiveTime).toString();
  const publish = event.publishTime ? toNano(event.publishTime).toString() : '';
  return `${event.topic}|${event.schemaName}|${receive}|${publish}`;
}

async function readSegment(
  player: Player,
  args: GetMessagesInTimeRangeArgs,
  signal?: AbortSignal,
): Promise<MessageEvent[]> {
  if (!player.getMessagesInTimeRange) return [];
  if (signal) {
    return player.getMessagesInTimeRange({ ...args, signal });
  }
  return rangeQueryCache.getOrCreate(player, args);
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException('Plot range read aborted', 'AbortError');
  }
}

function sortMessages(messages: MessageEvent[]): MessageEvent[] {
  return messages.sort((a, b) => {
    const diff = toNano(a.receiveTime) - toNano(b.receiveTime);
    return diff < 0n ? -1 : diff > 0n ? 1 : a.topic.localeCompare(b.topic);
  });
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, 0));
}

export async function readPlotRange({
  player,
  start,
  end,
  topics,
  signal,
  onProgress,
  maxMessages,
}: PlotRangeReadArgs): Promise<MessageEvent[]> {
  if (topics.length === 0 || !player.getMessagesInTimeRange) return [];
  const uniqueTopics = Array.from(new Set(topics)).sort();
  const segments = makeSegments(start, end);
  const deduped = new Map<string, MessageEvent>();
  const messageLimit = maxMessages != null && maxMessages > 0 ? maxMessages : undefined;

  for (let i = 0; i < segments.length; i++) {
    assertNotAborted(signal);
    if (messageLimit != null && deduped.size >= messageLimit) {
      break;
    }
    const segment = segments[i];
    const messages = await readSegment(player, {
      start: segment.start,
      end: segment.end,
      topics: uniqueTopics,
    }, signal);
    for (const event of messages) {
      deduped.set(messageKey(event), event);
      if (messageLimit != null && deduped.size >= messageLimit) {
        break;
      }
    }
    onProgress?.({ completed: i + 1, total: segments.length, messages: deduped.size });
    await yieldToEventLoop();
  }

  return sortMessages([...deduped.values()]);
}

function appendNewMessages(
  deduped: Map<string, MessageEvent>,
  messages: MessageEvent[],
  messageLimit?: number,
): MessageEvent[] {
  const out: MessageEvent[] = [];
  for (const event of messages) {
    if (messageLimit != null && deduped.size >= messageLimit) {
      break;
    }
    const key = messageKey(event);
    if (deduped.has(key)) {
      continue;
    }
    deduped.set(key, event);
    out.push(event);
  }
  return out;
}

export async function readPlotRangeIncremental({
  player,
  start,
  end,
  topics,
  signal,
  onProgress,
  onBatch,
  maxMessages,
}: PlotRangeIncrementalReadArgs): Promise<MessageEvent[]> {
  if (topics.length === 0 || (!player.getMessagesInTimeRange && !player.streamMessagesInTimeRange)) return [];
  const uniqueTopics = Array.from(new Set(topics)).sort();
  const segments = makeSegments(start, end);
  const deduped = new Map<string, MessageEvent>();
  const messageLimit = maxMessages != null && maxMessages > 0 ? maxMessages : undefined;

  for (let i = 0; i < segments.length; i++) {
    assertNotAborted(signal);
    if (messageLimit != null && deduped.size >= messageLimit) {
      break;
    }
    const segment = segments[i];
    if (player.streamMessagesInTimeRange) {
      for await (const messages of player.streamMessagesInTimeRange({
        start: segment.start,
        end: segment.end,
        topics: uniqueTopics,
        maxMessages: messageLimit == null ? undefined : messageLimit - deduped.size,
        signal,
      })) {
        assertNotAborted(signal);
        const added = appendNewMessages(deduped, messages, messageLimit);
        const progress = { completed: i, total: segments.length, messages: deduped.size };
        if (added.length > 0) {
          onBatch?.({ messages: added, progress });
        }
        onProgress?.(progress);
        if (messageLimit != null && deduped.size >= messageLimit) {
          break;
        }
        await yieldToEventLoop();
      }
    } else {
      const messages = await readSegment(player, {
        start: segment.start,
        end: segment.end,
        topics: uniqueTopics,
      }, signal);
      const added = appendNewMessages(deduped, messages, messageLimit);
      const progress = { completed: i + 1, total: segments.length, messages: deduped.size };
      if (added.length > 0) {
        onBatch?.({ messages: added, progress });
      }
      onProgress?.(progress);
      await yieldToEventLoop();
      continue;
    }

    const progress = { completed: i + 1, total: segments.length, messages: deduped.size };
    onProgress?.(progress);
    assertNotAborted(signal);
    await yieldToEventLoop();
  }

  return sortMessages([...deduped.values()]);
}

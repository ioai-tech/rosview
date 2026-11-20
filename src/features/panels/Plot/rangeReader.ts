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
  /**
   * Read the range coarse to fine around this time, when the source can say where it is stored
   * apart (`Player.getReadBoundaries`): the plot shows the shape of the whole range after a
   * fraction of its bytes, and the detail near `focus` first, instead of filling it left to right.
   */
  focus?: Time;
}

/** At most this many pieces: finer adds per-read overhead without showing more of the range. */
const MAX_SPREAD_PIECES = 512;
/** Spread reads per read near the focus: the whole range takes shape first, the playhead keeps detail. */
const SPREAD_PER_NEAR = 3;
/** Pieces read at once (each a short cursor; two keep the link busy between them). */
const SPREAD_CONCURRENCY = 2;

function bitReverse(i: number, bits: number): number {
  let r = 0;
  for (let b = 0; b < bits; b++) r = (r << 1) | ((i >> b) & 1);
  return r;
}

/**
 * The order to read `count` pieces in: the piece at `focusIndex`, then {@link SPREAD_PER_NEAR} pieces
 * of an even spread over the whole range (bit-reversed order: after any prefix the pieces read are
 * about evenly spaced) for each next piece outward from the focus (detail where the playhead is).
 * Each piece once.
 */
export function spreadReadOrder(count: number, focusIndex: number): number[] {
  if (count <= 0) return [];
  const focus = Math.min(count - 1, Math.max(0, focusIndex));
  const seen = new Uint8Array(count);
  const order: number[] = [];
  const take = (i: number): boolean => {
    if (i < 0 || i >= count || seen[i]) return false;
    seen[i] = 1;
    order.push(i);
    return true;
  };
  let bits = 0;
  while (1 << bits < count) bits++;
  const spreadTotal = 1 << bits;
  let spreadNext = 0;
  let near = 0; // 0, +1, -1, +2, -2, ... from the focus
  const nextNear = (): void => {
    while (near <= 2 * count) {
      const step = near === 0 ? 0 : near % 2 === 1 ? (near + 1) / 2 : -near / 2;
      near++;
      if (take(focus + step)) return;
    }
  };
  const nextSpread = (): void => {
    while (spreadNext < spreadTotal) {
      const i = Math.floor((bitReverse(spreadNext++, bits) / spreadTotal) * count);
      if (take(i)) return;
    }
  };
  while (order.length < count) {
    nextNear();
    for (let i = 0; i < SPREAD_PER_NEAR && order.length < count; i++) nextSpread();
  }
  return order;
}

/** Pieces `[b_i, b_{i+1})` of `[start, end]`, at most {@link MAX_SPREAD_PIECES}. */
function piecesFromBoundaries(boundaries: Time[], end: Time): Array<{ start: Time; end: Time }> {
  const stride = Math.ceil(boundaries.length / MAX_SPREAD_PIECES);
  const starts = boundaries.filter((_, i) => i % stride === 0).map(toNano);
  const endNs = toNano(end);
  return starts.map((s, i) => ({
    start: fromNano(s),
    end: fromNano(i + 1 < starts.length ? starts[i + 1] - 1n : endNs),
  }));
}

async function readSpread(
  args: PlotRangeIncrementalReadArgs & { topics: string[] },
  pieces: Array<{ start: Time; end: Time }>,
  focus: Time,
): Promise<MessageEvent[]> {
  const { player, signal, onProgress, onBatch, maxMessages } = args;
  const deduped = new Map<string, MessageEvent>();
  const messageLimit = maxMessages != null && maxMessages > 0 ? maxMessages : undefined;
  const focusNs = toNano(focus);
  const focusIndex = Math.max(0, pieces.findIndex((p) => toNano(p.end) >= focusNs));
  const order = spreadReadOrder(pieces.length, focusIndex);
  let next = 0;
  let completed = 0;
  const full = (): boolean => messageLimit != null && deduped.size >= messageLimit;
  const lane = async (): Promise<void> => {
    while (next < order.length && !full()) {
      assertNotAborted(signal);
      const piece = pieces[order[next++]];
      for await (const messages of player.streamMessagesInTimeRange!({ ...piece, topics: args.topics, signal })) {
        assertNotAborted(signal);
        const added = appendNewMessages(deduped, messages, messageLimit);
        if (added.length > 0) {
          onBatch?.({ messages: added, progress: { completed, total: pieces.length, messages: deduped.size } });
        }
        if (full()) break;
      }
      completed++;
      onProgress?.({ completed, total: pieces.length, messages: deduped.size });
      await yieldToEventLoop();
    }
  };
  await Promise.all(Array.from({ length: Math.min(SPREAD_CONCURRENCY, order.length) }, lane));
  assertNotAborted(signal);
  return sortMessages([...deduped.values()]);
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
  focus,
}: PlotRangeIncrementalReadArgs): Promise<MessageEvent[]> {
  if (topics.length === 0 || (!player.getMessagesInTimeRange && !player.streamMessagesInTimeRange)) return [];
  const uniqueTopics = Array.from(new Set(topics)).sort();
  if (focus && player.streamMessagesInTimeRange && player.getReadBoundaries) {
    const boundaries = await player.getReadBoundaries({ start, end, topics: uniqueTopics });
    assertNotAborted(signal);
    if (boundaries && boundaries.length >= 3) {
      return readSpread(
        { player, start, end, topics: uniqueTopics, signal, onProgress, onBatch, maxMessages },
        piecesFromBoundaries(boundaries, end),
        focus,
      );
    }
  }
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

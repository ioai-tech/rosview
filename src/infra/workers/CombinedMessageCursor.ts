import type { MessageEvent, Time } from '@/core/types/ros';
import { toNano } from '@/shared/utils/time';
import type { IMessageCursor } from './types';

const SOURCE_INDEX = Symbol('rosviewCombinedSourceIndex');

type TaggedMessageEvent = MessageEvent & { [SOURCE_INDEX]?: number };

/**
 * Stamp a message with the index of the member source (into
 * `CombinedSourceProxy`'s member list) that produced it. This is a
 * main-thread-only marker (never serialized across a Worker boundary) used
 * to route `resolveMessageBatch`/`resolveMessageForHighFrequencyLane` calls
 * back to the correct member — required because SharedArrayBuffer payload
 * rings are per-Worker.
 */
export function tagMessageSourceIndex<T extends MessageEvent>(message: T, sourceIndex: number): T {
  (message as TaggedMessageEvent)[SOURCE_INDEX] = sourceIndex;
  return message;
}

export function getMessageSourceIndex(message: MessageEvent): number | undefined {
  return (message as TaggedMessageEvent)[SOURCE_INDEX];
}

function receiveTimeNs(message: MessageEvent): bigint {
  return toNano(message.receiveTime);
}

function compareByReceiveTime(a: MessageEvent, b: MessageEvent): number {
  const diff = receiveTimeNs(a) - receiveTimeNs(b);
  if (diff < 0n) return -1;
  if (diff > 0n) return 1;
  return 0;
}

export interface CombinedCursorChild {
  cursor: IMessageCursor<unknown>;
  /** Index into `CombinedSourceProxy`'s member list. */
  sourceIndex: number;
}

/**
 * Merges N child cursors (one per member file/source) into a single
 * time-ordered stream. Batches are fetched from every child in parallel
 * (each child lives in its own Worker, so this overlaps I/O/decoding across
 * files) and merge-sorted by `receiveTime` before being handed back.
 */
export class CombinedMessageCursor implements IMessageCursor<unknown> {
  private _children: CombinedCursorChild[];
  private _pendingNext: Array<MessageEvent | undefined>;

  constructor(children: CombinedCursorChild[]) {
    this._children = children;
    this._pendingNext = children.map(() => undefined);
  }

  async next(): Promise<IteratorResult<MessageEvent>> {
    await Promise.all(
      this._children.map(async (child, i) => {
        if (this._pendingNext[i] !== undefined) return;
        const result = await child.cursor.next();
        if (!result.done) {
          this._pendingNext[i] = tagMessageSourceIndex(result.value, child.sourceIndex);
        }
      }),
    );

    let minIndex = -1;
    let minTimeNs: bigint | undefined;
    for (let i = 0; i < this._pendingNext.length; i++) {
      const msg = this._pendingNext[i];
      if (!msg) continue;
      const t = receiveTimeNs(msg);
      if (minTimeNs === undefined || t < minTimeNs) {
        minTimeNs = t;
        minIndex = i;
      }
    }
    if (minIndex === -1) {
      return { done: true, value: undefined };
    }
    const value = this._pendingNext[minIndex]!;
    this._pendingNext[minIndex] = undefined;
    return { done: false, value };
  }

  async nextBatch(
    durationMs: number,
    options?: { maxMessages?: number; maxWallTimeMs?: number; endTime?: Time; waitForData?: boolean },
  ): Promise<MessageEvent[]> {
    if (this._children.length === 0) {
      return [];
    }
    const batches = await Promise.all(
      this._children.map(async (child) => {
        const batch = await child.cursor.nextBatch(durationMs, options);
        for (const message of batch) {
          tagMessageSourceIndex(message, child.sourceIndex);
        }
        return batch;
      }),
    );
    if (batches.length === 1) {
      return batches[0];
    }
    return batches.flat().sort(compareByReceiveTime);
  }

  async end(): Promise<void> {
    await Promise.all(this._children.map((child) => child.cursor.end()));
  }
}

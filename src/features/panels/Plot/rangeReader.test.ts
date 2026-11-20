import { describe, expect, it, vi } from 'vitest';
import type { Player } from '@/core/types/player';
import type { MessageEvent } from '@/core/types/ros';
import { readPlotRangeIncremental, spreadReadOrder } from './rangeReader';

function event(sec: number, data = sec): MessageEvent {
  return {
    topic: '/value',
    receiveTime: { sec, nsec: 0 },
    publishTime: { sec, nsec: 0 },
    message: { data },
    schemaName: 'std_msgs/msg/Float64',
  };
}

function playerWithStream(batches: MessageEvent[][]): Player {
  return {
    streamMessagesInTimeRange: async function* () {
      for (const batch of batches) {
        yield batch;
      }
    },
    getMessagesInTimeRange: vi.fn(),
  } as unknown as Player;
}

describe('readPlotRangeIncremental', () => {
  it('emits batches from streamMessagesInTimeRange as they arrive', async () => {
    const first = event(1);
    const second = event(2);
    const player = playerWithStream([[first], [second]]);
    const batches: MessageEvent[][] = [];

    const messages = await readPlotRangeIncremental({
      player,
      start: { sec: 0, nsec: 0 },
      end: { sec: 5, nsec: 0 },
      topics: ['/value'],
      onBatch: ({ messages: batch }) => batches.push(batch),
    });

    expect(batches).toEqual([[first], [second]]);
    expect(messages).toEqual([first, second]);
  });

  it('dedupes repeated messages before invoking onBatch', async () => {
    const first = event(1);
    const second = event(2);
    const progressMessages: number[] = [];
    const batches: MessageEvent[][] = [];

    await readPlotRangeIncremental({
      player: playerWithStream([[first, first], [second]]),
      start: { sec: 0, nsec: 0 },
      end: { sec: 5, nsec: 0 },
      topics: ['/value'],
      onBatch: ({ messages }) => batches.push(messages),
      onProgress: (progress) => progressMessages.push(progress.messages),
    });

    expect(batches).toEqual([[first], [second]]);
    expect(progressMessages).toContain(1);
    expect(progressMessages).toContain(2);
  });

  it('falls back to getMessagesInTimeRange when streaming is unavailable', async () => {
    const first = event(1);
    const getMessagesInTimeRange = vi.fn(async () => [first]);
    const batches: MessageEvent[][] = [];
    const player = { getMessagesInTimeRange } as unknown as Player;

    const messages = await readPlotRangeIncremental({
      player,
      start: { sec: 0, nsec: 0 },
      end: { sec: 5, nsec: 0 },
      topics: ['/value'],
      onBatch: ({ messages: batch }) => batches.push(batch),
    });

    expect(getMessagesInTimeRange).toHaveBeenCalledTimes(1);
    expect(batches).toEqual([[first]]);
    expect(messages).toEqual([first]);
  });

  it('throws AbortError and stops after abort', async () => {
    const first = event(1);
    const controller = new AbortController();
    const onBatch = vi.fn(() => controller.abort());

    await expect(readPlotRangeIncremental({
      player: playerWithStream([[first], [event(2)]]),
      start: { sec: 0, nsec: 0 },
      end: { sec: 5, nsec: 0 },
      topics: ['/value'],
      signal: controller.signal,
      onBatch,
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(onBatch).toHaveBeenCalledTimes(1);
  });
});

describe('spreadReadOrder', () => {
  it('reads each piece once, the focus first, and keeps the pieces read evenly spread', () => {
    const order = spreadReadOrder(100, 0);
    expect(order[0]).toBe(0);
    expect([...order].sort((a, b) => a - b)).toEqual(Array.from({ length: 100 }, (_, i) => i));
    // After 16 reads (12 of them spread) no stretch without one is much wider than an eighth of the range.
    const read = [...order.slice(0, 16)].sort((a, b) => a - b);
    const gaps = [read[0], ...read.slice(1).map((x, i) => x - read[i]), 100 - read[read.length - 1]];
    expect(Math.max(...gaps)).toBeLessThanOrEqual(100 / 7);
  });

  it('reads the pieces around the focus early', () => {
    const order = spreadReadOrder(100, 50);
    expect(order[0]).toBe(50);
    expect(order.slice(0, 12)).toEqual(expect.arrayContaining([49, 51]));
  });

  it('handles a single piece and a focus past the end', () => {
    expect(spreadReadOrder(1, 0)).toEqual([0]);
    expect(spreadReadOrder(3, 9)[0]).toBe(2);
  });
});

describe('readPlotRangeIncremental with a focus', () => {
  /** A player whose recording has one message per second, stored in pieces that start every second. */
  function playerWithPieces(seconds: number) {
    const reads: number[] = [];
    const player = {
      getReadBoundaries: vi.fn(async () => Array.from({ length: seconds }, (_, i) => ({ sec: i, nsec: 0 }))),
      streamMessagesInTimeRange: async function* ({ start, end }: { start: { sec: number }; end: { sec: number; nsec: number } }) {
        reads.push(start.sec);
        const out: MessageEvent[] = [];
        for (let s = start.sec; s <= end.sec && s < seconds; s++) out.push(event(s));
        yield out;
      },
      getMessagesInTimeRange: vi.fn(),
    } as unknown as Player;
    return { player, reads };
  }

  it('reads the stored pieces coarse to fine from the focus and returns every message in time order once', async () => {
    const { player, reads } = playerWithPieces(32);
    const messages = await readPlotRangeIncremental({
      player,
      start: { sec: 0, nsec: 0 },
      end: { sec: 31, nsec: 0 },
      topics: ['/value'],
      focus: { sec: 0, nsec: 0 },
    });
    expect(messages.map((m) => m.receiveTime.sec)).toEqual(Array.from({ length: 32 }, (_, i) => i));
    expect(reads.slice(0, 2)).toEqual([0, 16]); // the focus, then the middle of the range
    expect(new Set(reads).size).toBe(32);
  });

  it('reads in time order without a focus or without boundaries', async () => {
    const { player, reads } = playerWithPieces(4);
    await readPlotRangeIncremental({ player, start: { sec: 0, nsec: 0 }, end: { sec: 3, nsec: 0 }, topics: ['/value'] });
    expect(player.getReadBoundaries).not.toHaveBeenCalled();
    expect(reads).toEqual([0]);
  });
});

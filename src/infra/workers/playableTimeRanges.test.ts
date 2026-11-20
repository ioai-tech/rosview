import { describe, expect, it } from 'vitest';
import { getPlayableTimeRanges, type ChunkCoverage } from './playableTimeRanges';
import { toNano } from '@/shared/utils/time';

const GAP_NS = 750_000_000n;

function chunk(
  startSec: number,
  endSec: number,
  byteStart: number,
  byteEnd: number,
): ChunkCoverage {
  return {
    startNs: BigInt(startSec) * 1_000_000_000n,
    endNs: BigInt(endSec) * 1_000_000_000n,
    timeRange: {
      start: { sec: startSec, nsec: 0 },
      end: { sec: endSec, nsec: 0 },
    },
    byteRange: { start: byteStart, end: byteEnd },
  };
}

describe('getPlayableTimeRanges', () => {
  it('returns empty when there is no chunk coverage', () => {
    expect(getPlayableTimeRanges([], [{ start: 0, end: 100 }], GAP_NS)).toEqual([]);
  });

  it('returns a single prefix when early chunks are continuously covered', () => {
    const chunks = [chunk(0, 1, 0, 10), chunk(1, 2, 10, 20), chunk(2, 3, 20, 30)];
    const ranges = getPlayableTimeRanges(chunks, [{ start: 0, end: 20 }], GAP_NS);
    expect(ranges).toHaveLength(1);
    expect(toNano(ranges[0].start)).toBe(0n);
    expect(toNano(ranges[0].end)).toBe(2_000_000_000n);
  });

  it('returns the mid-file segment when early chunks were evicted', () => {
    const chunks = [chunk(0, 1, 0, 10), chunk(1, 2, 10, 20), chunk(2, 3, 20, 30)];
    // Only mid/late bytes remain in cache (LRU evicted the start).
    const ranges = getPlayableTimeRanges(chunks, [{ start: 10, end: 30 }], GAP_NS);
    expect(ranges).toHaveLength(1);
    expect(toNano(ranges[0].start)).toBe(1_000_000_000n);
    expect(toNano(ranges[0].end)).toBe(3_000_000_000n);
  });

  it('returns multiple segments for disjoint downloaded ranges', () => {
    const chunks = [
      chunk(0, 1, 0, 10),
      chunk(1, 2, 10, 20),
      chunk(2, 3, 20, 30),
      chunk(3, 4, 30, 40),
    ];
    const ranges = getPlayableTimeRanges(
      chunks,
      [
        { start: 0, end: 10 },
        { start: 30, end: 40 },
      ],
      GAP_NS,
    );
    expect(ranges).toHaveLength(2);
    expect(toNano(ranges[0].start)).toBe(0n);
    expect(toNano(ranges[0].end)).toBe(1_000_000_000n);
    expect(toNano(ranges[1].start)).toBe(3_000_000_000n);
    expect(toNano(ranges[1].end)).toBe(4_000_000_000n);
  });

  it('splits segments when the time gap exceeds the contiguous threshold', () => {
    // 2s gap between chunk 0 end and chunk 1 start (> 750ms).
    const chunks = [chunk(0, 1, 0, 10), chunk(3, 4, 10, 20)];
    const ranges = getPlayableTimeRanges(chunks, [{ start: 0, end: 20 }], GAP_NS);
    expect(ranges).toHaveLength(2);
    expect(toNano(ranges[0].start)).toBe(0n);
    expect(toNano(ranges[0].end)).toBe(1_000_000_000n);
    expect(toNano(ranges[1].start)).toBe(3_000_000_000n);
    expect(toNano(ranges[1].end)).toBe(4_000_000_000n);
  });

  it('merges adjacent covered chunks within the gap threshold', () => {
    // 0.5s gap (< 750ms) should still merge.
    const chunks = [
      {
        ...chunk(0, 1, 0, 10),
        endNs: 1_000_000_000n,
      },
      {
        ...chunk(1, 2, 10, 20),
        startNs: 1_500_000_000n,
        endNs: 2_000_000_000n,
        timeRange: {
          start: { sec: 1, nsec: 500_000_000 },
          end: { sec: 2, nsec: 0 },
        },
      },
    ];
    const ranges = getPlayableTimeRanges(chunks, [{ start: 0, end: 20 }], GAP_NS);
    expect(ranges).toHaveLength(1);
    expect(toNano(ranges[0].start)).toBe(0n);
    expect(toNano(ranges[0].end)).toBe(2_000_000_000n);
  });
});

describe('getPlayableTimeRanges with a chunk that spans the recording', () => {
  // Chunks 0-2 in time order, then a last chunk written at the end but stamped from 0 s (a map).
  const chunks = [chunk(0, 0, 100, 110), chunk(0, 1, 0, 10), chunk(1, 2, 10, 20), chunk(2, 3, 20, 30)].map((c, i) =>
    i === 0 ? { ...c, endNs: 3_000_000_000n, timeRange: { start: { sec: 0, nsec: 0 }, end: { sec: 3, nsec: 0 } } } : c,
  );

  it('does not report the whole recording playable when only the spanning chunk and the first are cached', () => {
    const ranges = getPlayableTimeRanges(chunks, [{ start: 0, end: 10 }, { start: 100, end: 110 }], GAP_NS);
    expect(ranges.map((r) => [toNano(r.start), toNano(r.end)])).toEqual([[0n, 1_000_000_000n]]);
  });

  it('reports nothing playable while the spanning chunk is remote', () => {
    expect(getPlayableTimeRanges(chunks, [{ start: 0, end: 30 }], GAP_NS)).toEqual([]);
  });

  it('reports everything once every chunk is cached', () => {
    const ranges = getPlayableTimeRanges(chunks, [{ start: 0, end: 30 }, { start: 100, end: 110 }], GAP_NS);
    expect(ranges.map((r) => [toNano(r.start), toNano(r.end)])).toEqual([[0n, 3_000_000_000n]]);
  });
});

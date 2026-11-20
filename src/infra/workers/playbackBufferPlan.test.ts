import { describe, expect, it } from 'vitest';
import type { ChunkCoverage } from './playableTimeRanges';
import { planPlaybackBuffer } from './playbackBufferPlan';

const S = 1_000_000_000n;
const OPTIONS = { targetBytes: 64 * 1024 * 1024, horizonNs: 15n * S };

function chunk(startSec: number, endSec: number, byteStart: number, byteEnd: number): ChunkCoverage {
  return {
    startNs: BigInt(startSec) * S,
    endNs: BigInt(endSec) * S,
    timeRange: { start: { sec: startSec, nsec: 0 }, end: { sec: endSec, nsec: 0 } },
    byteRange: { start: byteStart, end: byteEnd },
  };
}

/** 100 one-second chunks of 1 MB in file order, then a 30 MB chunk spanning 0-100 s at the end. */
function egoShape(): ChunkCoverage[] {
  const MB = 1_000_000;
  const chunks = Array.from({ length: 100 }, (_, i) => chunk(i, i + 1, i * MB, (i + 1) * MB));
  chunks.push(chunk(0, 100, 100 * MB, 130 * MB));
  return chunks.sort((a, b) => (a.startNs < b.startNs ? -1 : a.startNs > b.startNs ? 1 : 0));
}

describe('planPlaybackBuffer', () => {
  it('reads the chunks of the next seconds, each by its own byte range', () => {
    const plan = planPlaybackBuffer(egoShape(), 50n * S, 5_000, OPTIONS);
    // 49-50 s may still hold a message at the playhead (chunk times are inclusive).
    expect(plan?.byteRanges).toEqual([{ start: 49_000_000, end: 56_000_000 }]);
    expect(plan?.endNs).toBe(55n * S);
  });

  it('never spans the bytes between a chunk at the playhead and a chunk written at the end of the file', () => {
    const plan = planPlaybackBuffer(egoShape(), 0n, 5_000, OPTIONS);
    // The spanning chunk starts at the playhead, so its first message is due now: it is read on its own.
    expect(plan?.byteRanges).toEqual([
      { start: 0, end: 6_000_000 },
      { start: 100_000_000, end: 130_000_000 },
    ]);
    expect(plan?.endNs).toBe(5n * S);
  });

  it('leaves a chunk that began before the playhead and spans more than the horizon to demand reads', () => {
    const plan = planPlaybackBuffer(egoShape(), 40n * S, 5_000, OPTIONS);
    expect(plan?.byteRanges.some((r) => r.end > 100_000_000)).toBe(false);
  });

  it('stops at the byte budget and reports where the buffer ends', () => {
    const plan = planPlaybackBuffer(egoShape(), 10n * S, 10_000, { ...OPTIONS, targetBytes: 3_000_000 });
    expect(plan?.byteRanges).toEqual([{ start: 9_000_000, end: 12_000_000 }]);
    expect(plan?.endNs).toBe(12n * S);
  });

  it('returns nothing past the end of the recording', () => {
    expect(planPlaybackBuffer(egoShape(), 200n * S, 5_000, OPTIONS)).toBeUndefined();
  });
});

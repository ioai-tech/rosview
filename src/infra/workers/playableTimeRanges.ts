import type { TimeRange } from '@/core/types/ros';
import type { Range } from '@/shared/utils/ranges';
import { fromNano } from '@/shared/utils/time';

export type ChunkCoverage = {
  byteRange: Range;
  timeRange: TimeRange;
  startNs: bigint;
  endNs: bigint;
};

export function isByteRangeCovered(query: Range, downloaded: readonly Range[]): boolean {
  return downloaded.some((range) => range.start <= query.start && range.end >= query.end);
}

/**
 * Map currently-downloaded byte ranges onto chunk time coverage.
 * Returns every contiguous playable segment (not only a prefix from file start),
 * so LRU eviction of early chunks does not collapse the buffer bar to empty.
 *
 * A time is playable only when every chunk whose time range covers it is cached: a cached chunk
 * that spans the whole recording (a map written at the end but stamped at the start) does not
 * make the recording playable while the chunks in between are still remote.
 */
export function getPlayableTimeRanges(
  chunkCoverage: readonly ChunkCoverage[],
  downloadedByteRanges: readonly Range[],
  maxContiguousGapNs: bigint,
): TimeRange[] {
  if (chunkCoverage.length === 0) {
    return [];
  }

  const segments: Array<{ startNs: bigint; endNs: bigint }> = [];
  const missing: Array<{ startNs: bigint; endNs: bigint }> = [];
  let current: { startNs: bigint; endNs: bigint } | undefined;

  for (const chunk of chunkCoverage) {
    if (!isByteRangeCovered(chunk.byteRange, downloadedByteRanges)) {
      missing.push({ startNs: chunk.startNs, endNs: chunk.endNs });
      current = undefined;
      continue;
    }
    if (current == undefined || chunk.startNs > current.endNs + maxContiguousGapNs) {
      current = { startNs: chunk.startNs, endNs: chunk.endNs };
      segments.push(current);
    } else if (chunk.endNs > current.endNs) {
      current.endNs = chunk.endNs;
    }
  }

  // Remove the interior of every chunk that is not cached (touching boundaries stay playable).
  missing.sort((a, b) => (a.startNs < b.startNs ? -1 : a.startNs > b.startNs ? 1 : 0));
  const ranges: TimeRange[] = [];
  for (const segment of segments) {
    let startNs = segment.startNs;
    for (const gap of missing) {
      if (gap.startNs >= segment.endNs) break;
      if (gap.endNs <= startNs) continue;
      if (gap.startNs > startNs) ranges.push({ start: fromNano(startNs), end: fromNano(gap.startNs) });
      startNs = gap.endNs;
      if (startNs >= segment.endNs) break;
    }
    if (startNs < segment.endNs || startNs === segment.startNs) ranges.push({ start: fromNano(startNs), end: fromNano(segment.endNs) });
  }
  return ranges;
}

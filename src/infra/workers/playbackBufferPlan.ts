import type { Range } from '@/shared/utils/ranges';
import type { ChunkCoverage } from './playableTimeRanges';

export type PlaybackBufferPlan = {
  /** Byte ranges of the chunks to read ahead, one per chunk (merged when adjacent), in file order. */
  byteRanges: Range[];
  /** Playback is buffered up to this time once every range is cached. */
  endNs: bigint;
};

/**
 * The chunks playback from `anchorNs` needs over the next `minAheadMs`, as byte ranges.
 *
 * Read-ahead bets on time locality: the chunks whose time range covers the next seconds are the
 * ones the playback cursor reads next. A chunk that began before the playhead and spans more than
 * `horizonNs` carries no such locality. The usual case is one written when the recording ended but
 * stamped at its start (a map, `/tf_static`, a whole trajectory): its time range covers every
 * playhead, its bytes sit at the end of the file, and whether it has a message in the window is only
 * known from its message index. Such a chunk is left to demand reads (backfill and the cursor read it
 * when one of its messages is due), and it never stretches the plan: each chunk contributes its own
 * byte range, never the span between chunks.
 */
export function planPlaybackBuffer(
  chunks: readonly ChunkCoverage[],
  anchorNs: bigint,
  minAheadMs: number,
  options: { targetBytes: number; horizonNs: bigint },
): PlaybackBufferPlan | undefined {
  const aheadNs = BigInt(Math.max(1, Math.round(minAheadMs))) * 1_000_000n;
  const windowEndNs = anchorNs + (aheadNs < options.horizonNs ? aheadNs : options.horizonNs);
  const picked: ChunkCoverage[] = [];
  let bytes = 0;
  let endNs: bigint | undefined;
  for (const chunk of chunks) {
    if (chunk.endNs < anchorNs || chunk.startNs > windowEndNs) continue;
    if (chunk.startNs < anchorNs && chunk.endNs - chunk.startNs > options.horizonNs) continue;
    if (bytes >= options.targetBytes) {
      // Over budget: buffered up to where the first chunk left out begins.
      endNs = endNs == undefined || chunk.startNs < endNs ? chunk.startNs : endNs;
      continue;
    }
    picked.push(chunk);
    bytes += chunk.byteRange.end - chunk.byteRange.start;
  }
  if (picked.length === 0) return undefined;
  if (endNs == undefined) {
    endNs = picked.reduce((max, chunk) => (chunk.endNs > max ? chunk.endNs : max), anchorNs);
    if (endNs > windowEndNs) endNs = windowEndNs;
  }
  const byteRanges: Range[] = [];
  for (const { byteRange } of [...picked].sort((a, b) => a.byteRange.start - b.byteRange.start)) {
    const last = byteRanges[byteRanges.length - 1];
    if (last && byteRange.start <= last.end) last.end = Math.max(last.end, byteRange.end);
    else byteRanges.push({ ...byteRange });
  }
  return { byteRanges, endNs };
}

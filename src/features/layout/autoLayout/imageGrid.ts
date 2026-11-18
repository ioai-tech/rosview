/**
 * Image topics of the default layout: which ones (at most {@link MAX_AUTO_IMAGE_TOPICS}), in
 * which order, and how they are arranged.
 *
 * Order is generic and name-based: head / front / wrist cameras first, then left / right, then
 * RGB / colour streams, then anything else, and depth / infrared last, so a recording with more
 * cameras than the grid holds drops the least informative ones.
 */

export const MAX_AUTO_IMAGE_TOPICS = 6;

const TOKEN_RANKS: ReadonlyArray<readonly [RegExp, number]> = [
  [/^(head|top)$/, 0],
  [/^front$/, 1],
  [/^wrist$/, 2],
  [/^left$/, 3],
  [/^right$/, 4],
  [/^(rgb|color|colour)$/, 5],
];
const OTHER_RANK = 6;
const DEPTH_RANK = 8;
const INFRARED_RANK = 9;

function tokens(topicName: string): string[] {
  return topicName
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Lower is shown earlier. Depth and infrared streams always rank after every other stream. */
export function cameraRank(topicName: string): number {
  const parts = tokens(topicName);
  if (parts.some((t) => t === 'depth')) return DEPTH_RANK;
  if (parts.some((t) => t === 'ir' || t === 'infra' || t === 'infrared')) return INFRARED_RANK;
  let best = OTHER_RANK;
  for (const part of parts) {
    for (const [pattern, rank] of TOKEN_RANKS) {
      if (pattern.test(part) && rank < best) best = rank;
    }
  }
  return best;
}

/** Rows for `count` panels: 1×n up to 3, then 2×2, then 3×2. */
export function imageGridColumns(count: number): number {
  if (count <= 3) return Math.max(1, count);
  if (count === 4) return 2;
  return 3;
}

const SIDE = /(^|[^a-z0-9])(left|right)(?=[^a-z0-9]|$)/;

/** `/cam/left/image` -> { side: 'left', key: '/cam/\0/image' }; undefined when there is no side token. */
function stereoSide(name: string): { side: 'left' | 'right'; key: string } | undefined {
  const lower = name.toLowerCase();
  const m = SIDE.exec(lower);
  if (!m) return undefined;
  return { side: m[2] as 'left' | 'right', key: lower.replace(SIDE, '$1\u0000') };
}

/**
 * Orders topics by {@link cameraRank} (ties keep the given order, which callers sort by
 * transport preference), keeps a left / right stereo pair side by side inside one row and
 * returns the grid rows.
 */
export function planImageGrid(topicNames: ReadonlyArray<string>): string[][] {
  const ranked = topicNames
    .map((name, index) => ({ name, index, rank: cameraRank(name) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .slice(0, MAX_AUTO_IMAGE_TOPICS)
    .map((entry) => entry.name);
  const n = ranked.length;
  if (n === 0) return [];
  const cols = imageGridColumns(n);

  // A right camera follows its left partner; the pair is one unit that never wraps across rows.
  const units: string[][] = [];
  const placed = new Set<string>();
  for (const name of ranked) {
    if (placed.has(name)) continue;
    placed.add(name);
    const me = stereoSide(name);
    const partner =
      me?.side === 'left'
        ? ranked.find((other) => !placed.has(other) && stereoSide(other)?.side === 'right' && stereoSide(other)?.key === me.key)
        : undefined;
    if (partner) placed.add(partner);
    units.push(partner ? [name, partner] : [name]);
  }

  const rows: string[][] = [];
  let current: string[] = [];
  const queue = [...units];
  while (queue.length > 0) {
    const unit = queue.shift()!;
    if (current.length + unit.length <= cols) {
      current.push(...unit);
    } else {
      // No room for a whole pair: fill the row with the next single camera, if there is one.
      const single = queue.findIndex((u) => u.length === 1);
      if (single >= 0 && current.length < cols) {
        current.push(...queue.splice(single, 1)[0]);
        queue.unshift(unit);
      } else {
        rows.push(current);
        current = [...unit];
      }
    }
    if (current.length >= cols) {
      rows.push(current);
      current = [];
    }
  }
  if (current.length > 0) rows.push(current);
  return rows;
}

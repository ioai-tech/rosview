import type { TopicInfo } from '@/core/types/ros';
import { isRosImageSchema } from '@/shared/ros/rosMessageTypes';

function normalizeTopicName(topicName: string): string {
  return topicName.trim().toLowerCase();
}

function isPathOverlap(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/**
 * Strict overlap dedupe:
 * - only dedupe when one topic path contains the other
 * - keep the longer topic path (more specific)
 */
export function dedupeOverlappingImageTopics(topicNames: ReadonlyArray<string>): string[] {
  const unique = [...new Set(topicNames.map(normalizeTopicName))];
  const kept: string[] = [];
  const sorted = [...unique].sort((a, b) => b.length - a.length || a.localeCompare(b));
  for (const current of sorted) {
    if (kept.some((existing) => isPathOverlap(current, existing))) {
      continue;
    }
    kept.push(current);
  }
  return kept;
}

/** Bucket key for row-pickers: strict-overlap mode keeps non-overlapping topics independent. */
export function imageDedupeBucket(topicName: string): string {
  return normalizeTopicName(topicName);
}

/**
 * Higher score wins within the same dedupe bucket.
 * Prefer compressed / resized previews; deprioritize raw-only and depth.
 */
export function imageTopicPriorityScore(topicName: string): number {
  const n = topicName.toLowerCase();
  if (n.includes('metadata')) return -1_000;
  let s = 0;
  if (n.includes('compressed')) s += 80;
  if (n.includes('video')) s += 70;
  if (n.includes('image_resized')) s += 40;
  if (n.includes('/depth/')) s -= 50;
  if (n.includes('image_rect_raw') && !n.includes('compressed')) s += 25;
  if (n.includes('image_raw') && !n.includes('compressed')) s += 20;
  if (n.includes('color')) s += 5;
  return s;
}

/**
 * Image topics with per-camera-stream deduping, best transport first. The layout planner
 * (`planImageGrid`) orders them by camera role and keeps the first six.
 */
export function selectImageTopicsForAutoLayout(topics: ReadonlyArray<TopicInfo>): string[] {
  const candidates = topics.filter((t) => isRosImageSchema(t.type));
  const bestByName = new Map<string, { name: string; score: number }>();

  for (const t of candidates) {
    const normalizedName = normalizeTopicName(t.name);
    const score = imageTopicPriorityScore(t.name);
    if (score <= -1_000) continue; // metadata-only streams; depth stays, ranked last by the planner
    const prev = bestByName.get(normalizedName);
    if (!prev || score > prev.score) {
      bestByName.set(normalizedName, { name: t.name, score });
    }
  }

  const dedupedNames = dedupeOverlappingImageTopics([...bestByName.keys()]);
  const picked = dedupedNames
    .map((name) => bestByName.get(name))
    .filter((value): value is { name: string; score: number } => value != null)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .map((x) => x.name);

  return picked;
}

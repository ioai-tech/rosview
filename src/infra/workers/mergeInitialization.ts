import type { Initialization, PlayerProblem, Time, TopicInfo, TopicStats } from '@/core/types/ros';
import { toNano } from '@/shared/utils/time';

export interface MergeableSource {
  /** Display label for this member (typically the file/URL basename). */
  label: string;
  initialization: Initialization;
}

export interface MergedInitializationResult {
  initialization: Initialization;
  /**
   * Topic name -> ordered list of member indices (into the `sources` array
   * passed to `mergeInitializations`) that publish this topic. Used by
   * `CombinedSourceProxy` to avoid fanning out calls to members that do not
   * own a requested topic.
   */
  memberIndicesByTopic: Map<string, number[]>;
}

function minTime(a: Time, b: Time): Time {
  return toNano(a) <= toNano(b) ? a : b;
}

function maxTime(a: Time, b: Time): Time {
  return toNano(a) >= toNano(b) ? a : b;
}

function mergeTopicStats(existing: TopicStats | undefined, incoming: TopicStats): TopicStats {
  if (!existing) {
    return { ...incoming };
  }
  const messageCount = existing.messageCount + incoming.messageCount;
  const durationSec =
    existing.durationSec != null || incoming.durationSec != null
      ? (existing.durationSec ?? 0) + (incoming.durationSec ?? 0)
      : undefined;
  const frequency =
    durationSec != null && durationSec > 0 ? messageCount / durationSec : Math.max(existing.frequency, incoming.frequency);
  return { messageCount, frequency, durationSec };
}

/**
 * Merge N per-source `Initialization` results into one, as if they came from
 * a single combined recording:
 *  - topics are concatenated in source order (first-seen wins for ties), so
 *    the default topic list order matches "load order" per file.
 *  - a topic name appearing in more than one source is folded into a single
 *    entry; its `sourceLabels` accumulates every contributing file so the UI
 *    can surface provenance without duplicating rows.
 *  - `start`/`end` become the union (min start, max end) across all sources,
 *    which is what drives the merged session's overall playback range.
 *
 * Per-topic `messageCount`/`frequency`/`durationSec` are intentionally left
 * undefined on the merged `TopicInfo` entries (except for topics that only
 * exist in a single member, where the original values pass through
 * unchanged); `IterablePlayer.initialize()` already backfills these from
 * `topicStats`, so the authoritative numbers come from the `topicStats`
 * merge below rather than being duplicated here.
 */
export function mergeInitializations(sources: MergeableSource[]): MergedInitializationResult {
  if (sources.length === 0) {
    throw new Error('mergeInitializations requires at least one source');
  }
  if (sources.length === 1) {
    const [only] = sources;
    const memberIndicesByTopic = new Map<string, number[]>();
    for (const topic of only.initialization.topics) {
      memberIndicesByTopic.set(topic.name, [0]);
    }
    return { initialization: only.initialization, memberIndicesByTopic };
  }

  const topicOrder: string[] = [];
  const topicsByName = new Map<string, TopicInfo>();
  const memberIndicesByTopic = new Map<string, number[]>();
  const datatypes: Initialization['datatypes'] = {};
  const publishersByTopic = new Map<string, Set<string>>();
  const topicStats: Record<string, TopicStats> = {};
  const problems: PlayerProblem[] = [];
  let start: Time | undefined;
  let end: Time | undefined;
  let preferredSamplingFps: number | undefined;
  let randomAccessByTopic = true;
  let remoteRangeBacked = false;

  sources.forEach((source, memberIndex) => {
    const init = source.initialization;
    problems.push(...init.problems);
    start = start ? minTime(start, init.start) : init.start;
    end = end ? maxTime(end, init.end) : init.end;
    if (init.remoteRangeBacked === true) remoteRangeBacked = true;
    if (init.randomAccessByTopic !== true) {
      randomAccessByTopic = false;
    }
    if (typeof init.preferredSamplingFps === 'number' && Number.isFinite(init.preferredSamplingFps)) {
      preferredSamplingFps = Math.max(preferredSamplingFps ?? 0, init.preferredSamplingFps);
    }
    Object.assign(datatypes, init.datatypes);
    for (const [topicName, publishers] of Object.entries(init.publishersByTopic)) {
      const set = publishersByTopic.get(topicName) ?? new Set<string>();
      for (const p of publishers) set.add(p);
      publishersByTopic.set(topicName, set);
    }
    for (const topic of init.topics) {
      const indices = memberIndicesByTopic.get(topic.name) ?? [];
      indices.push(memberIndex);
      memberIndicesByTopic.set(topic.name, indices);

      const stats = init.topicStats[topic.name];
      if (stats) {
        topicStats[topic.name] = mergeTopicStats(topicStats[topic.name], stats);
      }

      const existing = topicsByName.get(topic.name);
      if (!existing) {
        topicOrder.push(topic.name);
        topicsByName.set(topic.name, { ...topic, sourceLabels: [source.label] });
        continue;
      }
      if (existing.type !== topic.type) {
        problems.push({
          severity: 'warn',
          message: `Topic "${topic.name}" has mismatched schema across merged sources ("${existing.type}" vs "${topic.type}" from ${source.label}); using "${existing.type}".`,
        });
      }
      existing.sourceLabels = [...(existing.sourceLabels ?? []), source.label];
      // Multiple members contributing the same topic name is an edge case
      // (same-name reuse across files); clear per-member stats so the final
      // display values come from the merged `topicStats` below rather than
      // whichever member happened to be seen first.
      existing.messageCount = undefined;
      existing.frequency = undefined;
      existing.durationSec = undefined;
    }
  });

  const topics = topicOrder.map((name) => topicsByName.get(name)!);
  const mergedPublishersByTopic: Record<string, string[]> = {};
  for (const [topicName, set] of publishersByTopic) {
    mergedPublishersByTopic[topicName] = Array.from(set);
  }

  return {
    initialization: {
      topics,
      datatypes,
      start: start!,
      end: end!,
      publishersByTopic: mergedPublishersByTopic,
      topicStats,
      problems,
      preferredSamplingFps,
      randomAccessByTopic,
      remoteRangeBacked,
    },
    memberIndicesByTopic,
  };
}

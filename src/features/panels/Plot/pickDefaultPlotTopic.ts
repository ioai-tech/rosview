import type { TopicInfo } from '@/core/types/ros';
import { measuredTopicRank } from '@/shared/ros/rosMessageTypes';
import { filterPlottableTopics } from './plottableSchemas';
import { getSchemaDefaultPriority } from './schemaRegistry/plotSchemaRegistry';

export function pickDefaultPlotTopic(topics: ReadonlyArray<TopicInfo>): string {
  const plottable = filterPlottableTopics(topics);
  if (plottable.length === 0) return '';

  const sorted = [...plottable].sort((a, b) => {
    const priorityDiff = getSchemaDefaultPriority(b.type) - getSchemaDefaultPriority(a.type);
    if (priorityDiff !== 0) return priorityDiff;
    const rankDiff = measuredTopicRank(a.name) - measuredTopicRank(b.name);
    if (rankDiff !== 0) return rankDiff;
    return a.name.localeCompare(b.name);
  });

  return sorted[0]?.name ?? '';
}

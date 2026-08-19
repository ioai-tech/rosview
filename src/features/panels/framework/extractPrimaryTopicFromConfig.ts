function nonEmptyTopic(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const topic = value.trim();
  return topic.length > 0 ? topic : undefined;
}

function topicFromRecord(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  return nonEmptyTopic((value as { topic?: unknown }).topic);
}

/**
 * Best-effort primary topic from a panel config.
 * Looks at the fields used by Image/Audio/Raw/JointStatePlot, Plot series,
 * 3D topicSettings (not urdf.topic), and Align/Pose topics lists.
 */
export function extractPrimaryTopicFromConfig(config: unknown): string | undefined {
  if (!config || typeof config !== 'object') return undefined;
  const record = config as Record<string, unknown>;

  const direct = nonEmptyTopic(record.topic);
  if (direct) return direct;

  if (Array.isArray(record.series)) {
    for (const series of record.series) {
      const topic = topicFromRecord(series);
      if (topic) return topic;
    }
  }

  if (Array.isArray(record.topicSettings)) {
    for (const setting of record.topicSettings) {
      if (!setting || typeof setting !== 'object') continue;
      const entry = setting as { topic?: unknown; enabled?: unknown };
      if (entry.enabled === false) continue;
      const topic = nonEmptyTopic(entry.topic);
      if (topic) return topic;
    }
  }

  if (Array.isArray(record.topics)) {
    for (const entry of record.topics) {
      const topic = nonEmptyTopic(entry) ?? topicFromRecord(entry);
      if (topic) return topic;
    }
  }

  return undefined;
}

/**
 * The topic of a panel that shows exactly one (Image, Raw Messages, Audio, Joint State Plot).
 * Panels that combine topics (Plot series, 3D, Pose, Align) have none: naming them after their
 * first topic would mislabel the rest.
 */
export function singleTopicOfPanelConfig(config: unknown): string | undefined {
  if (!config || typeof config !== 'object') return undefined;
  const topic = (config as { topic?: unknown }).topic;
  if (typeof topic !== 'string') return undefined;
  const trimmed = topic.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function labelledPanelTitle(typeTitle: string, topic: string | undefined, label: string | undefined): {
  text: string;
  tooltip: string;
} {
  if (!label || !topic) return { text: typeTitle, tooltip: typeTitle };
  return { text: label, tooltip: `${typeTitle} · ${label}\n${topic}` };
}

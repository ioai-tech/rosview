import React, { createContext, useContext, useMemo } from 'react';

/**
 * Host-supplied display names per topic (`RosViewerProps.topicLabels`), keyed by the exact topic
 * name. RosView shows the label where a person reads which stream they are looking at (topic bars,
 * the topic picker, panel tabs, the sidebar topic list) and keeps the topic as secondary text. The
 * label never replaces the topic in configs, layouts, exports or message paths.
 */
export type TopicLabels = Readonly<Record<string, string>>;

const NO_LABELS: TopicLabels = Object.freeze({});

/**
 * Keeps the usable entries: a non-empty topic and a non-empty label that differs from the topic.
 * Anything else is dropped, so "no label" always means today's behaviour.
 */
export function normalizeTopicLabels(input: unknown): TopicLabels {
  if (!input || typeof input !== 'object') return NO_LABELS;
  const out: Record<string, string> = {};
  for (const [topic, raw] of Object.entries(input as Record<string, unknown>)) {
    if (typeof raw !== 'string') continue;
    const label = raw.trim();
    if (topic.length === 0 || label.length === 0 || label === topic) continue;
    out[topic] = label;
  }
  return Object.keys(out).length > 0 ? Object.freeze(out) : NO_LABELS;
}

/** Stable identity for equal content, so a host passing a new object each render does not re-render panels. */
function topicLabelsSignature(labels: TopicLabels): string {
  return JSON.stringify(Object.entries(labels).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

const TopicLabelsContext = createContext<TopicLabels>(NO_LABELS);

export function TopicLabelsProvider({
  labels,
  children,
}: {
  labels: Record<string, string> | undefined;
  children: React.ReactNode;
}) {
  const normalized = normalizeTopicLabels(labels);
  const signature = topicLabelsSignature(normalized);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the signature is the content
  const value = useMemo(() => normalized, [signature]);
  return <TopicLabelsContext.Provider value={value}>{children}</TopicLabelsContext.Provider>;
}

export function useTopicLabels(): TopicLabels {
  return useContext(TopicLabelsContext);
}

export function topicLabelOf(labels: TopicLabels, topic: string | undefined): string | undefined {
  if (!topic) return undefined;
  return Object.prototype.hasOwnProperty.call(labels, topic) ? labels[topic] : undefined;
}

/** The host's display name for `topic`, or undefined when it has none. */
export function useTopicLabel(topic: string | undefined): string | undefined {
  return topicLabelOf(useTopicLabels(), topic);
}

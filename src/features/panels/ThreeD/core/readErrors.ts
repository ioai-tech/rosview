import type { IntlShape } from 'react-intl';

/**
 * One line per topic of this panel whose frame the player could not read, so the scene says why
 * something is missing instead of showing an empty grid.
 */
export function readErrorLines(
  topicErrors: Readonly<Record<string, string>> | undefined,
  topics: readonly string[],
  formatMessage: IntlShape['formatMessage'],
): string[] {
  if (!topicErrors) return [];
  const lines: string[] = [];
  for (const topic of new Set(topics)) {
    const reason = topicErrors[topic];
    if (reason) lines.push(formatMessage({ id: 'panels.threeD.readFailed' }, { topic, reason }));
  }
  return lines;
}

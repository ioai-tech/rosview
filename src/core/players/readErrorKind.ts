import type { ReadErrorKind } from '@/core/types/player';

/**
 * The browsers' own words for a request that got no response (Chrome, Firefox, Safari, and a body
 * cut mid-transfer). Such an error is a network failure wherever it was thrown.
 */
const BROWSER_NETWORK_FAILURE = /^(failed to fetch|networkerror when attempting to fetch resource\.?|load failed|network error)$/i;

/**
 * The known kind of a read failure, from the error's name (kept across workers by Comlink and by
 * the sources' per-topic errors), for a localized message. Undefined for any other error, whose
 * own message is then shown.
 */
export function readErrorKind(error: unknown): ReadErrorKind | undefined {
  if (error == null || typeof error !== 'object') return undefined;
  const { name, message } = error as { name?: unknown; message?: unknown };
  switch (name) {
    case 'RangeNetworkError':
      return 'network';
    case 'RangeStallError':
      return 'stalled';
    case 'RangeHttpError':
      return 'refused';
    case 'TypeError':
      return typeof message === 'string' && BROWSER_NETWORK_FAILURE.test(message.trim()) ? 'network' : undefined;
    default:
      return undefined;
  }
}

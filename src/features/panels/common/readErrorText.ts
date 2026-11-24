import type { IntlShape } from 'react-intl';
import type { ReadErrorKind } from '@/core/types/player';

/**
 * What a viewer says about a read that failed: a localized sentence for a known kind of failure
 * (the raw message, for example the browser's "Failed to fetch", is only its detail), else the
 * error's own message.
 */
export function readErrorText(formatMessage: IntlShape['formatMessage'], message: string, kind?: ReadErrorKind): string {
  switch (kind) {
    case 'network':
      return formatMessage({ id: 'errors.read.network' });
    case 'stalled':
      return formatMessage({ id: 'errors.read.stalled' });
    case 'refused':
      return formatMessage({ id: 'errors.read.refused' });
    default:
      return message;
  }
}

/** The raw message as a detail (a tooltip) when `readErrorText` replaced it with a sentence. */
export function readErrorDetail(message: string, kind?: ReadErrorKind): string | undefined {
  return kind ? message : undefined;
}

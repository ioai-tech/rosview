import type { IntlShape } from 'react-intl';
import type { ImageSurfaceStatus } from './imageTypes';

/**
 * Overlay text for an image panel, in the viewer's UI language. Null when a frame is on screen.
 * `readError` (the player could not read this topic's frame) wins: the panel says why it has no
 * frame instead of waiting for one that will not come.
 */
export function getStatusText(
  status: ImageSurfaceStatus,
  formatMessage: IntlShape['formatMessage'],
  readError?: string,
): string | null {
  if (readError) {
    return formatMessage({ id: 'panels.image.status.readFailed' }, { reason: readError });
  }
  if (status.phase === 'idle') {
    return formatMessage({ id: 'panels.image.status.waiting' });
  }
  if (status.phase === 'error') {
    return status.message ?? formatMessage({ id: 'panels.image.status.decodeFailed' });
  }
  if (status.phase === 'stalled') {
    return status.message ?? formatMessage({ id: 'panels.image.status.stalled' });
  }
  if (status.phase === 'decoding' && !status.width && !status.height) {
    return formatMessage({ id: 'panels.image.status.decoding' });
  }
  return null;
}

import { useState } from 'react';
import { useMessagePipeline } from '@/core/pipeline/useMessagePipeline';

/**
 * A number that moves when the user retries (`Player.retry()`, the Retry of a failed playback)
 * while this panel's own read has failed (`failed`). Put it in the read's dependencies: a failed
 * window is read again without a seek, and a panel whose read succeeded does not read again.
 */
export function useReadRetry(failed: boolean): number {
  const retryCount = useMessagePipeline((state) => state.playerState.progress.retryCount ?? 0);
  const [seen, setSeen] = useState({ retryCount, attempt: 0 });
  if (seen.retryCount !== retryCount) {
    // Derived from the previous render (no effect): the read that depends on `attempt` runs once.
    setSeen({ retryCount, attempt: failed ? seen.attempt + 1 : seen.attempt });
  }
  return seen.attempt;
}

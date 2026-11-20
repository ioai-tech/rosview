import * as Comlink from 'comlink';
import type { BackfillTopicCallback } from './types';

/**
 * Runs a worker's backfill with the caller's per-topic callback and then releases that callback.
 * It crossed from the main thread as a Comlink proxy, which holds a MessagePort until released;
 * every worker releases it, whether or not its source hands topics over one by one.
 */
export async function withBackfillCallback<T>(
  onTopic: BackfillTopicCallback | undefined,
  run: (onTopic: BackfillTopicCallback | undefined) => Promise<T>,
): Promise<T> {
  try {
    return await run(onTopic);
  } finally {
    (onTopic as Partial<Comlink.Remote<BackfillTopicCallback>> | undefined)?.[Comlink.releaseProxy]?.();
  }
}

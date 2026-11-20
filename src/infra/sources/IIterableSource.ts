import type { Initialization, MessageEvent, Time } from '@/core/types/ros';
import type {
  BackfillTopicCallback,
  GetAdjacentMessageArgs,
  MessageIteratorArgs,
  ReadBoundariesArgs,
  GetBackfillMessagesArgs,
} from '@/infra/workers/types';

export type { GetAdjacentMessageArgs, AdjacentDirection } from '@/infra/workers/types';

export interface IIterableSource {
  initialize(): Promise<Initialization>;
  messageIterator(args: MessageIteratorArgs): AsyncIterableIterator<MessageEvent>;
  /** `onTopic` is optional to support: see `BackfillTopicCallback`. */
  getBackfillMessages(args: GetBackfillMessagesArgs, onTopic?: BackfillTopicCallback): Promise<MessageEvent[]>;
  /** Next/prev message in log time across the given topics (optional; workers may gate). */
  getAdjacentMessage?(args: GetAdjacentMessageArgs): Promise<MessageEvent | null>;
  /**
   * Where `[start, end]` can be cut so that each piece is stored apart from the others (for MCAP:
   * the start times of the chunks that hold `topics`, chunks that overlap in time merged). The
   * first boundary is `start`. A reader that reads the pieces out of order decodes each chunk
   * about once. Undefined when the format has no such units.
   */
  getReadBoundaries?(args: ReadBoundariesArgs): Promise<Time[] | undefined>;
}

import type { SourceInitPhase } from '@/core/types/player';
import type { DataQualityReport, Initialization, MessageEvent, Time, TimeRange } from '@/core/types/ros';
import type { TransportDiagnostics, WorkerTransportConfig } from './transport';
import type { Range } from '@/shared/utils/ranges';

export interface MessageIteratorArgs {
  startTime: Time;
  endTime?: Time;
  topics: string[];
  latestOnlyTopics?: string[];
}

export interface GetBackfillMessagesArgs {
  time: Time;
  topics: string[];
}

/** Why one backfill topic could not be read (plain data: it crosses a worker boundary). */
export interface BackfillTopicError {
  name: string;
  message: string;
}

/**
 * Receives one backfill topic's messages (empty when the topic has none) as soon as they are read,
 * so a caller can show each topic without waiting for the others. A topic that could not be read
 * comes with `error` and no messages; the other topics are still read. Returning false stops the
 * call: no further topic is read. Messages passed here are not returned again at the end. A source
 * that does not support it ignores it, returns every message at the end, and rejects on an error.
 */
export type BackfillTopicCallback = (
  topic: string,
  messages: MessageEvent[],
  error?: BackfillTopicError,
) => boolean | Promise<boolean>;

export type AdjacentDirection = 'next' | 'prev';

export interface GetAdjacentMessageArgs {
  time: Time;
  topics: string[];
  direction: AdjacentDirection;
}

export interface PreparePlaybackBufferArgs {
  time: Time;
  topics: string[];
  minAheadMs: number;
  waitTimeoutMs?: number;
}

export interface PlaybackBufferStatus {
  ready: boolean;
  bufferedUntil?: Time;
  bufferedAheadMs?: number;
}

export interface LoadProgress {
  downloadedByteRanges: Range[];
  totalBytes: number;
  percent: number;
  parsedMessageRanges: TimeRange[];
  bufferedAheadMs?: number;
}

export type { SourceInitPhase };

export interface SourceInitProgress {
  phase: SourceInitPhase;
  /** Bytes received in the current HTTP range (or full file for db3). */
  loadedBytes: number;
  /** Size of the current request, or file size when known. */
  totalBytes: number;
  /** Session-cumulative HTTP bytes (monotonic). */
  transferredBytes?: number;
}

export type SourceInitProgressCallback = (progress: SourceInitProgress) => void;

/** `T` is the deserialized message payload carried in {@link MessageEvent.message}. */
export interface IMessageCursor<T = unknown> {
  next(): Promise<IteratorResult<MessageEvent<T>>>;
  /**
   * The next messages. Without `waitForData` it waits briefly (playback ticks must not block), so an
   * empty batch only means "nothing read yet". With `waitForData` it waits until a message is read or
   * the cursor is exhausted, so an empty batch means the cursor's range is done (range scans).
   */
  nextBatch(
    durationMs: number,
    options?: { maxMessages?: number; maxWallTimeMs?: number; endTime?: Time; waitForData?: boolean },
  ): Promise<MessageEvent<T>[]>;
  end(): Promise<void>;
}

export interface IWorkerSerializedSourceWorker {
  initialize(
    args: Record<string, unknown>,
    onProgress?: SourceInitProgressCallback,
  ): Promise<Initialization>;
  configureTransport(config: WorkerTransportConfig): Promise<void>;
  startDataQualityScan(): Promise<void>;
  getMessageCursor(args: MessageIteratorArgs): Promise<IMessageCursor<unknown>>;
  getBackfillMessages(args: GetBackfillMessagesArgs, onTopic?: BackfillTopicCallback): Promise<MessageEvent[]>;
  getAdjacentMessage(args: GetAdjacentMessageArgs): Promise<MessageEvent | null>;
  preparePlaybackBuffer(args: PreparePlaybackBufferArgs): Promise<PlaybackBufferStatus>;
  getLoadProgress(): Promise<LoadProgress>;
  getTransportDiagnostics(): Promise<TransportDiagnostics>;
  getDataQualityReport(): Promise<DataQualityReport | undefined>;
}

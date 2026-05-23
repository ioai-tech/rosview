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

/** `T` is the deserialized message payload carried in {@link MessageEvent.message}. */
export interface IMessageCursor<T = unknown> {
  next(): Promise<IteratorResult<MessageEvent<T>>>;
  nextBatch(
    durationMs: number,
    options?: { maxMessages?: number; maxWallTimeMs?: number; endTime?: Time },
  ): Promise<MessageEvent<T>[]>;
  end(): Promise<void>;
}

export interface IWorkerSerializedSourceWorker {
  initialize(args: Record<string, unknown>): Promise<Initialization>;
  configureTransport(config: WorkerTransportConfig): Promise<void>;
  startDataQualityScan(): Promise<void>;
  getMessageCursor(args: MessageIteratorArgs): Promise<IMessageCursor<unknown>>;
  getBackfillMessages(args: GetBackfillMessagesArgs): Promise<MessageEvent[]>;
  getAdjacentMessage(args: GetAdjacentMessageArgs): Promise<MessageEvent | null>;
  preparePlaybackBuffer(args: PreparePlaybackBufferArgs): Promise<PlaybackBufferStatus>;
  getLoadProgress(): Promise<LoadProgress>;
  getTransportDiagnostics(): Promise<TransportDiagnostics>;
  getDataQualityReport(): Promise<DataQualityReport | undefined>;
}

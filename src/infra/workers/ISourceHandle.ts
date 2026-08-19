import type { DataQualityReport, Initialization, MessageEvent } from '@/core/types/ros';
import type {
  GetAdjacentMessageArgs,
  GetBackfillMessagesArgs,
  IMessageCursor,
  LoadProgress,
  MessageIteratorArgs,
  SourceInitProgressCallback,
  PlaybackBufferStatus,
  PreparePlaybackBufferArgs,
} from './types';
import type { TransportDiagnostics } from './transport';

export type ResolveHighFrequencyLaneOptions = {
  preferSharedView?: boolean;
  copyPayload?: boolean;
};

/**
 * Structural surface `IterablePlayer` depends on to talk to a recording source.
 *
 * `WorkerSerializedSource` (single file, backed by one Worker) implements this
 * directly. `CombinedSourceProxy` (multiple files merged into one session)
 * implements the same surface by fanning out to N `WorkerSerializedSource`
 * instances, so `IterablePlayer` never needs to know whether it is driving one
 * file or several.
 */
export interface ISourceHandle {
  initialize(
    args: Record<string, unknown>,
    onProgress?: SourceInitProgressCallback,
  ): Promise<Initialization>;
  getMessageCursor(args: MessageIteratorArgs): Promise<IMessageCursor<unknown>>;
  getBackfillMessages(args: GetBackfillMessagesArgs): Promise<MessageEvent[]>;
  getAdjacentMessage(args: GetAdjacentMessageArgs): Promise<MessageEvent | null>;
  preparePlaybackBuffer(args: PreparePlaybackBufferArgs): Promise<PlaybackBufferStatus>;
  getLoadProgress(): Promise<LoadProgress>;
  startDataQualityScan(): Promise<void>;
  getDataQualityReport(): Promise<DataQualityReport | undefined>;
  getTransportDiagnostics(): Promise<TransportDiagnostics>;
  resolveMessageBatch(messages: MessageEvent[]): MessageEvent[];
  resolveMessageForHighFrequencyLane(
    message: MessageEvent,
    options?: ResolveHighFrequencyLaneOptions,
  ): MessageEvent;
  terminate(): void;
}

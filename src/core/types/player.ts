import type { Time, TimeRange, TopicInfo, RosDatatypes, PlayerProblem, MessageEvent, DataQualityReport } from './ros';
import type { Range } from '@/shared/utils/ranges';

/** Arguments for optional range reads (e.g. Align panel). */
export interface GetMessagesInTimeRangeArgs {
  start: Time;
  end: Time;
  topics: string[];
  signal?: AbortSignal;
  /**
   * `'window'` (default): a panel's window or an export; it waits while the frame at the playhead
   * is read and shares the link with at most one other such read. `'frame'`: the frame on screen
   * needs it (an H.264 keyframe after a seek): it starts at once and window reads wait for it.
   */
  priority?: 'frame' | 'window';
}

export interface StreamMessagesInTimeRangeArgs extends GetMessagesInTimeRangeArgs {
  maxMessages?: number;
  batchSize?: number;
  batchWallTimeMs?: number;
}

export type Unsubscribe = () => void;

/** Random-access byte reader for ROS bag-like sources. */
export interface Readable {
  size(): Promise<number>;
  read(offset: number, length: number): Promise<Uint8Array>;
}

export type PlayerPresence = 'preinit' | 'initializing' | 'ready' | 'closed';

/** Worker-reported phase while a remote (or large local) source is opening. */
/** `indexing`: building a message index by scanning the file (e.g. an MCAP without a summary). */
export type SourceInitPhase = 'connecting' | 'downloading' | 'opening' | 'indexing';

export interface PlayerState {
  presence: PlayerPresence;
  progress: {
    /** Remote source download percentage in byte space. */
    percent?: number;
    /** Downloaded byte ranges [start, end) for transport/cache diagnostics. */
    downloadedByteRanges?: Range[];
    /** Total source bytes for byte-range diagnostics. */
    totalBytes?: number;
    /** Bytes received in the current HTTP range (or full-file download). */
    loadedBytes?: number;
    /** Session-cumulative HTTP bytes transferred while opening. */
    transferredBytes?: number;
    /** Coarse initialize phase for the loading overlay. */
    initPhase?: SourceInitPhase;
    /** Parsed/playable time ranges rendered on the playback track. */
    parsedMessageRanges?: TimeRange[];
    /** Current worker transport mode. */
    transportMode?: 'sab' | 'transfer' | 'comlink';
    /** Why SAB was not used when downgraded. */
    transportFallbackReason?: string;
    /** Whether browser runtime is cross-origin isolated for SharedArrayBuffer. */
    crossOriginIsolated?: boolean;
    /** Payload byte threshold for hybrid transfer/SAB transport. */
    binaryPayloadThresholdBytes?: number;
    /** Shared payload ring diagnostics when SAB is active. */
    sharedPayloadRing?: {
      slotCount: number;
      slotSizeBytes: number;
      totalBytes: number;
    };
    /** Number of dropped payload writes in worker ring. */
    droppedPayloads?: number;
    /** Number of stale SAB refs detected by main thread resolver. */
    stalePayloadRefs?: number;
    /** Configured sampling FPS for global playback ticks. */
    samplingFps?: number;
    /** Consecutive empty batches seen in playback loop. */
    emptyBatchStreak?: number;
    /** Cursor rebuild count for empty-batch recovery. */
    cursorRebuildCount?: number;
    /** Backfill fallback count for sustained empty batches. */
    fallbackBackfillCount?: number;
    /** Playback is intentionally waiting for a continuous local buffer. */
    buffering?: boolean;
    /** Retryable playback-time error, distinct from initialization problems. */
    playbackError?: string;
    /** What kind of failure `playbackError` is, when it is a known read failure (for a localized message). */
    playbackErrorKind?: ReadErrorKind;
    /**
     * The network dropped while reading the remote recording: reads wait and are asked again with a
     * bounded backoff (at most 3 s apart, at once on `online`), and playback resumes by itself when
     * the network is back. Not a failure.
     */
    reconnecting?: boolean;
    /**
     * How often `Player.retry()` was called. A panel whose own read failed (for example a Plot
     * window) reads it again when this changes.
     */
    retryCount?: number;
    /** Estimated continuous local buffer ahead of the current playback time. */
    bufferedAheadMs?: number;
    /** Background data quality scan report (session-only). */
    dataQualityReport?: DataQualityReport;
  };
  activeData?: {
    topics: TopicInfo[];
    datatypes: RosDatatypes;
    publishersByTopic: Map<string, Set<string>>;
    startTime: Time;
    endTime: Time;
    currentTime: Time;
    isPlaying: boolean;
    isLooping: boolean;
    speed: number;
    problems: PlayerProblem[];
    /**
     * Topics whose message for the current frame could not be read, with the reason (for example
     * a stalled range request). A panel shows it instead of waiting for data that will not come.
     */
    topicErrors?: Readonly<Record<string, string>>;
    /** The same errors by panel (subscriptions and high-frequency consumers), for the panel shell. */
    panelReadErrors?: Readonly<Record<string, ReadonlyArray<TopicReadError>>>;
    /** Whether the source supports efficient per-topic random access reads. */
    randomAccessByTopic?: boolean;
    /** Remote range-backed source: avoid whole-recording reads. */
    remoteRangeBacked?: boolean;
  };
}

/**
 * A known kind of read failure, for a localized message (the raw message stays the detail):
 * `network` the server could not be reached, `stalled` the server stopped sending data,
 * `refused` the server answered with an error status.
 */
export type ReadErrorKind = 'network' | 'stalled' | 'refused';

/** A topic whose frame could not be read, and why. */
export interface TopicReadError {
  topic: string;
  message: string;
  /** Set when the failure is of a known kind. */
  kind?: ReadErrorKind;
}

/** Whether a viewer's remote reads wait for the network to come back (see `progress.reconnecting`). */
export interface ConnectionStatus {
  readonly reconnecting: boolean;
  /** Called whenever `reconnecting` changes; returns the unsubscribe function. */
  subscribe(listener: () => void): () => void;
}

export interface Subscription {
  topic: string;
  subscriberId: string;
}

export interface HighFrequencyConsumer {
  topic: string;
  /**
   * The panel this consumer belongs to, so the panel shell can show this topic's read errors.
   * Defaults to the consumer id up to its first `:` (`${panelId}:image-main`).
   */
  panelId?: string;
  lane: 'video' | 'pointcloud';
  mode?: 'latest' | 'all';
  onLatestMessage?: (message: MessageEvent) => void;
  onMessageBatch?: (messages: MessageEvent[]) => void;
}

/** Highest deterministic playback rate exposed by the visualization player. */
export const MAX_PLAYBACK_SPEED = 10;

export interface Player {
  setListener(listener: (state: PlayerState) => void): void;
  /** @deprecated Prefer registerSubscriptions per panel */
  setSubscriptions(subscriptions: Subscription[]): void;
  registerSubscriptions(panelId: string, subscriptions: Subscription[]): void;
  unregisterSubscriptions(panelId: string): void;
  registerHighFrequencyConsumer(consumerId: string, consumer: HighFrequencyConsumer): void;
  unregisterHighFrequencyConsumer(consumerId: string): void;
  /** Playback time updates without going through React state (rAF path). Immediately emits the current time. */
  subscribeCurrentTime(cb: (time: Time) => void): Unsubscribe;
  /** Latest playback time. Prefer this or subscribeCurrentTime for real-time playhead reads. */
  getCurrentTime(): Time | undefined;
  play(): void;
  /**
   * Tries again what failed: playback (as `play()`), the frame of each topic that could not be
   * read, and panels' own window reads (`progress.retryCount`). Optional; hosts' players may omit it.
   */
  retry?(): void;
  pause(): void;
  seek(time: Time): void;
  stepBy(deltaMs: number): void;
  /** Step one message backward/forward in log time (union of subscribed topics). */
  stepMessage(direction: -1 | 1): void;
  /**
   * Read deserialized messages in `[start, end]` by receive time (source-dependent).
   * Implemented by {@link IterablePlayer}; absent on other player stubs.
   */
  getMessagesInTimeRange?(args: GetMessagesInTimeRangeArgs): Promise<MessageEvent[]>;
  /**
   * Stream deserialized messages in `[start, end]` by receive time. Batches are yielded as soon
   * as the source cursor produces them so callers can render partial results.
   */
  streamMessagesInTimeRange?(args: StreamMessagesInTimeRangeArgs): AsyncIterable<MessageEvent[]>;
  /**
   * Where `[start, end]` can be cut so that the pieces are stored apart (MCAP chunks holding
   * `topics`): reading the pieces in any order decodes each stored unit about once. The first
   * boundary is `start`. Undefined when the source has no such units.
   */
  getReadBoundaries?(args: { start: Time; end: Time; topics: string[] }): Promise<Time[] | undefined>;
  startDataQualityScan?(): void;
  setSpeed(speed: number): void;
  setSamplingFps(fps: number): void;
  getSamplingFps(): number;
  setLooping(looping: boolean): void;
  close(): void;
}

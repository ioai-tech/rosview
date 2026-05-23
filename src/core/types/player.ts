import type { Time, TimeRange, TopicInfo, RosDatatypes, PlayerProblem, MessageEvent, DataQualityReport } from './ros';
import type { Range } from '@/shared/utils/ranges';

/** Arguments for optional range reads (e.g. Align panel). */
export interface GetMessagesInTimeRangeArgs {
  start: Time;
  end: Time;
  topics: string[];
}

export type Unsubscribe = () => void;

/** Random-access byte reader for ROS bag-like sources. */
export interface Readable {
  size(): Promise<number>;
  read(offset: number, length: number): Promise<Uint8Array>;
}

export type PlayerPresence = 'preinit' | 'initializing' | 'ready' | 'closed';

export interface PlayerState {
  presence: PlayerPresence;
  progress: {
    /** Remote source download percentage in byte space. */
    percent?: number;
    /** Downloaded byte ranges [start, end) for transport/cache diagnostics. */
    downloadedByteRanges?: Range[];
    /** Total source bytes for byte-range diagnostics. */
    totalBytes?: number;
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
  };
}

export interface Subscription {
  topic: string;
  subscriberId: string;
}

export interface HighFrequencyConsumer {
  topic: string;
  lane: 'video' | 'pointcloud';
  mode?: 'latest' | 'all';
  onLatestMessage?: (message: MessageEvent) => void;
  onMessageBatch?: (messages: MessageEvent[]) => void;
}

/** Sentinel playback speed for “as fast as possible” (see IterablePlayer / PlaybackBar). */
export const PLAYBACK_SPEED_MAX = -1;

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
  play(): void;
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
  startDataQualityScan?(): void;
  setSpeed(speed: number): void;
  setSamplingFps(fps: number): void;
  getSamplingFps(): number;
  setLooping(looping: boolean): void;
  close(): void;
}

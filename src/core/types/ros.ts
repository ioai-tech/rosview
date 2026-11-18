export type Time = {
  sec: number;
  nsec: number;
};

export interface TimeRange {
  start: Time;
  end: Time;
}

export interface TopicInfo {
  name: string;
  type: string;
  messageCount?: number;
  frequency?: number;
  durationSec?: number;
  /**
   * Display labels for the recording file(s) this topic came from. Only
   * populated when multiple sources are merged into one session (see
   * `CombinedSourceProxy`); absent for single-file sessions so existing UI
   * is unaffected.
   */
  sourceLabels?: string[];
}

/** ROS datatype definitions keyed by schema name (payload shape is source-dependent). */
export type RosDatatypes = Record<string, unknown>;

export interface TopicStats {
  messageCount: number;
  frequency: number;
  durationSec?: number;
}

export interface PlayerProblem {
  severity: 'error' | 'warn';
  message: string;
}

export type {
  ClockEvidenceWindow,
  ClockPoint,
  DataQualityClockSource,
  DataQualityExplainPayload,
  DataQualityIssue,
  DataQualityIssueCounts,
  DataQualityIssueRange,
  DataQualityIssueType,
  DataQualityReport,
  DataQualityScope,
  DataQualitySeverity,
  DataQualityStatus,
  DataQualitySummaryStats,
  QualityIncident,
  QualityRawSample,
  QualityScanCoverage,
} from '@/core/quality/types';

export interface Initialization {
  topics: TopicInfo[];
  datatypes: RosDatatypes;
  start: Time;
  end: Time;
  publishersByTopic: Record<string, string[]>;
  topicStats: Record<string, TopicStats>;
  problems: PlayerProblem[];
  /**
   * Optional hint from the source about the natural playback sampling rate
   * (Hz). When present, the player uses it as the initial `samplingFps`
   * instead of its built-in default. Sources that wrap naturally periodic
   * data (e.g. synthesized HDF5 timelines) should set this so the PlaybackBar
   * FPS control matches the data cadence; message-based sources (MCAP / bag)
   * typically leave it unset.
   */
  preferredSamplingFps?: number;
  /**
   * When true, the source supports efficient random access by topic and time
   * (e.g. MCAP chunk index, SQLite db3). Plot panels can read only subscribed
   * topics without scanning the full recording.
   */
  randomAccessByTopic?: boolean;
  /**
   * True when the bytes come from a remote server through range reads. Panels that would
   * otherwise scan the whole recording (Plot) read a window around the playhead instead.
   */
  remoteRangeBacked?: boolean;
}

export interface MessageEvent<T = unknown> {
  topic: string;
  receiveTime: Time;
  publishTime: Time;
  message: T;
  schemaName: string;
  payloadKind?: 'object' | 'hybrid-transfer' | 'hybrid-sab';
  sizeInBytes?: number;
}

import type {
  GetMessagesInTimeRangeArgs,
  HighFrequencyConsumer,
  Player,
  PlayerState,
  Subscription,
} from '@/core/types/player';
import { PLAYBACK_SPEED_MAX } from '@/core/types/player';
import type { DataQualityReport, Time, Initialization, MessageEvent, TimeRange } from '@/core/types/ros';
import type { WorkerSerializedSource } from '@/infra/workers/WorkerSerializedSource';
import type { IMessageCursor } from '@/infra/workers/types';
import { addMs, toNano } from '@/shared/utils/time';
import { useMessagePipelineStore } from '@/core/pipeline/store';
import { messageBus } from '@/core/pipeline/messageBus';
import type { Range } from '@/shared/utils/ranges';
import { PlaybackClock } from './PlaybackClock';

const PIPELINE_EMIT_INTERVAL_MS = 200;
const DEFAULT_SAMPLING_FPS = 30;
const MAX_SAMPLING_FPS = 45;
const LOAD_PROGRESS_POLL_INTERVAL_MS = 1000;
const TRANSPORT_DIAGNOSTICS_POLL_INTERVAL_MS = 2000;
const EMPTY_BATCH_BACKFILL_COOLDOWN_MS = 1000;
const EMPTY_BATCH_BACKFILL_TRIGGER = 4;
const BACKFILL_STALE_THRESHOLD_NS = 1_000_000_000n;
const STALE_TOPIC_REFRESH_COOLDOWN_MS = 500;
const SLOW_DISTRIBUTION_MS = 16;

function isSameRanges(nextValue?: Range[], prevValue?: Range[]): boolean {
  if (nextValue === prevValue) {
    return true;
  }
  if (!nextValue || !prevValue || nextValue.length !== prevValue.length) {
    return false;
  }
  for (let i = 0; i < nextValue.length; i++) {
    const nextRange = nextValue[i];
    const prevRange = prevValue[i];
    if (!nextRange || !prevRange || nextRange.start !== prevRange.start || nextRange.end !== prevRange.end) {
      return false;
    }
  }
  return true;
}

function isSameTimeRanges(nextValue?: TimeRange[], prevValue?: TimeRange[]): boolean {
  if (nextValue === prevValue) {
    return true;
  }
  if (!nextValue || !prevValue || nextValue.length !== prevValue.length) {
    return false;
  }
  for (let i = 0; i < nextValue.length; i++) {
    const nextRange = nextValue[i];
    const prevRange = prevValue[i];
    if (
      !nextRange ||
      !prevRange ||
      nextRange.start.sec !== prevRange.start.sec ||
      nextRange.start.nsec !== prevRange.start.nsec ||
      nextRange.end.sec !== prevRange.end.sec ||
      nextRange.end.nsec !== prevRange.end.nsec
    ) {
      return false;
    }
  }
  return true;
}

type SharedPayloadRingProgress = NonNullable<PlayerState["progress"]["sharedPayloadRing"]>;

function isSameSharedPayloadRing(
  nextValue?: SharedPayloadRingProgress,
  prevValue?: SharedPayloadRingProgress,
): boolean {
  if (nextValue === prevValue) {
    return true;
  }
  if (!nextValue || !prevValue) {
    return false;
  }
  return (
    nextValue.slotCount === prevValue.slotCount &&
    nextValue.slotSizeBytes === prevValue.slotSizeBytes &&
    nextValue.totalBytes === prevValue.totalBytes
  );
}

function deriveDurationSec(messageCount?: number, frequency?: number): number | undefined {
  if (
    typeof messageCount !== "number" ||
    typeof frequency !== "number" ||
    !Number.isFinite(messageCount) ||
    !Number.isFinite(frequency) ||
    messageCount <= 1 ||
    frequency <= 0
  ) {
    return undefined;
  }
  return (messageCount - 1) / frequency;
}

function isSameDataQualityReport(nextValue?: DataQualityReport, prevValue?: DataQualityReport): boolean {
  if (nextValue === prevValue) {
    return true;
  }
  if (!nextValue || !prevValue) {
    return false;
  }
  return (
    nextValue.status === prevValue.status &&
    nextValue.scannedMessages === prevValue.scannedMessages &&
    nextValue.totalMessages === prevValue.totalMessages &&
    nextValue.updatedAt === prevValue.updatedAt &&
    nextValue.ranges.length === prevValue.ranges.length &&
    nextValue.issues.length === prevValue.issues.length &&
    nextValue.issueCounts.timestamp_rollback === prevValue.issueCounts.timestamp_rollback &&
    nextValue.issueCounts.topic_frame_drop === prevValue.issueCounts.topic_frame_drop
  );
}

export class IterablePlayer implements Player {
  private _source: WorkerSerializedSource;
  private _state: PlayerState = {
    presence: "preinit",
    progress: {},
  };
  private _listener?: (state: PlayerState) => void;
  private _subscriptionsByPanel = new Map<string, Subscription[]>();
  private _subscriptions: Subscription[] = [];
  private _subscriberIdsByTopic = new Map<string, string[]>();
  private _highFrequencyConsumersById = new Map<string, HighFrequencyConsumer>();
  private _highFrequencyConsumersByTopic = new Map<string, HighFrequencyConsumer[]>();
  private _isPlaying: boolean = false;
  private _isLooping: boolean = true;
  private _speed: number = 1.0;
  private _currentTime: Time = { sec: 0, nsec: 0 };
  private _initialization?: Initialization;
  private _cursor?: IMessageCursor<unknown>;
  private _clock = new PlaybackClock(this._currentTime);
  private _isFetching: boolean = false;
  private _timeSubscribers = new Set<(time: Time) => void>();
  private _rafId: number | undefined;
  private _lastPipelineEmitMs = 0;
  private _loadProgressPollId: ReturnType<typeof globalThis.setInterval> | undefined;
  private _samplingFps = DEFAULT_SAMPLING_FPS;
  private _lastTransportDiagnosticsMs = 0;
  private _lastTickWallMs = 0;
  private _pageSuspended = false;
  private _emptyBatchStreak = 0;
  private _cursorRebuildCount = 0;
  private _fallbackBackfillCount = 0;
  private _lastFallbackBackfillMs = 0;
  private _lastStaleRefreshMs = 0;
  private _isBuffering = false;
  private _topicLastMessageNs = new Map<string, bigint>();
  private _highFrequencyConsumerSignature = "";
  private _debugEnabled =
    typeof window !== "undefined" && new URLSearchParams(window.location.search).get("debugPlayback") === "1";

  constructor(source: WorkerSerializedSource) {
    this._source = source;
    this._attachPageLifecycleListeners();
  }

  setListener(listener: (state: PlayerState) => void): void {
    this._listener = listener;
    this._emitState();
  }

  subscribeCurrentTime(cb: (time: Time) => void): () => void {
    this._timeSubscribers.add(cb);
    cb(this._currentTime);
    return () => {
      this._timeSubscribers.delete(cb);
    };
  }

  registerSubscriptions(panelId: string, subscriptions: Subscription[]): void {
    this._subscriptionsByPanel.set(panelId, subscriptions);
    void this._rebuildSubscriptions();
  }

  unregisterSubscriptions(panelId: string): void {
    this._subscriptionsByPanel.delete(panelId);
    void this._rebuildSubscriptions();
  }

  registerHighFrequencyConsumer(consumerId: string, consumer: HighFrequencyConsumer): void {
    const prevTopics = new Set(this._currentTopics());
    const prevSignature = this._highFrequencyConsumerSignature;
    this._highFrequencyConsumersById.set(consumerId, consumer);
    this._rebuildHighFrequencyConsumerIndex();
    void this._handleHighFrequencyConsumerChange(prevTopics, prevSignature);
  }

  unregisterHighFrequencyConsumer(consumerId: string): void {
    const prevTopics = new Set(this._currentTopics());
    const prevSignature = this._highFrequencyConsumerSignature;
    this._highFrequencyConsumersById.delete(consumerId);
    this._rebuildHighFrequencyConsumerIndex();
    void this._handleHighFrequencyConsumerChange(prevTopics, prevSignature);
  }

  setSubscriptions(subscriptions: Subscription[]): void {
    this._subscriptionsByPanel.clear();
    this._subscriptionsByPanel.set("__legacy__", subscriptions);
    void this._rebuildSubscriptions();
  }

  private async _rebuildSubscriptions(): Promise<void> {
    const prevTopics = new Set(this._currentTopics());
    const merged = Array.from(this._subscriptionsByPanel.values()).flat();
    const oldSubscriptionSignature = this._subscriptions
      .map((s) => `${s.subscriberId}\0${s.topic}`)
      .sort()
      .join("\n");
    const newSubscriptionSignature = merged
      .map((s) => `${s.subscriberId}\0${s.topic}`)
      .sort()
      .join("\n");

    const subscriptionsChanged = oldSubscriptionSignature !== newSubscriptionSignature;

    this._subscriptions = merged;
    this._subscriberIdsByTopic = this._buildSubscriberIndex(merged);
    await this._handleTopicSetChange(prevTopics);
    if (subscriptionsChanged && this._cursor) {
      await this._cursor.end();
      this._cursor = undefined;
    }

    // When subscriptions change while paused and player is ready, backfill the
    // current position so panels receive data without requiring user interaction.
    if (subscriptionsChanged && !this._isPlaying && this._initialization) {
      await this._backfillCurrentTime();
    }
  }

  private _buildSubscriberIndex(subscriptions: Subscription[]): Map<string, string[]> {
    const index = new Map<string, string[]>();
    for (const sub of subscriptions) {
      let ids = index.get(sub.topic);
      if (!ids) {
        ids = [];
        index.set(sub.topic, ids);
      }
      if (!ids.includes(sub.subscriberId)) {
        ids.push(sub.subscriberId);
      }
    }
    return index;
  }

  private _rebuildHighFrequencyConsumerIndex(): void {
    const index = new Map<string, HighFrequencyConsumer[]>();
    for (const consumer of this._highFrequencyConsumersById.values()) {
      const consumers = index.get(consumer.topic) ?? [];
      consumers.push(consumer);
      index.set(consumer.topic, consumers);
    }
    this._highFrequencyConsumersByTopic = index;
    this._highFrequencyConsumerSignature = Array.from(this._highFrequencyConsumersById.entries())
      .map(([id, consumer]) => `${id}\0${consumer.topic}\0${consumer.lane}\0${consumer.mode ?? "latest"}`)
      .sort()
      .join("\n");
  }

  private _currentTopics(): string[] {
    return Array.from(new Set([...this._subscriberIdsByTopic.keys(), ...this._highFrequencyConsumersByTopic.keys()]));
  }

  private _latestOnlyHighFrequencyTopics(): string[] {
    return Array.from(this._highFrequencyConsumersByTopic.keys()).filter((topic) => {
      const consumers = this._highFrequencyConsumersByTopic.get(topic);
      return (
        (this._subscriberIdsByTopic.get(topic)?.length ?? 0) === 0 &&
        consumers != undefined &&
        consumers.length > 0 &&
        consumers.every((consumer) => (consumer.mode ?? "latest") === "latest")
      );
    });
  }

  private async _handleTopicSetChange(previousTopics: ReadonlySet<string>): Promise<void> {
    const nextTopics = new Set(this._currentTopics());
    let topicsChanged = previousTopics.size !== nextTopics.size;
    if (!topicsChanged) {
      for (const topic of nextTopics) {
        if (!previousTopics.has(topic)) {
          topicsChanged = true;
          break;
        }
      }
    }
    if (!topicsChanged) {
      return;
    }
    if (this._cursor) {
      await this._cursor.end();
      this._cursor = undefined;
    }
  }

  private async _handleHighFrequencyConsumerChange(
    previousTopics: ReadonlySet<string>,
    previousSignature: string,
  ): Promise<void> {
    const before = new Set(previousTopics);
    await this._handleTopicSetChange(before);
    if (this._cursor && previousSignature !== this._highFrequencyConsumerSignature) {
      await this._cursor.end();
      this._cursor = undefined;
    }
    if (!this._isPlaying && this._initialization) {
      await this._backfillCurrentTime();
    }
  }

  private async _backfillCurrentTime(): Promise<void> {
    const topics = this._currentTopics();
    if (topics.length === 0) return;
    try {
      const messages = await this._source.getBackfillMessages({
        time: this._currentTime,
        topics,
      });
      this._distributeMessages(messages, this._currentTime);
      this._lastPipelineEmitMs = 0;
      this._emitState();
    } catch (err) {
      console.warn("IterablePlayer: backfill failed", err);
    }
  }

  async initialize(args: Record<string, unknown>): Promise<void> {
    this._state.presence = "initializing";
    this._state.progress = {};
    this._emitState();

    try {
      this._initialization = await this._source.initialize(args);
      this._topicLastMessageNs.clear();
      this._currentTime = this._initialization.start;
      this._state.presence = "ready";

      // If the source suggests a natural sampling cadence (e.g. HDF5 at 10 Hz),
      // adopt it so the playback tick matches the data. Clamped to the same
      // range as user-facing setSamplingFps for consistency with the UI.
      const hinted = this._initialization.preferredSamplingFps;
      if (typeof hinted === "number" && Number.isFinite(hinted) && hinted > 0) {
        this._samplingFps = Math.max(1, Math.min(MAX_SAMPLING_FPS, Math.round(hinted)));
      }
      const publishersByTopic = new Map<string, Set<string>>(
        Object.entries(this._initialization.publishersByTopic).map(([k, v]) => [k, new Set(v)]),
      );
      const stats = this._initialization.topicStats;
      const mergedTopics = this._initialization.topics.map((t) => {
        const s = stats[t.name];
        const messageCount = t.messageCount ?? s?.messageCount;
        const frequency = t.frequency ?? s?.frequency;
        return {
          ...t,
          messageCount,
          frequency,
          durationSec: t.durationSec ?? s?.durationSec ?? deriveDurationSec(messageCount, frequency),
        };
      });
      this._state.activeData = {
        topics: mergedTopics,
        datatypes: this._initialization.datatypes,
        publishersByTopic,
        startTime: this._initialization.start,
        endTime: this._initialization.end,
        currentTime: this._currentTime,
        isPlaying: this._isPlaying,
        isLooping: this._isLooping,
        speed: this._speed,
        problems: this._initialization.problems,
      };

      messageBus.reset();
      const transportInfo = await this._source.getTransportDiagnostics();
      const dataQualityReport = await this._source.getDataQualityReport?.();
      this._state.progress = {
        ...this._state.progress,
        downloadedByteRanges: [],
        parsedMessageRanges: [],
        transportMode: transportInfo.mode,
        transportFallbackReason: transportInfo.fallbackReason,
        crossOriginIsolated: transportInfo.crossOriginIsolated,
        binaryPayloadThresholdBytes: transportInfo.binaryPayloadThresholdBytes,
        sharedPayloadRing: transportInfo.sharedPayloadRing,
        droppedPayloads: transportInfo.droppedPayloads,
        stalePayloadRefs: transportInfo.stalePayloadRefs,
        samplingFps: this._samplingFps,
        emptyBatchStreak: this._emptyBatchStreak,
        cursorRebuildCount: this._cursorRebuildCount,
        fallbackBackfillCount: this._fallbackBackfillCount,
        buffering: this._isBuffering,
        dataQualityReport,
      };
      this._lastTransportDiagnosticsMs = performance.now();
      useMessagePipelineStore.getState().setPlayerState(this._state);
      this._emitState();
      this._startLoadProgressPolling();
      void this._refreshLoadProgress();
    } catch (err) {
      console.error("IterablePlayer: initialization failed", err);
      this._state.presence = "closed";
      this._state.activeData = undefined;
      messageBus.reset();
      this._emitState();
      throw err;
    }
  }

  play(): void {
    if (this._isPlaying) return;
    this._isPlaying = true;
    const now = performance.now();
    this._clock.play(this._currentTime, this._speedFactor(), now);
    this._lastTickWallMs = now;
    this._pageSuspended = typeof document !== "undefined" && document.hidden;
    if (this._pageSuspended) {
      this._clock.suspend(now);
    }
    if (this._state.presence === "ready") {
      this._startLoadProgressPolling();
      void this._refreshLoadProgress();
    }
    this._emitState();
    this._cancelRaf();
    if (!this._pageSuspended) {
      this._rafId = requestAnimationFrame(this._tickLoop);
    }
  }

  pause(): void {
    const now = performance.now();
    this._clock.pause(now);
    this._currentTime = this._clock.getTime(now);
    this._isPlaying = false;
    this._pageSuspended = false;
    this._cancelRaf();
    this._stopLoadProgressPolling();
    this._emitState();
  }

  startDataQualityScan(): void {
    void (async () => {
      try {
        await this._source.startDataQualityScan();
        await this._refreshLoadProgress();
      } catch (err) {
        console.warn("IterablePlayer: startDataQualityScan failed", err);
      }
    })();
  }

  seek(time: Time): void {
    void this._seekAsync(time);
  }

  private async _seekAsync(time: Time): Promise<void> {
    this._currentTime = this._clampToRange(time);
    this._clock.seek(this._currentTime, performance.now());
    this._topicLastMessageNs.clear();
    if (this._cursor) {
      await this._cursor.end();
      this._cursor = undefined;
    }

    const topics = this._currentTopics();
    if (topics.length > 0) {
      const messages = await this._source.getBackfillMessages({ time, topics });
      this._distributeMessages(messages, this._currentTime);
    }

    this._notifyTimeSubscribers(this._currentTime);
    this._lastPipelineEmitMs = 0;
    this._emitState();
  }

  stepBy(deltaMs: number): void {
    const next = addMs(this._currentTime, deltaMs);
    void this._seekAsync(next);
  }

  stepMessage(direction: -1 | 1): void {
    void this._stepMessageAsync(direction);
  }

  private async _stepMessageAsync(direction: -1 | 1): Promise<void> {
    const topics = this._currentTopics();
    if (topics.length === 0) return;
    try {
      const msg = await this._source.getAdjacentMessage({
        time: this._currentTime,
        topics,
        direction: direction === 1 ? "next" : "prev",
      });
      if (!msg) return;
      if (this._cursor) {
        await this._cursor.end();
        this._cursor = undefined;
      }
      this._currentTime = this._clampToRange(msg.receiveTime);
      this._clock.seek(this._currentTime, performance.now());
      this._topicLastMessageNs.clear();
      this._distributeMessages([msg], this._currentTime);
      this._notifyTimeSubscribers(this._currentTime);
      this._lastPipelineEmitMs = 0;
      this._emitState();
    } catch (err) {
      console.warn("IterablePlayer: stepMessage failed", err);
    }
  }

  setSpeed(speed: number): void {
    if (speed === PLAYBACK_SPEED_MAX) {
      this._speed = PLAYBACK_SPEED_MAX;
    } else {
      this._speed = Math.min(8, Math.max(0.1, speed));
    }
    this._clock.setSpeed(this._speedFactor(), performance.now());
    this._emitState();
  }

  private _speedFactor(): number {
    return this._speed === PLAYBACK_SPEED_MAX ? 64 : this._speed;
  }

  setSamplingFps(fps: number): void {
    const clamped = Math.max(1, Math.min(MAX_SAMPLING_FPS, Math.round(fps)));
    this._samplingFps = clamped;
    this._state.progress = {
      ...this._state.progress,
      samplingFps: this._samplingFps,
    };
    this._emitState();
  }

  getSamplingFps(): number {
    return this._samplingFps;
  }

  setLooping(looping: boolean): void {
    this._isLooping = looping;
    this._emitState();
  }

  close(): void {
    this._clock.pause(performance.now());
    this._isPlaying = false;
    this._pageSuspended = false;
    this._cancelRaf();
    this._detachPageLifecycleListeners();
    this._stopLoadProgressPolling();
    this._source.terminate();
    this._state.presence = "closed";
    this._state.progress = {};
    this._state.activeData = undefined;
    this._initialization = undefined;
    this._clock = new PlaybackClock();
    this._cursor = undefined;
    this._topicLastMessageNs.clear();
    this._highFrequencyConsumersById.clear();
    this._highFrequencyConsumersByTopic.clear();
    this._emitState();
  }

  private _cancelRaf(): void {
    if (this._rafId != undefined) {
      cancelAnimationFrame(this._rafId);
      this._rafId = undefined;
    }
  }

  private _notifyTimeSubscribers(time: Time): void {
    for (const cb of this._timeSubscribers) {
      cb(time);
    }
  }

  /** Replace activeData with a shallow copy so Zustand/React see a new reference. */
  private _syncActiveDataSlice(): void {
    const cur = this._state.activeData;
    if (!cur) return;
    this._state.activeData = {
      ...cur,
      currentTime: this._currentTime,
      isPlaying: this._isPlaying,
      isLooping: this._isLooping,
      speed: this._speed,
    };
  }

  private _maybeEmitPipelineState(): void {
    const now = performance.now();
    if (now - this._lastPipelineEmitMs < PIPELINE_EMIT_INTERVAL_MS) return;
    this._lastPipelineEmitMs = now;
    this._syncActiveDataSlice();
    useMessagePipelineStore.getState().setPlayerState(this._state);
  }

  private _emitState() {
    this._syncActiveDataSlice();

    if (this._listener) {
      this._listener(this._state);
    }
    useMessagePipelineStore.getState().setPlayerState(this._state);
  }

  private _distributeMessages(messages: MessageEvent[], referenceTime?: Time) {
    if (messages.length === 0) return;
    const startedAt = this._debugEnabled ? performance.now() : 0;
    const messagesForSubscribers: MessageEvent[] = [];
    const latestMessagesForHighFrequencyConsumers = new Map<string, MessageEvent>();
    const batchesForHighFrequencyConsumers = new Map<string, MessageEvent[]>();
    const topicsWithSubscribers = new Set<string>();

    for (const msg of messages) {
      this._topicLastMessageNs.set(msg.topic, toNano(msg.receiveTime));
      const subscriberIds = this._subscriberIdsByTopic.get(msg.topic);
      if (subscriberIds && subscriberIds.length > 0) {
        messagesForSubscribers.push(msg);
        topicsWithSubscribers.add(msg.topic);
      }
      if (this._highFrequencyConsumersByTopic.has(msg.topic)) {
        latestMessagesForHighFrequencyConsumers.set(msg.topic, msg);
        const consumers = this._highFrequencyConsumersByTopic.get(msg.topic);
        if (consumers?.some((consumer) => consumer.mode === "all")) {
          const topicBatch = batchesForHighFrequencyConsumers.get(msg.topic) ?? [];
          topicBatch.push(msg);
          batchesForHighFrequencyConsumers.set(msg.topic, topicBatch);
        }
      }
    }

    // High-frequency lanes (video/3D) only need the latest frame per topic. Run
    // them before the full subscriber batch so a large normal batch cannot hold
    // the latest visual frame behind avoidable deserialization work.
    this._dispatchHighFrequencyMessages(
      latestMessagesForHighFrequencyConsumers,
      batchesForHighFrequencyConsumers,
      topicsWithSubscribers,
    );

    const resolvedMessages =
      messagesForSubscribers.length > 0
        ? this._source.resolveMessageBatch(messagesForSubscribers)
        : [];
    const messagesBySubscriber = new Map<string, MessageEvent[]>();
    const lastMessages = new Map<string, MessageEvent>();

    for (const msg of resolvedMessages) {
      const subscriberIds = this._subscriberIdsByTopic.get(msg.topic);
      if (subscriberIds && subscriberIds.length > 0) {
        lastMessages.set(msg.topic, msg);
        for (const subscriberId of subscriberIds) {
          if (!messagesBySubscriber.has(subscriberId)) {
            messagesBySubscriber.set(subscriberId, []);
          }
          messagesBySubscriber.get(subscriberId)!.push(msg);
        }
      }
    }

    messageBus.update(messagesBySubscriber, lastMessages);
    if (this._debugEnabled) {
      const elapsedMs = performance.now() - startedAt;
      if (elapsedMs >= SLOW_DISTRIBUTION_MS) {
        console.debug("[Playback] slow distribute " + JSON.stringify({
          elapsedMs,
          inputCount: messages.length,
          subscriberMessageCount: messagesForSubscribers.length,
          resolvedMessageCount: resolvedMessages.length,
          highFrequencyTopicCount: latestMessagesForHighFrequencyConsumers.size,
          highFrequencyBatchTopicCount: batchesForHighFrequencyConsumers.size,
          referenceTime,
        }));
      }
    }
    if (this._debugEnabled) {
      console.debug("[Playback] distribute " + JSON.stringify({
        messageCount: resolvedMessages.length,
        topicCount: lastMessages.size,
        highFrequencyTopicCount: latestMessagesForHighFrequencyConsumers.size,
        highFrequencyBatchTopicCount: batchesForHighFrequencyConsumers.size,
        referenceTime,
      }));
    }
  }

  private _dispatchHighFrequencyMessages(
    latestMessagesForHighFrequencyConsumers: Map<string, MessageEvent>,
    batchesForHighFrequencyConsumers: Map<string, MessageEvent[]>,
    topicsWithSubscribers: Set<string>,
  ): void {
    for (const [topic, latestMessage] of latestMessagesForHighFrequencyConsumers) {
      const consumers = this._highFrequencyConsumersByTopic.get(topic);
      if (!consumers) {
        continue;
      }
      const copyPayload = topicsWithSubscribers.has(topic) || consumers.length > 1;
      const topicBatch = batchesForHighFrequencyConsumers.get(topic);
      const sharedHighFrequencyMessage = copyPayload
        ? undefined
        : this._source.resolveMessageForHighFrequencyLane(latestMessage, {
            preferSharedView: true,
            copyPayload: false,
          });
      const sharedHighFrequencyBatch =
        !copyPayload && topicBatch
          ? topicBatch.map((message) =>
              this._source.resolveMessageForHighFrequencyLane(message, {
                preferSharedView: true,
                copyPayload: false,
              }),
            )
          : undefined;
      for (const consumer of consumers) {
        try {
          if (consumer.mode === "all" && consumer.onMessageBatch) {
            const highFrequencyBatch =
              sharedHighFrequencyBatch ??
              (topicBatch ?? [latestMessage]).map((message) =>
                this._source.resolveMessageForHighFrequencyLane(message, {
                  preferSharedView: false,
                  copyPayload: true,
                }),
              );
            consumer.onMessageBatch(highFrequencyBatch);
            continue;
          }
          const highFrequencyMessage =
            sharedHighFrequencyMessage ??
            this._source.resolveMessageForHighFrequencyLane(latestMessage, {
              preferSharedView: false,
              copyPayload: true,
            });
          consumer.onLatestMessage?.(highFrequencyMessage);
        } catch (error) {
          console.error('IterablePlayer: high-frequency consumer failed', error);
        }
      }
    }
  }

  private _tickLoop = (): void => {
    void this._tickAsync();
  };

  private _handleVisibilityChange = (): void => {
    if (typeof document === "undefined") return;
    if (document.hidden) {
      this._suspendForPageLifecycle();
    } else {
      this._resumeFromPageLifecycle();
    }
  };

  private _handlePageHide = (): void => {
    this._suspendForPageLifecycle();
  };

  private _handlePageShow = (): void => {
    if (typeof document !== "undefined" && document.hidden) return;
    this._resumeFromPageLifecycle();
  };

  private _attachPageLifecycleListeners(): void {
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", this._handleVisibilityChange);
    }
    if (typeof window !== "undefined") {
      window.addEventListener("pagehide", this._handlePageHide);
      window.addEventListener("pageshow", this._handlePageShow);
    }
  }

  private _detachPageLifecycleListeners(): void {
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this._handleVisibilityChange);
    }
    if (typeof window !== "undefined") {
      window.removeEventListener("pagehide", this._handlePageHide);
      window.removeEventListener("pageshow", this._handlePageShow);
    }
  }

  private _suspendForPageLifecycle(): void {
    if (!this._isPlaying || this._pageSuspended) return;
    const now = performance.now();
    this._clock.suspend(now);
    this._currentTime = this._clock.getTime(now);
    this._lastTickWallMs = now;
    this._pageSuspended = true;
    this._cancelRaf();
    this._notifyTimeSubscribers(this._currentTime);
    this._maybeEmitPipelineState();
  }

  private _resumeFromPageLifecycle(): void {
    if (!this._isPlaying || !this._pageSuspended) return;
    const now = performance.now();
    this._clock.resume(now);
    this._lastTickWallMs = now;
    this._pageSuspended = false;
    this._cancelRaf();
    this._rafId = requestAnimationFrame(this._tickLoop);
  }

  private async _tickAsync(): Promise<void> {
    if (!this._isPlaying || this._pageSuspended) return;
    const now = performance.now();
    if (this._isFetching) {
      this._clock.seek(this._currentTime, now);
      if (this._isPlaying) {
        this._rafId = requestAnimationFrame(this._tickLoop);
      }
      return;
    }

    const tickDurationMs = 1000 / this._samplingFps;
    if (now - this._lastTickWallMs < tickDurationMs) {
      if (this._isPlaying) {
        this._rafId = requestAnimationFrame(this._tickLoop);
      }
      return;
    }

    this._lastTickWallMs = now;
    const nextTime = this._clampToRange(this._clock.getTime(now));
    const currentNs = toNano(this._currentTime);
    const nextNs = toNano(nextTime);
    if (nextNs <= currentNs) {
      if (this._isPlaying) {
        this._rafId = requestAnimationFrame(this._tickLoop);
      }
      return;
    }
    const batchDurationMs = Math.max(1, Number(nextNs - currentNs) / 1e6);

    if (!this._cursor) {
      const topics = this._currentTopics();
      if (topics.length > 0) {
        this._cursor = await this._source.getMessageCursor({
          startTime: this._currentTime,
          topics,
          latestOnlyTopics: this._latestOnlyHighFrequencyTopics(),
        });
      }
    }

    if (this._cursor) {
      this._isFetching = true;
      try {
        const messages = await this._cursor.nextBatch(batchDurationMs, { endTime: nextTime });
        if (messages.length > 0) {
          this._emptyBatchStreak = 0;
          this._distributeMessages(messages);
          if (this._debugEnabled) {
            console.debug("[Playback] nextBatch " + JSON.stringify({
              batchDurationMs,
              count: messages.length,
              currentTime: this._currentTime,
            }));
          }
        } else {
          await this._handleEmptyBatch(now);
        }
      } catch (err) {
        console.error("Failed to fetch messages", err);
      } finally {
        this._isFetching = false;
      }
    }

    this._currentTime = nextTime;
    this._clock.seek(this._currentTime, performance.now());
    await this._refreshStaleTopicsFromBackfill(now);

    if (this._initialization && toNano(this._currentTime) >= toNano(this._initialization.end)) {
      if (this._isLooping) {
        this._currentTime = this._initialization.start;
        this._clock.seek(this._currentTime, performance.now());
        if (this._cursor) {
          await this._cursor.end();
          this._cursor = undefined;
        }
        const topics = this._currentTopics();
        if (topics.length > 0) {
          const messages = await this._source.getBackfillMessages({ time: this._currentTime, topics });
          this._distributeMessages(messages, this._currentTime);
        }
        this._notifyTimeSubscribers(this._currentTime);
        this._emitState();
        if (this._isPlaying) {
          this._rafId = requestAnimationFrame(this._tickLoop);
        }
        return;
      }
      this._currentTime = this._initialization.end;
      this._clock.seek(this._currentTime, performance.now());
      this.pause();
      this._notifyTimeSubscribers(this._currentTime);
      return;
    }

    this._notifyTimeSubscribers(this._currentTime);
    this._maybeEmitPipelineState();

    if (this._isPlaying) {
      this._rafId = requestAnimationFrame(this._tickLoop);
    }
  }

  private _clampToRange(time: Time): Time {
    if (!this._initialization) return time;
    const t = toNano(time);
    const start = toNano(this._initialization.start);
    const end = toNano(this._initialization.end);
    if (t < start) return this._initialization.start;
    if (t > end) return this._initialization.end;
    return time;
  }

  private _startLoadProgressPolling(): void {
    this._stopLoadProgressPolling();
    this._loadProgressPollId = globalThis.setInterval(() => {
      void this._refreshLoadProgress();
    }, LOAD_PROGRESS_POLL_INTERVAL_MS);
  }

  private _stopLoadProgressPolling(): void {
    if (this._loadProgressPollId != undefined) {
      globalThis.clearInterval(this._loadProgressPollId);
      this._loadProgressPollId = undefined;
    }
  }

  private async _refreshLoadProgress(): Promise<void> {
    if (this._state.presence !== "ready") return;
    try {
      const progress = await this._source.getLoadProgress();
      const now = performance.now();
      const shouldRefreshTransport =
        this._state.progress.transportMode == null ||
        now - this._lastTransportDiagnosticsMs >= TRANSPORT_DIAGNOSTICS_POLL_INTERVAL_MS;
      let transportMode = this._state.progress.transportMode;
      let transportFallbackReason = this._state.progress.transportFallbackReason;
      let crossOriginIsolated = this._state.progress.crossOriginIsolated;
      let binaryPayloadThresholdBytes = this._state.progress.binaryPayloadThresholdBytes;
      let sharedPayloadRing = this._state.progress.sharedPayloadRing;
      let droppedPayloads = this._state.progress.droppedPayloads;
      let stalePayloadRefs = this._state.progress.stalePayloadRefs;
      if (shouldRefreshTransport) {
        const transport = await this._source.getTransportDiagnostics();
        transportMode = transport.mode;
        transportFallbackReason = transport.fallbackReason;
        crossOriginIsolated = transport.crossOriginIsolated;
        binaryPayloadThresholdBytes = transport.binaryPayloadThresholdBytes;
        sharedPayloadRing = transport.sharedPayloadRing;
        droppedPayloads = transport.droppedPayloads;
        stalePayloadRefs = transport.stalePayloadRefs;
        this._lastTransportDiagnosticsMs = now;
      }
      const dataQualityReport = await this._source.getDataQualityReport?.();
      const nextProgress = {
        percent: progress.percent,
        downloadedByteRanges: progress.downloadedByteRanges,
        parsedMessageRanges: progress.parsedMessageRanges,
        totalBytes: progress.totalBytes,
        transportMode,
        transportFallbackReason,
        crossOriginIsolated,
        binaryPayloadThresholdBytes,
        sharedPayloadRing,
        droppedPayloads,
        stalePayloadRefs,
        samplingFps: this._samplingFps,
        emptyBatchStreak: this._emptyBatchStreak,
        cursorRebuildCount: this._cursorRebuildCount,
        fallbackBackfillCount: this._fallbackBackfillCount,
        buffering: this._isBuffering,
        bufferedAheadMs: progress.bufferedAheadMs,
        dataQualityReport,
      };
      const prevProgress = this._state.progress;
      const unchanged =
        nextProgress.percent === prevProgress.percent &&
        nextProgress.totalBytes === prevProgress.totalBytes &&
        nextProgress.transportMode === prevProgress.transportMode &&
        nextProgress.transportFallbackReason === prevProgress.transportFallbackReason &&
        nextProgress.crossOriginIsolated === prevProgress.crossOriginIsolated &&
        nextProgress.binaryPayloadThresholdBytes === prevProgress.binaryPayloadThresholdBytes &&
        isSameSharedPayloadRing(nextProgress.sharedPayloadRing, prevProgress.sharedPayloadRing) &&
        nextProgress.droppedPayloads === prevProgress.droppedPayloads &&
        nextProgress.stalePayloadRefs === prevProgress.stalePayloadRefs &&
        nextProgress.samplingFps === prevProgress.samplingFps &&
        nextProgress.emptyBatchStreak === prevProgress.emptyBatchStreak &&
        nextProgress.cursorRebuildCount === prevProgress.cursorRebuildCount &&
        nextProgress.fallbackBackfillCount === prevProgress.fallbackBackfillCount &&
        nextProgress.buffering === prevProgress.buffering &&
        nextProgress.bufferedAheadMs === prevProgress.bufferedAheadMs &&
        isSameDataQualityReport(nextProgress.dataQualityReport, prevProgress.dataQualityReport) &&
        isSameRanges(nextProgress.downloadedByteRanges, prevProgress.downloadedByteRanges) &&
        isSameTimeRanges(nextProgress.parsedMessageRanges, prevProgress.parsedMessageRanges);
      if (unchanged) {
        return;
      }
      this._state.progress = nextProgress;
      useMessagePipelineStore.getState().setPlayerState(this._state);
    } catch (err) {
      console.warn("IterablePlayer: load progress refresh failed", err);
    }
  }

  private async _handleEmptyBatch(nowMs: number): Promise<void> {
    this._emptyBatchStreak += 1;
    this._state.progress = {
      ...this._state.progress,
      emptyBatchStreak: this._emptyBatchStreak,
      cursorRebuildCount: this._cursorRebuildCount,
      fallbackBackfillCount: this._fallbackBackfillCount,
    };

    if (this._emptyBatchStreak === 1) {
      await this._rebuildCursorFromCurrentTime();
      if (this._debugEnabled) {
        console.debug("[Playback] empty batch -> rebuild cursor " + JSON.stringify({
          streak: this._emptyBatchStreak,
          currentTime: this._currentTime,
        }));
      }
      return;
    }
    if (this._emptyBatchStreak < EMPTY_BATCH_BACKFILL_TRIGGER) {
      return;
    }
    if (nowMs - this._lastFallbackBackfillMs < EMPTY_BATCH_BACKFILL_COOLDOWN_MS) {
      return;
    }
    this._lastFallbackBackfillMs = nowMs;
    this._fallbackBackfillCount += 1;
    const topics = this._currentTopics();
    if (topics.length === 0) {
      return;
    }
    try {
      const messages = await this._source.getBackfillMessages({
        time: this._currentTime,
        topics,
      });
      // For latched topics (URDF, static TF), the backfill returns the same
      // message we already distributed – skip those so downstream panels don't
      // needlessly rebuild (URDF rebuild fetches + parses meshes, which was
      // the main cause of unbounded heap/CPU growth during long playback).
      const freshMessages = this._filterAlreadyDeliveredMessages(messages);
      if (freshMessages.length === 0) {
        return;
      }
      this._distributeMessages(freshMessages, this._currentTime);
      if (this._debugEnabled) {
        console.debug("[Playback] empty batch -> fallback backfill " + JSON.stringify({
          streak: this._emptyBatchStreak,
          topics: topics.length,
          count: messages.length,
          currentTime: this._currentTime,
        }));
      }
    } catch (err) {
      console.warn("IterablePlayer: fallback backfill failed", err);
    }
  }

  private async _rebuildCursorFromCurrentTime(): Promise<void> {
    if (this._cursor) {
      await this._cursor.end();
      this._cursor = undefined;
    }
    const topics = this._currentTopics();
    if (topics.length === 0) return;
    this._cursorRebuildCount += 1;
    this._cursor = await this._source.getMessageCursor({
      startTime: this._currentTime,
      topics,
      latestOnlyTopics: this._latestOnlyHighFrequencyTopics(),
    });
  }

  private async _refreshStaleTopicsFromBackfill(nowMs: number): Promise<void> {
    if (nowMs - this._lastStaleRefreshMs < STALE_TOPIC_REFRESH_COOLDOWN_MS) {
      return;
    }
    const topics = this._currentTopics();
    if (topics.length === 0) {
      return;
    }
    const nowNs = toNano(this._currentTime);
    const staleTopics = topics.filter((topic) => {
      const lastNs = this._topicLastMessageNs.get(topic);
      if (lastNs == null) return true;
      return nowNs - lastNs > BACKFILL_STALE_THRESHOLD_NS;
    });
    if (staleTopics.length === 0) {
      return;
    }
    this._lastStaleRefreshMs = nowMs;
    try {
      const messages = await this._source.getBackfillMessages({
        time: this._currentTime,
        topics: staleTopics,
      });
      // Same reasoning as in _handleEmptyBatch: latched topics would otherwise
      // get re-delivered on every refresh tick (~5 Hz), causing panels like
      // the 3D/URDF renderer to rebuild from scratch and leak GPU buffers.
      const freshMessages = this._filterAlreadyDeliveredMessages(messages);
      if (freshMessages.length === 0) {
        return;
      }
      this._distributeMessages(freshMessages, this._currentTime);
      if (this._debugEnabled) {
        console.debug("[Playback] stale refresh " + JSON.stringify({
          staleTopicCount: staleTopics.length,
          messageCount: messages.length,
          freshCount: freshMessages.length,
          currentTime: this._currentTime,
        }));
      }
    } catch (err) {
      console.warn("IterablePlayer: stale topic refresh failed", err);
    }
  }

  /**
   * Independent range scan for diagnostics (Align). Uses a short-lived cursor;
   * does not replace the playback cursor. Drains the iterator until an empty
   * batch; partial batches can still have more messages (MessageCursor caps batch size).
   */
  async getMessagesInTimeRange(args: GetMessagesInTimeRangeArgs): Promise<MessageEvent[]> {
    const MAX = 80_000;
    if (!this._initialization || args.topics.length === 0) {
      return [];
    }
    const start = this._clampToRange(args.start);
    const end = this._clampToRange(args.end);
    const startNs = toNano(start);
    const endNs = toNano(end);
    if (startNs > endNs) {
      return [];
    }

    const cursor = await this._source.getMessageCursor({
      startTime: start,
      endTime: end,
      topics: args.topics,
    });
    const out: MessageEvent[] = [];
    try {
      for (;;) {
        if (out.length >= MAX) {
          break;
        }
        const batch = await cursor.nextBatch(86_400_000, {
          maxMessages: 2048,
          maxWallTimeMs: 16,
        });
        if (batch.length === 0) {
          break;
        }
        const resolved = this._source.resolveMessageBatch(batch);
        for (const m of resolved) {
          const t = toNano(m.receiveTime);
          if (t < startNs || t > endNs) {
            continue;
          }
          out.push(m);
          if (out.length >= MAX) {
            break;
          }
        }
      }
    } finally {
      await cursor.end();
    }
    return out;
  }

  /**
   * Drop messages whose receive time matches the most-recently distributed
   * message on the same topic. This prevents "stale/empty-batch" backfills
   * from re-publishing latched messages (e.g. `/robot_description`,
   * `/tf_static`) that never actually change – those were forcing full
   * downstream rebuilds every ~200 ms during long playback.
   */
  private _filterAlreadyDeliveredMessages(
    messages: MessageEvent[],
  ): MessageEvent[] {
    if (messages.length === 0) return messages;
    const out: MessageEvent[] = [];
    for (const msg of messages) {
      const msgNs = toNano(msg.receiveTime);
      const lastNs = this._topicLastMessageNs.get(msg.topic);
      if (lastNs != null && msgNs === lastNs) continue;
      out.push(msg);
    }
    return out;
  }
}

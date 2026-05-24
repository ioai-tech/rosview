import type {
  GetMessagesInTimeRangeArgs,
  HighFrequencyConsumer,
  Player,
  PlayerState,
  Subscription,
} from '@/core/types/player';
import type { MessageEvent, Time } from '@/core/types/ros';
import { useMessagePipelineStore } from '@/core/pipeline/store';

const ZERO_TIME: Time = { sec: 0, nsec: 0 };

function createReadyState(): PlayerState {
  return {
    presence: 'ready',
    progress: {},
    activeData: {
      topics: [],
      datatypes: {},
      publishersByTopic: new Map(),
      startTime: ZERO_TIME,
      endTime: ZERO_TIME,
      currentTime: ZERO_TIME,
      isPlaying: false,
      isLooping: false,
      speed: 1,
      problems: [],
    },
  };
}

/**
 * No-op player for tool/embed modes without a recording source.
 * Keeps the message pipeline in `ready` with empty topics so panels like UrdfDebug can mount.
 */
export class MinimalPlayer implements Player {
  private _closed = false;
  private _state: PlayerState = createReadyState();
  private _timeSubscribers = new Set<(time: Time) => void>();

  constructor() {
    useMessagePipelineStore.getState().setPlayerState(this._state);
  }

  setListener(listener: (state: PlayerState) => void): void {
    listener(this._state);
  }

  setSubscriptions(_subscriptions: Subscription[]): void {
    useMessagePipelineStore.getState().setSubscriptions([]);
  }

  registerSubscriptions(_panelId: string, _subscriptions: Subscription[]): void {
    // Live topics require IterablePlayer; manual URDF tooling does not need subscriptions.
  }

  unregisterSubscriptions(_panelId: string): void {}

  registerHighFrequencyConsumer(_consumerId: string, _consumer: HighFrequencyConsumer): void {}

  unregisterHighFrequencyConsumer(_consumerId: string): void {}

  subscribeCurrentTime(cb: (time: Time) => void): () => void {
    this._timeSubscribers.add(cb);
    cb(this._currentTime());
    return () => {
      this._timeSubscribers.delete(cb);
    };
  }

  play(): void {}

  pause(): void {}

  seek(_time: Time): void {}

  stepBy(_deltaMs: number): void {}

  stepMessage(_direction: -1 | 1): void {}

  getMessagesInTimeRange(_args: GetMessagesInTimeRangeArgs): Promise<MessageEvent[]> {
    return Promise.resolve([]);
  }

  startDataQualityScan?(): void {}

  setSpeed(_speed: number): void {}

  setSamplingFps(_fps: number): void {}

  getSamplingFps(): number {
    return 30;
  }

  setLooping(_looping: boolean): void {}

  close(): void {
    if (this._closed) return;
    this._closed = true;
    this._timeSubscribers.clear();
    this._state = { presence: 'closed', progress: {} };
    useMessagePipelineStore.getState().setPlayerState(this._state);
    useMessagePipelineStore.getState().setSubscriptions([]);
  }

  private _currentTime(): Time {
    return this._state.activeData?.currentTime ?? ZERO_TIME;
  }
}

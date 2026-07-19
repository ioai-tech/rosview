import { afterEach, describe, expect, it, vi } from 'vitest';
import { IterablePlayer } from './IterablePlayer';
import { messageBus } from '@/core/pipeline/messageBus';
import { useMessagePipelineStore } from '@/core/pipeline/store';
import type { Initialization, MessageEvent } from '@/core/types/ros';
import type { PlayerState } from '@/core/types/player';
import type { WorkerSerializedSource } from '@/infra/workers/WorkerSerializedSource';

const TOPIC = '/camera/front/image/compressed';

function makeInitialization(): Initialization {
  return {
    topics: [{ name: TOPIC, type: 'sensor_msgs/CompressedImage' }],
    datatypes: {},
    start: { sec: 0, nsec: 0 },
    end: { sec: 10, nsec: 0 },
    publishersByTopic: {},
    topicStats: {},
    problems: [],
  };
}

function makeInitializationWithTopicStats(): Initialization {
  return {
    topics: [{ name: TOPIC, type: 'sensor_msgs/CompressedImage' }],
    datatypes: {},
    start: { sec: 0, nsec: 0 },
    end: { sec: 10, nsec: 0 },
    publishersByTopic: {},
    topicStats: {
      [TOPIC]: {
        messageCount: 120,
        frequency: 30,
        durationSec: 4,
      },
    },
    problems: [],
  };
}

function makeImageMessage(): MessageEvent {
  return {
    topic: TOPIC,
    schemaName: 'sensor_msgs/CompressedImage',
    receiveTime: { sec: 1, nsec: 0 },
    publishTime: { sec: 1, nsec: 0 },
    message: {
      format: 'jpeg',
      data: new Uint8Array([1, 2, 3, 4]),
    },
  };
}

function makeImageMessageAt(sec: number): MessageEvent {
  return {
    ...makeImageMessage(),
    receiveTime: { sec, nsec: 0 },
    publishTime: { sec, nsec: 0 },
  };
}

function makeImageMessageAtMs(ms: number): MessageEvent {
  const sec = Math.floor(ms / 1000);
  const nsec = (ms % 1000) * 1_000_000;
  return {
    ...makeImageMessage(),
    receiveTime: { sec, nsec },
    publishTime: { sec, nsec },
  };
}

function makeSource(messages: MessageEvent[]): WorkerSerializedSource {
  return {
    initialize: vi.fn(async () => makeInitialization()),
    getTransportDiagnostics: vi.fn(async () => ({
      mode: 'transfer',
      crossOriginIsolated: false,
      binaryPayloadThresholdBytes: 64 * 1024,
      droppedPayloads: 0,
      stalePayloadRefs: 0,
    })),
    getLoadProgress: vi.fn(async () => ({
      percent: 100,
      totalBytes: 0,
      downloadedByteRanges: [],
      parsedMessageRanges: [],
    })),
    getBackfillMessages: vi.fn(async () => messages),
    getMessageCursor: vi.fn(),
    getAdjacentMessage: vi.fn(),
    resolveMessageBatch: vi.fn((batch: MessageEvent[]) => batch),
    resolveMessageForHighFrequencyLane: vi.fn((message: MessageEvent) => message),
    terminate: vi.fn(),
    getTransportMode: vi.fn(() => 'transfer'),
    getTransportFallbackReason: vi.fn(() => undefined),
  } as unknown as WorkerSerializedSource;
}

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  messageBus.reset();
});

describe('IterablePlayer playback speed', () => {
  it('uses a deterministic 10x maximum instead of a best-effort sentinel', async () => {
    const player = new IterablePlayer(makeSource([]));
    let latestState: PlayerState | undefined;
    player.setListener((state) => {
      latestState = state;
    });
    await player.initialize({});

    player.setSpeed(10);
    expect(latestState?.activeData?.speed).toBe(10);

    player.setSpeed(64);
    expect(latestState?.activeData?.speed).toBe(10);

    player.close();
  });
});

describe('IterablePlayer high-frequency lane', () => {
  it('routes video-only topics outside the generic message bus', async () => {
    const source = makeSource([makeImageMessage()]);
    const player = new IterablePlayer(source);
    const onLatestMessage = vi.fn();

    await player.initialize({});
    player.registerHighFrequencyConsumer('image-panel', {
      topic: TOPIC,
      lane: 'video',
      onLatestMessage,
    });
    await flushAsyncWork();

    expect(onLatestMessage).toHaveBeenCalledTimes(1);
    expect(source.resolveMessageForHighFrequencyLane).toHaveBeenCalledWith(
      expect.objectContaining({ topic: TOPIC }),
      { preferSharedView: true, copyPayload: false },
    );
    expect(messageBus.getLastMessage(TOPIC)).toBeNull();
    expect(source.getBackfillMessages).toHaveBeenCalledWith({
      time: { sec: 0, nsec: 0 },
      topics: [TOPIC],
    });

    player.close();
  });

  it('keeps shared topics on the generic lane when a normal subscriber exists', async () => {
    const source = makeSource([makeImageMessage()]);
    const player = new IterablePlayer(source);
    const onLatestMessage = vi.fn();

    await player.initialize({});
    player.registerSubscriptions('raw-panel', [{ topic: TOPIC, subscriberId: 'raw-panel' }]);
    await flushAsyncWork();
    player.registerHighFrequencyConsumer('image-panel', {
      topic: TOPIC,
      lane: 'video',
      onLatestMessage,
    });
    await flushAsyncWork();

    expect(onLatestMessage).toHaveBeenCalled();
    expect(source.resolveMessageForHighFrequencyLane).toHaveBeenCalledWith(
      expect.objectContaining({ topic: TOPIC }),
      { preferSharedView: false, copyPayload: true },
    );
    expect(messageBus.getLastMessage(TOPIC)).not.toBeNull();
    expect(messageBus.getSubscriberMessages('raw-panel')).toHaveLength(1);

    player.close();
  });

  it('isolates payloads when multiple video consumers share one topic', async () => {
    const source = makeSource([makeImageMessage()]);
    const player = new IterablePlayer(source);
    const firstConsumer = vi.fn();
    const secondConsumer = vi.fn();

    await player.initialize({});
    player.registerHighFrequencyConsumer('image-panel-a', {
      topic: TOPIC,
      lane: 'video',
      onLatestMessage: firstConsumer,
    });
    player.registerHighFrequencyConsumer('image-panel-b', {
      topic: TOPIC,
      lane: 'video',
      onLatestMessage: secondConsumer,
    });
    await flushAsyncWork();

    expect(firstConsumer).toHaveBeenCalled();
    expect(secondConsumer).toHaveBeenCalled();
    expect(source.resolveMessageForHighFrequencyLane).toHaveBeenLastCalledWith(
      expect.objectContaining({ topic: TOPIC }),
      { preferSharedView: false, copyPayload: true },
    );

    player.close();
  });

  it('delivers ordered high-frequency batches without marking the topic latest-only', async () => {
    const oldRequestAnimationFrame = globalThis.requestAnimationFrame;
    const oldCancelAnimationFrame = globalThis.cancelAnimationFrame;
    globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => {
      setTimeout(() => cb(performance.now()), 0);
      return 1;
    };
    globalThis.cancelAnimationFrame = vi.fn() as typeof cancelAnimationFrame;
    const first = makeImageMessageAtMs(10);
    const second = makeImageMessageAtMs(20);
    const source = makeSource([first]);
    const cursor = {
      nextBatch: vi.fn(async () => [first, second]),
      end: vi.fn(),
    };
    vi.mocked(source.getMessageCursor).mockResolvedValue(cursor as never);
    const player = new IterablePlayer(source);
    const onMessageBatch = vi.fn();

    try {
      await player.initialize({});
      player.registerHighFrequencyConsumer('image-panel', {
        topic: TOPIC,
        lane: 'video',
        mode: 'all',
        onMessageBatch,
      });
      await flushAsyncWork();
      player.play();
      await new Promise((resolve) => setTimeout(resolve, 50));
      await flushAsyncWork();

      expect(source.getMessageCursor).toHaveBeenCalledWith(
        expect.objectContaining({
          topics: [TOPIC],
          latestOnlyTopics: [],
        }),
      );
      expect(onMessageBatch).toHaveBeenCalledWith([
        expect.objectContaining({ topic: TOPIC }),
        expect.objectContaining({ receiveTime: { sec: 0, nsec: 20_000_000 } }),
      ]);
    } finally {
      player.close();
      globalThis.requestAnimationFrame = oldRequestAnimationFrame;
      globalThis.cancelAnimationFrame = oldCancelAnimationFrame;
    }
  });
});

describe('IterablePlayer range reads', () => {
  it('streams range messages in cursor batches', async () => {
    const first = makeImageMessageAt(1);
    const second = makeImageMessageAt(2);
    const third = makeImageMessageAt(3);
    const source = makeSource([]);
    const cursor = {
      nextBatch: vi
        .fn()
        .mockResolvedValueOnce([first, second])
        .mockResolvedValueOnce([third])
        .mockResolvedValueOnce([]),
      end: vi.fn(async () => undefined),
    };
    vi.mocked(source.getMessageCursor).mockResolvedValue(cursor as never);
    const player = new IterablePlayer(source);

    try {
      await player.initialize({});
      const batches: MessageEvent[][] = [];
      for await (const batch of player.streamMessagesInTimeRange({
        start: { sec: 0, nsec: 0 },
        end: { sec: 5, nsec: 0 },
        topics: [TOPIC],
      })) {
        batches.push(batch);
      }

      expect(batches).toEqual([[first, second], [third]]);
      expect(source.getMessageCursor).toHaveBeenCalledWith({
        startTime: { sec: 0, nsec: 0 },
        endTime: { sec: 5, nsec: 0 },
        topics: [TOPIC],
      });
      expect(cursor.end).toHaveBeenCalledTimes(1);
    } finally {
      player.close();
    }
  });

  it('keeps getMessagesInTimeRange compatible with streamed results', async () => {
    const first = makeImageMessageAt(1);
    const outside = makeImageMessageAt(9);
    const second = makeImageMessageAt(2);
    const source = makeSource([]);
    const cursor = {
      nextBatch: vi
        .fn()
        .mockResolvedValueOnce([first, outside])
        .mockResolvedValueOnce([second])
        .mockResolvedValueOnce([]),
      end: vi.fn(async () => undefined),
    };
    vi.mocked(source.getMessageCursor).mockResolvedValue(cursor as never);
    const player = new IterablePlayer(source);

    try {
      await player.initialize({});
      await expect(player.getMessagesInTimeRange({
        start: { sec: 0, nsec: 0 },
        end: { sec: 5, nsec: 0 },
        topics: [TOPIC],
      })).resolves.toEqual([first, second]);
      expect(cursor.end).toHaveBeenCalledTimes(1);
    } finally {
      player.close();
    }
  });

  it('stops streamed range reads at maxMessages', async () => {
    const first = makeImageMessageAt(1);
    const second = makeImageMessageAt(2);
    const third = makeImageMessageAt(3);
    const source = makeSource([]);
    const cursor = {
      nextBatch: vi.fn().mockResolvedValueOnce([first, second, third]),
      end: vi.fn(async () => undefined),
    };
    vi.mocked(source.getMessageCursor).mockResolvedValue(cursor as never);
    const player = new IterablePlayer(source);

    try {
      await player.initialize({});
      const batches: MessageEvent[][] = [];
      for await (const batch of player.streamMessagesInTimeRange({
        start: { sec: 0, nsec: 0 },
        end: { sec: 5, nsec: 0 },
        topics: [TOPIC],
        maxMessages: 2,
      })) {
        batches.push(batch);
      }

      expect(batches).toEqual([[first, second]]);
      expect(cursor.end).toHaveBeenCalledTimes(1);
    } finally {
      player.close();
    }
  });
});

describe('IterablePlayer playback clock', () => {
  it('emits the current time immediately when subscribing', async () => {
    const source = makeSource([]);
    const player = new IterablePlayer(source);
    const seenTimes: number[] = [];

    vi.mocked(source.initialize).mockResolvedValueOnce({
      ...makeInitialization(),
      start: { sec: 2, nsec: 500_000_000 },
    });
    await player.initialize({});
    const unsubscribe = player.subscribeCurrentTime((time) => {
      seenTimes.push(time.sec + time.nsec / 1e9);
    });

    expect(seenTimes).toEqual([2.5]);

    unsubscribe();
    player.close();
  });

  it('returns current time through the imperative getter', async () => {
    const source = makeSource([]);
    const player = new IterablePlayer(source);

    await player.initialize({});
    expect(player.getCurrentTime()).toEqual({ sec: 0, nsec: 0 });

    player.seek({ sec: 3, nsec: 250_000_000 });
    await flushAsyncWork();
    expect(player.getCurrentTime()).toEqual({ sec: 3, nsec: 250_000_000 });

    player.close();
  });

  it('does not advance pipeline-store currentTime on pure playback ticks', async () => {
    let now = 0;
    let nextRafId = 1;
    const oldPerformanceNow = performance.now;
    const oldRequestAnimationFrame = globalThis.requestAnimationFrame;
    const oldCancelAnimationFrame = globalThis.cancelAnimationFrame;
    const rafCallbacks = new Map<number, FrameRequestCallback>();
    Object.defineProperty(performance, 'now', {
      configurable: true,
      value: () => now,
    });
    globalThis.requestAnimationFrame = vi.fn((cb: FrameRequestCallback) => {
      const id = nextRafId++;
      rafCallbacks.set(id, cb);
      return id;
    });
    globalThis.cancelAnimationFrame = vi.fn((id: number) => {
      rafCallbacks.delete(id);
    });

    const source = makeSource([]);
    const player = new IterablePlayer(source);
    const seenTimes: number[] = [];

    try {
      await player.initialize({});
      player.play();
      const pipelineTimeBefore = useMessagePipelineStore.getState().playerState.activeData?.currentTime;
      const unsubscribeTime = player.subscribeCurrentTime((time) => {
        seenTimes.push(time.sec + time.nsec / 1e9);
      });

      now = 1000;
      const firstRaf = Math.min(...rafCallbacks.keys());
      rafCallbacks.get(firstRaf)?.(now);
      await flushAsyncWork();

      expect(seenTimes.at(-1)).toBeCloseTo(1, 3);
      expect(player.getCurrentTime()).toEqual({ sec: 1, nsec: 0 });
      expect(useMessagePipelineStore.getState().playerState.activeData?.currentTime).toBe(
        pipelineTimeBefore,
      );

      unsubscribeTime();
    } finally {
      player.close();
      Object.defineProperty(performance, 'now', {
        configurable: true,
        value: oldPerformanceNow,
      });
      globalThis.requestAnimationFrame = oldRequestAnimationFrame;
      globalThis.cancelAnimationFrame = oldCancelAnimationFrame;
    }
  });

  it('keeps time moving during a short cursor stall, then buffers without accumulating stale video', async () => {
    let now = 0;
    let nextRafId = 1;
    const oldPerformanceNow = performance.now;
    const oldRequestAnimationFrame = globalThis.requestAnimationFrame;
    const oldCancelAnimationFrame = globalThis.cancelAnimationFrame;
    const rafCallbacks = new Map<number, FrameRequestCallback>();
    Object.defineProperty(performance, 'now', {
      configurable: true,
      value: () => now,
    });
    globalThis.requestAnimationFrame = vi.fn((cb: FrameRequestCallback) => {
      const id = nextRafId++;
      rafCallbacks.set(id, cb);
      return id;
    });
    globalThis.cancelAnimationFrame = vi.fn((id: number) => {
      rafCallbacks.delete(id);
    });

    const delayedBatch = deferred<MessageEvent[]>();
    const source = makeSource([]);
    const cursor = {
      nextBatch: vi.fn(() => delayedBatch.promise),
      end: vi.fn(async () => undefined),
    };
    vi.mocked(source.getMessageCursor).mockResolvedValue(cursor as never);
    const player = new IterablePlayer(source);
    const seenTimes: number[] = [];
    let latestState: PlayerState | undefined;

    const runNextRaf = () => {
      const id = Math.min(...rafCallbacks.keys());
      const callback = rafCallbacks.get(id);
      rafCallbacks.delete(id);
      callback?.(now);
    };

    try {
      player.setListener((state) => {
        latestState = state;
      });
      await player.initialize({});
      player.registerSubscriptions('panel', [{ topic: TOPIC, subscriberId: 'panel' }]);
      await flushAsyncWork();
      player.subscribeCurrentTime((time) => {
        seenTimes.push(time.sec + time.nsec / 1e9);
      });
      player.play();

      now = 100;
      runNextRaf();
      await flushAsyncWork();
      expect(cursor.nextBatch).toHaveBeenCalledTimes(1);
      expect(seenTimes.at(-1)).toBeCloseTo(0.1, 3);

      now = 200;
      runNextRaf();
      await Promise.resolve();
      expect(seenTimes.at(-1)).toBeCloseTo(0.2, 3);
      expect(latestState?.progress.buffering).toBe(false);

      now = 600;
      runNextRaf();
      await Promise.resolve();
      expect(seenTimes.at(-1)).toBeCloseTo(0.2, 3);
      expect(latestState?.progress.buffering).toBe(true);

      delayedBatch.resolve([makeImageMessageAtMs(150), makeImageMessageAtMs(50)]);
      await flushAsyncWork();

      expect(messageBus.getSubscriberMessages('panel').map((message) => message.receiveTime)).toEqual([
        { sec: 0, nsec: 50_000_000 },
        { sec: 0, nsec: 150_000_000 },
      ]);
      expect(latestState?.progress.buffering).toBe(false);
    } finally {
      player.close();
      Object.defineProperty(performance, 'now', {
        configurable: true,
        value: oldPerformanceNow,
      });
      globalThis.requestAnimationFrame = oldRequestAnimationFrame;
      globalThis.cancelAnimationFrame = oldCancelAnimationFrame;
    }
  });

  it('keeps a slow-starting cursor after an empty batch and delivers the next message', async () => {
    let now = 0;
    let nextRafId = 1;
    const oldPerformanceNow = performance.now;
    const oldRequestAnimationFrame = globalThis.requestAnimationFrame;
    const oldCancelAnimationFrame = globalThis.cancelAnimationFrame;
    const rafCallbacks = new Map<number, FrameRequestCallback>();
    Object.defineProperty(performance, 'now', {
      configurable: true,
      value: () => now,
    });
    globalThis.requestAnimationFrame = vi.fn((cb: FrameRequestCallback) => {
      const id = nextRafId++;
      rafCallbacks.set(id, cb);
      return id;
    });
    globalThis.cancelAnimationFrame = vi.fn((id: number) => {
      rafCallbacks.delete(id);
    });

    const source = makeSource([]);
    const message = makeImageMessageAtMs(150);
    const cursor = {
      nextBatch: vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([message]),
      end: vi.fn(async () => undefined),
    };
    vi.mocked(source.getMessageCursor).mockResolvedValue(cursor as never);
    const player = new IterablePlayer(source);
    const seenTimes: number[] = [];

    const runNextRaf = () => {
      const id = Math.min(...rafCallbacks.keys());
      const callback = rafCallbacks.get(id);
      rafCallbacks.delete(id);
      callback?.(now);
    };

    try {
      await player.initialize({});
      player.registerSubscriptions('panel', [{ topic: TOPIC, subscriberId: 'panel' }]);
      await flushAsyncWork();
      player.subscribeCurrentTime((time) => {
        seenTimes.push(time.sec + time.nsec / 1e9);
      });
      player.play();

      now = 100;
      runNextRaf();
      await flushAsyncWork();
      now = 200;
      runNextRaf();
      await flushAsyncWork();

      expect(seenTimes.at(-1)).toBeCloseTo(0.2, 3);
      expect(cursor.nextBatch).toHaveBeenCalledTimes(2);
      expect(cursor.end).not.toHaveBeenCalled();
      expect(source.getMessageCursor).toHaveBeenCalledTimes(1);
      expect(messageBus.getSubscriberMessages('panel')).toEqual([message]);
    } finally {
      player.close();
      Object.defineProperty(performance, 'now', {
        configurable: true,
        value: oldPerformanceNow,
      });
      globalThis.requestAnimationFrame = oldRequestAnimationFrame;
      globalThis.cancelAnimationFrame = oldCancelAnimationFrame;
    }
  });

  it('keeps one cursor across sparse topic windows and recovers from buffering', async () => {
    let now = 0;
    let nextRafId = 1;
    const oldPerformanceNow = performance.now;
    const oldRequestAnimationFrame = globalThis.requestAnimationFrame;
    const oldCancelAnimationFrame = globalThis.cancelAnimationFrame;
    const rafCallbacks = new Map<number, FrameRequestCallback>();
    Object.defineProperty(performance, 'now', {
      configurable: true,
      value: () => now,
    });
    globalThis.requestAnimationFrame = vi.fn((cb: FrameRequestCallback) => {
      const id = nextRafId++;
      rafCallbacks.set(id, cb);
      return id;
    });
    globalThis.cancelAnimationFrame = vi.fn((id: number) => {
      rafCallbacks.delete(id);
    });

    const sparseMessage = makeImageMessageAtMs(900);
    const sparseBatch = deferred<MessageEvent[]>();
    const source = makeSource([]);
    const cursor = {
      nextBatch: vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockReturnValueOnce(sparseBatch.promise),
      end: vi.fn(async () => undefined),
    };
    vi.mocked(source.getMessageCursor).mockResolvedValue(cursor as never);
    const player = new IterablePlayer(source);
    let latestState: PlayerState | undefined;

    const runNextRaf = () => {
      const id = Math.min(...rafCallbacks.keys());
      const callback = rafCallbacks.get(id);
      rafCallbacks.delete(id);
      callback?.(now);
    };

    try {
      player.setListener((state) => {
        latestState = state;
      });
      await player.initialize({});
      player.registerSubscriptions('panel', [{ topic: TOPIC, subscriberId: 'panel' }]);
      await flushAsyncWork();
      player.play();

      now = 100;
      runNextRaf();
      await flushAsyncWork();
      now = 300;
      runNextRaf();
      await flushAsyncWork();
      now = 600;
      runNextRaf();
      await Promise.resolve();

      expect(cursor.nextBatch).toHaveBeenCalledTimes(3);
      expect(cursor.end).not.toHaveBeenCalled();
      expect(source.getMessageCursor).toHaveBeenCalledTimes(1);
      expect(latestState?.progress.buffering).toBe(true);

      sparseBatch.resolve([sparseMessage]);
      await flushAsyncWork();
      expect(latestState?.progress.buffering).toBe(false);

      now = 1200;
      runNextRaf();
      await flushAsyncWork();

      expect(messageBus.getSubscriberMessages('panel')).toEqual([sparseMessage]);
    } finally {
      player.close();
      Object.defineProperty(performance, 'now', {
        configurable: true,
        value: oldPerformanceNow,
      });
      globalThis.requestAnimationFrame = oldRequestAnimationFrame;
      globalThis.cancelAnimationFrame = oldCancelAnimationFrame;
    }
  });

  it('invalidates buffered messages when subscriptions change on the same topic', async () => {
    let now = 0;
    let nextRafId = 1;
    const oldPerformanceNow = performance.now;
    const oldRequestAnimationFrame = globalThis.requestAnimationFrame;
    const oldCancelAnimationFrame = globalThis.cancelAnimationFrame;
    const rafCallbacks = new Map<number, FrameRequestCallback>();
    Object.defineProperty(performance, 'now', {
      configurable: true,
      value: () => now,
    });
    globalThis.requestAnimationFrame = vi.fn((cb: FrameRequestCallback) => {
      const id = nextRafId++;
      rafCallbacks.set(id, cb);
      return id;
    });
    globalThis.cancelAnimationFrame = vi.fn((id: number) => {
      rafCallbacks.delete(id);
    });

    const message = makeImageMessageAtMs(300);
    const source = makeSource([]);
    const firstCursor = {
      nextBatch: vi.fn(async () => [message]),
      end: vi.fn(async () => undefined),
    };
    const secondCursor = {
      nextBatch: vi.fn(async () => [message]),
      end: vi.fn(async () => undefined),
    };
    vi.mocked(source.getMessageCursor)
      .mockResolvedValueOnce(firstCursor as never)
      .mockResolvedValueOnce(secondCursor as never);
    const player = new IterablePlayer(source);

    const runNextRaf = () => {
      const id = Math.min(...rafCallbacks.keys());
      const callback = rafCallbacks.get(id);
      rafCallbacks.delete(id);
      callback?.(now);
    };

    try {
      await player.initialize({});
      player.registerSubscriptions('panel-a', [{ topic: TOPIC, subscriberId: 'panel-a' }]);
      await flushAsyncWork();
      player.play();

      now = 100;
      runNextRaf();
      await flushAsyncWork();
      expect(messageBus.getSubscriberMessages('panel-a')).toBeNull();

      player.registerSubscriptions('panel-b', [{ topic: TOPIC, subscriberId: 'panel-b' }]);
      await flushAsyncWork();
      expect(firstCursor.end).toHaveBeenCalledTimes(1);

      now = 300;
      runNextRaf();
      await flushAsyncWork();

      expect(source.getMessageCursor).toHaveBeenCalledTimes(2);
      expect(messageBus.getSubscriberMessages('panel-a')).toEqual([message]);
      expect(messageBus.getSubscriberMessages('panel-b')).toEqual([message]);
    } finally {
      player.close();
      Object.defineProperty(performance, 'now', {
        configurable: true,
        value: oldPerformanceNow,
      });
      globalThis.requestAnimationFrame = oldRequestAnimationFrame;
      globalThis.cancelAnimationFrame = oldCancelAnimationFrame;
    }
  });

  it('reaches loop and once boundaries after a sustained empty tail', async () => {
    let now = 0;
    let nextRafId = 1;
    const oldPerformanceNow = performance.now;
    const oldRequestAnimationFrame = globalThis.requestAnimationFrame;
    const oldCancelAnimationFrame = globalThis.cancelAnimationFrame;
    const rafCallbacks = new Map<number, FrameRequestCallback>();
    Object.defineProperty(performance, 'now', {
      configurable: true,
      value: () => now,
    });
    globalThis.requestAnimationFrame = vi.fn((cb: FrameRequestCallback) => {
      const id = nextRafId++;
      rafCallbacks.set(id, cb);
      return id;
    });
    globalThis.cancelAnimationFrame = vi.fn((id: number) => {
      rafCallbacks.delete(id);
    });

    const source = makeSource([]);
    vi.mocked(source.initialize).mockResolvedValueOnce({
      ...makeInitialization(),
      end: { sec: 1, nsec: 0 },
    });
    const cursor = {
      nextBatch: vi.fn(async () => []),
      end: vi.fn(async () => undefined),
    };
    vi.mocked(source.getMessageCursor).mockResolvedValue(cursor as never);
    const player = new IterablePlayer(source);
    let latestState: PlayerState | undefined;

    const runNextRaf = () => {
      const id = Math.min(...rafCallbacks.keys());
      const callback = rafCallbacks.get(id);
      rafCallbacks.delete(id);
      callback?.(now);
    };

    try {
      player.setListener((state) => {
        latestState = state;
      });
      await player.initialize({});
      player.registerSubscriptions('panel', [{ topic: TOPIC, subscriberId: 'panel' }]);
      await flushAsyncWork();
      player.play();

      now = 100;
      runNextRaf();
      await flushAsyncWork();
      now = 600;
      runNextRaf();
      await flushAsyncWork();

      expect(latestState?.progress.buffering).toBe(true);
      expect(player.getCurrentTime()).toEqual({ sec: 0, nsec: 600_000_000 });

      now = 1000;
      runNextRaf();
      await flushAsyncWork();

      expect(player.getCurrentTime()).toEqual({ sec: 0, nsec: 0 });
      expect(latestState?.activeData?.isPlaying).toBe(true);
      expect(latestState?.progress.buffering).toBe(false);
      expect(cursor.end).toHaveBeenCalledTimes(1);

      player.setLooping(false);
      now = 2000;
      runNextRaf();
      await flushAsyncWork();

      expect(player.getCurrentTime()).toEqual({ sec: 1, nsec: 0 });
      expect(latestState?.activeData?.isPlaying).toBe(false);
      expect(latestState?.progress.buffering).toBe(false);
      expect(cursor.end).toHaveBeenCalledTimes(1);
    } finally {
      player.close();
      Object.defineProperty(performance, 'now', {
        configurable: true,
        value: oldPerformanceNow,
      });
      globalThis.requestAnimationFrame = oldRequestAnimationFrame;
      globalThis.cancelAnimationFrame = oldCancelAnimationFrame;
    }
  });

  it('waits for the old playback cursor to close before opening one for an H264 consumer', async () => {
    let now = 0;
    let nextRafId = 1;
    const oldPerformanceNow = performance.now;
    const oldRequestAnimationFrame = globalThis.requestAnimationFrame;
    const oldCancelAnimationFrame = globalThis.cancelAnimationFrame;
    const rafCallbacks = new Map<number, FrameRequestCallback>();
    Object.defineProperty(performance, 'now', {
      configurable: true,
      value: () => now,
    });
    globalThis.requestAnimationFrame = vi.fn((cb: FrameRequestCallback) => {
      const id = nextRafId++;
      rafCallbacks.set(id, cb);
      return id;
    });
    globalThis.cancelAnimationFrame = vi.fn((id: number) => {
      rafCallbacks.delete(id);
    });

    const closeDeferred = deferred<void>();
    const events: string[] = [];
    const source = makeSource([]);
    const firstCursor = {
      nextBatch: vi.fn(async () => []),
      end: vi.fn(async () => {
        events.push('close-start');
        await closeDeferred.promise;
        events.push('close-end');
      }),
    };
    const secondCursor = {
      nextBatch: vi.fn(async () => []),
      end: vi.fn(async () => undefined),
    };
    vi.mocked(source.getMessageCursor).mockImplementation(async () => {
      const call = vi.mocked(source.getMessageCursor).mock.calls.length;
      events.push(`open-${call}`);
      return (call === 1 ? firstCursor : secondCursor) as never;
    });
    const player = new IterablePlayer(source);

    const runNextRaf = () => {
      const id = Math.min(...rafCallbacks.keys());
      const callback = rafCallbacks.get(id);
      rafCallbacks.delete(id);
      callback?.(now);
    };

    try {
      await player.initialize({});
      player.registerSubscriptions('panel', [{ topic: TOPIC, subscriberId: 'panel' }]);
      await flushAsyncWork();
      player.play();

      now = 100;
      runNextRaf();
      await flushAsyncWork();
      expect(source.getMessageCursor).toHaveBeenCalledTimes(1);

      player.registerHighFrequencyConsumer('h264-panel', {
        topic: TOPIC,
        lane: 'video',
        onLatestMessage: vi.fn(),
      });
      await flushAsyncWork();
      expect(firstCursor.end).toHaveBeenCalledTimes(1);

      now = 200;
      runNextRaf();
      await flushAsyncWork();
      expect(source.getMessageCursor).toHaveBeenCalledTimes(1);
      expect(events).toEqual(['open-1', 'close-start']);

      closeDeferred.resolve();
      await flushAsyncWork();

      expect(source.getMessageCursor).toHaveBeenCalledTimes(2);
      expect(events).toEqual(['open-1', 'close-start', 'close-end', 'open-2']);
    } finally {
      closeDeferred.resolve();
      player.close();
      Object.defineProperty(performance, 'now', {
        configurable: true,
        value: oldPerformanceNow,
      });
      globalThis.requestAnimationFrame = oldRequestAnimationFrame;
      globalThis.cancelAnimationFrame = oldCancelAnimationFrame;
    }
  });

  it('does not catch up wall time elapsed while the page is hidden', async () => {
    let now = 0;
    const oldPerformanceNow = performance.now;
    const oldRequestAnimationFrame = globalThis.requestAnimationFrame;
    const oldCancelAnimationFrame = globalThis.cancelAnimationFrame;
    const oldDocument = globalThis.document;
    const oldWindow = globalThis.window;
    const listeners = new Map<string, EventListener[]>();
    let hidden = false;
    let nextRafId = 1;
    const rafCallbacks = new Map<number, FrameRequestCallback>();
    const fakeDocument = {
      get hidden() {
        return hidden;
      },
      addEventListener: vi.fn((type: string, listener: EventListener) => {
        listeners.set(type, [...(listeners.get(type) ?? []), listener]);
      }),
      removeEventListener: vi.fn((type: string, listener: EventListener) => {
        listeners.set(type, (listeners.get(type) ?? []).filter((entry) => entry !== listener));
      }),
    };
    const fakeWindow = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      location: { search: '' },
    };
    Object.defineProperty(performance, 'now', {
      configurable: true,
      value: () => now,
    });
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: fakeDocument,
    });
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: fakeWindow,
    });
    globalThis.requestAnimationFrame = vi.fn((cb: FrameRequestCallback) => {
      const id = nextRafId++;
      rafCallbacks.set(id, cb);
      return id;
    });
    globalThis.cancelAnimationFrame = vi.fn((id: number) => {
      rafCallbacks.delete(id);
    });
    const source = makeSource([]);
    const cursor = {
      nextBatch: vi.fn(async () => []),
      end: vi.fn(),
    };
    vi.mocked(source.getMessageCursor).mockResolvedValue(cursor as never);
    const player = new IterablePlayer(source);
    const seenTimes: number[] = [];

    try {
      await player.initialize({});
      player.registerSubscriptions('panel', [{ topic: TOPIC, subscriberId: 'panel' }]);
      await flushAsyncWork();
      player.subscribeCurrentTime((time) => {
        seenTimes.push(time.sec + time.nsec / 1e9);
      });
      player.play();

      now = 1000;
      rafCallbacks.get(1)?.(now);
      await flushAsyncWork();
      expect(seenTimes.at(-1)).toBeCloseTo(1, 3);

      hidden = true;
      for (const listener of listeners.get('visibilitychange') ?? []) {
        listener(new Event('visibilitychange'));
      }
      now = 11_000;
      hidden = false;
      for (const listener of listeners.get('visibilitychange') ?? []) {
        listener(new Event('visibilitychange'));
      }

      const nextVisibleRaf = Math.max(...rafCallbacks.keys());
      now = 11_050;
      rafCallbacks.get(nextVisibleRaf)?.(now);
      await flushAsyncWork();

      expect(seenTimes.at(-1)).toBeLessThan(1.2);
    } finally {
      player.close();
      Object.defineProperty(performance, 'now', {
        configurable: true,
        value: oldPerformanceNow,
      });
      Object.defineProperty(globalThis, 'document', {
        configurable: true,
        value: oldDocument,
      });
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: oldWindow,
      });
      globalThis.requestAnimationFrame = oldRequestAnimationFrame;
      globalThis.cancelAnimationFrame = oldCancelAnimationFrame;
    }
  });

  it('does not let an in-flight playback batch overwrite a backward seek', async () => {
    let now = 0;
    let nextRafId = 1;
    const oldPerformanceNow = performance.now;
    const oldRequestAnimationFrame = globalThis.requestAnimationFrame;
    const oldCancelAnimationFrame = globalThis.cancelAnimationFrame;
    const rafCallbacks = new Map<number, FrameRequestCallback>();
    Object.defineProperty(performance, 'now', {
      configurable: true,
      value: () => now,
    });
    globalThis.requestAnimationFrame = vi.fn((cb: FrameRequestCallback) => {
      const id = nextRafId++;
      rafCallbacks.set(id, cb);
      return id;
    });
    globalThis.cancelAnimationFrame = vi.fn((id: number) => {
      rafCallbacks.delete(id);
    });

    const delayedBatch = deferred<MessageEvent[]>();
    const source = makeSource([]);
    const cursor = {
      nextBatch: vi.fn(() => delayedBatch.promise),
      end: vi.fn(async () => undefined),
    };
    vi.mocked(source.getMessageCursor).mockResolvedValue(cursor as never);
    const player = new IterablePlayer(source);
    const seenTimes: number[] = [];

    try {
      await player.initialize({});
      player.registerSubscriptions('panel', [{ topic: TOPIC, subscriberId: 'panel' }]);
      await flushAsyncWork();
      player.seek({ sec: 7, nsec: 0 });
      await flushAsyncWork();
      player.subscribeCurrentTime((time) => {
        seenTimes.push(time.sec + time.nsec / 1e9);
      });
      player.play();

      now = 100;
      rafCallbacks.get(1)?.(now);
      await flushAsyncWork();
      expect(cursor.nextBatch).toHaveBeenCalled();

      player.seek({ sec: 5, nsec: 0 });
      await flushAsyncWork();
      expect(seenTimes.at(-1)).toBe(5);

      delayedBatch.resolve([makeImageMessageAt(7)]);
      await flushAsyncWork();

      expect(seenTimes.at(-1)).toBe(5);
      expect(messageBus.getLastMessage(TOPIC)).toBeNull();
    } finally {
      player.close();
      Object.defineProperty(performance, 'now', {
        configurable: true,
        value: oldPerformanceNow,
      });
      globalThis.requestAnimationFrame = oldRequestAnimationFrame;
      globalThis.cancelAnimationFrame = oldCancelAnimationFrame;
    }
  });

  it('keeps the latest seek when older backfill finishes later', async () => {
    const source = makeSource([]);
    const firstBackfill = deferred<MessageEvent[]>();
    const secondBackfill = deferred<MessageEvent[]>();
    vi.mocked(source.getBackfillMessages).mockImplementation(async ({ time }) => {
      if (time.sec === 5) {
        return await firstBackfill.promise;
      }
      if (time.sec === 4) {
        return await secondBackfill.promise;
      }
      return [];
    });
    const player = new IterablePlayer(source);
    const seenTimes: number[] = [];

    try {
      await player.initialize({});
      player.registerSubscriptions('panel', [{ topic: TOPIC, subscriberId: 'panel' }]);
      await flushAsyncWork();
      player.subscribeCurrentTime((time) => {
        seenTimes.push(time.sec + time.nsec / 1e9);
      });

      player.seek({ sec: 5, nsec: 0 });
      await Promise.resolve();
      player.seek({ sec: 4, nsec: 0 });
      await Promise.resolve();

      secondBackfill.resolve([makeImageMessageAt(4)]);
      await flushAsyncWork();
      firstBackfill.resolve([makeImageMessageAt(5)]);
      await flushAsyncWork();

      expect(seenTimes.at(-1)).toBe(4);
      expect(messageBus.getLastMessage(TOPIC)?.receiveTime).toEqual({ sec: 4, nsec: 0 });
    } finally {
      player.close();
    }
  });
});

describe('IterablePlayer topic metadata', () => {
  it('merges duration and count from topic stats into active topics', async () => {
    const source = {
      initialize: vi.fn(async () => makeInitializationWithTopicStats()),
      getTransportDiagnostics: vi.fn(async () => ({
        mode: 'transfer',
        crossOriginIsolated: false,
        binaryPayloadThresholdBytes: 64 * 1024,
        droppedPayloads: 0,
        stalePayloadRefs: 0,
      })),
      getLoadProgress: vi.fn(async () => ({
        percent: 100,
        totalBytes: 0,
        downloadedByteRanges: [],
        parsedMessageRanges: [],
      })),
      getBackfillMessages: vi.fn(async () => []),
      getMessageCursor: vi.fn(),
      getAdjacentMessage: vi.fn(),
      resolveMessageBatch: vi.fn((batch: MessageEvent[]) => batch),
      resolveMessageForHighFrequencyLane: vi.fn((message: MessageEvent) => message),
      terminate: vi.fn(),
      getTransportMode: vi.fn(() => 'transfer'),
      getTransportFallbackReason: vi.fn(() => undefined),
    } as unknown as WorkerSerializedSource;

    const player = new IterablePlayer(source);
    let latestState: PlayerState | undefined;
    player.setListener((state) => {
      latestState = state;
    });

    await player.initialize({});

    expect(latestState).toBeDefined();
    expect(latestState!.activeData?.topics).toEqual([
      expect.objectContaining({
        name: TOPIC,
        messageCount: 120,
        frequency: 30,
        durationSec: 4,
      }),
    ]);

    player.close();
  });
});

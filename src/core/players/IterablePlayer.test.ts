import { afterEach, describe, expect, it, vi } from 'vitest';
import { IterablePlayer } from './IterablePlayer';
import { messageBus } from '@/core/pipeline/messageBus';
import { useMessagePipelineStore } from '@/core/pipeline/store';
import type { Initialization, MessageEvent } from '@/core/types/ros';
import type { PlayerState } from '@/core/types/player';
import type { WorkerSerializedSource } from '@/infra/workers/WorkerSerializedSource';
import type { SourceInitProgressCallback } from '@/infra/workers/types';

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
    expect(source.getBackfillMessages).toHaveBeenCalledWith(
      {
        time: { sec: 0, nsec: 0 },
        topics: [TOPIC],
      },
      expect.any(Function),
    );

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
      expect(latestState?.progress.buffering).toBe(false);

      now = 1200;
      runNextRaf();
      await Promise.resolve();
      expect(latestState?.progress.buffering).toBe(true);

      sparseBatch.resolve([sparseMessage]);
      await flushAsyncWork();
      expect(latestState?.progress.buffering).toBe(false);

      now = 1500;
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

      expect(latestState?.progress.buffering).toBe(false);
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

describe('IterablePlayer initialize progress', () => {
  it('emits loadedBytes while presence is still initializing', async () => {
    const gate = deferred<Initialization>();
    const source = makeSource([]);
    source.initialize = vi.fn(async (_args: Record<string, unknown>, onProgress?: SourceInitProgressCallback) => {
      onProgress?.({ phase: 'downloading', loadedBytes: 12, totalBytes: 100, transferredBytes: 12 });
      await gate.promise;
      return makeInitialization();
    });

    const player = new IterablePlayer(source);
    let latestState: PlayerState | undefined;
    player.setListener((state) => {
      latestState = state;
    });

    const pending = player.initialize({});
    await flushAsyncWork();

    expect(latestState?.presence).toBe('initializing');
    expect(latestState?.progress.loadedBytes).toBe(12);
    expect(latestState?.progress.totalBytes).toBe(100);
    expect(latestState?.progress.initPhase).toBe('downloading');
    expect(useMessagePipelineStore.getState().playerState.progress.loadedBytes).toBe(12);

    gate.resolve(makeInitialization());
    await pending;
    player.close();
  });
});

describe('IterablePlayer play before ready', () => {
  it('defers play requested during initialization and starts from the recording start', async () => {
    let now = 0;
    let nextRafId = 1;
    const oldPerformanceNow = performance.now;
    const oldRequestAnimationFrame = globalThis.requestAnimationFrame;
    const oldCancelAnimationFrame = globalThis.cancelAnimationFrame;
    const rafCallbacks = new Map<number, FrameRequestCallback>();
    Object.defineProperty(performance, 'now', { configurable: true, value: () => now });
    globalThis.requestAnimationFrame = vi.fn((cb: FrameRequestCallback) => {
      const id = nextRafId++;
      rafCallbacks.set(id, cb);
      return id;
    });
    globalThis.cancelAnimationFrame = vi.fn((id: number) => {
      rafCallbacks.delete(id);
    });

    const gate = deferred<Initialization>();
    const source = makeSource([]);
    source.initialize = vi.fn(async () => await gate.promise);
    const player = new IterablePlayer(source);
    let latestState: PlayerState | undefined;
    player.setListener((state) => {
      latestState = state;
    });

    try {
      const pending = player.initialize({});
      await flushAsyncWork();
      player.play();
      expect(latestState?.activeData).toBeUndefined();

      now = 5_000;
      gate.resolve({ ...makeInitialization(), start: { sec: 100, nsec: 0 }, end: { sec: 110, nsec: 0 } });
      await pending;
      expect(latestState?.activeData?.isPlaying).toBe(true);
      expect(player.getCurrentTime()).toEqual({ sec: 100, nsec: 0 });

      now = 6_000;
      rafCallbacks.get(Math.max(...rafCallbacks.keys()))?.(now);
      await flushAsyncWork();
      expect(player.getCurrentTime()).toEqual({ sec: 101, nsec: 0 });
    } finally {
      player.close();
      Object.defineProperty(performance, 'now', { configurable: true, value: oldPerformanceNow });
      globalThis.requestAnimationFrame = oldRequestAnimationFrame;
      globalThis.cancelAnimationFrame = oldCancelAnimationFrame;
    }
  });

  it('drops a deferred play when paused before initialization finishes', async () => {
    const gate = deferred<Initialization>();
    const source = makeSource([]);
    source.initialize = vi.fn(async () => await gate.promise);
    const player = new IterablePlayer(source);
    let latestState: PlayerState | undefined;
    player.setListener((state) => {
      latestState = state;
    });

    const pending = player.initialize({});
    await flushAsyncWork();
    player.play();
    player.pause();
    gate.resolve(makeInitialization());
    await pending;
    expect(latestState?.activeData?.isPlaying).toBe(false);
    player.close();
  });
});

function installFakePlaybackClock() {
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
  return {
    get now() {
      return now;
    },
    set now(value: number) {
      now = value;
    },
    runNextRaf() {
      const id = Math.min(...rafCallbacks.keys());
      const callback = rafCallbacks.get(id);
      rafCallbacks.delete(id);
      callback?.(now);
    },
    restore() {
      Object.defineProperty(performance, 'now', {
        configurable: true,
        value: oldPerformanceNow,
      });
      globalThis.requestAnimationFrame = oldRequestAnimationFrame;
      globalThis.cancelAnimationFrame = oldCancelAnimationFrame;
    },
  };
}

describe('IterablePlayer playback watchdogs', () => {

  it('keeps scheduling ticks when a current-time subscriber throws', async () => {
    const clock = installFakePlaybackClock();
    const source = makeSource([]);
    const cursor = {
      nextBatch: vi.fn(async () => [makeImageMessageAtMs(150)]),
      end: vi.fn(async () => undefined),
    };
    vi.mocked(source.getMessageCursor).mockResolvedValue(cursor as never);
    const player = new IterablePlayer(source);
    const times: number[] = [];

    try {
      await player.initialize({});
      player.registerSubscriptions('panel', [{ topic: TOPIC, subscriberId: 'panel' }]);
      await flushAsyncWork();
      player.subscribeCurrentTime(() => {
        throw new Error('subscriber failed');
      });
      player.subscribeCurrentTime((time) => {
        times.push(time.sec + time.nsec / 1e9);
      });
      player.play();

      clock.now = 100;
      clock.runNextRaf();
      await flushAsyncWork();
      clock.now = 200;
      clock.runNextRaf();
      await flushAsyncWork();

      expect(times.length).toBeGreaterThan(1);
    } finally {
      player.close();
      clock.restore();
    }
  });

  it('does not let a stalled cursor close block the next seek', async () => {
    const clock = installFakePlaybackClock();
    const source = makeSource([makeImageMessageAtMs(100)]);
    const hangingEnd = deferred<void>();
    const firstCursor = {
      nextBatch: vi.fn(async () => []),
      end: vi.fn(() => hangingEnd.promise),
    };
    vi.mocked(source.getMessageCursor).mockResolvedValue(firstCursor as never);
    const player = new IterablePlayer(source, { cursorCloseTimeoutMs: 20 });

    try {
      await player.initialize({});
      player.registerSubscriptions('panel', [{ topic: TOPIC, subscriberId: 'panel' }]);
      await flushAsyncWork();
      player.play();
      clock.now = 100;
      clock.runNextRaf();
      await flushAsyncWork();
      expect(source.getMessageCursor).toHaveBeenCalledTimes(1);

      const seekStartedAt = Date.now();
      player.seek({ sec: 0, nsec: 200_000_000 });
      await new Promise((resolve) => setTimeout(resolve, 50));
      await flushAsyncWork();

      expect(firstCursor.end).toHaveBeenCalledTimes(1);
      expect(Date.now() - seekStartedAt).toBeLessThan(200);
    } finally {
      hangingEnd.resolve();
      player.close();
      clock.restore();
    }
  });

  it('pauses with a retryable error after repeated nextBatch timeouts', async () => {
    const clock = installFakePlaybackClock();
    const source = makeSource([]);
    const cursor = {
      nextBatch: vi.fn(() => new Promise<MessageEvent[]>(() => undefined)),
      end: vi.fn(async () => undefined),
    };
    vi.mocked(source.getMessageCursor).mockResolvedValue(cursor as never);
    const player = new IterablePlayer(source, {
      rpcTimeoutMs: 20,
      sourceFailureThreshold: 2,
    });
    let latestState: PlayerState | undefined;

    try {
      player.setListener((state) => {
        latestState = state;
      });
      await player.initialize({});
      player.registerSubscriptions('panel', [{ topic: TOPIC, subscriberId: 'panel' }]);
      await flushAsyncWork();
      player.play();

      clock.now = 100;
      clock.runNextRaf();
      await new Promise((resolve) => setTimeout(resolve, 30));
      clock.now = 200;
      clock.runNextRaf();
      await new Promise((resolve) => setTimeout(resolve, 30));
      clock.now = 700;
      clock.runNextRaf();
      await new Promise((resolve) => setTimeout(resolve, 30));

      expect(latestState?.progress.buffering).toBe(false);
      expect(latestState?.progress.playbackError).toMatch(/timed out/);
      expect(latestState?.activeData?.isPlaying).toBe(false);
    } finally {
      player.close();
      clock.restore();
    }
  });

  it('holds the playhead while the network is down and plays on from there once it is back (M-2)', async () => {
    const clock = installFakePlaybackClock();
    const source = makeSource([]);
    const cursor = { nextBatch: vi.fn(async () => []), end: vi.fn(async () => undefined) };
    vi.mocked(source.getMessageCursor).mockResolvedValue(cursor as never);
    const listeners = new Set<() => void>();
    const connection = {
      reconnecting: false,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const setReconnecting = (value: boolean): void => {
      connection.reconnecting = value;
      for (const listener of listeners) listener();
    };
    const player = new IterablePlayer(source, { connection });
    let state: PlayerState | undefined;
    const seconds = (): number => {
      const t = player.getCurrentTime()!;
      return t.sec + t.nsec / 1e9;
    };
    try {
      player.setListener((s) => (state = s));
      await player.initialize({});
      player.registerSubscriptions('panel', [{ topic: TOPIC, subscriberId: 'panel' }]);
      await flushAsyncWork();
      player.play();
      clock.now = 1_000;
      clock.runNextRaf();
      await flushAsyncWork();
      const before = seconds();
      expect(before).toBeGreaterThan(0.9);

      // Data the cursor still has would let the clock run on; the frames would not follow.
      setReconnecting(true);
      for (const at of [2_000, 3_000, 4_000]) {
        clock.now = at;
        clock.runNextRaf();
        await flushAsyncWork();
      }
      expect(seconds()).toBe(before);
      expect(state?.progress.buffering).toBe(true);

      setReconnecting(false);
      expect(state?.progress.buffering).toBe(false);
      clock.now = 4_500;
      clock.runNextRaf();
      await flushAsyncWork();
      // On from where it waited: half a second later, not three and a half.
      expect(seconds()).toBeCloseTo(before + 0.5, 1);
    } finally {
      player.close();
      clock.restore();
    }
  });

  it('a seek while playing plays on from the seek time once its frame arrives, however long that took (M-2)', async () => {
    const clock = installFakePlaybackClock();
    const source = makeSource([]);
    const cursor = { nextBatch: vi.fn(async () => []), end: vi.fn(async () => undefined) };
    vi.mocked(source.getMessageCursor).mockResolvedValue(cursor as never);
    const player = new IterablePlayer(source);
    try {
      await player.initialize({});
      player.registerSubscriptions('panel', [{ topic: TOPIC, subscriberId: 'panel' }]);
      await flushAsyncWork();
      player.play();
      clock.now = 100;
      clock.runNextRaf();
      await flushAsyncWork();

      // The frame at the seek time takes 5 s (the network is down meanwhile).
      const frame = deferred<MessageEvent[]>();
      vi.mocked(source.getBackfillMessages).mockImplementationOnce(() => frame.promise);
      player.seek({ sec: 2, nsec: 0 });
      clock.now = 5_100;
      frame.resolve([]);
      await flushAsyncWork();
      clock.now = 5_200;
      clock.runNextRaf();
      await flushAsyncWork();

      // Playback goes on from 2 s, not from 2 s plus the 5 s the frame took.
      const now = player.getCurrentTime()!;
      expect(now.sec + now.nsec / 1e9).toBeGreaterThanOrEqual(2);
      expect(now.sec + now.nsec / 1e9).toBeLessThan(2.5);
    } finally {
      player.close();
      clock.restore();
    }
  });

  it('while the network is down a slow read never fails playback, which resumes when the read answers (M-2)', async () => {
    const clock = installFakePlaybackClock();
    const source = makeSource([]);
    const batch = deferred<MessageEvent[]>();
    const cursor = { nextBatch: vi.fn(() => batch.promise), end: vi.fn(async () => undefined) };
    vi.mocked(source.getMessageCursor).mockResolvedValue(cursor as never);
    // The viewer's network state, as the range reader reports it.
    const listeners = new Set<() => void>();
    const connection = {
      reconnecting: false,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const setReconnecting = (value: boolean): void => {
      connection.reconnecting = value;
      for (const listener of listeners) listener();
    };
    const player = new IterablePlayer(source, { rpcTimeoutMs: 20, sourceFailureThreshold: 1, connection });
    let state: PlayerState | undefined;
    try {
      player.setListener((s) => (state = s));
      await player.initialize({});
      player.registerSubscriptions('panel', [{ topic: TOPIC, subscriberId: 'panel' }]);
      await flushAsyncWork();
      player.play();
      setReconnecting(true);
      expect(state?.progress.reconnecting).toBe(true);
      clock.now = 100;
      clock.runNextRaf();
      // Many deadlines pass while the read waits for the network: none of them is a failure.
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(state?.progress.playbackError).toBeUndefined();
      expect(state?.activeData?.isPlaying).toBe(true);

      setReconnecting(false);
      expect(state?.progress.reconnecting).toBe(false);
      batch.resolve([makeImageMessageAtMs(50)]);
      await flushAsyncWork();
      expect(state?.progress.playbackError).toBeUndefined();
      expect(state?.activeData?.isPlaying).toBe(true);
    } finally {
      player.close();
      clock.restore();
    }
    // A closed player no longer listens.
    expect(listeners.size).toBe(0);
  });
});

describe('IterablePlayer initialize logging', () => {
  async function initializeWith(rejection: Error) {
    const source = makeSource([]);
    vi.mocked(source.initialize).mockRejectedValue(rejection);
    const player = new IterablePlayer(source);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    try {
      await expect(player.initialize({})).rejects.toBe(rejection);
      return {
        error: error.mock.calls.map((c) => String(c[0])),
        debug: debug.mock.calls.map((c) => String(c[0])),
      };
    } finally {
      error.mockRestore();
      debug.mockRestore();
    }
  }

  it('logs a cancelled source at debug level only', async () => {
    const cancelled = new Error('Worker initialize cancelled');
    cancelled.name = 'WorkerSourceCancelledError';
    const logs = await initializeWith(cancelled);
    expect(logs.error).not.toContain('IterablePlayer: initialization failed');
    expect(logs.debug).toContain('IterablePlayer: initialization cancelled');
  });

  it('still reports a real failure as a console error', async () => {
    const logs = await initializeWith(new Error('HTTP 404'));
    expect(logs.error).toContain('IterablePlayer: initialization failed');
  });
});

describe('IterablePlayer stepMessage', () => {
  const OTHER_TOPIC = '/camera/rear/image/compressed';

  function imageAt(topic: string, ms: number): MessageEvent {
    return { ...makeImageMessageAtMs(ms), topic };
  }

  it('stepping back while paused announces the new time first, then refreshes every topic at it', async () => {
    const source = makeSource([]);
    vi.mocked(source.initialize).mockImplementation(async () => ({
      ...makeInitialization(),
      topics: [
        { name: TOPIC, type: 'sensor_msgs/CompressedImage' },
        { name: OTHER_TOPIC, type: 'sensor_msgs/CompressedImage' },
      ],
    }));
    // The latest message per topic at or before the requested time.
    vi.mocked(source.getBackfillMessages).mockImplementation(async ({ time, topics }) => {
      const ms = time.sec * 1000 + Math.floor(time.nsec / 1_000_000);
      const frames = [imageAt(TOPIC, 0), imageAt(TOPIC, 400), imageAt(OTHER_TOPIC, 0), imageAt(OTHER_TOPIC, 390)];
      return topics.flatMap((topic) => {
        const latest = frames
          .filter((f) => f.topic === topic && f.receiveTime.sec * 1000 + f.receiveTime.nsec / 1_000_000 <= ms)
          .at(-1);
        return latest ? [latest] : [];
      });
    });
    vi.mocked(source.getAdjacentMessage).mockImplementation(async () => imageAt(TOPIC, 400));

    const player = new IterablePlayer(source);
    await player.initialize({});
    const events: string[] = [];
    for (const topic of [TOPIC, OTHER_TOPIC]) {
      player.registerHighFrequencyConsumer(`panel:${topic}`, {
        topic,
        lane: 'video',
        onLatestMessage: (message) => {
          events.push(`frame ${message.topic} ${message.receiveTime.nsec / 1_000_000}`);
        },
      });
    }
    player.seek({ sec: 0, nsec: 500_000_000 });
    await flushAsyncWork();
    await flushAsyncWork();
    player.subscribeCurrentTime((time) => {
      events.push(`time ${time.nsec / 1_000_000}`);
    });
    events.length = 0;

    player.stepMessage(-1);
    await flushAsyncWork();
    await flushAsyncWork();

    // Panels clear on a rewind, so the new time must come before the frames
    // that fill them, and every topic (not only the stepped one) must get one.
    const timeIndex = events.indexOf('time 400');
    expect(timeIndex).toBeGreaterThanOrEqual(0);
    const after = events.slice(timeIndex + 1);
    expect(after).toContain(`frame ${TOPIC} 400`);
    expect(after).toContain(`frame ${OTHER_TOPIC} 390`);

    player.close();
  });
});

describe('IterablePlayer paused frame', () => {
  const MAP_TOPIC = '/scene/map';

  function mapMessage(): MessageEvent {
    return { ...makeImageMessageAt(0), topic: MAP_TOPIC, schemaName: 'sensor_msgs/PointCloud2' };
  }

  it('asks for the frame first in one call, delivers each topic as it is read, and a slow one after the RPC deadline', async () => {
    const source = makeSource([]);
    const map = deferred<void>();
    vi.mocked(source.getBackfillMessages).mockImplementation(async ({ topics }, onTopic) => {
      for (const topic of topics) {
        if (topic === MAP_TOPIC) await map.promise;
        await onTopic?.(topic, [topic === MAP_TOPIC ? mapMessage() : { ...makeImageMessageAt(0), topic }]);
      }
      return [];
    });
    const player = new IterablePlayer(source, { rpcTimeoutMs: 20 });
    const frames: string[] = [];
    try {
      await player.initialize({});
      player.registerSubscriptions('plot', [{ topic: '/joint_states', subscriberId: 'plot' }]);
      player.registerSubscriptions('logs', [{ topic: '/rosout', subscriberId: 'logs' }]);
      for (const topic of [TOPIC, MAP_TOPIC]) {
        player.registerHighFrequencyConsumer(`panel:${topic}`, {
          topic,
          lane: 'video',
          onLatestMessage: (message) => frames.push(message.topic),
        });
      }
      await flushAsyncWork();
      const calls = vi.mocked(source.getBackfillMessages).mock.calls;
      // One call for the whole frame (the worker bounds how many topics it reads at once), with the
      // topics a user waits for (Image, 3D) first.
      expect(calls.at(-1)?.[0].topics).toEqual([TOPIC, MAP_TOPIC, '/joint_states', '/rosout']);
      expect(frames).toContain(TOPIC);
      expect(frames).not.toContain(MAP_TOPIC);

      // The map takes longer than the RPC deadline (a slow link, not a hung worker): still shown.
      await new Promise((resolve) => setTimeout(resolve, 60));
      map.resolve();
      await flushAsyncWork();
      expect(frames).toContain(MAP_TOPIC);
    } finally {
      player.close();
    }
  });

  it('stops the backfill call once the frame moved on', async () => {
    const source = makeSource([]);
    const gate = deferred<void>();
    const answers: boolean[] = [];
    vi.mocked(source.getBackfillMessages).mockImplementation(async ({ time, topics }, onTopic) => {
      if (time.sec === 0) await gate.promise;
      for (const topic of topics) answers.push(await (onTopic?.(topic, [makeImageMessageAt(time.sec)]) ?? true));
      return [];
    });
    const player = new IterablePlayer(source);
    try {
      await player.initialize({});
      player.registerHighFrequencyConsumer('panel', { topic: TOPIC, lane: 'video', onLatestMessage: vi.fn() });
      await flushAsyncWork();
      player.seek({ sec: 5, nsec: 0 });
      await flushAsyncWork();
      expect(answers).toEqual([true]);
      gate.resolve();
      await flushAsyncWork();
      // The call at 0 s is told to stop: its frame is no longer wanted.
      expect(answers).toEqual([true, false]);
    } finally {
      player.close();
    }
  });

  it('drops a backfill result that arrives after the deadline while playing', async () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const source = makeSource([]);
    vi.mocked(source.getMessageCursor).mockResolvedValue({ nextBatch: vi.fn(async () => []), end: vi.fn() } as never);
    (source as unknown as { preparePlaybackBuffer: () => Promise<{ ready: boolean }> }).preparePlaybackBuffer =
      async () => ({ ready: true });
    const slow = deferred<void>();
    vi.mocked(source.getBackfillMessages).mockImplementation(async ({ time, topics }, onTopic) => {
      if (time.sec === 7) await slow.promise;
      for (const topic of topics) await onTopic?.(topic, [makeImageMessageAt(time.sec)]);
      return [];
    });
    const player = new IterablePlayer(source, { rpcTimeoutMs: 20 });
    const frames: number[] = [];
    try {
      await player.initialize({});
      player.registerHighFrequencyConsumer('panel', {
        topic: TOPIC,
        lane: 'video',
        onLatestMessage: (message) => frames.push(message.receiveTime.sec),
      });
      await flushAsyncWork();
      player.play();
      player.seek({ sec: 3, nsec: 0 });
      await flushAsyncWork();
      expect(frames).toContain(3);
      player.seek({ sec: 7, nsec: 0 });
      await new Promise((resolve) => setTimeout(resolve, 60));
      slow.resolve();
      await flushAsyncWork();
      // Playback fills the panel by then; the late frame would be stale.
      expect(frames).not.toContain(7);
    } finally {
      player.close();
      vi.unstubAllGlobals();
    }
  });

  it('drops a late frame once the paused frame moved on', async () => {
    const source = makeSource([]);
    const late = deferred<MessageEvent[]>();
    vi.mocked(source.getBackfillMessages).mockImplementation(async ({ time }) =>
      time.sec === 0 ? await late.promise : [makeImageMessageAt(time.sec)],
    );
    // (This source returns everything at the end, like a source without per-topic delivery.)
    const player = new IterablePlayer(source, { rpcTimeoutMs: 20 });
    const frames: number[] = [];
    try {
      await player.initialize({});
      player.registerHighFrequencyConsumer('panel', {
        topic: TOPIC,
        lane: 'video',
        onLatestMessage: (message) => frames.push(message.receiveTime.sec),
      });
      await new Promise((resolve) => setTimeout(resolve, 40));
      player.seek({ sec: 5, nsec: 0 });
      await flushAsyncWork();
      late.resolve([makeImageMessageAt(0)]);
      await flushAsyncWork();
      expect(frames).toEqual([5]);
    } finally {
      player.close();
    }
  });

  it('starts no read-ahead while paused, also after a seek; play starts it', async () => {
    const source = makeSource([makeImageMessage()]);
    const prepare = vi.fn(async () => ({ ready: true }));
    (source as unknown as { preparePlaybackBuffer: typeof prepare }).preparePlaybackBuffer = prepare;
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const player = new IterablePlayer(source);
    try {
      await player.initialize({});
      player.registerSubscriptions('panel', [{ topic: TOPIC, subscriberId: 'panel' }]);
      player.seek({ sec: 5, nsec: 0 });
      await flushAsyncWork();
      expect(prepare).not.toHaveBeenCalled();
      player.play();
      await flushAsyncWork();
      expect(prepare).toHaveBeenCalledTimes(1);
    } finally {
      player.close();
      vi.unstubAllGlobals();
    }
  });
});

describe('IterablePlayer range scans', () => {
  it('a range scan waits for data, and fails with the source error instead of waiting forever', async () => {
    const source = makeSource([]);
    const stall = Object.assign(new Error('No data arrived from the server for 20 s'), { name: 'RangeStallError' });
    const cursor = { nextBatch: vi.fn(async () => Promise.reject(stall)), end: vi.fn(async () => undefined) };
    vi.mocked(source.getMessageCursor).mockResolvedValue(cursor as never);
    const player = new IterablePlayer(source);
    try {
      await player.initialize({});
      // Callers without an abort signal (a topic sample, CSV export) finish with the error.
      await expect(
        player.getMessagesInTimeRange({ start: { sec: 0, nsec: 0 }, end: { sec: 1, nsec: 0 }, topics: [TOPIC] }),
      ).rejects.toMatchObject({ name: 'RangeStallError' });
      expect(cursor.nextBatch).toHaveBeenCalledWith(expect.any(Number), expect.objectContaining({ waitForData: true }));
      expect(cursor.end).toHaveBeenCalled();
    } finally {
      player.close();
    }
  });

  it('an abort ends a range scan whose batch is still waiting for data', async () => {
    const source = makeSource([]);
    const ended = deferred<MessageEvent[]>();
    const cursor = {
      nextBatch: vi.fn(async () => await ended.promise),
      end: vi.fn(async () => ended.resolve([])),
    };
    vi.mocked(source.getMessageCursor).mockResolvedValue(cursor as never);
    const player = new IterablePlayer(source);
    try {
      await player.initialize({});
      const controller = new AbortController();
      const scan = player.getMessagesInTimeRange({
        start: { sec: 0, nsec: 0 },
        end: { sec: 1, nsec: 0 },
        topics: [TOPIC],
        signal: controller.signal,
      });
      await flushAsyncWork();
      controller.abort();
      await expect(scan).resolves.toEqual([]);
      expect(cursor.end).toHaveBeenCalled();
    } finally {
      player.close();
    }
  });
});

describe('IterablePlayer honest errors', () => {
  const MAP_TOPIC = '/scene/map';
  const stall = (): Error =>
    Object.assign(new Error('No data arrived from the server for 20 s while reading rec (bytes 0–1), also after a retry.'), {
      name: 'RangeStallError',
    });

  it('a topic whose frame cannot be read shows its reason; the other topics are still shown', async () => {
    const source = makeSource([]);
    vi.mocked(source.getBackfillMessages).mockImplementation(async ({ topics, time }, onTopic) => {
      for (const topic of topics) {
        if (topic === MAP_TOPIC && time.sec === 0) await onTopic?.(topic, [], { name: 'RangeStallError', message: stall().message });
        else await onTopic?.(topic, [{ ...makeImageMessageAt(time.sec), topic }]);
      }
      return [];
    });
    const player = new IterablePlayer(source);
    let state: PlayerState | undefined;
    const frames: string[] = [];
    try {
      player.setListener((s) => (state = s));
      await player.initialize({});
      for (const topic of [TOPIC, MAP_TOPIC]) {
        player.registerHighFrequencyConsumer(`panel:${topic}`, {
          topic,
          lane: 'video',
          onLatestMessage: (message) => frames.push(message.topic),
        });
      }
      await flushAsyncWork();
      expect(frames).toEqual([TOPIC]);
      expect(state?.activeData?.topicErrors).toEqual({ [MAP_TOPIC]: stall().message });
      expect(state?.activeData?.problems).toContainEqual({ severity: 'error', message: `${MAP_TOPIC}: ${stall().message}` });

      // The next frame of that topic clears its error.
      player.seek({ sec: 2, nsec: 0 });
      await flushAsyncWork();
      expect(frames).toContain(MAP_TOPIC);
      expect(state?.activeData?.topicErrors).toEqual({});
    } finally {
      player.close();
    }
  });

  it('a backfill error that comes after the RPC deadline still reaches the panels while paused', async () => {
    const source = makeSource([]);
    const failing = deferred<MessageEvent[]>();
    // A source without per-topic delivery: the whole call fails, later than the deadline.
    vi.mocked(source.getBackfillMessages).mockImplementation(async () => await failing.promise);
    const player = new IterablePlayer(source, { rpcTimeoutMs: 20 });
    let state: PlayerState | undefined;
    try {
      player.setListener((s) => (state = s));
      await player.initialize({});
      player.registerHighFrequencyConsumer('panel', { topic: TOPIC, lane: 'video', onLatestMessage: vi.fn() });
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(state?.activeData?.topicErrors?.[TOPIC]).toBeUndefined();
      failing.reject(stall());
      await flushAsyncWork();
      expect(state?.activeData?.topicErrors?.[TOPIC]).toBe(stall().message);
    } finally {
      player.close();
    }
  });

  it('playback shows the real error that ends a read the deadline gave up on, not the timeout', async () => {
    const clock = installFakePlaybackClock();
    const source = makeSource([]);
    const batch = deferred<MessageEvent[]>();
    const cursor = { nextBatch: vi.fn(() => batch.promise), end: vi.fn(async () => undefined) };
    vi.mocked(source.getMessageCursor).mockResolvedValue(cursor as never);
    const player = new IterablePlayer(source, { rpcTimeoutMs: 20, sourceFailureThreshold: 1 });
    let state: PlayerState | undefined;
    try {
      player.setListener((s) => (state = s));
      await player.initialize({});
      player.registerSubscriptions('panel', [{ topic: TOPIC, subscriberId: 'panel' }]);
      await flushAsyncWork();
      player.play();
      clock.now = 100;
      clock.runNextRaf();
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(state?.progress.playbackError).toMatch(/timed out: no answer within 0 s/);

      batch.reject(stall());
      await flushAsyncWork();
      expect(state?.progress.playbackError).toBe(stall().message);
      expect(state?.activeData?.isPlaying).toBe(false);
    } finally {
      player.close();
      clock.restore();
    }
  });

  it('a real playback error is shown at once, without waiting for repeated failures', async () => {
    const clock = installFakePlaybackClock();
    const source = makeSource([]);
    const cursor = { nextBatch: vi.fn(async () => Promise.reject(stall())), end: vi.fn(async () => undefined) };
    vi.mocked(source.getMessageCursor).mockResolvedValue(cursor as never);
    const player = new IterablePlayer(source, { sourceFailureThreshold: 3 });
    let state: PlayerState | undefined;
    try {
      player.setListener((s) => (state = s));
      await player.initialize({});
      player.registerSubscriptions('panel', [{ topic: TOPIC, subscriberId: 'panel' }]);
      await flushAsyncWork();
      player.play();
      clock.now = 100;
      clock.runNextRaf();
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(state?.progress.playbackError).toBe(stall().message);
      expect(state?.activeData?.isPlaying).toBe(false);
    } finally {
      player.close();
      clock.restore();
    }
  });
});

describe('IterablePlayer read errors by panel', () => {
  const MAP_TOPIC = '/scene/map';
  const reason = 'No data arrived from the server for 20 s while reading rec (bytes 0–1), also after a retry.';

  /** A source whose backfill of `failing` topics fails; others deliver one message. */
  function failingSource(failing: Set<string>) {
    const source = makeSource([]);
    vi.mocked(source.getBackfillMessages).mockImplementation(async ({ topics, time }, onTopic) => {
      for (const topic of topics) {
        if (failing.has(topic)) await onTopic?.(topic, [], { name: 'RangeStallError', message: reason });
        else await onTopic?.(topic, [{ ...makeImageMessageAt(time.sec), topic }]);
      }
      return [];
    });
    return source;
  }

  it('lists each panel its failed topics, including those of its high-frequency consumers', async () => {
    const source = failingSource(new Set([MAP_TOPIC, TOPIC]));
    const player = new IterablePlayer(source);
    let state: PlayerState | undefined;
    try {
      player.setListener((s) => (state = s));
      await player.initialize({});
      player.registerSubscriptions('Raw!1', [{ topic: MAP_TOPIC, subscriberId: 'Raw!1' }]);
      player.registerSubscriptions('3D!1', [
        { topic: MAP_TOPIC, subscriberId: '3D!1' },
        { topic: '/tf', subscriberId: '3D!1' },
      ]);
      player.registerHighFrequencyConsumer('Image!1:image-main', { topic: TOPIC, lane: 'video', onLatestMessage: vi.fn() });
      await flushAsyncWork();
      expect(state?.activeData?.panelReadErrors).toEqual({
        'Raw!1': [{ topic: MAP_TOPIC, message: reason, kind: 'stalled' }],
        '3D!1': [{ topic: MAP_TOPIC, message: reason, kind: 'stalled' }],
        'Image!1': [{ topic: TOPIC, message: reason, kind: 'stalled' }],
      });
    } finally {
      player.close();
    }
  });

  it('retry() reads the frame of each failed topic again, also while paused, and bumps retryCount', async () => {
    const failing = new Set([MAP_TOPIC]);
    const source = failingSource(failing);
    const player = new IterablePlayer(source);
    let state: PlayerState | undefined;
    try {
      player.setListener((s) => (state = s));
      await player.initialize({});
      player.registerSubscriptions('Raw!1', [{ topic: MAP_TOPIC, subscriberId: 'Raw!1' }]);
      await flushAsyncWork();
      expect(state?.activeData?.topicErrors?.[MAP_TOPIC]).toBe(reason);
      expect(state?.progress.retryCount).toBeUndefined();

      failing.clear(); // the server answers again
      player.retry();
      await flushAsyncWork();
      expect(state?.activeData?.topicErrors).toEqual({});
      expect(state?.activeData?.panelReadErrors).toBeUndefined();
      expect(state?.progress.retryCount).toBe(1);
      expect(state?.activeData?.isPlaying).toBe(false);
    } finally {
      player.close();
    }
  });

  it('drops the error of a topic that no panel reads any more', async () => {
    const source = failingSource(new Set([MAP_TOPIC]));
    const player = new IterablePlayer(source);
    let state: PlayerState | undefined;
    try {
      player.setListener((s) => (state = s));
      await player.initialize({});
      player.registerSubscriptions('Raw!1', [{ topic: MAP_TOPIC, subscriberId: 'Raw!1' }]);
      player.registerSubscriptions('Raw!2', [{ topic: TOPIC, subscriberId: 'Raw!2' }]);
      await flushAsyncWork();
      expect(state?.activeData?.problems).toContainEqual({ severity: 'error', message: `${MAP_TOPIC}: ${reason}` });

      player.unregisterSubscriptions('Raw!1');
      await flushAsyncWork();
      expect(state?.activeData?.topicErrors).toEqual({});
      expect(state?.activeData?.panelReadErrors).toBeUndefined();
      expect(state?.activeData?.problems.some((p) => p.message.startsWith(MAP_TOPIC))).toBe(false);
    } finally {
      player.close();
    }
  });

  it.each([
    { panel: 'Raw!1', change: 'switches its path', before: [MAP_TOPIC], after: [TOPIC] },
    { panel: 'Plot!1', change: 'drops a series', before: [MAP_TOPIC, TOPIC], after: [TOPIC] },
  ])('a panel that $change no longer lists the error of its old topic', async ({ panel, before, after }) => {
    const source = failingSource(new Set([MAP_TOPIC]));
    const player = new IterablePlayer(source);
    let state: PlayerState | undefined;
    const subscribe = (topics: string[]) =>
      player.registerSubscriptions(
        panel,
        topics.map((topic) => ({ topic, subscriberId: panel })),
      );
    try {
      player.setListener((s) => (state = s));
      await player.initialize({});
      subscribe(before);
      await flushAsyncWork();
      expect(state?.activeData?.panelReadErrors).toEqual({ [panel]: [{ topic: MAP_TOPIC, message: reason, kind: 'stalled' }] });

      // The same panel re-registers with its new topics (a Raw path change, a Plot series change).
      subscribe(after);
      await flushAsyncWork();
      expect(state?.activeData?.panelReadErrors).toBeUndefined();
      expect(state?.activeData?.topicErrors).toEqual({});
    } finally {
      player.close();
    }
  });

  it('clears a topic error when playback delivers that topic', async () => {
    const clock = installFakePlaybackClock();
    const source = failingSource(new Set([MAP_TOPIC]));
    const cursor = {
      nextBatch: vi.fn(async () => [{ ...makeImageMessageAtMs(50), topic: MAP_TOPIC }]),
      end: vi.fn(async () => undefined),
    };
    vi.mocked(source.getMessageCursor).mockResolvedValue(cursor as never);
    const player = new IterablePlayer(source);
    let state: PlayerState | undefined;
    try {
      player.setListener((s) => (state = s));
      await player.initialize({});
      player.registerSubscriptions('Raw!1', [{ topic: MAP_TOPIC, subscriberId: 'Raw!1' }]);
      await flushAsyncWork();
      expect(state?.activeData?.topicErrors).toEqual({ [MAP_TOPIC]: reason });

      player.play();
      for (const now of [100, 200, 300]) {
        clock.now = now;
        clock.runNextRaf();
        await flushAsyncWork();
      }
      expect(state?.activeData?.topicErrors).toEqual({});
      expect(state?.activeData?.panelReadErrors).toBeUndefined();
    } finally {
      player.close();
      clock.restore();
    }
  });
});

describe('IterablePlayer background range scans', () => {
  /** A cursor whose batches wait until the test releases them. */
  function gatedCursors() {
    const pending: Array<() => void> = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const cursor = () => {
      let batches = 1;
      return {
        nextBatch: vi.fn(async () => {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise<void>((resolve) => pending.push(resolve));
          inFlight--;
          return batches-- > 0 ? [makeImageMessageAt(1)] : [];
        }),
        end: vi.fn(async () => undefined),
      };
    };
    return { cursor, pending, inFlight: () => inFlight, maxInFlight: () => maxInFlight };
  }

  async function drain(iterable: AsyncIterable<MessageEvent[]>): Promise<number> {
    let n = 0;
    for await (const batch of iterable) n += batch.length;
    return n;
  }

  it('does not read a window while the frame at the playhead is read, and runs at most two scan batches at once', async () => {
    const source = makeSource([]);
    const gates = gatedCursors();
    vi.mocked(source.getMessageCursor).mockImplementation(async () => gates.cursor() as never);
    const frameReads: Array<() => void> = [];
    const releaseFrame = (): void => frameReads.splice(0).forEach((resolve) => resolve());
    const player = new IterablePlayer(source);
    try {
      await player.initialize({});
      vi.mocked(source.getBackfillMessages).mockImplementation(
        () => new Promise((resolve) => frameReads.push(() => resolve([]))),
      );
      // A seek: its frame is being read.
      player.registerSubscriptions('Image!1', [{ topic: TOPIC, subscriberId: 'Image!1' }]);
      player.seek({ sec: 1, nsec: 0 });
      await flushAsyncWork();

      const range = { start: { sec: 0, nsec: 0 }, end: { sec: 5, nsec: 0 }, topics: [TOPIC] };
      const scans = [0, 1, 2].map(() => drain(player.streamMessagesInTimeRange(range)));
      await flushAsyncWork();
      expect(gates.inFlight()).toBe(0);

      releaseFrame();
      await flushAsyncWork();
      expect(gates.inFlight()).toBe(2);

      while (gates.pending.length > 0 || gates.inFlight() > 0) {
        gates.pending.splice(0).forEach((resolve) => resolve());
        await flushAsyncWork();
      }
      expect(await Promise.all(scans)).toEqual([1, 1, 1]);
      expect(gates.maxInFlight()).toBe(2);
    } finally {
      player.close();
    }
  });
});

describe('IterablePlayer frame-priority reads and the window gate', () => {
  function hangingCursor(onBatch?: () => void) {
    return {
      nextBatch: vi.fn(() => {
        onBatch?.();
        return new Promise<MessageEvent[]>(() => undefined);
      }),
      end: vi.fn(async () => undefined),
    };
  }

  async function first(iterable: AsyncIterable<MessageEvent[]>): Promise<void> {
    for await (const batch of iterable) {
      void batch;
      return;
    }
  }

  it('starts a frame-priority read at once while window reads hold both slots, and holds new window reads while it runs', async () => {
    const source = makeSource([]);
    let windowBatches = 0;
    let frameBatches = 0;
    let releaseFrame: () => void = () => undefined;
    vi.mocked(source.getMessageCursor).mockImplementation(async ({ topics }) => {
      if (topics[0] === '/frame') {
        return {
          nextBatch: vi.fn(async () => {
            frameBatches++;
            await new Promise<void>((resolve) => (releaseFrame = resolve));
            return [];
          }),
          end: vi.fn(async () => undefined),
        } as never;
      }
      return hangingCursor(() => windowBatches++) as never;
    });
    const player = new IterablePlayer(source);
    try {
      await player.initialize({});
      const range = { start: { sec: 0, nsec: 0 }, end: { sec: 5, nsec: 0 } };
      // Two plots' window reads that never finish (a slow link) hold both slots.
      void first(player.streamMessagesInTimeRange({ ...range, topics: [TOPIC] }));
      void first(player.streamMessagesInTimeRange({ ...range, topics: [TOPIC] }));
      await flushAsyncWork();
      expect(windowBatches).toBe(2);

      // The H.264 keyframe repair after a seek.
      const frameRead = first(player.streamMessagesInTimeRange({ ...range, topics: ['/frame'], priority: 'frame' }));
      await flushAsyncWork();
      expect(frameBatches).toBe(1);

      // Window reads wait while it runs ...
      const controller = new AbortController();
      void first(player.streamMessagesInTimeRange({ ...range, topics: [TOPIC], signal: controller.signal }));
      await flushAsyncWork();
      expect(windowBatches).toBe(2);
      releaseFrame();
      await frameRead;
      controller.abort();
    } finally {
      player.close();
    }
  });

  it('does not open the cursor of a window read that waits for a slot (a worker cursor reads from the moment it is made)', async () => {
    const source = makeSource([]);
    vi.mocked(source.getMessageCursor).mockImplementation(async () => hangingCursor() as never);
    const player = new IterablePlayer(source);
    try {
      await player.initialize({});
      const range = { start: { sec: 0, nsec: 0 }, end: { sec: 5, nsec: 0 }, topics: [TOPIC] };
      for (let i = 0; i < 4; i++) void first(player.streamMessagesInTimeRange(range));
      await flushAsyncWork();
      expect(source.getMessageCursor).toHaveBeenCalledTimes(2);
    } finally {
      player.close();
    }
  });

  it('lets window reads go once the playhead\'s images are delivered, while a large map is still read', async () => {
    const source = makeSource([]);
    let windowBatches = 0;
    vi.mocked(source.getMessageCursor).mockImplementation(async () => hangingCursor(() => windowBatches++) as never);
    const MAP = '/scene/map';
    vi.mocked(source.getBackfillMessages).mockImplementation(async ({ topics, time }, onTopic) => {
      for (const topic of topics) {
        if (topic === MAP) await new Promise<void>(() => undefined); // the map never arrives
        await onTopic?.(topic, [{ ...makeImageMessageAt(time.sec), topic }]);
      }
      return [];
    });
    const player = new IterablePlayer(source);
    try {
      await player.initialize({});
      player.registerHighFrequencyConsumer('Image!1:image-main', { topic: TOPIC, lane: 'video', onLatestMessage: vi.fn() });
      player.registerSubscriptions('3D!1', [{ topic: MAP, subscriberId: '3D!1' }]);
      player.seek({ sec: 1, nsec: 0 });
      await flushAsyncWork();

      void first(player.streamMessagesInTimeRange({ start: { sec: 0, nsec: 0 }, end: { sec: 5, nsec: 0 }, topics: [TOPIC] }));
      await flushAsyncWork();
      expect(windowBatches).toBe(1);
    } finally {
      player.close();
    }
  });

  it('frees the slot of a window read that fails (a stalled range), so later reads still run', async () => {
    const source = makeSource([]);
    let calls = 0;
    vi.mocked(source.getMessageCursor).mockImplementation(async () => ({
      nextBatch: vi.fn(async () => {
        calls++;
        if (calls <= 2) throw Object.assign(new Error('No data arrived from the server for 20 s'), { name: 'RangeStallError' });
        return calls === 3 ? [makeImageMessageAt(1)] : [];
      }),
      end: vi.fn(async () => undefined),
    }) as never);
    const player = new IterablePlayer(source);
    try {
      await player.initialize({});
      const range = { start: { sec: 0, nsec: 0 }, end: { sec: 5, nsec: 0 }, topics: [TOPIC] };
      for (let i = 0; i < 2; i++) {
        await expect(first(player.streamMessagesInTimeRange(range))).rejects.toThrow('No data arrived');
      }
      let got = 0;
      for await (const batch of player.streamMessagesInTimeRange(range)) got += batch.length;
      expect(got).toBe(1);
    } finally {
      player.close();
    }
  });

  it('does not inject single-frame stale backfills into ordered (mode="all") video consumers', async () => {
    let now = 0;
    let nextRafId = 1;
    const oldPerformanceNow = performance.now;
    const oldRequestAnimationFrame = globalThis.requestAnimationFrame;
    const oldCancelAnimationFrame = globalThis.cancelAnimationFrame;
    const rafCallbacks = new Map<number, FrameRequestCallback>();
    Object.defineProperty(performance, 'now', { configurable: true, value: () => now });
    globalThis.requestAnimationFrame = vi.fn((cb: FrameRequestCallback) => {
      const id = nextRafId++;
      rafCallbacks.set(id, cb);
      return id;
    });
    globalThis.cancelAnimationFrame = vi.fn((id: number) => {
      rafCallbacks.delete(id);
    });

    const source = makeSource([]);
    vi.mocked(source.getMessageCursor).mockResolvedValue({
      nextBatch: vi.fn(async () => []),
      end: vi.fn(async () => undefined),
    } as never);
    const backfillMock = vi.mocked(source.getBackfillMessages);
    backfillMock.mockClear();

    const player = new IterablePlayer(source);
    const onMessageBatch = vi.fn();
    try {
      await player.initialize({});
      player.registerHighFrequencyConsumer('Image!1:image-main', {
        topic: TOPIC,
        panelId: 'Image!1',
        lane: 'video',
        mode: 'all',
        onMessageBatch,
      });
      await flushAsyncWork();
      backfillMock.mockClear();

      player.play();
      now = 2_000;
      const id = Math.min(...rafCallbacks.keys());
      const cb = rafCallbacks.get(id);
      rafCallbacks.delete(id);
      cb?.(now);
      await flushAsyncWork();

      expect(backfillMock).not.toHaveBeenCalled();
      expect(onMessageBatch).not.toHaveBeenCalled();
    } finally {
      player.close();
      Object.defineProperty(performance, 'now', { configurable: true, value: oldPerformanceNow });
      globalThis.requestAnimationFrame = oldRequestAnimationFrame;
      globalThis.cancelAnimationFrame = oldCancelAnimationFrame;
    }
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Initialization } from '@/core/types/ros';
import {
  WorkerSerializedSource,
  WorkerSourceCancelledError,
} from './WorkerSerializedSource';

const mockInitialization: Initialization = {
  topics: [],
  datatypes: new Map(),
  start: { sec: 0, nsec: 0 },
  end: { sec: 1, nsec: 0 },
  publishersByTopic: {},
  topicStats: {},
  problems: [],
};

type MockRemote = {
  initialize: ReturnType<typeof vi.fn>;
  configureTransport: ReturnType<typeof vi.fn>;
  getTransportDiagnostics: ReturnType<typeof vi.fn>;
};

let mockRemote: MockRemote;
let workerListeners: Map<string, Set<EventListener>>;

function createMockWorker(): Worker {
  workerListeners = new Map();
  return {
    addEventListener(type: string, listener: EventListener) {
      let set = workerListeners.get(type);
      if (!set) {
        set = new Set();
        workerListeners.set(type, set);
      }
      set.add(listener);
    },
    removeEventListener(type: string, listener: EventListener) {
      workerListeners.get(type)?.delete(listener);
    },
    terminate: vi.fn(),
  } as unknown as Worker;
}

function dispatchWorkerError(message: string): void {
  const event = { message } as ErrorEvent;
  for (const listener of workerListeners.get('error') ?? []) {
    listener.call(globalThis, event);
  }
}

vi.mock('comlink', () => ({
  wrap: vi.fn(() => mockRemote),
  proxy: vi.fn((value: unknown) => value),
}));

vi.mock('./transports/createWorkerTransport', () => ({
  createWorkerTransport: vi.fn(() => ({
    configure: vi.fn(async () => undefined),
    diagnostics: vi.fn(async () => ({ mode: 'comlink' as const })),
    mode: () => 'comlink' as const,
    fallbackReason: () => undefined,
  })),
}));

describe('WorkerSerializedSource.initialize', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockRemote = {
      initialize: vi.fn(),
      configureTransport: vi.fn(),
      getTransportDiagnostics: vi.fn(),
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('waits longer than the former 30s timeout without failing', async () => {
    let resolveInitialize!: (value: Initialization) => void;
    mockRemote.initialize.mockReturnValue(
      new Promise<Initialization>((resolve) => {
        resolveInitialize = resolve;
      }),
    );

    const source = new WorkerSerializedSource(createMockWorker());
    const pending = source.initialize({ file: new Blob(['x']) });

    await vi.advanceTimersByTimeAsync(60_000);
    resolveInitialize(mockInitialization);

    await expect(pending).resolves.toEqual(mockInitialization);
  });

  it('propagates worker initialize rejection without a timed-out message', async () => {
    mockRemote.initialize.mockRejectedValue(new Error('HTTP 404'));

    const source = new WorkerSerializedSource(createMockWorker());

    await expect(source.initialize({ url: 'https://example.com/file.mcap' })).rejects.toThrow('HTTP 404');
  });

  it('rejects with WorkerSourceCancelledError when terminate is called during initialize', async () => {
    mockRemote.initialize.mockReturnValue(new Promise<Initialization>(() => undefined));

    const worker = createMockWorker();
    const source = new WorkerSerializedSource(worker);
    const pending = source.initialize({ file: new Blob(['x']) });

    await Promise.resolve();
    source.terminate();

    await expect(pending).rejects.toBeInstanceOf(WorkerSourceCancelledError);
    expect(worker.terminate).toHaveBeenCalled();
  });

  it('rejects when the worker emits an error event during initialize', async () => {
    mockRemote.initialize.mockReturnValue(new Promise<Initialization>(() => undefined));

    const source = new WorkerSerializedSource(createMockWorker());
    const pending = source.initialize({ file: new Blob(['x']) });

    await Promise.resolve();
    dispatchWorkerError('Worker script failed');

    await expect(pending).rejects.toThrow('Worker script failed');
  });
});

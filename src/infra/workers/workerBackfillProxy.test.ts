import * as Comlink from 'comlink';
import { describe, expect, it, vi } from 'vitest';

// Worker modules expose themselves over Comlink when loaded; the test drives the classes directly.
vi.mock('comlink', async (importOriginal) => ({
  ...(await importOriginal<typeof import('comlink')>()),
  expose: vi.fn(),
}));

type BackfillWorker = {
  getBackfillMessages(args: unknown, onTopic?: unknown): Promise<unknown>;
};

const WORKERS: Array<[string, () => Promise<new () => BackfillWorker>]> = [
  ['mcap', async () => (await import('./mcap.worker')).McapWorkerImpl],
  ['bag', async () => (await import('./bag.worker')).BagWorker],
  ['db3', async () => (await import('./db3.worker')).Db3Worker],
  ['bvh', async () => (await import('./bvh.worker')).BvhWorkerImpl],
  ['hdf5', async () => (await import('./hdf5.worker')).Hdf5WorkerImpl],
];

describe('worker backfill callback', () => {
  it.each(WORKERS)('the %s worker releases the per-topic callback proxy, also when the read fails', async (_name, load) => {
    const Worker = await load();
    for (const outcome of ['ok', 'fail'] as const) {
      const worker = new Worker();
      (worker as unknown as { _source: unknown })._source = {
        getBackfillMessages: vi.fn(async () => {
          if (outcome === 'fail') throw new Error('stalled');
          return [];
        }),
      };
      const release = vi.fn();
      const onTopic = Object.assign(vi.fn(() => true), { [Comlink.releaseProxy]: release });
      const call = worker.getBackfillMessages({ time: { sec: 0, nsec: 0 }, topics: ['/a'] }, onTopic);
      if (outcome === 'fail') await expect(call).rejects.toThrow('stalled');
      else await call;
      expect(release).toHaveBeenCalledTimes(1);
    }
    // Loading a worker module (its codecs and sources) takes seconds under a full parallel run.
  }, 30_000);
});

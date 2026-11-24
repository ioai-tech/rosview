/**
 * @vitest-environment happy-dom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectionMonitor, networkRetryDelayMs } from './connection';

describe('ConnectionMonitor', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('backs off 0.5 s doubling, never more than 5 s apart', () => {
    expect([0, 1, 2, 3, 4, 10, 100].map(networkRetryDelayMs)).toEqual([500, 1000, 2000, 4000, 5000, 5000, 5000]);
  });

  it('asks again when its delay has passed', async () => {
    vi.useFakeTimers();
    const monitor = new ConnectionMonitor();
    let woke = false;
    void monitor.waitToRetry({}, 3, new AbortController().signal).then(() => (woke = true));
    await vi.advanceTimersByTimeAsync(3_999);
    expect(woke).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(woke).toBe(true);
  });

  it("asks again at once on the browser's online event, a hint that the network is back", async () => {
    vi.useFakeTimers();
    const monitor = new ConnectionMonitor();
    let woke = false;
    void monitor.waitToRetry({}, 10, new AbortController().signal).then(() => (woke = true));
    window.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(0);
    expect(woke).toBe(true);
  });

  it('asks again at once when another request got a response', async () => {
    vi.useFakeTimers();
    const monitor = new ConnectionMonitor();
    let woke = false;
    void monitor.waitToRetry({}, 10, new AbortController().signal).then(() => (woke = true));
    monitor.responded();
    await vi.advanceTimersByTimeAsync(0);
    expect(woke).toBe(true);
  });

  it('is reconnecting from the first dropped request until every one has been released', async () => {
    const monitor = new ConnectionMonitor();
    const seen: boolean[] = [];
    monitor.subscribe(() => seen.push(monitor.reconnecting));
    const a = {};
    const b = {};
    void monitor.waitToRetry(a, 0, new AbortController().signal);
    void monitor.waitToRetry(b, 0, new AbortController().signal);
    expect(monitor.reconnecting).toBe(true);
    monitor.release(a);
    expect(monitor.reconnecting).toBe(true);
    monitor.release(b);
    monitor.release(b);
    expect(monitor.reconnecting).toBe(false);
    expect(seen).toEqual([true, false]);
  });

  it('rejects with AbortError when the request is aborted, and leaves no listener behind', async () => {
    const monitor = new ConnectionMonitor();
    const controller = new AbortController();
    const remove = vi.spyOn(window, 'removeEventListener');
    const wait = monitor.waitToRetry({}, 10, controller.signal);
    controller.abort();
    await expect(wait).rejects.toMatchObject({ name: 'AbortError' });
    expect(remove).toHaveBeenCalledWith('online', expect.any(Function));
    await expect(monitor.waitToRetry({}, 0, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
});

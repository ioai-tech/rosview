/**
 * The network state of one viewer's remote reads, and the one place that decides when a read the
 * network dropped is asked again.
 *
 * A `RangeSource` whose server answered before and whose request then fails without any response
 * (the browser's "Failed to fetch") does not fail the read: it waits here and asks again, with a
 * bounded backoff, for as long as the network is gone. It is asked again at once when the browser
 * reports `online` (a hint only: a cut that the browser does not see never fires it) or when any
 * other request of the viewer got a response (the network is back). While a read waits the viewer
 * is `reconnecting`, which the player shows instead of a failure.
 */
import type { ConnectionStatus } from '@/core/types/player';

/**
 * Delay before the `attempt`-th retry (0-based) of a read the network dropped: 0.5 s doubling, at
 * most 3 s, so a viewer is back within about 3 s of the network even when the browser never says
 * `online`. A request the network drops costs the server nothing.
 */
export function networkRetryDelayMs(attempt: number): number {
  return Math.min(NETWORK_RETRY_MAX_MS, NETWORK_RETRY_FIRST_MS * 2 ** Math.max(0, attempt));
}

const NETWORK_RETRY_FIRST_MS = 500;
const NETWORK_RETRY_MAX_MS = 3_000;

function abortError(): Error {
  const e = new Error('Aborted');
  e.name = 'AbortError';
  return e;
}

export class ConnectionMonitor implements ConnectionStatus {
  /** Requests that the network dropped and that have not had a response since. */
  #waiting = new Set<object>();
  #wakers = new Set<() => void>();
  #listeners = new Set<() => void>();

  /** True while a read waits for the network to come back. */
  get reconnecting(): boolean {
    return this.#waiting.size > 0;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * `owner` (one request) got no response because of the network. Resolves when it should ask
   * again: after `networkRetryDelayMs(attempt)`, on the browser's `online` event, or as soon as
   * another request got a response. Rejects with an AbortError when `signal` aborts. The viewer
   * stays `reconnecting` until `release(owner)`.
   */
  waitToRetry(owner: object, attempt: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(abortError());
    const wasReconnecting = this.reconnecting;
    this.#waiting.add(owner);
    if (!wasReconnecting) this.#emit();
    return new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        clearTimeout(timer);
        this.#wakers.delete(wake);
        signal.removeEventListener('abort', onAbort);
        if (typeof window !== 'undefined') window.removeEventListener('online', wake);
      };
      const wake = (): void => {
        cleanup();
        resolve();
      };
      const onAbort = (): void => {
        cleanup();
        reject(abortError());
      };
      const timer = setTimeout(wake, networkRetryDelayMs(attempt));
      this.#wakers.add(wake);
      signal.addEventListener('abort', onAbort, { once: true });
      if (typeof window !== 'undefined') window.addEventListener('online', wake, { once: true });
    });
  }

  /** A request got a response (any status): the network works, so every waiting request asks again now. */
  responded(): void {
    for (const wake of [...this.#wakers]) wake();
  }

  /** `owner` no longer waits for the network (it got its response, failed otherwise or was aborted). */
  release(owner: object): void {
    if (this.#waiting.delete(owner) && this.#waiting.size === 0) this.#emit();
  }

  #emit(): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener();
      } catch (err) {
        console.warn('ConnectionMonitor: listener failed', err);
      }
    }
  }
}

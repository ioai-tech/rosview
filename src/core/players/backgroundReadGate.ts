/**
 * Orders the player's reads on a shared link: at most `slots` background range scans (Plot, Align
 * and Timeline windows, CSV export) read at once, and none starts while a foreground read (the
 * frame at the playhead after an open or a seek, or a frame-priority read such as an H.264
 * keyframe repair) is in progress. Without this, every panel's scans queue ahead of the frame the
 * user is waiting for.
 */
export class BackgroundReadGate {
  private _active = 0;
  private _foreground = 0;
  private _playbackActive = false;
  private _playbackPriority = false;
  private _waiters: Array<() => void> = [];
  private readonly _slots: number;

  constructor(slots: number) {
    this._slots = slots;
  }

  /**
   * While active playback is running with ordered video consumers, cap
   * background window scans to a single slot so Plot/Timeline scans cannot
   * saturate the single MCAP worker or the HTTP Range link with parallel reads.
   */
  setPlaybackActive(active: boolean): void {
    if (this._playbackActive === active) return;
    this._playbackActive = active;
    if (!active) {
      this._playbackPriority = false;
    }
    this._wake();
  }

  /**
   * Temporarily holds background scans while the playback cursor itself needs
   * headroom (e.g. buffering or low prefetched queue during active playback).
   */
  setPlaybackPriority(priority: boolean): void {
    const next = this._playbackActive && priority;
    if (this._playbackPriority === next) return;
    this._playbackPriority = next;
    if (!next) {
      this._wake();
    }
  }

  get playbackActive(): boolean {
    return this._playbackActive;
  }

  /** Marks a foreground read; call the result when it ends (any number of times). */
  beginForeground(): () => void {
    this._foreground++;
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      this._foreground--;
      this._wake();
    };
  }

  /**
   * Waits until foreground reads and playback-priority periods finish. Used
   * between background range-scan batches so an already-acquired Plot cursor
   * yields the worker thread whenever playback needs to refill.
   */
  async waitForHeadroom(signal?: AbortSignal): Promise<boolean> {
    while (this._foreground > 0 || this._playbackPriority) {
      if (signal?.aborted) return false;
      await this._waitOnce(signal);
    }
    return !signal?.aborted;
  }

  /**
   * Waits for a background slot. Resolves to a release function, or to undefined when `signal`
   * aborts first.
   */
  async acquire(signal?: AbortSignal): Promise<(() => void) | undefined> {
    while (this._foreground > 0 || this._playbackPriority || this._active >= this._effectiveSlots()) {
      if (signal?.aborted) return undefined;
      await this._waitOnce(signal);
    }
    if (signal?.aborted) return undefined;
    this._active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this._active--;
      this._wake();
    };
  }

  private _effectiveSlots(): number {
    return this._playbackActive ? Math.min(1, this._slots) : this._slots;
  }

  private async _waitOnce(signal?: AbortSignal): Promise<void> {
    await new Promise<void>((resolve) => {
      const onAbort = (): void => resolve();
      signal?.addEventListener('abort', onAbort, { once: true });
      this._waiters.push(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      });
    });
  }

  private _wake(): void {
    const waiters = this._waiters;
    this._waiters = [];
    for (const wake of waiters) wake();
  }
}

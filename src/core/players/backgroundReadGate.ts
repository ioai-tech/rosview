/**
 * Orders the player's reads on a shared link: background range scans (Plot, Align and Timeline
 * windows, CSV export) run at most `slots` batches at once and none while a foreground read (the
 * frame at the playhead, after an open or a seek) is in progress. A scan's batch reads a chunk or
 * so; without this, every panel's scans queue ahead of the frame the user is waiting for.
 */
export class BackgroundReadGate {
  private _active = 0;
  private _foreground = 0;
  private _waiters: Array<() => void> = [];
  private readonly _slots: number;

  constructor(slots: number) {
    this._slots = slots;
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
   * Waits for a background slot. Resolves to a release function, or to undefined when `signal`
   * aborts first.
   */
  async acquire(signal?: AbortSignal): Promise<(() => void) | undefined> {
    while (this._foreground > 0 || this._active >= this._slots) {
      if (signal?.aborted) return undefined;
      await new Promise<void>((resolve) => {
        const onAbort = (): void => resolve();
        signal?.addEventListener('abort', onAbort, { once: true });
        this._waiters.push(() => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        });
      });
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

  private _wake(): void {
    const waiters = this._waiters;
    this._waiters = [];
    for (const wake of waiters) wake();
  }
}

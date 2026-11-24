/**
 * Stall watchdog clock of an H.264 Image panel: reports a stall when playback has run for
 * `limitMs` without a frame reaching the canvas.
 *
 * Only playing time counts. A paused panel renders nothing by design, so time spent paused is not
 * a stall: without this, pressing play after more than `limitMs` paused reported every H.264
 * panel as stalled at once and asked each one for an extra keyframe repair.
 */
export class H264StallWatch {
  /** Wall clock from which the current stretch without progress is measured. */
  #since: number | null = null;
  #playing = false;
  /** Wall clock of the last pause; null before the first play. */
  #pausedAt: number | null = null;
  #reported = false;

  /** Starts measuring from the first live frame (a no-op once armed). */
  arm(now: number): void {
    this.#since ??= now;
  }

  /** A frame reached the canvas. */
  noteProgress(now: number): void {
    this.#since = now;
    this.#reported = false;
  }

  /** Forget the measurement (decoder reset); the transport state is kept. */
  reset(): void {
    this.#since = null;
    this.#reported = false;
  }

  /** Follows the transport: the clock stops on pause and resumes where it stopped on play. */
  setPlaying(playing: boolean, now: number): void {
    if (playing === this.#playing) return;
    this.#playing = playing;
    if (!playing) {
      this.#pausedAt = now;
      return;
    }
    if (this.#since == null) return;
    // Playing time already spent without progress before the pause (none if progress came later).
    const playedBeforePause = this.#pausedAt == null ? 0 : Math.max(0, this.#pausedAt - this.#since);
    this.#since = now - playedBeforePause;
  }

  /** True once per stall: playing, armed, and `limitMs` of playing time without progress. */
  shouldReport(now: number, limitMs: number): boolean {
    if (this.#since == null || !this.#playing || this.#reported) return false;
    if (now - this.#since < limitMs) return false;
    this.#reported = true;
    return true;
  }
}

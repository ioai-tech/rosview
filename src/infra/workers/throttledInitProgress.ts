import type { SourceInitPhase, SourceInitProgress, SourceInitProgressCallback } from './types';

const DEFAULT_INTERVAL_MS = 100;

/**
 * Coalesce high-frequency download ticks so Comlink callbacks do not flood the
 * main thread. Phase changes always flush immediately.
 */
export function createThrottledInitProgress(
  onProgress: SourceInitProgressCallback | undefined,
  intervalMs = DEFAULT_INTERVAL_MS,
): SourceInitProgressCallback | undefined {
  if (!onProgress) {
    return undefined;
  }
  let lastSentAt = 0;
  let lastPhase: SourceInitPhase | undefined;
  return (progress: SourceInitProgress) => {
    const now = Date.now();
    const phaseChanged = progress.phase !== lastPhase;
    if (!phaseChanged && now - lastSentAt < intervalMs) {
      return;
    }
    lastSentAt = now;
    lastPhase = progress.phase;
    onProgress(progress);
  };
}

/** Remember the last byte counts so phase-only updates keep the current request stats. */
export function trackInitProgress(
  onProgress?: SourceInitProgressCallback,
): (update: Partial<SourceInitProgress> & Pick<SourceInitProgress, 'phase'>) => void {
  const report = createThrottledInitProgress(onProgress);
  let last: SourceInitProgress = { phase: 'connecting', loadedBytes: 0, totalBytes: 0 };
  return (update) => {
    last = { ...last, ...update };
    report?.(last);
  };
}

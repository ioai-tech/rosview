import { useEffect, useRef, useState } from 'react';

const WINDOW_MS = 3000;
const MIN_SAMPLE_MS = 200;

/** Sliding-window bytes/sec from a monotonically increasing (or resetting) byte counter. */
export function useTransferRate(loadedBytes: number | undefined): number | undefined {
  const samplesRef = useRef<Array<{ t: number; bytes: number }>>([]);
  const [bps, setBps] = useState<number | undefined>();

  useEffect(() => {
    if (loadedBytes == null || !Number.isFinite(loadedBytes) || loadedBytes < 0) {
      return;
    }
    const now = performance.now();
    const samples = samplesRef.current;
    const last = samples[samples.length - 1];
    if (last && loadedBytes < last.bytes) {
      samples.length = 0;
    }
    samples.push({ t: now, bytes: loadedBytes });
    const cutoff = now - WINDOW_MS;
    while (samples.length > 1 && samples[0].t < cutoff) {
      samples.shift();
    }
    if (samples.length >= 2) {
      const first = samples[0];
      const latest = samples[samples.length - 1];
      const dt = (latest.t - first.t) / 1000;
      if (dt * 1000 >= MIN_SAMPLE_MS) {
        setBps((latest.bytes - first.bytes) / dt);
      }
    }
  }, [loadedBytes]);

  return bps;
}

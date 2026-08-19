export type EtaUnit = 'seconds' | 'minutes' | 'hours';

export function estimateEtaSeconds(remainingBytes: number, bytesPerSecond: number): number | undefined {
  if (!(bytesPerSecond > 0) || !(remainingBytes > 0) || !Number.isFinite(remainingBytes)) {
    return undefined;
  }
  const seconds = remainingBytes / bytesPerSecond;
  return Number.isFinite(seconds) ? seconds : undefined;
}

export function formatEtaParts(seconds: number): { unit: EtaUnit; n: number } {
  if (seconds < 60) {
    return { unit: 'seconds', n: Math.max(1, Math.round(seconds)) };
  }
  if (seconds < 3600) {
    return { unit: 'minutes', n: Math.max(1, Math.round(seconds / 60)) };
  }
  return { unit: 'hours', n: Math.max(1, Math.round(seconds / 3600)) };
}

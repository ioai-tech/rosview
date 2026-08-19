import { describe, expect, it } from 'vitest';
import { estimateEtaSeconds, formatEtaParts } from './formatEta';

describe('formatEta', () => {
  it('estimates remaining seconds from throughput', () => {
    expect(estimateEtaSeconds(20_000_000, 2_000_000)).toBe(10);
    expect(estimateEtaSeconds(0, 2_000_000)).toBeUndefined();
    expect(estimateEtaSeconds(10, 0)).toBeUndefined();
  });

  it('buckets durations into seconds, minutes, and hours', () => {
    expect(formatEtaParts(20)).toEqual({ unit: 'seconds', n: 20 });
    expect(formatEtaParts(90)).toEqual({ unit: 'minutes', n: 2 });
    expect(formatEtaParts(7200)).toEqual({ unit: 'hours', n: 2 });
  });
});

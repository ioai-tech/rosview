import { describe, expect, it } from 'vitest';
import { findUnsafeIntegerFields } from './unsafeIntegers';

describe('findUnsafeIntegerFields', () => {
  it('reports nested time-like integers above 2^53', () => {
    expect(
      findUnsafeIntegerFields({
        sample_time_ns: 1794223925884797000,
        left: { state: { source_time_ns: 1794223925884440300, position: [1e300] } },
        idx: 3,
      }),
    ).toEqual(['sample_time_ns', 'left.state.source_time_ns']);
  });

  it('ignores safe values, strings, bigints and non time-like keys', () => {
    expect(
      findUnsafeIntegerFields({
        stamp_ns: '1794223925884797015',
        log_time: 1794223925884797015n,
        small_time: 123,
        energy: 1e30,
      }),
    ).toEqual([]);
  });
});

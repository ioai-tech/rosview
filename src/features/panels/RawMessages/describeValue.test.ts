import { describe, expect, it } from 'vitest';
import { describeValue } from './RawMessagesPanel';

describe('describeValue', () => {
  it('shows hex preview for small binary buffers', () => {
    const value = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const visual = describeValue(value, 256);
    expect(visual.text).toBe('Uint8Array(4) 0xdeadbeef');
    expect(visual.kind).toBe('binary');
  });

  it('shows compact hex preview for large binary buffers', () => {
    const value = new Uint8Array(2048);
    value[0] = 0xff;
    value[7] = 0x00;
    const visual = describeValue(value, 256);
    expect(visual.text).toBe(
      'Uint8Array(2048) 0xff00000000000000000000000000000000000000000000000000000000000000...',
    );
  });

  it('shows compact hex preview for image topics regardless of size', () => {
    const value = new Uint8Array(40);
    for (let i = 0; i < value.length; i++) {
      value[i] = i + 1;
    }
    const visual = describeValue(value, 256, { hideBinaryHex: true });
    expect(visual.text).toBe(
      'Uint8Array(40) 0x0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20...',
    );
  });

  it('formats ROS time values', () => {
    const visual = describeValue({ sec: 100, nsec: 500_000_000 }, 256);
    expect(visual.text).toContain('100.500000000');
    expect(visual.kind).toBe('number');
  });

  it('describes Float64Array as an expandable Array(n) preview', () => {
    const visual = describeValue(new Float64Array(16), 256);
    expect(visual.text).toBe('Array(16)');
    expect(visual.kind).toBe('array');
  });

  it('still treats Uint8Array as binary', () => {
    const visual = describeValue(new Uint8Array([0x00, 0x01]), 256);
    expect(visual.kind).toBe('binary');
    expect(visual.text).toBe('Uint8Array(2) 0x0001');
  });
});

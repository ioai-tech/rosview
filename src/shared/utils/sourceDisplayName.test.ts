import { describe, expect, it } from 'vitest';
import { sourceDisplayName } from './sourceDisplayName';

describe('sourceDisplayName', () => {
  it('returns the URL basename and ignores query strings', () => {
    expect(
      sourceDisplayName(
        'https://cdn.example.com/bags/RealMan_PicknPlace.mcap?sign=abc',
      ),
    ).toBe('RealMan_PicknPlace.mcap');
  });

  it('returns the local filename as-is', () => {
    expect(sourceDisplayName('run.mcap')).toBe('run.mcap');
    expect(sourceDisplayName('/tmp/data/run.bag')).toBe('run.bag');
  });
});

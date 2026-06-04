import { describe, expect, it } from 'vitest';
import { diffSeriesTopology, type SeriesSignature } from './usePlotChart';

function sig(key: string, meta = 'l|#000|solid|1', show = true): SeriesSignature {
  return { key, meta, show };
}

describe('diffSeriesTopology', () => {
  it('returns identical when same keys and meta', () => {
    const a = [sig('a'), sig('b')];
    const b = [sig('a'), sig('b')];
    expect(diffSeriesTopology(a, b)).toEqual({ kind: 'identical' });
  });

  it('detects pure tail additions (incremental load case)', () => {
    const a = [sig('a')];
    const b = [sig('a'), sig('b'), sig('c')];
    const diff = diffSeriesTopology(a, b);
    expect(diff.kind).toBe('pureAdd');
    if (diff.kind === 'pureAdd') {
      expect(diff.addedAt).toBe(1);
      expect(diff.added.map((s) => s.key)).toEqual(['b', 'c']);
    }
  });

  it('detects pure tail removal', () => {
    const a = [sig('a'), sig('b'), sig('c')];
    const b = [sig('a')];
    const diff = diffSeriesTopology(a, b);
    expect(diff).toEqual({ kind: 'pureDel', removedFrom: 1, removedCount: 2 });
  });

  it('falls back to remount on reorder', () => {
    const a = [sig('a'), sig('b')];
    const b = [sig('b'), sig('a')];
    expect(diffSeriesTopology(a, b)).toEqual({ kind: 'remount' });
  });

  it('falls back to remount on meta change for same key', () => {
    const a = [sig('a', 'l|#000|solid|1')];
    const b = [sig('a', 'l|#fff|solid|1')];
    expect(diffSeriesTopology(a, b)).toEqual({ kind: 'remount' });
  });

  it('falls back to remount when prefix differs (mixed insertion)', () => {
    const a = [sig('a'), sig('b')];
    const b = [sig('z'), sig('a'), sig('b')];
    expect(diffSeriesTopology(a, b)).toEqual({ kind: 'remount' });
  });

  it('handles empty -> non-empty as pure addition', () => {
    const a: SeriesSignature[] = [];
    const b = [sig('a'), sig('b')];
    expect(diffSeriesTopology(a, b)).toMatchObject({ kind: 'pureAdd', addedAt: 0 });
  });
});

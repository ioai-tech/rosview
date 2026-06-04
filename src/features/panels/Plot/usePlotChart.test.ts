import { describe, expect, it } from 'vitest';
import {
  diffSeriesTopology,
  shouldRemountForIncrementalSeriesUpdate,
  type SeriesSignature,
} from './usePlotChart';

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

  it('returns styleUpdate on meta change for same keys (no remount)', () => {
    const a = [sig('a', 'l|#000|solid|1'), sig('b', 'l|#111|solid|1')];
    const b = [sig('a', 'l|#fff|solid|1'), sig('b', 'l|#111|dashed|2')];
    expect(diffSeriesTopology(a, b)).toEqual({ kind: 'styleUpdate', changed: [0, 1] });
  });

  it('reports only the changed indices in styleUpdate', () => {
    const a = [sig('a', 'l|#000|solid|1'), sig('b', 'l|#111|solid|1')];
    const b = [sig('a', 'l|#000|solid|1'), sig('b', 'l|#111|solid|3')];
    expect(diffSeriesTopology(a, b)).toEqual({ kind: 'styleUpdate', changed: [1] });
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

describe('shouldRemountForIncrementalSeriesUpdate', () => {
  it('remounts when chart Y count does not match signature ref', () => {
    expect(shouldRemountForIncrementalSeriesUpdate(2, 3, { kind: 'pureDel', removedFrom: 1, removedCount: 2 }, 1))
      .toBe(true);
  });

  it('remounts when pureDel would delete more series than chart has', () => {
    expect(shouldRemountForIncrementalSeriesUpdate(2, 2, { kind: 'pureDel', removedFrom: 1, removedCount: 2 }, 1))
      .toBe(true);
  });

  it('allows pureDel when chart and ref are in sync', () => {
    expect(shouldRemountForIncrementalSeriesUpdate(3, 3, { kind: 'pureDel', removedFrom: 1, removedCount: 2 }, 1))
      .toBe(false);
  });

  it('allows pureAdd when chart and ref are in sync', () => {
    expect(shouldRemountForIncrementalSeriesUpdate(1, 1, { kind: 'pureAdd', added: [sig('b')], addedAt: 1 }, 2))
      .toBe(false);
  });
});

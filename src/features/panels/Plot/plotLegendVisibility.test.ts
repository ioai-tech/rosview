import { describe, expect, it } from 'vitest';
import {
  hiddenSeriesIndices,
  isPlotLegendVisible,
  plotLegendSelectionState,
  pruneHiddenLegendKeys,
  setAllPlotLegendVisible,
  setPlotLegendGroupVisible,
  setPlotLegendVisible,
} from './plotLegendVisibility';

describe('plotLegendVisibility', () => {
  const entries = [
    { key: 'a', label: 'A', color: '#111' },
    { key: 'b', label: 'B', color: '#222' },
    { key: 'c', label: 'C', color: '#333' },
  ];

  it('tracks hidden keys and selection state', () => {
    expect(isPlotLegendVisible([], 'a')).toBe(true);
    expect(setPlotLegendVisible([], 'a', false)).toEqual(['a']);
    expect(plotLegendSelectionState(entries, ['b'])).toBe('partial');
    expect(plotLegendSelectionState(entries, [])).toBe('all');
    expect(plotLegendSelectionState(entries, ['a', 'b', 'c'])).toBe('none');
  });

  it('supports toggling all entries from header checkbox', () => {
    expect(setAllPlotLegendVisible(['a', 'b'], true)).toEqual([]);
    expect(setAllPlotLegendVisible(['a', 'b'], false)).toEqual(['a', 'b']);
  });

  it('toggles a legend group without affecting other series keys', () => {
    expect(setPlotLegendGroupVisible(['s1:a', 's2:x'], ['s1:a', 's1:b'], true)).toEqual(['s2:x']);
    expect(setPlotLegendGroupVisible(['s2:x'], ['s1:a', 's1:b'], false)).toEqual([
      's2:x',
      's1:a',
      's1:b',
    ]);
  });

  it('maps hidden keys to chart series indices', () => {
    expect([...hiddenSeriesIndices(entries, ['b'])]).toEqual([1]);
  });

  it('prunes stale hidden keys when legend changes', () => {
    expect(pruneHiddenLegendKeys(['a', 'x'], ['a', 'b'])).toEqual(['a']);
  });
});

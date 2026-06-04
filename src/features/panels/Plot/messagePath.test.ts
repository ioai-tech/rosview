import { describe, expect, it } from 'vitest';
import { extractPlotPathValues, isArrayLikePlotPath } from './messagePath';

describe('extractPlotPathValues', () => {
  it('extracts scalar numeric fields', () => {
    expect(extractPlotPathValues({ data: 1.5 }, 'data')).toEqual([
      { key: 'data', label: 'data', value: 1.5 },
    ]);
  });

  it('extracts Float64MultiArray data slices', () => {
    expect(extractPlotPathValues({ data: [1, 2, 3] }, 'data[:]')).toEqual([
      { key: 'data[0]', label: 'data[0]', value: 1 },
      { key: 'data[1]', label: 'data[1]', value: 2 },
      { key: 'data[2]', label: 'data[2]', value: 3 },
    ]);
  });

  it('supports typed arrays', () => {
    expect(extractPlotPathValues({ data: new Float64Array([4, 5]) }, 'data[:]')).toEqual([
      { key: 'data[0]', label: 'data[0]', value: 4 },
      { key: 'data[1]', label: 'data[1]', value: 5 },
    ]);
  });

  it('maps JointState arrays by name', () => {
    const message = { name: ['shoulder', 'elbow'], position: [0.1, 0.2] };
    expect(extractPlotPathValues(message, 'position[:]')).toEqual([
      { key: 'position[shoulder]', label: 'position[0] (shoulder)', value: 0.1 },
      { key: 'position[elbow]', label: 'position[1] (elbow)', value: 0.2 },
    ]);
    expect(extractPlotPathValues(message, 'position[elbow]')).toEqual([
      { key: 'position[elbow]', label: 'position[1] (elbow)', value: 0.2 },
    ]);
  });

  it('applies math modifiers', () => {
    expect(extractPlotPathValues({ data: -2 }, 'data@abs')).toEqual([
      { key: 'data', label: 'data', value: 2 },
    ]);
  });

  it('extracts multiple comma-separated paths in one series', () => {
    const message = {
      name: ['j0', 'j1', 'j2'],
      position: [0.1, 0.2, 0.3],
      effort: [10, 20, 30],
    };
    expect(extractPlotPathValues(message, 'position[1],position[2],effort[1],effort[2]')).toEqual([
      { key: 'position[1]', label: 'position[1]', value: 0.2 },
      { key: 'position[2]', label: 'position[2]', value: 0.3 },
      { key: 'effort[1]', label: 'effort[1]', value: 20 },
      { key: 'effort[2]', label: 'effort[2]', value: 30 },
    ]);
  });

  it('extracts multiple slice paths separated by spaces', () => {
    const message = { position: [0.1, 0.2], velocity: [3, 4] };
    expect(extractPlotPathValues(message, 'position[:] velocity[:]')).toEqual([
      { key: 'position[0]', label: 'position[0]', value: 0.1 },
      { key: 'position[1]', label: 'position[1]', value: 0.2 },
      { key: 'velocity[0]', label: 'velocity[0]', value: 3 },
      { key: 'velocity[1]', label: 'velocity[1]', value: 4 },
    ]);
  });

  it('uses Foxglove inclusive bounds for bounded slices', () => {
    expect(extractPlotPathValues({ position: [0.1, 0.2, 0.3] }, 'position[1:2]')).toEqual([
      { key: 'position[1]', label: 'position[1]', value: 0.2 },
      { key: 'position[2]', label: 'position[2]', value: 0.3 },
    ]);
    expect(extractPlotPathValues({ data: [1, 2, 3, 4, 5] }, 'data[1:3]')).toEqual([
      { key: 'data[1]', label: 'data[1]', value: 2 },
      { key: 'data[2]', label: 'data[2]', value: 3 },
      { key: 'data[3]', label: 'data[3]', value: 4 },
    ]);
    expect(extractPlotPathValues({ numbers: [3, 5, 7, 9, 10] }, 'numbers[-2:-1]')).toEqual([
      { key: 'numbers[3]', label: 'numbers[3]', value: 9 },
      { key: 'numbers[4]', label: 'numbers[4]', value: 10 },
    ]);
  });

  it('maps inclusive JointState slices by name', () => {
    const message = { name: ['shoulder', 'elbow', 'wrist'], position: [0.1, 0.2, 0.3] };
    expect(extractPlotPathValues(message, 'position[1:2]')).toEqual([
      { key: 'position[elbow]', label: 'position[1] (elbow)', value: 0.2 },
      { key: 'position[wrist]', label: 'position[2] (wrist)', value: 0.3 },
    ]);
  });

  it('supports hyphen slice syntax as an alias for colon slices', () => {
    const message = { position: [0.1, 0.2, 0.3] };
    const colon = extractPlotPathValues(message, 'position[1:2]');
    expect(extractPlotPathValues(message, 'position[1-2]')).toEqual(colon);
    expect(extractPlotPathValues({ numbers: [3, 5, 7, 9, 10] }, 'numbers[-2--1]')).toEqual(
      extractPlotPathValues({ numbers: [3, 5, 7, 9, 10] }, 'numbers[-2:-1]'),
    );
    expect(extractPlotPathValues({ data: [1, 2, 3, 4, 5] }, 'data[2-]')).toEqual(
      extractPlotPathValues({ data: [1, 2, 3, 4, 5] }, 'data[2:]'),
    );
  });
});

describe('isArrayLikePlotPath', () => {
  it('detects [:] slice as array-like', () => {
    expect(isArrayLikePlotPath('position[:]')).toBe(true);
    expect(isArrayLikePlotPath('data[:]')).toBe(true);
  });

  it('detects bounded slice as array-like', () => {
    expect(isArrayLikePlotPath('data[1:5]')).toBe(true);
    expect(isArrayLikePlotPath('data[:5]')).toBe(true);
    expect(isArrayLikePlotPath('data[2:]')).toBe(true);
    expect(isArrayLikePlotPath('position[1-2]')).toBe(true);
    expect(isArrayLikePlotPath('data[2-]')).toBe(true);
  });

  it('treats scalar paths as not array-like', () => {
    expect(isArrayLikePlotPath('data')).toBe(false);
    expect(isArrayLikePlotPath('header.stamp.sec')).toBe(false);
    expect(isArrayLikePlotPath('')).toBe(false);
  });

  it('treats fixed-index paths as not array-like', () => {
    expect(isArrayLikePlotPath('position[0]')).toBe(false);
    expect(isArrayLikePlotPath('position[shoulder]')).toBe(false);
  });

  it('returns true if any subpath in a list is array-like', () => {
    expect(isArrayLikePlotPath('position[0],velocity[:]')).toBe(true);
    expect(isArrayLikePlotPath('position[0],velocity[1]')).toBe(false);
  });

  it('ignores @modifiers', () => {
    expect(isArrayLikePlotPath('data[:]@derivative')).toBe(true);
    expect(isArrayLikePlotPath('data@abs')).toBe(false);
  });
});

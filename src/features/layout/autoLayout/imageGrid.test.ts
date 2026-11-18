import { describe, expect, it } from 'vitest';
import { cameraRank, imageGridColumns, planImageGrid } from './imageGrid';

describe('cameraRank', () => {
  it('ranks head, front, wrist, left, right, rgb/color, others, then depth and ir', () => {
    const names = [
      '/camera/depth/image',
      '/camera/ir/image',
      '/camera/other/image',
      '/camera/color/image',
      '/camera/right/image',
      '/camera/left/image',
      '/camera/wrist/image',
      '/camera/front/image',
      '/camera/head/image',
    ];
    const ordered = [...names].sort((a, b) => cameraRank(a) - cameraRank(b));
    expect(ordered).toEqual([
      '/camera/head/image',
      '/camera/front/image',
      '/camera/wrist/image',
      '/camera/left/image',
      '/camera/right/image',
      '/camera/color/image',
      '/camera/other/image',
      '/camera/depth/image',
      '/camera/ir/image',
    ]);
  });

  it('puts a depth stream after colour even when its path says left', () => {
    expect(cameraRank('/left/depth/image')).toBeGreaterThan(cameraRank('/right/color/image'));
  });
});

describe('planImageGrid', () => {
  it('is 1xn up to three, 2x2 for four, 3x2 for five and six', () => {
    const t = (n: number) => Array.from({ length: n }, (_, i) => `/cam${i}/image`);
    expect(planImageGrid(t(1)).map((r) => r.length)).toEqual([1]);
    expect(planImageGrid(t(3)).map((r) => r.length)).toEqual([3]);
    expect(planImageGrid(t(4)).map((r) => r.length)).toEqual([2, 2]);
    expect(planImageGrid(t(5)).map((r) => r.length)).toEqual([3, 2]);
    expect(planImageGrid(t(6)).map((r) => r.length)).toEqual([3, 3]);
    expect(imageGridColumns(6)).toBe(3);
  });

  it('keeps at most six cameras, dropping depth and ir first', () => {
    const rows = planImageGrid([
      '/a/depth/image',
      '/a/ir/image',
      '/head/image',
      '/front/image',
      '/wrist/image',
      '/left/image',
      '/right/image',
    ]);
    expect(rows.flat()).toHaveLength(6);
    expect(rows.flat()).toContain('/a/depth/image'); // the sixth slot goes to depth, ahead of ir
    expect(rows.flat()).not.toContain('/a/ir/image');
  });

  it('shows a left / right stereo pair side by side in one row', () => {
    const rows = planImageGrid([
      '/cam/head/image_raw/compressed',
      '/cam/left/image_raw/compressed',
      '/cam/right/image_raw/compressed',
      '/cam/belly/image_raw/compressed',
    ]);
    expect(rows).toHaveLength(2);
    const pairRow = rows.find((r) => r.includes('/cam/left/image_raw/compressed'))!;
    const at = pairRow.indexOf('/cam/left/image_raw/compressed');
    expect(pairRow[at + 1]).toBe('/cam/right/image_raw/compressed');
  });

  it('does not split a pair across rows when it would land on a row edge', () => {
    const rows = planImageGrid([
      '/s/head/image',
      '/s/front/image',
      '/s/left/image',
      '/s/right/image',
      '/s/other/image',
    ]);
    const pairRow = rows.find((r) => r.includes('/s/left/image'))!;
    expect(pairRow).toContain('/s/right/image');
    expect(rows.flat()).toHaveLength(5);
  });
});

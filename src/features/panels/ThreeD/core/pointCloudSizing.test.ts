import { describe, expect, it } from 'vitest';
import { MIN_CLOUD_POINT_SIZE, scannedCloudPointSize } from './pointCloudSizing';

function grid(side: number, step: number, z = 0): Float32Array {
  const out = new Float32Array(side * side * 3);
  for (let i = 0; i < side; i += 1) {
    for (let j = 0; j < side; j += 1) {
      const k = (i * side + j) * 3;
      out[k] = i * step;
      out[k + 1] = j * step;
      out[k + 2] = z;
    }
  }
  return out;
}

describe('scannedCloudPointSize', () => {
  it('draws a dense scan at its spacing, below the Point size (m-9)', () => {
    // A floor scanned every 5 mm: 5 cm points would overlap ten deep.
    const floor = grid(400, 0.005);
    const size = scannedCloudPointSize(floor, 400 * 400, 0.05);
    expect(size).toBeGreaterThan(0.004);
    expect(size).toBeLessThan(0.01);
  });

  it('measures a depth frame by the area it covers, not by its bounding box', () => {
    // A tilted 1 m x 1 m patch seen by a depth camera, a point every 4 mm: its bounding box is
    // a metre deep, but the points lie on one surface.
    const side = 250;
    const patch = new Float32Array(side * side * 3);
    for (let i = 0; i < side; i += 1) {
      for (let j = 0; j < side; j += 1) {
        const k = (i * side + j) * 3;
        patch[k] = i * 0.004;
        patch[k + 1] = j * 0.004;
        patch[k + 2] = i * 0.004;
      }
    }
    const size = scannedCloudPointSize(patch, side * side, 0.05);
    expect(size).toBeGreaterThan(0.003);
    expect(size).toBeLessThan(0.01);
  });

  it('keeps the Point size for a sparse cloud', () => {
    // A sweep with a point every 50 cm.
    const sparse = grid(40, 0.5);
    expect(scannedCloudPointSize(sparse, 40 * 40, 0.05)).toBe(0.05);
    // The setting is not capped by the measuring voxel: a sparse cloud may be drawn larger.
    expect(scannedCloudPointSize(sparse, 40 * 40, 0.15)).toBe(0.15);
  });

  it('never goes below the floor, and ignores non-finite points', () => {
    const tiny = grid(100, 1e-6);
    expect(scannedCloudPointSize(tiny, 100 * 100, 0.05)).toBe(MIN_CLOUD_POINT_SIZE);
    const withNaN = new Float32Array([NaN, 0, 0, 0, 0, 0]);
    expect(scannedCloudPointSize(withNaN, 2, 0.05)).toBe(0.05);
    expect(scannedCloudPointSize(new Float32Array(), 0, 0.05)).toBe(0.05);
  });
});

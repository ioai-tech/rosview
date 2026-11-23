/** Smallest point size (m) a cloud is drawn at; the Point size setting's own floor. */
export const MIN_CLOUD_POINT_SIZE = 0.002;
/** Voxel edge (m) at which a cloud's surface area is measured. */
const AREA_VOXEL_M = 0.05;

/**
 * Point size (m) for a cloud: its own point spacing (its points then tile its surfaces without
 * overlapping), never larger than `maxSize` (the panel's Point size) nor smaller than
 * {@link MIN_CLOUD_POINT_SIZE}.
 *
 * The spacing of a scanned cloud is `sqrt(area / count)`, its points lying on surfaces; the area
 * is the number of 5 cm voxels the points occupy times a voxel face. Drawn at a fixed 5 cm, a dense
 * scan (a room map, a depth frame: points millimetres apart) becomes overlapping squares that bury
 * the markers inside it (hand joints of 1.4 cm) and fill the screen once the camera is near. A
 * cloud sparser than the voxel (a lidar sweep: one point per voxel) measures a spacing near the
 * voxel edge and keeps `maxSize`.
 */
export function scannedCloudPointSize(positions: ArrayLike<number>, count: number, maxSize: number): number {
  const occupied = new Set<number>();
  let finite = 0;
  for (let i = 0; i < count; i += 1) {
    const x = positions[i * 3];
    const y = positions[i * 3 + 1];
    const z = positions[i * 3 + 2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    finite += 1;
    const ix = Math.floor(x / AREA_VOXEL_M);
    const iy = Math.floor(y / AREA_VOXEL_M);
    const iz = Math.floor(z / AREA_VOXEL_M);
    occupied.add(((ix * 73_856_093) ^ (iy * 19_349_663) ^ (iz * 83_492_791)) | 0);
  }
  if (finite < 2) return maxSize;
  const spacing = Math.sqrt((occupied.size * AREA_VOXEL_M * AREA_VOXEL_M) / finite);
  // Nearly one point per voxel: the voxel cannot measure the spacing, which is at least its edge.
  if (spacing >= AREA_VOXEL_M * 0.9) return maxSize;
  return Math.max(MIN_CLOUD_POINT_SIZE, Math.min(maxSize, spacing));
}

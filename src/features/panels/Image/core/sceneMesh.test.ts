import { describe, expect, it } from 'vitest';
import {
  inferCameraCalibrationTopic,
  parseDoubleSphereCalibration,
  parseSceneMeshes,
  selectSynchronizedSceneMeshes,
} from './sceneMesh';

describe('scene mesh image overlay messages', () => {
  it('parses indexed triangle meshes from foxglove.SceneUpdate', () => {
    const frame = parseSceneMeshes({
      entities: [{
        id: 'safety-zone',
        frameId: 'warehouse_map',
        timestamp: { sec: 12n, nsec: 34 },
        triangles: [{
          points: [
            { x: 0, y: 0, z: 1 },
            { x: 1, y: 0, z: 1 },
            { x: 0, y: 1, z: 1 },
          ],
          indices: [0, 1, 2],
          color: { r: 0.1, g: 0.2, b: 0.3, a: 0.8 },
        }],
      }],
    });

    expect(frame?.timestampNs).toBe(12_000_000_034n);
    expect(frame?.meshes).toHaveLength(1);
    expect(frame?.meshes[0]?.frameId).toBe('warehouse_map');
    expect(Array.from(frame?.meshes[0]?.indices ?? [])).toEqual([0, 1, 2]);
  });

  it('parses and normalizes Double Sphere camera calibration', () => {
    const calibration = parseDoubleSphereCalibration({
      width: 1280,
      height: 720,
      distortion_model: 'DS',
      D: [640, 641, 639, 359, -0.12, 0.55],
      T_r_c: [1, 2, 3, 0, 0, 0, 2],
    });

    expect(calibration?.intrinsics).toEqual([640, 641, 639, 359, -0.12, 0.55]);
    expect(calibration?.referenceFromCameraTranslation).toEqual([1, 2, 3]);
    expect(calibration?.referenceFromCameraQuaternion).toEqual([0, 0, 0, 1]);
  });

  it('infers the paired camera calibration topic', () => {
    expect(inferCameraCalibrationTopic('/warehouse/front_camera/image/compressed')).toBe(
      '/warehouse/front_camera/camera_info',
    );
  });

  it('selects only a mesh frame within the image sync tolerance', () => {
    const frame = { timestampNs: 1_000_000_000n, meshes: [] };
    expect(selectSynchronizedSceneMeshes([frame], 1_007_000_000n)).toBe(frame);
    expect(selectSynchronizedSceneMeshes([frame], 1_009_000_000n)).toBeNull();
  });
});

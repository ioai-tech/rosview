import * as THREE from 'three';

export const Z_UP = new THREE.Vector3(0, 0, 1);
export const GIZMO_MARGIN: [number, number] = [80, 80];
export const GIZMO_AXIS_COLORS: [string, string, string] = ['#ff3653', '#0adb46', '#2c8fff'];
export const DEFAULT_GRID_SIZE = 20;
export const DEFAULT_GRID_DIVISIONS = 10;
export const CAMERA_GRID_FILL_RATIO = 0.8;
export const CAMERA_VIEW_DIRECTION = new THREE.Vector3(
  Math.cos(Math.PI / 6),
  0,
  Math.sin(Math.PI / 6),
).normalize();

/** +X toward viewer with a slight top-down angle, +Z up — matches framing in `framePerspectiveCameraToGrid`. */
export const CANVAS_CAMERA = {
  position: [10, 0, 6] as [number, number, number],
  up: [0, 0, 1] as [number, number, number],
  fov: 45,
  near: 0.5,
  far: 5000,
};

export const CANVAS_GL = { antialias: true };

export function framePerspectiveCameraToGrid(
  camera: THREE.PerspectiveCamera,
  center: THREE.Vector3,
  gridSize: number,
  fillRatio: number = CAMERA_GRID_FILL_RATIO,
): void {
  const vFov = THREE.MathUtils.degToRad(camera.fov);
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
  const tanHalfV = Math.tan(vFov / 2);
  const tanHalfH = Math.tan(hFov / 2);
  const forward = CAMERA_VIEW_DIRECTION.clone().negate();
  const right = new THREE.Vector3().crossVectors(forward, Z_UP).normalize();
  const up = new THREE.Vector3().crossVectors(right, forward).normalize();
  const halfSize = gridSize / 2;
  const corners = [
    new THREE.Vector3(-halfSize, -halfSize, 0),
    new THREE.Vector3(-halfSize, halfSize, 0),
    new THREE.Vector3(halfSize, -halfSize, 0),
    new THREE.Vector3(halfSize, halfSize, 0),
  ];

  let distance = 0;
  for (const corner of corners) {
    const towardCamera = corner.dot(CAMERA_VIEW_DIRECTION);
    distance = Math.max(
      distance,
      towardCamera + Math.abs(corner.dot(right)) / (tanHalfH * fillRatio),
      towardCamera + Math.abs(corner.dot(up)) / (tanHalfV * fillRatio),
    );
  }

  camera.up.copy(Z_UP);
  camera.position.copy(center).addScaledVector(CAMERA_VIEW_DIRECTION, distance);
  camera.lookAt(center);
  camera.near = Math.max(0.01, distance / 1500);
  camera.far = Math.max(6000, distance * 80);
  camera.updateProjectionMatrix();
}

/**
 * Frame a Z-up perspective camera to a point-cloud AABB so the view looks
 * along ROS +X (forward), matching a depth/color camera "looking ahead".
 * Returns the box center for OrbitControls.target.
 */
/** Behind and slightly above, looking toward ROS +X: a depth camera's view of a cloud. */
export const BOX_VIEW_FROM_BEHIND = new THREE.Vector3(-1, 0, 0.28).normalize();
/**
 * Behind and well above (about 55 degrees down), looking toward +X: markers (a head trajectory,
 * hands over a table) seen over the walls of a room-sized map rather than through them.
 */
export const BOX_VIEW_FROM_ABOVE = new THREE.Vector3(-1, 0, 1.4).normalize();

export function framePerspectiveCameraToBox(
  camera: THREE.PerspectiveCamera,
  box: THREE.Box3,
  fillRatio: number = CAMERA_GRID_FILL_RATIO,
  viewFrom: THREE.Vector3 = BOX_VIEW_FROM_BEHIND,
): THREE.Vector3 {
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const fromCenterToCamera = viewFrom.clone().normalize();
  const forward = fromCenterToCamera.clone().negate();
  const right = new THREE.Vector3().crossVectors(forward, Z_UP).normalize();
  const up = new THREE.Vector3().crossVectors(right, forward).normalize();

  const vFov = THREE.MathUtils.degToRad(camera.fov);
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
  const tanHalfV = Math.tan(vFov / 2);
  const tanHalfH = Math.tan(hFov / 2);

  const half = size.clone().multiplyScalar(0.5);
  const corners = [
    new THREE.Vector3(-half.x, -half.y, -half.z),
    new THREE.Vector3(-half.x, -half.y, half.z),
    new THREE.Vector3(-half.x, half.y, -half.z),
    new THREE.Vector3(-half.x, half.y, half.z),
    new THREE.Vector3(half.x, -half.y, -half.z),
    new THREE.Vector3(half.x, -half.y, half.z),
    new THREE.Vector3(half.x, half.y, -half.z),
    new THREE.Vector3(half.x, half.y, half.z),
  ];

  let distance = 0.5;
  for (const corner of corners) {
    const towardCamera = corner.dot(fromCenterToCamera);
    distance = Math.max(
      distance,
      towardCamera + Math.abs(corner.dot(right)) / (tanHalfH * fillRatio),
      towardCamera + Math.abs(corner.dot(up)) / (tanHalfV * fillRatio),
    );
  }
  // Keep a little padding so near-plane points are not clipped.
  distance = Math.max(distance, size.length() * 0.35 + 0.5);

  camera.up.copy(Z_UP);
  camera.position.copy(center).addScaledVector(fromCenterToCamera, distance);
  camera.lookAt(center);
  camera.near = Math.max(0.01, distance / 1500);
  camera.far = Math.max(6000, distance * 80);
  camera.updateProjectionMatrix();
  return center;
}

/**
 * Grows `box` about its centre so no side is shorter than `minSize` (m). Framing a few small
 * markers (a hand, the start of a trajectory) then keeps a human-scale neighbourhood in view
 * instead of filling the panel with a 10 cm object.
 */
export function expandBoxToMinimumSize(box: THREE.Box3, minSize: number): THREE.Box3 {
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  size.set(Math.max(size.x, minSize), Math.max(size.y, minSize), Math.max(size.z, minSize));
  return box.setFromCenterAndSize(center, size);
}

/** What may frame the 3D panel's default camera. */
export type SceneCameraFitSource = 'markers' | 'cloud';

/**
 * One owner for the default camera of a 3D scene. Markers are what a recording annotates
 * (trajectories, hands, detections) and point clouds are usually its surroundings (a room-sized
 * map), so markers win: a cloud frames the camera only while nothing has, and markers frame it
 * once even after a cloud did. Each source frames it at most once, and once the user moves the
 * camera ({@link SceneCameraFit.yieldToUser}) nothing frames it again: markers that first appear
 * later in the recording never take a camera the user has placed.
 */
export class SceneCameraFit {
  #by: SceneCameraFitSource | 'user' | null = null;

  get by(): SceneCameraFitSource | 'user' | null {
    return this.#by;
  }

  /** The user moved the camera: from now on it is theirs. */
  yieldToUser(): void {
    this.#by = 'user';
  }

  /** True when `source` may frame the camera now; the caller then frames it. */
  claim(source: SceneCameraFitSource): boolean {
    if (this.#by === 'markers' || this.#by === 'user') return false;
    if (source === 'cloud' && this.#by != null) return false;
    this.#by = source;
    return true;
  }
}

import * as THREE from 'three';

/**
 * `visualization_msgs/Marker` / `MarkerArray` → scene primitives in the display (fixed) frame.
 *
 * Each marker is placed with `T_fixed_frameId(stamp) * pose`, as RViz and Foxglove do. When the
 * frame is unknown to the TF tree (no TF in the recording) the marker keeps its raw coordinates,
 * which is the previous behaviour for world-frame markers.
 *
 * Supported types: ARROW (0, as a line), CUBE (1), SPHERE (2), CYLINDER (3),
 * LINE_STRIP (4), LINE_LIST (5), CUBE_LIST (6), SPHERE_LIST (7), POINTS (8). Actions: ADD/MODIFY (0),
 * DELETE (2), DELETEALL (3).
 */

export type Vec3 = [number, number, number];

export type ScenePrimitive =
  | { kind: 'sphere' | 'cube'; key: string; frameIndex?: number; position: Vec3; scale: Vec3; color: string }
  | {
      kind: 'orientedBox';
      key: string;
      frameIndex?: number;
      /** CYLINDER markers: the unit cylinder along z; otherwise the unit box. */
      shape?: 'box' | 'cylinder';
      position: Vec3;
      scale: Vec3;
      quaternion: [number, number, number, number];
      color: string;
    }
  /**
   * `width`: LINE_STRIP / LINE_LIST line width in metres (`scale.x`, 0 when unset), drawn at that
   * world width with a minimum on-screen width. Absent: a one-pixel line (arrows, BVH bones).
   */
  | { kind: 'line'; key: string; frameIndex?: number; points: Vec3[]; color: string; width?: number }
  | { kind: 'segments'; key: string; frameIndex?: number; points: Vec3[]; color: string; width?: number }
  | { kind: 'instances'; key: string; frameIndex?: number; shape: 'sphere' | 'cube'; points: Vec3[]; scale: Vec3; color: string };

export type MarkerUpdate = {
  upserts: ScenePrimitive[];
  /** Keys to remove (DELETE). */
  deletes: string[];
  /** DELETEALL: remove every marker (`null`) or every marker of these namespaces. */
  deleteAll: Array<string | null>;
};

/** Returns the transform from `frameId` at `stampNs` into the fixed frame, or undefined when unknown. */
export type FrameResolver = (frameId: string, stampNs: bigint) => THREE.Matrix4 | undefined;

const ACTION_DELETE = 2;
const ACTION_DELETEALL = 3;

const SCRATCH_POSE = new THREE.Matrix4();
const SCRATCH_FULL = new THREE.Matrix4();
const SCRATCH_POS = new THREE.Vector3();
const SCRATCH_QUAT = new THREE.Quaternion();
const SCRATCH_SCALE = new THREE.Vector3();
const UNIT = new THREE.Vector3(1, 1, 1);

export function stampToNs(stamp: unknown): bigint | undefined {
  if (!stamp || typeof stamp !== 'object') return undefined;
  const s = stamp as Record<string, unknown>;
  const sec = typeof s.sec === 'number' ? s.sec : typeof s.secs === 'number' ? s.secs : undefined;
  const nsec =
    typeof s.nanosec === 'number' ? s.nanosec : typeof s.nsec === 'number' ? s.nsec : typeof s.nsecs === 'number' ? s.nsecs : 0;
  if (sec === undefined) return undefined;
  return BigInt(Math.trunc(sec)) * 1_000_000_000n + BigInt(Math.trunc(nsec));
}

export function headerFrame(message: unknown): { frameId?: string; stampNs?: bigint } {
  if (!message || typeof message !== 'object') return {};
  const header = (message as Record<string, unknown>).header;
  if (!header || typeof header !== 'object') return {};
  const h = header as Record<string, unknown>;
  return {
    frameId: typeof h.frame_id === 'string' && h.frame_id.length > 0 ? h.frame_id : undefined,
    stampNs: stampToNs(h.stamp),
  };
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function readVec(value: unknown): Vec3 | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.x !== 'number' || typeof v.y !== 'number') return null;
  return [v.x, v.y, num(v.z, 0)];
}

function readPose(pose: unknown, out: THREE.Matrix4): void {
  const rec = pose && typeof pose === 'object' ? (pose as Record<string, unknown>) : {};
  const p = readVec(rec.position) ?? [0, 0, 0];
  const o = rec.orientation && typeof rec.orientation === 'object' ? (rec.orientation as Record<string, unknown>) : {};
  SCRATCH_QUAT.set(num(o.x, 0), num(o.y, 0), num(o.z, 0), num(o.w, 1));
  if (SCRATCH_QUAT.lengthSq() < 1e-12) SCRATCH_QUAT.identity();
  SCRATCH_QUAT.normalize();
  out.compose(SCRATCH_POS.set(p[0], p[1], p[2]), SCRATCH_QUAT, UNIT);
}

export function colorToCss(color: unknown, fallback: string): string {
  if (!color || typeof color !== 'object') return fallback;
  const c = color as Record<string, unknown>;
  if (typeof c.r !== 'number' && typeof c.g !== 'number' && typeof c.b !== 'number') return fallback;
  const ch = (v: unknown) => Math.round(Math.max(0, Math.min(1, num(v, 0))) * 255);
  return `rgb(${ch(c.r)}, ${ch(c.g)}, ${ch(c.b)})`;
}

function markerKey(marker: Record<string, unknown>, index: number): { key: string; ns: string } {
  const ns = typeof marker.ns === 'string' ? marker.ns : 'marker';
  const id =
    typeof marker.id === 'number' || typeof marker.id === 'string' || typeof marker.id === 'bigint'
      ? String(marker.id)
      : String(index);
  return { key: `${ns}:${id}`, ns };
}

/** Convert one Marker or MarkerArray message. `topic` namespaces the keys so two topics never collide. */
export function markersToPrimitives(
  message: unknown,
  topic: string,
  fallbackColor: string,
  resolve?: FrameResolver,
): MarkerUpdate {
  const update: MarkerUpdate = { upserts: [], deletes: [], deleteAll: [] };
  if (!message || typeof message !== 'object') return update;
  const rec = message as Record<string, unknown>;
  const list = Array.isArray(rec.markers) ? rec.markers : [message];
  list.forEach((raw, index) => {
    if (!raw || typeof raw !== 'object') return;
    const marker = raw as Record<string, unknown>;
    const { key: localKey, ns } = markerKey(marker, index);
    const key = `${topic}|${localKey}`;
    const action = num(marker.action, 0);
    if (action === ACTION_DELETEALL) {
      update.deleteAll.push(Array.isArray(rec.markers) && typeof marker.ns === 'string' && marker.ns ? `${topic}|${ns}:` : `${topic}|`);
      return;
    }
    if (action === ACTION_DELETE) {
      update.deletes.push(key);
      return;
    }
    const prim = markerToPrimitive(marker, key, fallbackColor, resolve);
    if (prim) update.upserts.push(prim);
  });
  return update;
}

function markerToPrimitive(
  marker: Record<string, unknown>,
  key: string,
  fallbackColor: string,
  resolve?: FrameResolver,
): ScenePrimitive | null {
  const type = num(marker.type, 2);
  const color = colorToCss(marker.color, fallbackColor);
  const rawScale = readVec(marker.scale);
  const scaleVec = rawScale ?? [0.2, 0.2, 0.2];
  // Lines take `scale.x` as given: an unset width is the thinnest visible line, not 20 cm.
  const lineWidth = rawScale && Number.isFinite(rawScale[0]) && rawScale[0] > 0 ? rawScale[0] : 0;
  const scale: Vec3 = [scaleVec[0] > 0 ? scaleVec[0] : 0.2, scaleVec[1] > 0 ? scaleVec[1] : 0.2, scaleVec[2] > 0 ? scaleVec[2] : 0.2];
  const { frameId, stampNs } = headerFrame(marker);
  const frame = frameId && resolve ? resolve(frameId, stampNs ?? 0n) : undefined;
  readPose(marker.pose, SCRATCH_POSE);
  const full = frame ? SCRATCH_FULL.multiplyMatrices(frame, SCRATCH_POSE) : SCRATCH_POSE;
  const toFixed = (p: Vec3): Vec3 => {
    SCRATCH_POS.set(p[0], p[1], p[2]).applyMatrix4(full);
    return [SCRATCH_POS.x, SCRATCH_POS.y, SCRATCH_POS.z];
  };
  const points = Array.isArray(marker.points)
    ? marker.points.map(readVec).filter((p): p is Vec3 => p !== null).map(toFixed)
    : [];

  switch (type) {
    case 4:
      return points.length >= 2 ? { kind: 'line', key, points, color, width: lineWidth } : null;
    case 0:
      return points.length >= 2 ? { kind: 'line', key, points: points.slice(0, 2), color } : null;
    case 5:
      return points.length >= 2
        ? { kind: 'segments', key, points: points.slice(0, points.length - (points.length % 2)), color, width: lineWidth }
        : null;
    case 6:
    case 7:
    case 8:
      if (points.length === 0) return null;
      return {
        kind: 'instances',
        key,
        shape: type === 6 ? 'cube' : 'sphere',
        points,
        scale: type === 8 ? [scale[0], scale[1], scale[0]] : scale,
        color,
      };
    default: {
      full.decompose(SCRATCH_POS, SCRATCH_QUAT, SCRATCH_SCALE);
      const position: Vec3 = [SCRATCH_POS.x, SCRATCH_POS.y, SCRATCH_POS.z];
      if (type === 1 || type === 3) {
        return {
          kind: 'orientedBox',
          key,
          shape: type === 3 ? 'cylinder' : 'box',
          position,
          scale,
          quaternion: [SCRATCH_QUAT.x, SCRATCH_QUAT.y, SCRATCH_QUAT.z, SCRATCH_QUAT.w],
          color,
        };
      }
      return { kind: 'sphere', key, position, scale, color };
    }
  }
}

/** Apply an update to the current primitive map (in place) and return it. */
export function applyMarkerUpdate(current: Map<string, ScenePrimitive>, update: MarkerUpdate): Map<string, ScenePrimitive> {
  for (const prefix of update.deleteAll) {
    for (const key of Array.from(current.keys())) {
      if (prefix === null || key.startsWith(prefix)) current.delete(key);
    }
  }
  for (const key of update.deletes) current.delete(key);
  for (const prim of update.upserts) current.set(prim.key, prim);
  return current;
}

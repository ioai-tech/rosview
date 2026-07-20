export const SCENE_MESH_SYNC_TOLERANCE_NS = 8_000_000n;
const parsedSceneMeshCache = new WeakMap<object, SceneMeshFrame>();


export interface SceneMeshPrimitive {
  id: string;
  frameId: string;
  points: Float32Array;
  indices: Uint32Array;
  color: [number, number, number, number];
}

export interface SceneMeshFrame {
  timestampNs: bigint;
  meshes: SceneMeshPrimitive[];
}

export interface DoubleSphereCalibration {
  width: number;
  height: number;
  intrinsics: [number, number, number, number, number, number];
  referenceFromCameraTranslation: [number, number, number];
  referenceFromCameraQuaternion: [number, number, number, number];
}

export function isSceneUpdateSchema(schemaName: string): boolean {
  const normalized = schemaName.toLowerCase().replaceAll('_', '');
  return normalized.endsWith('sceneupdate');
}

export function inferCameraCalibrationTopic(imageTopic: string): string | null {
  const match = imageTopic.match(/^(.*?)(?:\/image)?\/(?:compressed|image(?:_raw)?)$/i);
  return match ? `${match[1]}/camera_info` : null;
}

export function parseSceneMeshes(
  message: unknown,
  fallbackTimestampNs?: bigint,
): SceneMeshFrame | null {
  if (!isRecord(message) || !Array.isArray(message.entities)) return null;
  const cached = parsedSceneMeshCache.get(message);
  if (cached) return cached;
  const meshes: SceneMeshPrimitive[] = [];
  let timestampNs: bigint | undefined;
  for (const entityValue of message.entities) {
    if (!isRecord(entityValue)) continue;
    const trianglesValue = entityValue.triangles;
    if (!Array.isArray(trianglesValue)) continue;
    const id = readString(entityValue, ['id']) ?? `mesh-${meshes.length}`;
    const frameId = readString(entityValue, ['frame_id', 'frameId']) ?? '';
    timestampNs ??= readTimestampNs(entityValue.timestamp);
    for (let index = 0; index < trianglesValue.length; index += 1) {
      const mesh = parseTrianglePrimitive(
        trianglesValue[index],
        trianglesValue.length === 1 ? id : `${id}-${index}`,
        frameId,
      );
      if (mesh) meshes.push(mesh);
    }
  }
  if (meshes.length === 0) return null;
  timestampNs ??= fallbackTimestampNs;
  if (timestampNs === undefined) return null;
  const frame = { timestampNs, meshes };
  parsedSceneMeshCache.set(message, frame);
  return frame;
}

export function parseDoubleSphereCalibration(message: unknown): DoubleSphereCalibration | null {
  if (!isRecord(message)) return null;
  const width = readNumber(message, ['width']);
  const height = readNumber(message, ['height']);
  const model = readString(message, ['distortion_model', 'distortionModel']);
  const distortion = readNumberArray(message.D ?? message.d);
  const transform = readNumberArray(
    message.T_r_c ?? message.t_r_c ?? message.TRC ?? message.tRC,
  );
  if (
    width === undefined ||
    height === undefined ||
    width <= 0 ||
    height <= 0 ||
    model?.toLowerCase() !== 'ds' ||
    distortion?.length !== 6 ||
    transform?.length !== 7
  ) return null;
  const quaternionNorm = Math.hypot(transform[3], transform[4], transform[5], transform[6]);
  if (!Number.isFinite(quaternionNorm) || quaternionNorm < 1e-9) return null;
  return {
    width,
    height,
    intrinsics: distortion as DoubleSphereCalibration['intrinsics'],
    referenceFromCameraTranslation: [transform[0], transform[1], transform[2]],
    referenceFromCameraQuaternion: [
      transform[3] / quaternionNorm,
      transform[4] / quaternionNorm,
      transform[5] / quaternionNorm,
      transform[6] / quaternionNorm,
    ],
  };
}

export function selectSynchronizedSceneMeshes(
  frames: readonly SceneMeshFrame[],
  imageTimestampNs: bigint,
  toleranceNs = SCENE_MESH_SYNC_TOLERANCE_NS,
): SceneMeshFrame | null {
  let best: SceneMeshFrame | null = null;
  let bestDelta = toleranceNs + 1n;
  for (const frame of frames) {
    const delta = frame.timestampNs >= imageTimestampNs
      ? frame.timestampNs - imageTimestampNs
      : imageTimestampNs - frame.timestampNs;
    if (delta < bestDelta) {
      best = frame;
      bestDelta = delta;
    }
  }
  return bestDelta <= toleranceNs ? best : null;
}

function parseTrianglePrimitive(
  value: unknown,
  id: string,
  frameId: string,
): SceneMeshPrimitive | null {
  if (!isRecord(value) || !Array.isArray(value.points)) return null;
  const pointValues = value.points as unknown[];
  const indicesValue = readNumberArray(value.indices);
  if (!indicesValue || indicesValue.length === 0 || indicesValue.length % 3 !== 0) return null;
  const points = new Float32Array(pointValues.length * 3);
  for (let index = 0; index < pointValues.length; index += 1) {
    const point = pointValues[index];
    if (!isRecord(point)) return null;
    const x = readNumber(point, ['x']);
    const y = readNumber(point, ['y']);
    const z = readNumber(point, ['z']);
    if (x === undefined || y === undefined || z === undefined) return null;
    points[index * 3] = x;
    points[index * 3 + 1] = y;
    points[index * 3 + 2] = z;
  }
  const indices = new Uint32Array(indicesValue.length);
  for (let index = 0; index < indicesValue.length; index += 1) {
    const vertex = indicesValue[index];
    if (!Number.isInteger(vertex) || vertex < 0 || vertex >= pointValues.length) return null;
    indices[index] = vertex;
  }
  const color = parseColor(value.color) ?? [0.3, 0.72, 1, 0.78];
  return { id, frameId, points, indices, color };
}

function parseColor(value: unknown): [number, number, number, number] | null {
  if (!isRecord(value)) return null;
  const r = readNumber(value, ['r']);
  const g = readNumber(value, ['g']);
  const b = readNumber(value, ['b']);
  const a = readNumber(value, ['a']);
  return r === undefined || g === undefined || b === undefined || a === undefined
    ? null
    : [clamp01(r), clamp01(g), clamp01(b), clamp01(a)];
}

function readTimestampNs(value: unknown): bigint | undefined {
  if (!isRecord(value)) return undefined;
  const sec = readBigInt(value.sec ?? value.seconds);
  const nsec = readBigInt(value.nsec ?? value.nanosec ?? value.nanos);
  return sec !== undefined && nsec !== undefined ? sec * 1_000_000_000n + nsec : undefined;
}

function readNumberArray(value: unknown): number[] | null {
  if (!Array.isArray(value) && !ArrayBuffer.isView(value)) return null;
  const values = Array.from(value as ArrayLike<unknown>);
  return values.every(isFiniteNumber) ? values : null;
}

function readString(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string') return value;
  }
  return undefined;
}

function readNumber(record: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (isFiniteNumber(value)) return value;
  }
  return undefined;
}

function readBigInt(value: unknown): bigint | undefined {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  return undefined;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

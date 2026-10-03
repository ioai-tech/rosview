import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Player } from '@/core/types/player';
import type { Time, TopicInfo } from '@/core/types/ros';
import type { MessagePipelineState } from '@/core/pipeline/store';
import { useMessagePipeline } from '@/core/pipeline/useMessagePipeline';
import { messageBus } from '@/core/pipeline/messageBus';
import { scheduleFrame } from '@/shared/utils/rafScheduler';
import type { PointCloudData } from '@/shared/utils/pointCloud';
import { copyToTransferableArrayBuffer } from '@/shared/utils/pointCloud';
import PointCloudParseWorkerClass from './core/PointCloudParse.worker.ts?worker&inline';
import type {
  PointCloudFieldWire,
  PointCloudParseRequest,
  PointCloudParseResponse,
} from './core/pointCloudWorkerProtocol';
import { transformBvhPointToScene } from '@/shared/bvh/coordinates';
import { getScenePanelThemeColors, type ScenePanelThemeColors } from '@/features/panels/common/scenePanelTheme';
import {
  ThreeCanvas,
  createAxesHelper,
  createZUpGrid,
  createZUpLights,
  useSceneObject,
  useThreeCanvas,
} from '@/features/panels/common/threeCanvas';
import {
  CANVAS_CAMERA,
  CANVAS_GL,
  DEFAULT_GRID_DIVISIONS,
  DEFAULT_GRID_SIZE,
  framePerspectiveCameraToBox,
  framePerspectiveCameraToGrid,
  Z_UP,
} from '@/features/panels/common/zUpSceneLayout';
import { extractPathPoints3, readPoseStampedPosition3 } from '@/features/panels/common/poseExtractors';
import * as THREE from 'three';
import { useRosViewTheme } from '@/features/viewer/RosViewProvider';

import {
  applyFramePoses,
  applyJointStates,
  applyTfMessage,
  buildRobotRenderable,
  disposeRobotRenderable,
  type MeshLoadProgress,
  type RobotRenderable,
} from './core/renderables';
import type { JointStateMsg, TFMessage } from './core/types';

import {
  defaultThreeDConfig,
  defaultUrdfSource,
  type ThreeDSkeletonConfig,
  type ThreeDTopicSetting,
  type UrdfSource,
} from './defaults';

interface ThreeDPanelProps {
  player: Player;
  panelId: string;
  showGrid?: boolean;
  showAxes?: boolean;
  showPlaceholder?: boolean;
  pointSize?: number;
  skeleton?: ThreeDSkeletonConfig;
  /** Where to load the URDF document from. When omitted, defaults to `topic` source with auto-detect. */
  urdf?: UrdfSource;
  topicSettings?: ThreeDTopicSetting[];
}

// ── Coordinate-system helpers ──────────────────────────────────────
/** URDF uses meters; grid is ~`DEFAULT_GRID_SIZE` scene units — scale root so a ~2m robot reads ~half the default grid. */
const URDF_ROOT_SCALE_AT_DEFAULT_GRID = 5;
const BVH_AUTOFIT_SAMPLE_INTERVAL = 8;

function toNanoSec(sec: number, nsec: number): bigint {
  return BigInt(sec) * 1_000_000_000n + BigInt(nsec);
}

type ThemeColors = ScenePanelThemeColors;

/** Reused when computing world AABB for oriented bone boxes (single-threaded render path). */
const TMP_BOUNDS_BOX = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
const TMP_BOUNDS_BOX_BOX = new THREE.Box3();
const SHARED_BOX_GEOMETRY = new THREE.BoxGeometry(1, 1, 1);
const SHARED_SPHERE_GEOMETRY = new THREE.SphereGeometry(0.5, 16, 12);

function computeMarkerPrimitivesBoundingBox(primitives: MarkerPrimitive[]): THREE.Box3 | null {
  if (primitives.length === 0) return null;
  const box = new THREE.Box3();
  let has = false;
  const center = new THREE.Vector3();
  const sizeVec = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const v = new THREE.Vector3();

  for (const p of primitives) {
    if (p.kind === 'line') {
      for (const pt of p.points) {
        v.set(pt[0], pt[1], pt[2]);
        if (!has) {
          box.setFromCenterAndSize(v, new THREE.Vector3(1e-4, 1e-4, 1e-4));
          has = true;
        } else {
          box.expandByPoint(v);
        }
      }
      continue;
    }
    if (p.kind === 'orientedBox') {
      TMP_BOUNDS_BOX.position.set(p.position[0], p.position[1], p.position[2]);
      TMP_BOUNDS_BOX.scale.set(p.scale[0], p.scale[1], p.scale[2]);
      quat.set(p.quaternion[0], p.quaternion[1], p.quaternion[2], p.quaternion[3]);
      TMP_BOUNDS_BOX.quaternion.copy(quat);
      TMP_BOUNDS_BOX.updateMatrixWorld(true);
      TMP_BOUNDS_BOX_BOX.setFromObject(TMP_BOUNDS_BOX);
      if (!has) {
        box.copy(TMP_BOUNDS_BOX_BOX);
        has = true;
      } else {
        box.union(TMP_BOUNDS_BOX_BOX);
      }
      continue;
    }
    // Unit sphere geometry uses radius 0.5; unit cube is 1×1×1 — both use mesh `scale` as full axis extents.
    center.set(p.position[0], p.position[1], p.position[2]);
    sizeVec.set(p.scale[0], p.scale[1], p.scale[2]);
    TMP_BOUNDS_BOX_BOX.setFromCenterAndSize(center, sizeVec);
    if (!has) {
      box.copy(TMP_BOUNDS_BOX_BOX);
      has = true;
    } else {
      box.union(TMP_BOUNDS_BOX_BOX);
    }
  }

  if (!has) return null;
  box.expandByScalar(0.02);
  return box;
}

export type BvhGroundLayoutState = {
  size: number;
  divisions: number;
  position: [number, number, number];
};

function roundedTupleKey(tuple: readonly number[]): string {
  return tuple.map((value) => value.toFixed(3)).join(',');
}

export function bvhPrimitiveFrameKey(resetVersion: number, primitives: MarkerPrimitive[]): string {
  const first = primitives[0];
  const last = primitives[primitives.length - 1];
  const parts = [String(resetVersion), String(primitives.length)];
  const frameIndex = primitives.find((primitive) => typeof primitive.frameIndex === 'number')?.frameIndex;
  if (typeof frameIndex === 'number') parts.push(String(frameIndex));
  for (const primitive of [first, last]) {
    if (!primitive) continue;
    parts.push(primitive.key);
    if (primitive.kind === 'line') {
      const firstPoint = primitive.points[0];
      const lastPoint = primitive.points[primitive.points.length - 1];
      if (firstPoint) parts.push(roundedTupleKey(firstPoint));
      if (lastPoint) parts.push(roundedTupleKey(lastPoint));
    } else {
      parts.push(roundedTupleKey(primitive.position));
    }
  }
  return parts.join('|');
}

export function shouldUpdateBvhGroundLayout(
  previous: BvhGroundLayoutState | null,
  next: BvhGroundLayoutState,
): boolean {
  if (!previous) return true;
  if (next.size > previous.size) return true;
  return (
    Math.abs(next.position[0] - previous.position[0]) > 0.05 ||
    Math.abs(next.position[1] - previous.position[1]) > 0.05 ||
    Math.abs(next.position[2] - previous.position[2]) > 0.05
  );
}

export const PLAYBACK_REWIND_CLEAR_POLICY = {
  clearTracks: true,
  clearMarkerPrimitives: true,
  clearSkeletonPrimitives: false,
  clearLaserScanCloud: true,
  clearOccupancyCloud: true,
} as const;

/**
 * First time per `resetVersion` that BVH skeleton primitives exist: frame camera + orbit target,
 * and report ground grid extent so the grid covers the motion volume.
 */
const BvhSceneAutoFit: React.FC<{
  bvhTopic: string | undefined;
  skeletonPrimitives: MarkerPrimitive[];
  resetVersion: number;
  onGroundLayout?: (layout: BvhGroundLayoutState) => void;
}> = ({ bvhTopic, skeletonPrimitives, resetVersion, onGroundLayout }) => {
  const { camera, controls, invalidate } = useThreeCanvas();
  const fittedForResetRef = useRef<number | null>(null);
  const accumulatedBoundsRef = useRef<THREE.Box3 | null>(null);
  const lastGroundLayoutRef = useRef<BvhGroundLayoutState | null>(null);
  const processedFrameKeyRef = useRef<string | null>(null);
  const sampledFrameCountRef = useRef(0);
  const onGroundLayoutRef = useRef(onGroundLayout);

  useEffect(() => {
    onGroundLayoutRef.current = onGroundLayout;
  }, [onGroundLayout]);

  useEffect(() => {
    if (!bvhTopic) {
      fittedForResetRef.current = null;
      accumulatedBoundsRef.current = null;
      lastGroundLayoutRef.current = null;
      processedFrameKeyRef.current = null;
      sampledFrameCountRef.current = 0;
    }
  }, [bvhTopic]);

  useEffect(() => {
    accumulatedBoundsRef.current = null;
    lastGroundLayoutRef.current = null;
    processedFrameKeyRef.current = null;
    sampledFrameCountRef.current = 0;
    fittedForResetRef.current = null;
  }, [resetVersion]);

  useEffect(() => {
    if (!bvhTopic) return;
    const bvhPrims = skeletonPrimitives.filter((p) => p.key.startsWith('bvh:'));
    if (bvhPrims.length === 0) return;
    const frameKey = bvhPrimitiveFrameKey(resetVersion, bvhPrims);
    if (processedFrameKeyRef.current === frameKey) return;

    const needsInitialFit = fittedForResetRef.current !== resetVersion;
    if (!needsInitialFit) {
      sampledFrameCountRef.current += 1;
      if (sampledFrameCountRef.current % BVH_AUTOFIT_SAMPLE_INTERVAL !== 0) return;
    }
    processedFrameKeyRef.current = frameKey;

    const frameBounds = computeMarkerPrimitivesBoundingBox(bvhPrims);
    if (!frameBounds || frameBounds.isEmpty()) return;

    const accumulated = accumulatedBoundsRef.current;
    if (accumulated) {
      accumulated.union(frameBounds);
    } else {
      accumulatedBoundsRef.current = frameBounds.clone();
    }
    const bounds = accumulatedBoundsRef.current!;

    const center = new THREE.Vector3();
    const size = new THREE.Vector3();
    bounds.getCenter(center);
    bounds.getSize(size);

    // Frame the camera once per reset/load so the user keeps manual orbit control afterwards.
    let shouldInvalidate = false;
    if (needsInitialFit) {
      fittedForResetRef.current = resetVersion;
      const xySpan = Math.max(size.x, size.y, 2);
      const gridSize = Math.max(DEFAULT_GRID_SIZE, Math.ceil(xySpan * 1.6));
      const gridCenter = new THREE.Vector3(center.x, center.y, 0);
      framePerspectiveCameraToGrid(camera, gridCenter, gridSize);
      controls.target.copy(gridCenter);
      controls.update();
      shouldInvalidate = true;
    }

    // Grow the ground grid to envelope the full motion volume (never shrink),
    // centered on the running motion XY centroid.
    const xySpan = Math.max(size.x, size.y, 2);
    const desiredSize = Math.max(DEFAULT_GRID_SIZE, Math.ceil(xySpan * 1.6));
    const nextLayout = {
      size: desiredSize,
      divisions: DEFAULT_GRID_DIVISIONS,
      position: [center.x, center.y, 0],
    } satisfies BvhGroundLayoutState;
    if (shouldUpdateBvhGroundLayout(lastGroundLayoutRef.current, nextLayout)) {
      lastGroundLayoutRef.current = nextLayout;
      onGroundLayoutRef.current?.(nextLayout);
      shouldInvalidate = true;
    }

    if (shouldInvalidate) invalidate();
  }, [bvhTopic, skeletonPrimitives, resetVersion, camera, controls, invalidate]);

  return null;
};

// ── Point cloud ────────────────────────────────────────────────────
// Geometry/attributes are reused across frames when the point count is
// unchanged. Rebuilding BufferGeometry every message forced Three.js to
// recompute boundingSphere (full point scan) and made R3F reconcile a new
// object identity each tick.
type PointCloudGpuState = {
  geometry: THREE.BufferGeometry;
  position: THREE.BufferAttribute;
  color: THREE.BufferAttribute | null;
  /** Allocated point capacity (may exceed current drawCount). */
  capacity: number;
  drawCount: number;
};

function disposePointCloudGpu(state: PointCloudGpuState | null): void {
  if (!state) return;
  state.geometry.dispose();
}

function createFrustumCulledOffPoints(
  geometry: THREE.BufferGeometry,
  params: { size: number; color: string; vertexColors: boolean },
): THREE.Points {
  const material = new THREE.PointsMaterial({
    size: params.size,
    sizeAttenuation: true,
    vertexColors: params.vertexColors,
    color: params.vertexColors ? '#ffffff' : params.color,
  });
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  return points;
}

function applyPointsMaterial(
  points: THREE.Points,
  params: { size: number; color: string; vertexColors: boolean },
): void {
  const material = points.material as THREE.PointsMaterial;
  material.size = params.size;
  material.sizeAttenuation = true;
  if (material.vertexColors !== params.vertexColors) {
    material.vertexColors = params.vertexColors;
    material.needsUpdate = true;
  }
  material.color.set(params.vertexColors ? '#ffffff' : params.color);
}

function disposePointsMaterial(points: THREE.Points | null): void {
  if (!points) return;
  const { material } = points;
  if (Array.isArray(material)) {
    for (const entry of material) entry.dispose();
  } else {
    material.dispose();
  }
}

function safeComputeBoundingSphere(geometry: THREE.BufferGeometry): void {
  geometry.computeBoundingSphere();
  const sphere = geometry.boundingSphere;
  if (!sphere || !Number.isFinite(sphere.radius) || sphere.radius < 0) {
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 1);
  }
}

function setAttributeDrawCount(attribute: THREE.BufferAttribute, count: number): void {
  // Three.js typings mark `count` readonly; runtime still honors updates used with setDrawRange.
  (attribute as THREE.BufferAttribute & { count: number }).count = count;
}

function applyPointCloudData(
  prev: PointCloudGpuState | null,
  data: PointCloudData,
): PointCloudGpuState {
  const count = data.count;
  const hasColors = data.colors != undefined && data.colors.length >= count * 3;
  const desiredCapacity = Math.max(data.maxPoints ?? count, count, 1);

  // Reuse GPU buffers whenever the new cloud fits — valid-point count often
  // fluctuates on is_dense=false depth clouds; avoid rebuild every frame.
  if (prev && count <= prev.capacity) {
    prev.position.array.set(data.positions.subarray(0, count * 3));
    setAttributeDrawCount(prev.position, count);
    prev.position.needsUpdate = true;
    if (hasColors) {
      if (prev.color) {
        prev.color.array.set(data.colors!.subarray(0, count * 3));
        setAttributeDrawCount(prev.color, count);
        prev.color.needsUpdate = true;
      } else {
        const colorArray = new Float32Array(prev.capacity * 3);
        colorArray.set(data.colors!.subarray(0, count * 3));
        const colorAttr = new THREE.BufferAttribute(colorArray, 3);
        setAttributeDrawCount(colorAttr, count);
        colorAttr.setUsage(THREE.DynamicDrawUsage);
        prev.geometry.setAttribute('color', colorAttr);
        prev.color = colorAttr;
      }
    } else if (prev.color) {
      prev.geometry.deleteAttribute('color');
      prev.color = null;
    }
    prev.geometry.setDrawRange(0, count);
    prev.drawCount = count;
    return prev;
  }

  disposePointCloudGpu(prev);
  const capacity = desiredCapacity;
  const geometry = new THREE.BufferGeometry();

  const positionArray = new Float32Array(capacity * 3);
  if (count > 0) {
    positionArray.set(data.positions.subarray(0, count * 3));
  }
  const position = new THREE.BufferAttribute(positionArray, 3);
  setAttributeDrawCount(position, count);
  position.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('position', position);

  let color: THREE.BufferAttribute | null = null;
  if (hasColors && count > 0) {
    const colorArray = new Float32Array(capacity * 3);
    colorArray.set(data.colors!.subarray(0, count * 3));
    color = new THREE.BufferAttribute(colorArray, 3);
    setAttributeDrawCount(color, count);
    color.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('color', color);
  }

  geometry.setDrawRange(0, count);
  if (count > 0) {
    safeComputeBoundingSphere(geometry);
  } else {
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 1);
  }
  return { geometry, position, color, capacity, drawCount: count };
}

/** Low-frequency clouds (LaserScan / OccupancyGrid) that arrive via React props. */
const PointCloud = ({ data, color, size }: { data: PointCloudData; color: string; size: number }) => {
  const gpuRef = useRef<PointCloudGpuState | null>(null);
  const pointsRef = useRef<THREE.Points | null>(null);
  const [pointsObject, setPointsObject] = useState<THREE.Points | null>(null);
  const { invalidate } = useThreeCanvas();

  useEffect(() => {
    const next = applyPointCloudData(gpuRef.current, data);
    gpuRef.current = next;
    const vertexColors = next.color != null;
    let points = pointsRef.current;
    if (!points) {
      points = createFrustumCulledOffPoints(next.geometry, { size, color, vertexColors });
      pointsRef.current = points;
      setPointsObject(points);
    } else {
      points.geometry = next.geometry;
      applyPointsMaterial(points, { size, color, vertexColors });
    }
    invalidate();
  }, [color, data, invalidate, size]);

  useEffect(() => {
    return () => {
      disposePointCloudGpu(gpuRef.current);
      gpuRef.current = null;
      disposePointsMaterial(pointsRef.current);
      pointsRef.current = null;
    };
  }, []);

  useSceneObject(pointsObject);
  return null;
};

/**
 * High-frequency PointCloud2 layer. Parsing runs in a dedicated worker;
 * transferable ArrayBuffers come back so the main thread only uploads to GPU.
 * Intermediate frames are coalesced (latest-only) while a parse is in flight.
 */
const LivePointCloudLayer = ({
  player,
  panelId,
  topic,
  color,
  size,
}: {
  player: Player;
  panelId: string;
  topic: string;
  color: string;
  size: number;
}) => {
  const gpuRef = useRef<PointCloudGpuState | null>(null);
  const pointsRef = useRef<THREE.Points | null>(null);
  const [pointsObject, setPointsObject] = useState<THREE.Points | null>(null);
  const { invalidate, camera, controls } = useThreeCanvas();
  const cameraRef = useRef(camera);
  const controlsRef = useRef(controls);
  const invalidateRef = useRef(invalidate);
  const sizeRef = useRef(size);
  const colorRef = useRef(color);
  const workerRef = useRef<Worker | null>(null);
  const nextIdRef = useRef(1);
  const inflightIdRef = useRef<number | null>(null);
  const pendingJobRef = useRef<PointCloudParseRequest | null>(null);
  const didAutofitRef = useRef(false);

  useEffect(() => {
    cameraRef.current = camera;
    controlsRef.current = controls;
    invalidateRef.current = invalidate;
  }, [camera, controls, invalidate]);

  useEffect(() => {
    sizeRef.current = size;
    colorRef.current = color;
  }, [color, size]);

  useEffect(() => {
    didAutofitRef.current = false;
  }, [topic]);

  useEffect(() => {
    const points = pointsRef.current;
    if (!points) return;
    applyPointsMaterial(points, {
      size,
      color,
      vertexColors: (points.material as THREE.PointsMaterial).vertexColors,
    });
    invalidate();
  }, [color, invalidate, size]);

  useEffect(() => {
    const worker = new PointCloudParseWorkerClass();
    workerRef.current = worker;

    const autofitOnce = (geo: THREE.BufferGeometry) => {
      if (didAutofitRef.current) return;
      const cam = cameraRef.current;
      if (!(cam instanceof THREE.PerspectiveCamera)) return;
      safeComputeBoundingSphere(geo);
      const sphere = geo.boundingSphere;
      if (!sphere || !Number.isFinite(sphere.radius) || sphere.radius <= 0) return;
      const box = new THREE.Box3().setFromBufferAttribute(
        geo.getAttribute('position') as THREE.BufferAttribute,
      );
      if (box.isEmpty()) return;
      const target = framePerspectiveCameraToBox(cam, box);
      const oc = controlsRef.current;
      oc.target.copy(target);
      oc.update();
      didAutofitRef.current = true;
    };

    const applyParsed = (
      positions: Float32Array,
      colors: Float32Array | undefined,
      pointCount: number,
      maxPoints: number,
    ) => {
      if (pointCount <= 0) return;
      const parsed: PointCloudData = {
        positions,
        colors,
        count: pointCount,
        maxPoints,
      };
      const next = applyPointCloudData(gpuRef.current, parsed);
      gpuRef.current = next;
      const vertexColors = next.color != null;
      let points = pointsRef.current;
      if (!points) {
        points = createFrustumCulledOffPoints(next.geometry, {
          size: sizeRef.current,
          color: colorRef.current,
          vertexColors,
        });
        pointsRef.current = points;
        setPointsObject(points);
      } else {
        points.geometry = next.geometry;
        applyPointsMaterial(points, {
          size: sizeRef.current,
          color: colorRef.current,
          vertexColors,
        });
      }
      autofitOnce(next.geometry);
      invalidateRef.current();
    };

    const flushPending = () => {
      const pending = pendingJobRef.current;
      if (!pending || inflightIdRef.current != null) {
        return;
      }
      pendingJobRef.current = null;
      inflightIdRef.current = pending.id;
      worker.postMessage(pending, [pending.data]);
    };

    worker.onmessage = (event: MessageEvent<PointCloudParseResponse>) => {
      const response = event.data;
      if (response.id !== inflightIdRef.current) {
        flushPending();
        return;
      }
      inflightIdRef.current = null;
      if (response.type === 'parsed') {
        const positions = new Float32Array(response.positions);
        const colors = response.colors ? new Float32Array(response.colors) : undefined;
        applyParsed(positions, colors, response.pointCount, response.maxPoints);
      }
      flushPending();
    };

    const consumerId = `${panelId}:pointcloud`;
    let cachedFields: PointCloudFieldWire[] | null = null;
    player.registerHighFrequencyConsumer(consumerId, {
      topic,
      lane: 'pointcloud',
      mode: 'latest',
      onLatestMessage: (msg) => {
        const message = msg.message;
        if (!message || typeof message !== 'object') {
          return;
        }
        const record = message as Record<string, unknown>;
        const data = record.data;
        if (!(data instanceof Uint8Array)) {
          return;
        }
        if (!Array.isArray(record.fields) || typeof record.point_step !== 'number') {
          return;
        }
        if (typeof record.width !== 'number' || typeof record.height !== 'number') {
          return;
        }

        if (!cachedFields) {
          const fields: PointCloudFieldWire[] = [];
          for (const field of record.fields) {
            if (!field || typeof field !== 'object') continue;
            const f = field as Record<string, unknown>;
            if (typeof f.name !== 'string' || typeof f.offset !== 'number') continue;
            fields.push({
              name: f.name,
              offset: f.offset,
              datatype: typeof f.datatype === 'number' ? f.datatype : undefined,
            });
          }
          cachedFields = fields;
        }

        const header = record.header;
        const frameId =
          header && typeof header === 'object' && typeof (header as Record<string, unknown>).frame_id === 'string'
            ? ((header as Record<string, unknown>).frame_id as string)
            : undefined;

        const payload = copyToTransferableArrayBuffer(data);
        const id = nextIdRef.current++;
        const job: PointCloudParseRequest = {
          type: 'parse',
          id,
          fields: cachedFields,
          pointStep: record.point_step,
          width: record.width,
          height: record.height,
          isBigendian: record.is_bigendian === true,
          topic,
          frameId,
          data: payload,
        };
        pendingJobRef.current = job;
        if (inflightIdRef.current == null) {
          pendingJobRef.current = null;
          inflightIdRef.current = id;
          worker.postMessage(job, [payload]);
        }
      },
    });

    return () => {
      player.unregisterHighFrequencyConsumer(consumerId);
      worker.onmessage = null;
      worker.terminate();
      workerRef.current = null;
      pendingJobRef.current = null;
      inflightIdRef.current = null;
      disposePointCloudGpu(gpuRef.current);
      gpuRef.current = null;
      disposePointsMaterial(pointsRef.current);
      pointsRef.current = null;
      setPointsObject(null);
    };
  }, [player, panelId, topic]);

  useSceneObject(pointsObject);
  return null;
};

type Simple3DTrack = {
  topic: string;
  color: string;
  points: Array<[number, number, number]>;
  mode: 'path' | 'pose';
};

export type MarkerPrimitive =
  | {
      kind: 'sphere' | 'cube';
      key: string;
      frameIndex?: number;
      position: [number, number, number];
      scale: [number, number, number];
      color: string;
    }
  | {
      kind: 'orientedBox';
      key: string;
      frameIndex?: number;
      position: [number, number, number];
      scale: [number, number, number];
      quaternion: [number, number, number, number];
      color: string;
    }
  | {
      kind: 'line';
      key: string;
      frameIndex?: number;
      points: Array<[number, number, number]>;
      color: string;
    };

const TrackLine: React.FC<{ track: Simple3DTrack }> = ({ track }) => {
  const object = useMemo((): THREE.Object3D | null => {
    if (track.points.length === 0) return null;
    if (track.mode === 'pose') {
      const latest = track.points[track.points.length - 1];
      if (!latest) return null;
      const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(0.08, 16, 12),
        new THREE.MeshStandardMaterial({ color: track.color }),
      );
      mesh.position.set(latest[0], latest[1], latest[2]);
      return mesh;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(track.points.flat(), 3));
    return new THREE.Line(geo, new THREE.LineBasicMaterial({ color: track.color }));
  }, [track.color, track.mode, track.points]);

  useEffect(
    () => () => {
      if (!object) return;
      const disposable = object as THREE.Mesh;
      if (disposable.geometry) disposable.geometry.dispose();
      const material = disposable.material as THREE.Material | THREE.Material[] | undefined;
      if (!material) return;
      if (Array.isArray(material)) {
        for (const entry of material) entry.dispose();
      } else {
        material.dispose();
      }
    },
    [object],
  );

  useSceneObject(object);
  return null;
};

const MarkerLinePrimitiveView: React.FC<{ primitive: Extract<MarkerPrimitive, { kind: 'line' }> }> = React.memo(({ primitive }) => {
  const geometry = useMemo(() => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(primitive.points.flat(), 3));
    return geo;
  }, [primitive.points]);
  const material = useMemo(() => new THREE.LineBasicMaterial({ color: primitive.color }), [primitive.color]);
  const lineObject = useMemo(() => new THREE.Line(geometry, material), [geometry, material]);

  useEffect(
    () => () => {
      geometry.dispose();
    },
    [geometry],
  );
  useEffect(() => () => material.dispose(), [material]);

  useSceneObject(lineObject);
  return null;
});
MarkerLinePrimitiveView.displayName = 'MarkerLinePrimitiveView';

const MeshPrimitiveView: React.FC<{
  primitive: Extract<MarkerPrimitive, { kind: 'sphere' | 'cube' | 'orientedBox' }>;
}> = React.memo(({ primitive }) => {
  const { invalidate } = useThreeCanvas();
  const material = useMemo(
    () => new THREE.MeshStandardMaterial({ color: primitive.color, roughness: 0.58, metalness: 0.04 }),
    [primitive.color],
  );
  const mesh = useMemo(() => {
    const geometry = primitive.kind === 'sphere' ? SHARED_SPHERE_GEOMETRY : SHARED_BOX_GEOMETRY;
    return new THREE.Mesh(geometry, material);
  }, [material, primitive.kind]);

  useEffect(() => () => material.dispose(), [material]);

  useLayoutEffect(() => {
    mesh.position.set(primitive.position[0], primitive.position[1], primitive.position[2]);
    mesh.scale.set(primitive.scale[0], primitive.scale[1], primitive.scale[2]);
    if (primitive.kind === 'orientedBox') {
      mesh.quaternion.set(
        primitive.quaternion[0],
        primitive.quaternion[1],
        primitive.quaternion[2],
        primitive.quaternion[3],
      );
    } else {
      mesh.quaternion.identity();
    }
    invalidate();
  }, [invalidate, mesh, primitive]);

  useSceneObject(mesh);
  return null;
});
MeshPrimitiveView.displayName = 'MeshPrimitiveView';

const MarkerPrimitiveView: React.FC<{ primitive: MarkerPrimitive }> = React.memo(({ primitive }) => {
  if (primitive.kind === 'line') {
    return <MarkerLinePrimitiveView primitive={primitive} />;
  }
  return <MeshPrimitiveView primitive={primitive} />;
});
MarkerPrimitiveView.displayName = 'MarkerPrimitiveView';

function toHexColor(color: unknown, fallback = '#38bdf8'): string {
  if (!color || typeof color !== 'object') return fallback;
  const record = color as Record<string, unknown>;
  const r = typeof record.r === 'number' ? Math.max(0, Math.min(1, record.r)) : 0.22;
  const g = typeof record.g === 'number' ? Math.max(0, Math.min(1, record.g)) : 0.74;
  const b = typeof record.b === 'number' ? Math.max(0, Math.min(1, record.b)) : 0.97;
  return `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`;
}

function markerFieldToString(value: unknown, fallback: string): string {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') {
    return String(value);
  }
  return fallback;
}

function readPoseXYZ(pose: unknown): [number, number, number] | null {
  if (!pose || typeof pose !== 'object') return null;
  const pRec = pose as Record<string, unknown>;
  const position = pRec.position;
  if (
    position &&
    typeof position === 'object' &&
    typeof (position as { x?: unknown }).x === 'number' &&
    typeof (position as { y?: unknown }).y === 'number'
  ) {
    const p = position as { x: number; y: number; z?: unknown };
    return [p.x, p.y, typeof p.z === 'number' ? p.z : 0];
  }
  return null;
}

function extractMarkerPrimitives(message: unknown, fallbackColor: string): MarkerPrimitive[] {
  if (!message || typeof message !== 'object') return [];
  const mrec = message as Record<string, unknown>;
  const list = Array.isArray(mrec.markers) ? mrec.markers : [message];
  const out: MarkerPrimitive[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const marker = raw as Record<string, unknown>;
    const id = markerFieldToString(marker.id, String(out.length));
    const ns = markerFieldToString(marker.ns, 'marker');
    const key = `${ns}:${id}`;
    const color = toHexColor(marker.color, fallbackColor);
    const scaleRaw =
      marker.scale && typeof marker.scale === 'object' ? (marker.scale as Record<string, unknown>) : {};
    const scale: [number, number, number] = [
      typeof scaleRaw.x === 'number' && scaleRaw.x > 0 ? scaleRaw.x : 0.2,
      typeof scaleRaw.y === 'number' && scaleRaw.y > 0 ? scaleRaw.y : 0.2,
      typeof scaleRaw.z === 'number' && scaleRaw.z > 0 ? scaleRaw.z : 0.2,
    ];
    if (marker.type === 4 && Array.isArray(marker.points)) {
      const points = marker.points
        .map((point: unknown) => readPoseStampedPosition3({ position: point }))
        .filter((point): point is [number, number, number] => point != null);
      if (points.length >= 2) {
        out.push({ kind: 'line', key, points, color });
      }
      continue;
    }
    const position = readPoseXYZ(marker.pose) ?? readPoseXYZ({ position: marker.position }) ?? [0, 0, 0];
    const kind: 'sphere' | 'cube' = marker.type === 1 ? 'cube' : 'sphere';
    out.push({ kind, key, position, scale, color });
  }
  return out;
}

function jointRadius(name: string): number {
  if (/Thumb|Index|Middle|Ring|Pinky|InHand/i.test(name)) return 0.018;
  if (/Hand|Foot|Neck|Head/i.test(name)) return 0.035;
  return 0.045;
}

function jointBoxScale(
  joint: { name: string; parentIndex: number },
  joints: Array<{ name: string; parentIndex: number }>,
): [number, number, number] | undefined {
  const parent = joint.parentIndex >= 0 ? joints[joint.parentIndex] : undefined;
  if (joint.name === 'End Site' && /^Head$/i.test(parent?.name ?? '')) return undefined;
  if (/^Head$/i.test(joint.name)) return [0.093, 0.073, 0.1];
  const radius = jointRadius(joint.name);
  if (/Thumb|Index|Middle|Ring|Pinky|InHand/i.test(joint.name)) return [radius * 1.6, radius, radius * 1.1];
  if (/Hand|Foot/i.test(joint.name)) return [radius * 1.8, radius * 1.2, radius * 0.9];
  if (/Shoulder|UpLeg|Hips/i.test(joint.name)) return [radius * 2.0, radius * 1.2, radius * 1.2];
  if (/Spine|Neck/i.test(joint.name)) return [radius * 1.4, radius * 1.2, radius * 1.8];
  return [radius * 1.6, radius * 1.1, radius * 1.2];
}

function boneRadius(childName: string, parentName: string): number {
  const name = `${parentName}:${childName}`;
  if (/Thumb|Index|Middle|Ring|Pinky|InHand/i.test(name)) return 0.012;
  if (/Hand|Foot|Neck|Head/i.test(name)) return 0.03;
  if (/Spine|Hips/i.test(name)) return 0.07;
  return 0.045;
}

function stickmanColor(childName: string, parentName = ''): string {
  const name = `${parentName}:${childName}`;
  if (/Head|Neck/i.test(name)) return '#f8c7a3';
  if (/Thumb|Index|Middle|Ring|Pinky|InHand/i.test(name)) return '#f6d365';
  if (/Right.*(Shoulder|Arm|ForeArm|Hand)/i.test(name)) return '#60a5fa';
  if (/Left.*(Shoulder|Arm|ForeArm|Hand)/i.test(name)) return '#f59e0b';
  if (/Right.*(UpLeg|Leg|Foot)/i.test(name)) return '#f87171';
  if (/Left.*(UpLeg|Leg|Foot)/i.test(name)) return '#34d399';
  if (/Spine|Hips/i.test(name)) return '#a78bfa';
  return '#94a3b8';
}

function makeBoneBoxPrimitive(
  key: string,
  parent: { name: string; position: [number, number, number] },
  child: { name: string; position: [number, number, number] },
  frameIndex?: number,
): MarkerPrimitive | undefined {
  const start = new THREE.Vector3(...parent.position);
  const end = new THREE.Vector3(...child.position);
  const direction = end.clone().sub(start);
  const length = direction.length();
  if (length <= 1e-6) return undefined;
  direction.normalize();
  const midpoint = start.add(end).multiplyScalar(0.5);
  const quaternion = new THREE.Quaternion().setFromUnitVectors(Z_UP, direction);
  const isHeadBox = /^Head$/i.test(parent.name) && child.name === 'End Site';
  const radius = isHeadBox
    ? Math.min(Math.max(length * 0.45, 0.08), 0.14)
    : Math.min(boneRadius(child.name, parent.name), Math.max(length * 0.35, 0.006));
  return {
    kind: 'orientedBox',
    key,
    frameIndex,
    position: [midpoint.x, midpoint.y, midpoint.z],
    scale: [radius, radius, length],
    quaternion: [quaternion.x, quaternion.y, quaternion.z, quaternion.w],
    color: stickmanColor(child.name, parent.name),
  };
}

export function extractBvhSkeletonPrimitives(
  message: unknown,
  skeleton: ThreeDSkeletonConfig,
): MarkerPrimitive[] {
  if (!message || typeof message !== 'object') return [];
  const msg = message as Record<string, unknown>;
  const frameIndex =
    typeof msg.frame_index === 'number' && Number.isFinite(msg.frame_index) ? msg.frame_index : undefined;
  const jointsRaw = msg.joints;
  if (!Array.isArray(jointsRaw)) return [];

  const joints = jointsRaw
    .map((raw) => {
      if (!raw || typeof raw !== 'object') return undefined;
      const rec = raw as Record<string, unknown>;
      const x = Number(rec.x);
      const y = Number(rec.y);
      const z = Number(rec.z);
      const parentIndex = Number(rec.parent_index);
      if (![x, y, z, parentIndex].every((v) => Number.isFinite(v))) return undefined;
      return {
        name: typeof rec.name === 'string' ? rec.name : '',
        position: transformBvhPointToScene([x, y, z], skeleton),
        parentIndex,
      };
    })
    .filter((v): v is { name: string; position: [number, number, number]; parentIndex: number } => v != null);

  const out: MarkerPrimitive[] = [];
  if (skeleton.renderMode === 'stick') {
    const seenJoints = new Set<number>();
    for (let i = 0; i < joints.length; i++) {
      const joint = joints[i];
      if (!joint) continue;
      if (!seenJoints.has(i)) {
        seenJoints.add(i);
        const scale = jointBoxScale(joint, joints);
        if (scale) {
          out.push({
            kind: 'cube',
            key: `bvh:joint:${i}`,
            frameIndex,
            position: joint.position,
            scale,
            color: stickmanColor(joint.name),
          });
        }
      }
      if (joint.parentIndex < 0 || joint.parentIndex >= joints.length) continue;
      const parent = joints[joint.parentIndex];
      if (!parent) continue;
      const bone = makeBoneBoxPrimitive(`bvh:bone:${joint.parentIndex}->${i}`, parent, joint, frameIndex);
      if (bone) out.push(bone);
    }
    return out;
  }

  for (let i = 0; i < joints.length; i++) {
    const joint = joints[i];
    if (!joint) continue;
    if (joint.parentIndex < 0 || joint.parentIndex >= joints.length) continue;
    const parent = joints[joint.parentIndex];
    if (!parent) continue;
    out.push({
      kind: 'line',
      key: `bvh:line:${joint.parentIndex}->${i}`,
      frameIndex,
      points: [parent.position, joint.position],
      color: skeleton.color,
    });
  }
  return out;
}

function extractLaserScanPoints(message: unknown): PointCloudData | null {
  if (!message || typeof message !== 'object') return null;
  const record = message as Record<string, unknown>;
  if (!Array.isArray(record.ranges) || typeof record.angle_min !== 'number' || typeof record.angle_increment !== 'number') {
    return null;
  }
  const positions: number[] = [];
  const rangesList: unknown[] = record.ranges;
  for (let i = 0; i < rangesList.length; i += 1) {
    const range = rangesList[i];
    if (typeof range !== 'number' || !Number.isFinite(range) || range <= 0) continue;
    const angle = record.angle_min + i * record.angle_increment;
    positions.push(Math.cos(angle) * range, Math.sin(angle) * range, 0);
  }
  if (positions.length === 0) return null;
  const positionsArray = new Float32Array(positions);
  return { positions: positionsArray, count: positionsArray.length / 3 };
}

function extractOccupancyGridPoints(message: unknown): PointCloudData | null {
  if (!message || typeof message !== 'object') return null;
  const record = message as Record<string, unknown>;
  const info = record.info;
  if (!info || typeof info !== 'object' || !Array.isArray(record.data)) return null;
  const infoRec = info as Record<string, unknown>;
  const width = typeof infoRec.width === 'number' ? infoRec.width : 0;
  const height = typeof infoRec.height === 'number' ? infoRec.height : 0;
  const resolution = typeof infoRec.resolution === 'number' ? infoRec.resolution : 0;
  if (width <= 0 || height <= 0 || resolution <= 0) return null;
  const origin = readPoseXYZ(infoRec.origin) ?? [0, 0, 0];
  const positions: number[] = [];
  const gridData: unknown[] = record.data;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const idx = y * width + x;
      const value = gridData[idx];
      if (typeof value !== 'number' || value < 50) continue;
      positions.push(origin[0] + x * resolution, origin[1] + y * resolution, origin[2]);
    }
  }
  if (positions.length === 0) return null;
  const positionsArray = new Float32Array(positions);
  return { positions: positionsArray, count: positionsArray.length / 3 };
}

// ── URDF mesh resolution (unchanged) ──────────────────────────────
const warnedMeshUrls = new Set<string>();
const DEFAULT_URDF_RESOURCE_BASE = 'https://assets.embodiflow.com/resources';
const ENV_URDF_RESOURCE_BASE =
  import.meta.env.VITE_ROSVIEW_URDF_PACKAGE_BASE?.trim() ||
  import.meta.env.VITE_ROS_STUDIO_URDF_PACKAGE_BASE?.trim();

function normalizeBase(base: string): string {
  return base.endsWith('/') ? base.slice(0, -1) : base;
}

function dedupeResourcesPrefix(base: string, rawRelativePath: string): string {
  const baseHasResourcesSuffix = /\/resources\/?$/i.test(base);
  if (!baseHasResourcesSuffix) {
    return rawRelativePath;
  }
  return rawRelativePath.replace(/^resources\/+/i, '');
}

function resolveUrdfMeshUrl(rawPath: string): string {
  if (/^https?:\/\//i.test(rawPath)) return rawPath;
  const globalConfig = window as Window & {
    __ROSVIEW_URDF_PACKAGE_BASE__?: string;
    __ROSVIEW_URDF_PACKAGE_BASES__?: Record<string, string>;
    /** @deprecated Use `__ROSVIEW_URDF_PACKAGE_BASE__` */
    __ROS_STUDIO_URDF_PACKAGE_BASE__?: string;
    /** @deprecated Use `__ROSVIEW_URDF_PACKAGE_BASES__` */
    __ROS_STUDIO_URDF_PACKAGE_BASES__?: Record<string, string>;
  };
  const defaultBase = normalizeBase(
    globalConfig.__ROSVIEW_URDF_PACKAGE_BASE__ ||
      globalConfig.__ROS_STUDIO_URDF_PACKAGE_BASE__ ||
      ENV_URDF_RESOURCE_BASE ||
      DEFAULT_URDF_RESOURCE_BASE,
  );

  if (rawPath.startsWith('/')) {
    const absolutePath = rawPath.replace(/^\/+/, '');
    const normalizedPath = dedupeResourcesPrefix(defaultBase, absolutePath);
    return `${defaultBase}/${normalizedPath}`;
  }
  if (!rawPath.startsWith('package://')) return rawPath;

  const packagePath = rawPath.slice('package://'.length);
  const firstSlash = packagePath.indexOf('/');
  const packageName = firstSlash >= 0 ? packagePath.slice(0, firstSlash) : packagePath;
  const insidePackagePath = firstSlash >= 0 ? packagePath.slice(firstSlash + 1) : '';

  const packageBase =
    globalConfig.__ROSVIEW_URDF_PACKAGE_BASES__?.[packageName] ??
    globalConfig.__ROS_STUDIO_URDF_PACKAGE_BASES__?.[packageName];
  if (packageBase) {
    const resolvedBase = normalizeBase(packageBase);
    return insidePackagePath ? `${resolvedBase}/${insidePackagePath}` : resolvedBase;
  }
  return `${defaultBase}/${dedupeResourcesPrefix(defaultBase, packagePath)}`;
}

function warnMeshIssue(meshUrl: string, reason: string): void {
  const key = `${meshUrl}|${reason}`;
  if (warnedMeshUrls.has(key)) return;
  warnedMeshUrls.add(key);
  console.warn(`ROSView 3D: skip mesh ${meshUrl}. ${reason}`);
}

interface RobotProps {
  player: Player;
  urdf: string;
  jointState: JointStateMsg | null;
  tfMessagesRef: React.MutableRefObject<TFMessage[]>;
  tfVersion: number;
  resetVersion: number;
  startTime?: Time;
  urdfRootScale: number;
  fallbackMeshColor: string;
  meshOutlineColor: string;
  onMeshLoadProgressChange?: (progress: MeshLoadProgress | null) => void;
}

// Compact the tf ring buffer when the applied cursor drifts too far from 0.
// We pay an O(N) splice once every `TF_COMPACT_THRESHOLD` applied messages
// instead of letting the array grow unbounded over long playback sessions.
const TF_COMPACT_THRESHOLD = 512;

const RobotComponent: React.FC<RobotProps> = ({
  player,
  urdf,
  jointState,
  tfMessagesRef,
  tfVersion,
  resetVersion,
  startTime,
  urdfRootScale,
  fallbackMeshColor,
  meshOutlineColor,
  onMeshLoadProgressChange,
}) => {
  const [robotModel, setRobotModel] = useState<RobotRenderable | null>(null);
  const appliedTfCountRef = useRef(0);
  const initialPlaybackTimeNs = startTime ? toNanoSec(startTime.sec, startTime.nsec) : 0n;
  const playbackTimeRef = useRef<bigint>(initialPlaybackTimeNs);
  const jointStateRef = useRef<JointStateMsg | null>(jointState);
  const jointStateDirtyRef = useRef(false);
  const applyPendingRef = useRef(false);
  const cancelApplyFrameRef = useRef<(() => void) | null>(null);
  const { invalidate } = useThreeCanvas();
  const scaleGroup = useMemo(() => new THREE.Group(), []);

  useEffect(() => {
    jointStateRef.current = jointState;
  }, [jointState]);

  const schedulePoseApply = useCallback(() => {
    if (!robotModel || applyPendingRef.current) {
      return;
    }
    applyPendingRef.current = true;
    cancelApplyFrameRef.current = scheduleFrame(() => {
      applyPendingRef.current = false;
      cancelApplyFrameRef.current = null;
      if (jointStateDirtyRef.current) {
        jointStateDirtyRef.current = false;
        applyJointStates(robotModel, jointStateRef.current);
      }
      applyFramePoses(robotModel, playbackTimeRef.current);
      invalidate();
    });
  }, [robotModel, invalidate]);

  useEffect(() => {
    playbackTimeRef.current = initialPlaybackTimeNs;
    schedulePoseApply();
  }, [initialPlaybackTimeNs, schedulePoseApply]);

  useEffect(() => {
    return () => {
      cancelApplyFrameRef.current?.();
      cancelApplyFrameRef.current = null;
      applyPendingRef.current = false;
    };
  }, [robotModel]);

  // Subscribe to playback time via ref – no React re-renders are triggered
  // by each tick. Pose writes are flushed through the shared rAF scheduler so
  // time, tf, and joint updates in the same frame coalesce.
  useEffect(() => {
    const unsubscribe = player.subscribeCurrentTime((time: Time) => {
      playbackTimeRef.current =
        BigInt(time.sec) * 1_000_000_000n + BigInt(time.nsec);
      schedulePoseApply();
    });
    return () => {
      unsubscribe();
    };
  }, [player, schedulePoseApply]);

  useEffect(() => {
    let cancelled = false;
    appliedTfCountRef.current = 0;
    onMeshLoadProgressChange?.(null);

    void (async () => {
      try {
        const model = await buildRobotRenderable(urdf, {
          resolveMeshUrl: resolveUrdfMeshUrl,
          warn: warnMeshIssue,
          fallbackMeshColor,
          outlineColor: meshOutlineColor,
          onMeshLoadProgress: (progress) => {
            if (cancelled) return;
            onMeshLoadProgressChange?.(progress);
          },
        });
        if (cancelled) {
          disposeRobotRenderable(model);
          return;
        }
        for (const tfMsg of tfMessagesRef.current) {
          applyTfMessage(model, tfMsg);
          appliedTfCountRef.current += 1;
        }
        applyJointStates(model, jointState);
        applyFramePoses(model, playbackTimeRef.current);
        setRobotModel(model);
        onMeshLoadProgressChange?.(null);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`ROS View 3D: URDF parse failed. ${message}`);
        onMeshLoadProgressChange?.(null);
      }
    })();

    return () => {
      cancelled = true;
      onMeshLoadProgressChange?.(null);
      setRobotModel((current) => {
        disposeRobotRenderable(current);
        return null;
      });
    };
    // jointState is intentionally excluded – it's applied imperatively in the
    // sibling effect. Including it here used to force a full robot rebuild on
    // every joint tick, fetching STL/DAE meshes repeatedly and leaking
    // BufferGeometry buffers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urdf, resetVersion, fallbackMeshColor, meshOutlineColor, onMeshLoadProgressChange]);

  useEffect(() => {
    if (!robotModel) {
      return;
    }

    const arr = tfMessagesRef.current;
    let applied = appliedTfCountRef.current;
    const len = arr.length;
    for (let i = applied; i < len; i++) {
      const tfMsg = arr[i];
      if (tfMsg) applyTfMessage(robotModel, tfMsg);
    }
    applied = len;

    if (applied >= TF_COMPACT_THRESHOLD) {
      arr.splice(0, applied);
      applied = 0;
    }
    appliedTfCountRef.current = applied;

    schedulePoseApply();
  }, [robotModel, tfMessagesRef, tfVersion, schedulePoseApply]);

  useEffect(() => {
    if (!robotModel) {
      return;
    }
    jointStateDirtyRef.current = true;
    schedulePoseApply();
  }, [robotModel, jointState, schedulePoseApply]);

  useLayoutEffect(() => {
    scaleGroup.scale.set(urdfRootScale, urdfRootScale, urdfRootScale);
    invalidate();
  }, [invalidate, scaleGroup, urdfRootScale]);

  useLayoutEffect(() => {
    if (!robotModel) return;
    scaleGroup.add(robotModel.root);
    invalidate();
    return () => {
      scaleGroup.remove(robotModel.root);
      invalidate();
    };
  }, [invalidate, robotModel, scaleGroup]);

  useSceneObject(robotModel ? scaleGroup : null);
  return null;
};

const Robot = React.memo(RobotComponent);

const ThreeDSceneChrome: React.FC<{
  colors: ThemeColors;
  showGrid: boolean;
  showAxes: boolean;
  bvhGroundLayout: BvhGroundLayoutState | null;
}> = ({ colors, showGrid, showAxes, bvhGroundLayout }) => {
  const { scene, invalidate } = useThreeCanvas();

  useLayoutEffect(() => {
    const lights = createZUpLights({ preset: 'full', colors });
    scene.add(lights.object);

    const grid = showGrid
      ? createZUpGrid({
          size: bvhGroundLayout?.size ?? DEFAULT_GRID_SIZE,
          divisions: bvhGroundLayout?.divisions ?? DEFAULT_GRID_DIVISIONS,
          rotationX: Math.PI / 2,
          primary: colors.gridPrimary,
          secondary: colors.gridSecondary,
          position: bvhGroundLayout
            ? new THREE.Vector3(
                bvhGroundLayout.position[0],
                bvhGroundLayout.position[1],
                bvhGroundLayout.position[2],
              )
            : undefined,
        })
      : null;
    if (grid) scene.add(grid.object);

    const axes = showAxes ? createAxesHelper(1) : null;
    if (axes) scene.add(axes.object);

    invalidate();
    return () => {
      scene.remove(lights.object);
      lights.dispose();
      if (grid) {
        scene.remove(grid.object);
        grid.dispose();
      }
      if (axes) {
        scene.remove(axes.object);
        axes.dispose();
      }
      invalidate();
    };
  }, [bvhGroundLayout, colors, invalidate, scene, showAxes, showGrid]);

  return null;
};

const PlaceholderBox: React.FC<{ color: string }> = ({ color }) => {
  const mesh = useMemo(() => {
    const instance = new THREE.Mesh(
      SHARED_BOX_GEOMETRY,
      new THREE.MeshStandardMaterial({ color }),
    );
    instance.position.set(0, 0, 0.5);
    return instance;
  }, [color]);

  useEffect(
    () => () => {
      (mesh.material as THREE.Material).dispose();
    },
    [mesh],
  );

  useSceneObject(mesh);
  return null;
};

// ── Scene ──────────────────────────────────────────────────────────
const Scene = ({
  player,
  panelId,
  colors,
  showGrid,
  showAxes,
  showPlaceholder,
  pointSize,
  skeleton,
  urdf,
  topicSettings,
  onMeshLoadProgressChange,
}: {
  player: Player;
  panelId: string;
  colors: ThemeColors;
  showGrid: boolean;
  showAxes: boolean;
  showPlaceholder: boolean;
  pointSize: number;
  skeleton: ThreeDSkeletonConfig;
  urdf: UrdfSource;
  topicSettings: ThreeDTopicSetting[];
  onMeshLoadProgressChange?: (progress: MeshLoadProgress | null) => void;
}) => {
  const [tracks, setTracks] = useState<Simple3DTrack[]>([]);
  const [markerPrimitives, setMarkerPrimitives] = useState<MarkerPrimitive[]>([]);
  const [skeletonPrimitives, setSkeletonPrimitives] = useState<MarkerPrimitive[]>([]);
  const [laserScanCloud, setLaserScanCloud] = useState<PointCloudData | null>(null);
  const [occupancyCloud, setOccupancyCloud] = useState<PointCloudData | null>(null);
  const [urdfText, setUrdfText] = useState<string | null>(null);
  // Content hash of the current URDF – lets us skip React state updates when
  // a latched `/robot_description` message is re-delivered with identical
  // content (previously caused a full robot rebuild every ~200 ms).
  const urdfTextRef = useRef<string | null>(null);
  const [jointState, setJointState] = useState<JointStateMsg | null>(null);
  const tfMessagesRef = useRef<TFMessage[]>([]);
  const [tfVersion, setTfVersion] = useState(0);
  const [resetVersion, setResetVersion] = useState(0);
  const lastPlaybackTimeNsRef = useRef<bigint>(0n);
  const [bvhGroundLayout, setBvhGroundLayout] = useState<BvhGroundLayoutState | null>(null);
  const handleBvhGroundLayout = useCallback((layout: BvhGroundLayoutState) => {
    setBvhGroundLayout((prev) => {
      if (!prev) return layout;
      // Expand-only: keep larger size and move center to the latest layout, ignore shrinks.
      if (layout.size <= prev.size) return prev;
      return layout;
    });
  }, []);

  const urdfRootScale = useMemo(() => {
    const groundSize = bvhGroundLayout?.size ?? DEFAULT_GRID_SIZE;
    return URDF_ROOT_SCALE_AT_DEFAULT_GRID * (groundSize / DEFAULT_GRID_SIZE);
  }, [bvhGroundLayout]);

  const topics = useMessagePipeline((state: MessagePipelineState) => state.sortedTopics);
  const startTime = useMessagePipeline((state: MessagePipelineState) => state.playerState.activeData?.startTime);

  const pcTopic = useMemo(
    () => topics.find((t: TopicInfo) => t.type.includes('PointCloud2'))?.name,
    [topics],
  );
  const enabledTopicSettings = useMemo(
    () => topicSettings.filter((entry) => entry.enabled && entry.topic.length > 0),
    [topicSettings],
  );

  // Pick the URDF topic to subscribe to. When `urdf.sourceType === 'topic'`:
  //   - an empty `urdf.topic` means auto-detect (legacy behaviour);
  //   - a non-empty value means strictly subscribe to that topic.
  // For non-topic sources we do NOT subscribe to any topic.
  const urdfTopic = useMemo(() => {
    if (urdf.sourceType !== 'topic') return undefined;
    if (urdf.topic && urdf.topic.length > 0) return urdf.topic;
    return topics.find((t: TopicInfo) => t.name.includes('robot_description'))?.name;
  }, [topics, urdf.sourceType, urdf.topic]);

  // URL / file loading: when the source is not `topic`, feed `setUrdfText`
  // directly. `fetch` is aborted when the URL changes so stale responses
  // never overwrite newer ones. The error is surfaced via `console.warn` for
  // now (future work: a scene-level toast).
  const [urdfLoadError, setUrdfLoadError] = useState<string | null>(null);
  useEffect(() => {
    if (urdfLoadError) {
      console.warn(`ROS View 3D: ${urdfLoadError}`);
    }
  }, [urdfLoadError]);

  const jointsTopic = useMemo(
    () => topics.find((t: { type: string }) => t.type === 'sensor_msgs/msg/JointState')?.name,
    [topics],
  );
  const bvhTopic = useMemo(
    () => topics.find((t: TopicInfo) => t.type.includes('BvhSkeletonFrame'))?.name,
    [topics],
  );

  useEffect(() => {
    setBvhGroundLayout(null);
  }, [resetVersion]);

  useEffect(() => {
    if (!bvhTopic) {
      setBvhGroundLayout(null);
    }
  }, [bvhTopic]);

  useEffect(() => {
    // `topic` flows through the message pipeline below; other sources feed
    // the Robot component directly.
    if (urdf.sourceType === 'topic') {
      // Reset any fetched text when switching back to topic mode so that
      // stale URL/file URDFs don't linger.
      if (urdfTextRef.current && !urdfTopic) {
        urdfTextRef.current = null;
        setUrdfText(null);
      }
      setUrdfLoadError(null);
      return;
    }
    if (urdf.sourceType === 'file') {
      const text = urdf.fileContent;
      if (text && text !== urdfTextRef.current) {
        urdfTextRef.current = text;
        setUrdfText(text);
      } else if (!text && urdfTextRef.current) {
        urdfTextRef.current = null;
        setUrdfText(null);
      }
      setUrdfLoadError(null);
      return;
    }
    if (urdf.sourceType === 'url') {
      if (!urdf.url) {
        if (urdfTextRef.current) {
          urdfTextRef.current = null;
          setUrdfText(null);
        }
        setUrdfLoadError(null);
        return;
      }
      const controller = new AbortController();
      setUrdfLoadError(null);
      void (async () => {
        try {
          const response = await fetch(urdf.url, { signal: controller.signal });
          if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
          }
          const text = await response.text();
          if (controller.signal.aborted) return;
          if (text !== urdfTextRef.current) {
            urdfTextRef.current = text;
            setUrdfText(text);
          }
        } catch (error) {
          if (controller.signal.aborted) return;
          const message = error instanceof Error ? error.message : String(error);
          setUrdfLoadError(`Failed to load URDF: ${message}`);
        }
      })();
      return () => controller.abort();
    }
  }, [urdf.sourceType, urdf.topic, urdf.url, urdf.fileContent, urdfTopic]);

  const tfTopics = useMemo(
    () =>
      topics
        .filter(
          (t: TopicInfo) =>
            t.type.includes('TFMessage') ||
            t.type.includes('tf2_msgs') ||
            t.type.includes('tf/tfMessage'),
        )
        .map((t: TopicInfo) => t.name),
    [topics],
  );

  // Register subscriptions for all needed topics
  useEffect(() => {
    const subs: { topic: string; subscriberId: string }[] = [];
    if (urdfTopic) subs.push({ topic: urdfTopic, subscriberId: panelId });
    if (jointsTopic) subs.push({ topic: jointsTopic, subscriberId: panelId });
    if (bvhTopic) subs.push({ topic: bvhTopic, subscriberId: panelId });
    for (const setting of enabledTopicSettings) {
      subs.push({ topic: setting.topic, subscriberId: panelId });
    }
    for (const tf of tfTopics) {
      subs.push({ topic: tf, subscriberId: panelId });
    }

    if (subs.length > 0) {
      player.registerSubscriptions(panelId, subs);
    }
    return () => player.unregisterSubscriptions(panelId);
  }, [player, panelId, urdfTopic, jointsTopic, bvhTopic, enabledTopicSettings, tfTopics]);

  const tfTopicSet = useMemo(() => new Set(tfTopics), [tfTopics]);
  const topicSettingByName = useMemo(
    () => new Map(enabledTopicSettings.map((entry) => [entry.topic, entry])),
    [enabledTopicSettings],
  );

  // Scene only listens to time for rewind/loop detection – Robot has its own
  // ref-based subscription that does NOT re-render the whole scene every tick.
  useEffect(() => {
    return player.subscribeCurrentTime((time) => {
      const timeNs = toNanoSec(time.sec, time.nsec);
      const previous = lastPlaybackTimeNsRef.current;
      const startNs = startTime ? toNanoSec(startTime.sec, startTime.nsec) : undefined;
      const rewoundToStart =
        startNs != undefined && timeNs <= startNs + 5_000_000n && previous > timeNs;
      const jumpedBack = previous > timeNs + 5_000_000n;

      if (rewoundToStart || jumpedBack) {
        tfMessagesRef.current = [];
        setTfVersion(0);
        if (PLAYBACK_REWIND_CLEAR_POLICY.clearTracks) setTracks([]);
        if (PLAYBACK_REWIND_CLEAR_POLICY.clearMarkerPrimitives) setMarkerPrimitives([]);
        if (PLAYBACK_REWIND_CLEAR_POLICY.clearSkeletonPrimitives) setSkeletonPrimitives([]);
        if (PLAYBACK_REWIND_CLEAR_POLICY.clearLaserScanCloud) setLaserScanCloud(null);
        if (PLAYBACK_REWIND_CLEAR_POLICY.clearOccupancyCloud) setOccupancyCloud(null);
        setResetVersion((value) => value + 1);
      }

      lastPlaybackTimeNsRef.current = timeNs;
    });
  }, [player, startTime]);

  const processSubscriberBatch = useCallback(() => {
    const messages = messageBus.getSubscriberMessages(panelId);
    if (!messages || messages.length === 0) return;

    // Collect changes locally and flush to React once per batch so we do not
    // pay N×setState + N×invalidate per tick (was ~40 tf msgs → 40 setStates).
    let nextUrdf: string | undefined;
    let nextJointState: JointStateMsg | undefined;
    let tfAppended = 0;
    const nextTracks = new Map<string, Simple3DTrack>();
    const nextMarkers = new Map<string, MarkerPrimitive>();
    let nextLaser: PointCloudData | undefined;
    let nextOccupancy: PointCloudData | undefined;
    let nextSkeleton: MarkerPrimitive[] | undefined;
    const tfArr = tfMessagesRef.current;

    for (const msg of messages) {
      const payload = msg.message;
      const rec =
        payload !== null && typeof payload === 'object' ? (payload as Record<string, unknown>) : null;

      if (msg.topic === urdfTopic) {
        if (!rec) continue;
        if (typeof rec.data === 'string') nextUrdf = rec.data;
      } else if (msg.topic === jointsTopic) {
        if (!rec) continue;
        const name = rec.name;
        const position = rec.position;
        if (Array.isArray(name) && Array.isArray(position) && name.every((n) => typeof n === 'string')) {
          nextJointState = {
            name: name,
            position: position as number[],
          };
        }
      } else if (msg.topic === bvhTopic) {
        if (skeleton.enabled) {
          nextSkeleton = extractBvhSkeletonPrimitives(payload, skeleton);
        }
      } else if (tfTopicSet.has(msg.topic)) {
        if (!rec) continue;
        if (Array.isArray(rec.transforms)) {
          tfArr.push(payload as TFMessage);
          tfAppended++;
        }
      } else {
        const setting = topicSettingByName.get(msg.topic);
        if (!setting) continue;
        const mode = setting.renderMode;
        if (mode === 'pose' || mode === 'path') {
          const points = extractPathPoints3(payload);
          if (points.length > 0) {
            nextTracks.set(msg.topic, {
              topic: msg.topic,
              color: setting.color,
              points,
              mode,
            });
          }
          continue;
        }
        if (mode === 'skeleton') {
          nextSkeleton = extractBvhSkeletonPrimitives(payload, {
            ...skeleton,
            color: setting.color || skeleton.color,
          });
          continue;
        }
        if (
          mode === 'marker' ||
          (mode === 'auto' &&
            rec &&
            (Array.isArray(rec.markers) || typeof rec.type === 'number'))
        ) {
          const markers = extractMarkerPrimitives(payload, setting.color);
          for (const marker of markers) nextMarkers.set(marker.key, marker);
          continue;
        }
        if (
          mode === 'laserScan' ||
          (mode === 'auto' &&
            rec &&
            Array.isArray(rec.ranges) &&
            typeof rec.angle_increment === 'number')
        ) {
          const cloud = extractLaserScanPoints(payload);
          if (cloud) nextLaser = cloud;
          continue;
        }
        if (
          mode === 'depth' ||
          (mode === 'auto' && rec && Array.isArray(rec.data) && rec.info && typeof rec.info === 'object')
        ) {
          const cloud = extractOccupancyGridPoints(payload);
          if (cloud) nextOccupancy = cloud;
        }
      }
    }

    // Guard against identical URDF re-delivery: the IterablePlayer already
    // filters out same-timestamp latched backfills, but be defensive – some
    // tools publish `/robot_description` as a "periodic" latched topic where
    // the content never changes. Skipping the setState here avoids rebuilding
    // the robot (fetch+parse all meshes) when nothing actually changed.
    if (nextUrdf !== undefined && nextUrdf !== urdfTextRef.current) {
      urdfTextRef.current = nextUrdf;
      setUrdfText(nextUrdf);
    }
    if (nextJointState !== undefined) setJointState(nextJointState);
    if (nextTracks.size > 0) {
      setTracks((prev) => {
        const byTopic = new Map(prev.map((track) => [track.topic, track]));
        for (const [trackTopic, track] of nextTracks) byTopic.set(trackTopic, track);
        return Array.from(byTopic.values());
      });
    }
    if (nextMarkers.size > 0) {
      setMarkerPrimitives((prev) => {
        const byKey = new Map(prev.map((marker) => [marker.key, marker]));
        for (const [key, marker] of nextMarkers) byKey.set(key, marker);
        return Array.from(byKey.values());
      });
    }
    if (nextSkeleton) setSkeletonPrimitives(nextSkeleton);
    if (nextLaser) setLaserScanCloud(nextLaser);
    if (nextOccupancy) setOccupancyCloud(nextOccupancy);
    if (tfAppended > 0) setTfVersion((v) => v + 1);
  }, [panelId, urdfTopic, jointsTopic, bvhTopic, skeleton, tfTopicSet, topicSettingByName]);

  useEffect(() => {
    const unsubscribe = messageBus.subscribeToMessages(panelId, processSubscriberBatch);
    processSubscriberBatch();
    return unsubscribe;
  }, [panelId, processSubscriberBatch]);

  return (
    <>
      <ThreeDSceneChrome
        colors={colors}
        showGrid={showGrid}
        showAxes={showAxes}
        bvhGroundLayout={bvhTopic ? bvhGroundLayout : null}
      />
      <BvhSceneAutoFit
        bvhTopic={bvhTopic}
        skeletonPrimitives={skeletonPrimitives}
        resetVersion={resetVersion}
        onGroundLayout={handleBvhGroundLayout}
      />

      {pcTopic && (
        <LivePointCloudLayer
          player={player}
          panelId={panelId}
          topic={pcTopic}
          color={colors.pointCloudColor}
          size={pointSize}
        />
      )}
      {laserScanCloud && <PointCloud data={laserScanCloud} color="#f97316" size={0.02} />}
      {occupancyCloud && <PointCloud data={occupancyCloud} color="#a855f7" size={0.04} />}
      {tracks.map((track) => (
        <TrackLine key={track.topic} track={track} />
      ))}
      {markerPrimitives.map((primitive) => (
        <MarkerPrimitiveView key={primitive.key} primitive={primitive} />
      ))}
      {skeletonPrimitives.map((primitive) => (
        <MarkerPrimitiveView key={primitive.key} primitive={primitive} />
      ))}
      {urdfText && (
        <Robot
          player={player}
          urdf={urdfText}
          jointState={jointState}
          tfMessagesRef={tfMessagesRef}
          tfVersion={tfVersion}
          resetVersion={resetVersion}
          startTime={startTime}
          urdfRootScale={urdfRootScale}
          fallbackMeshColor={colors.fallbackMeshColor}
          meshOutlineColor={colors.meshOutlineColor}
          onMeshLoadProgressChange={onMeshLoadProgressChange}
        />
      )}

      {showPlaceholder && !pcTopic && !urdfText && skeletonPrimitives.length === 0 && (
        <PlaceholderBox color={colors.placeholderColor} />
      )}
    </>
  );
};

export const ThreeDPanel: React.FC<ThreeDPanelProps> = ({
  player,
  panelId,
  showGrid = true,
  showAxes = false,
  showPlaceholder = true,
  pointSize = 0.05,
  skeleton = defaultThreeDConfig().skeleton,
  urdf,
  topicSettings = [],
}) => {
  const { resolvedTheme } = useRosViewTheme();
  const colors = useMemo(() => getScenePanelThemeColors(resolvedTheme), [resolvedTheme]);
  const resolvedUrdf = urdf ?? defaultUrdfSource();
  const [meshLoadProgress, setMeshLoadProgress] = useState<MeshLoadProgress | null>(null);
  const isMeshLoading =
    meshLoadProgress !== null &&
    meshLoadProgress.total > 0 &&
    meshLoadProgress.loaded < meshLoadProgress.total;
  const meshLoadPercent = isMeshLoading
    ? Math.round((meshLoadProgress.loaded / meshLoadProgress.total) * 100)
    : 0;

  return (
    <div className={`relative h-full w-full overflow-hidden contain-strict ${colors.panelBackgroundClassName}`}>
      <div
        className={`absolute top-2 left-2 z-10 px-2 py-1 rounded text-[10px] font-mono pointer-events-none ${
          isMeshLoading ? 'animate-pulse' : ''
        } ${colors.overlayClassName}`}
      >
        {isMeshLoading
          ? `Loading Mesh ${meshLoadProgress.loaded}/${meshLoadProgress.total} (${meshLoadPercent}%)`
          : '3D View'}
      </div>
      <ThreeCanvas
        shadows
        gl={CANVAS_GL}
        camera={CANVAS_CAMERA}
        autoFrameToGrid
        background={colors.sceneBackground}
        gizmoLabelColor={colors.gizmoLabelColor}
      >
        <Scene
          player={player}
          panelId={panelId}
          colors={colors}
          showGrid={showGrid}
          showAxes={showAxes}
          showPlaceholder={showPlaceholder}
          pointSize={pointSize}
          skeleton={skeleton}
          urdf={resolvedUrdf}
          topicSettings={topicSettings}
          onMeshLoadProgressChange={setMeshLoadProgress}
        />
      </ThreeCanvas>
    </div>
  );
};

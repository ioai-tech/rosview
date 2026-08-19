import * as THREE from 'three';
import { ColladaLoader } from 'three/examples/jsm/loaders/ColladaLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';

import { composeJointTransform, parseUrdf } from './urdf';
import { TransformTree, normalizeFrameId } from './transformTree';
import {
  isSupportedMeshExtension,
  resolveMeshFormat,
  type SupportedMeshExtension,
} from './meshFormat';
import {
  eulerToQuaternion,
  type JointStateMsg,
  type ParsedUrdf,
  type TFMessage,
  type UrdfGeometryMesh,
  type UrdfMaterial,
  type UrdfVisual,
} from './types';

export {
  getMeshExtensionFromPath,
  getMeshExtensionFromUrl,
  isSupportedMeshExtension,
  resolveMeshFormat,
  SUPPORTED_MESH_EXTENSIONS,
  type SupportedMeshExtension,
} from './meshFormat';

export type RobotRenderable = {
  root: THREE.Group;
  parsed: ParsedUrdf;
  transformTree: TransformTree;
  rootFrameId: string | undefined;
  frameObjects: Array<{ frameId: string; object: THREE.Object3D }>;
  hasRealtimeTf: boolean;
  kinematicState: RobotKinematicState;
};

type KinematicFramePose = {
  matrix: THREE.Matrix4;
  position: THREE.Vector3;
  rotation: THREE.Quaternion;
};

type RobotKinematicState = {
  childrenByParent: Map<string, string[]>;
  parentByChild: Map<string, string>;
  localByChild: Map<string, THREE.Matrix4>;
  poseByFrame: Map<string, KinematicFramePose>;
};

const UNIT_SCALE = new THREE.Vector3(1, 1, 1);
const SCRATCH_REL_MATRIX = new THREE.Matrix4();
const SCRATCH_DECOMPOSE_SCALE = new THREE.Vector3(1, 1, 1);

export type MeshLoadProgress = {
  total: number;
  loaded: number;
  failed: number;
};

/** Foxglove-compatible mesh file up-axis (REP-103 scene is always Z-up). */
export type MeshUpAxis = 'y_up' | 'z_up';

export const DEFAULT_MESH_UP_AXIS: MeshUpAxis = 'y_up';

type BuildRobotRenderableOptions = {
  resolveMeshUrl: (rawPath: string) => string;
  warn: (meshUrl: string, reason: string) => void;
  fallbackMeshColor?: string;
  outlineColor?: string;
  meshUpAxis?: MeshUpAxis;
  onMeshLoadProgress?: (progress: MeshLoadProgress) => void;
};

type MeshAsset =
  | { kind: 'stl'; buffer: ArrayBuffer }
  | { kind: 'dae'; text: string }
  | { kind: 'obj'; text: string };

type MeshAssetLoadResult =
  | { ok: true; asset: MeshAsset }
  | { ok: false; reason: string };

const meshAssetCache = new Map<string, Promise<MeshAssetLoadResult>>();
const OUTLINE_NAME = '__ros3d_edge_outline__';
const OUTLINE_THRESHOLD_ANGLE = 30;
const MAX_OUTLINE_TRIANGLE_COUNT = 10_000;
const edgeGeometryCache = new WeakMap<THREE.BufferGeometry, THREE.EdgesGeometry>();

export async function buildRobotRenderable(
  urdfText: string,
  options: BuildRobotRenderableOptions,
): Promise<RobotRenderable> {
  const parsed = parseUrdf(urdfText);
  const transformTree = new TransformTree();
  for (const frameId of parsed.frames) {
    transformTree.addFrame(frameId);
  }
  for (const transform of parsed.transforms) {
    transformTree.addTransform(
      transform.parent,
      transform.child,
      0n,
      transform.translation,
      transform.rotation,
    );
  }

  const root = new THREE.Group();
  const frameObjects: Array<{ frameId: string; object: THREE.Object3D }> = [];
  const totalMeshVisuals = Array.from(parsed.robot.links.values()).reduce((count, link) => {
    return count + link.visuals.filter((visual) => visual.geometry.geometryType === 'mesh').length;
  }, 0);
  let loadedMeshVisuals = 0;
  let failedMeshVisuals = 0;

  if (totalMeshVisuals > 0) {
    options.onMeshLoadProgress?.({
      total: totalMeshVisuals,
      loaded: 0,
      failed: 0,
    });
  }

  for (const link of parsed.robot.links.values()) {
    for (let index = 0; index < link.visuals.length; index += 1) {
      const visual = link.visuals[index];
      const object = await createFrameObject(link.name, visual, parsed, index, options);
      if (visual.geometry.geometryType === 'mesh') {
        loadedMeshVisuals += 1;
        if (!object) {
          failedMeshVisuals += 1;
        }
        options.onMeshLoadProgress?.({
          total: totalMeshVisuals,
          loaded: loadedMeshVisuals,
          failed: failedMeshVisuals,
        });
      }
      if (!object) {
        continue;
      }
      frameObjects.push({ frameId: link.name, object });
      root.add(object);
    }
  }

  const rootFrameId = parsed.robot.links.has('world')
    ? 'world'
    : inferRootFrameId(parsed) ?? parsed.frames[0] ?? parsed.robot.name;

  return {
    root,
    parsed,
    transformTree,
    rootFrameId,
    frameObjects,
    hasRealtimeTf: false,
    kinematicState: buildKinematicState(parsed, rootFrameId),
  };
}

function createFramePose(): KinematicFramePose {
  return {
    matrix: new THREE.Matrix4(),
    position: new THREE.Vector3(),
    rotation: new THREE.Quaternion(),
  };
}

function matrixFromPose(
  translation: { x: number; y: number; z: number },
  rotation: { x: number; y: number; z: number; w: number },
): THREE.Matrix4 {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(translation.x, translation.y, translation.z),
    new THREE.Quaternion(rotation.x, rotation.y, rotation.z, rotation.w),
    UNIT_SCALE,
  );
}

function ensureKinematicPose(
  poseByFrame: Map<string, KinematicFramePose>,
  frameId: string,
): KinematicFramePose {
  const normalized = normalizeFrameId(frameId);
  let pose = poseByFrame.get(normalized);
  if (!pose) {
    pose = createFramePose();
    poseByFrame.set(normalized, pose);
  }
  return pose;
}

function buildKinematicState(parsed: ParsedUrdf, rootFrameId: string | undefined): RobotKinematicState {
  const childrenByParent = new Map<string, string[]>();
  const parentByChild = new Map<string, string>();
  const localByChild = new Map<string, THREE.Matrix4>();
  const poseByFrame = new Map<string, KinematicFramePose>();

  for (const frameId of parsed.frames) {
    ensureKinematicPose(poseByFrame, frameId);
  }
  for (const transform of parsed.transforms) {
    const parent = normalizeFrameId(transform.parent);
    const child = normalizeFrameId(transform.child);
    parentByChild.set(child, parent);
    const children = childrenByParent.get(parent) ?? [];
    children.push(child);
    childrenByParent.set(parent, children);
    localByChild.set(child, matrixFromPose(transform.translation, transform.rotation));
    ensureKinematicPose(poseByFrame, parent);
    ensureKinematicPose(poseByFrame, child);
  }

  const state = { childrenByParent, parentByChild, localByChild, poseByFrame };
  recomputeKinematicPoses(state, rootFrameId, parsed.frames);
  return state;
}

function recomputeKinematicPoses(
  state: RobotKinematicState,
  rootFrameId: string | undefined,
  frames: string[],
): void {
  const visited = new Set<string>();
  const roots = rootFrameId ? [normalizeFrameId(rootFrameId)] : [];
  for (const frameId of frames) {
    const normalized = normalizeFrameId(frameId);
    if (!state.parentByChild.has(normalized) && !roots.includes(normalized)) {
      roots.push(normalized);
    }
  }
  for (const parent of state.childrenByParent.keys()) {
    if (!state.parentByChild.has(parent) && !roots.includes(parent)) {
      roots.push(parent);
    }
  }

  const visit = (frameId: string, parentMatrix?: THREE.Matrix4) => {
    if (visited.has(frameId)) return;
    visited.add(frameId);
    const pose = ensureKinematicPose(state.poseByFrame, frameId);
    const local = state.localByChild.get(frameId);
    if (parentMatrix && local) {
      pose.matrix.multiplyMatrices(parentMatrix, local);
    } else if (local) {
      pose.matrix.copy(local);
    } else {
      pose.matrix.identity();
    }
    pose.matrix.decompose(pose.position, pose.rotation, SCRATCH_DECOMPOSE_SCALE);

    for (const child of state.childrenByParent.get(frameId) ?? []) {
      visit(child, pose.matrix);
    }
  };

  for (const root of roots) {
    visit(root);
  }
}

function resolveDisplayRootFrameId(model: RobotRenderable): string | undefined {
  return (
    model.transformTree.getRootFrameId(model.rootFrameId) ??
    model.rootFrameId ??
    inferRootFrameId(model.parsed) ??
    model.parsed.frames[0]
  );
}

function inferRootFrameId(parsed: ParsedUrdf): string | undefined {
  const childLinks = new Set(Array.from(parsed.robot.joints.values(), (joint) => joint.child));
  for (const link of parsed.robot.links.values()) {
    if (!childLinks.has(link.name)) {
      return link.name;
    }
  }
  return undefined;
}

async function createFrameObject(
  frameId: string,
  visual: UrdfVisual,
  parsed: ParsedUrdf,
  index: number,
  options: BuildRobotRenderableOptions,
): Promise<THREE.Object3D | undefined> {
  const frameObject = new THREE.Group();
  frameObject.name = `${frameId}-${index}-${visual.geometry.geometryType}`;

  const visualGroup = new THREE.Group();
  const visualOrientation = eulerToQuaternion(visual.origin.rpy);
  visualGroup.position.set(visual.origin.xyz.x, visual.origin.xyz.y, visual.origin.xyz.z);
  visualGroup.quaternion.set(
    visualOrientation.x,
    visualOrientation.y,
    visualOrientation.z,
    visualOrientation.w,
  );

  const geometryObject = await createVisualObject(visual, parsed, options);
  if (!geometryObject) {
    return undefined;
  }

  visualGroup.add(geometryObject);
  frameObject.add(visualGroup);
  return frameObject;
}

async function createVisualObject(
  visual: UrdfVisual,
  parsed: ParsedUrdf,
  options: BuildRobotRenderableOptions,
): Promise<THREE.Object3D | undefined> {
  const color =
    getMaterialColor(visual.material, parsed) ??
    new THREE.Color(options.fallbackMeshColor ?? '#94a3b8');

  switch (visual.geometry.geometryType) {
    case 'box': {
      const { size } = visual.geometry;
      const geometry = new THREE.BoxGeometry(size.x, size.y, size.z);
      return makeLitMesh(geometry, color);
    }
    case 'sphere': {
      const geometry = new THREE.SphereGeometry(visual.geometry.radius, 24, 16);
      return makeLitMesh(geometry, color);
    }
    case 'cylinder': {
      const geometry = new THREE.CylinderGeometry(
        visual.geometry.radius,
        visual.geometry.radius,
        visual.geometry.length,
        24,
      );
      const mesh = makeLitMesh(geometry, color);
      mesh.rotateX(Math.PI / 2);
      return mesh;
    }
    case 'mesh':
      return await loadMeshObject(visual, color, options);
    default:
      return undefined;
  }
}

function makeLitMesh(geometry: THREE.BufferGeometry, color: THREE.Color): THREE.Mesh {
  const material = createFallbackMeshMaterial(color);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function createFallbackMeshMaterial(color: THREE.Color): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color,
    metalness: 0.08,
    roughness: 0.55,
    envMapIntensity: 0.25,
  });
}

function hasTextureMaterial(material: THREE.Material): boolean {
  const candidate = material as THREE.MeshStandardMaterial;
  return Boolean(candidate.map || candidate.normalMap || candidate.roughnessMap || candidate.metalnessMap);
}

function ensureMeshNormals(geometry: THREE.BufferGeometry): void {
  if (!geometry.getAttribute('normal')) {
    geometry.computeVertexNormals();
  }
  geometry.normalizeNormals();
}

function getGeometryTriangleCount(geometry: THREE.BufferGeometry): number {
  const indexCount = geometry.getIndex()?.count;
  if (indexCount != undefined) {
    return Math.ceil(indexCount / 3);
  }
  return Math.ceil((geometry.getAttribute('position')?.count ?? 0) / 3);
}

function getOutlineGeometry(geometry: THREE.BufferGeometry): THREE.EdgesGeometry | undefined {
  if (getGeometryTriangleCount(geometry) > MAX_OUTLINE_TRIANGLE_COUNT) {
    return undefined;
  }
  let edgeGeometry = edgeGeometryCache.get(geometry);
  if (!edgeGeometry) {
    edgeGeometry = new THREE.EdgesGeometry(geometry, OUTLINE_THRESHOLD_ANGLE);
    edgeGeometryCache.set(geometry, edgeGeometry);
  }
  return edgeGeometry;
}

function attachMeshOutline(mesh: THREE.Mesh, outlineColor: string): void {
  if (mesh.children.some((child) => child.name === OUTLINE_NAME)) {
    return;
  }
  const edgeGeometry = getOutlineGeometry(mesh.geometry);
  if (!edgeGeometry) {
    return;
  }
  const edgeMaterial = new THREE.LineBasicMaterial({
    color: outlineColor,
    transparent: true,
    opacity: 0.35,
    depthTest: true,
    depthWrite: false,
    toneMapped: false,
  });
  const edgeLines = new THREE.LineSegments(edgeGeometry, edgeMaterial);
  edgeLines.name = OUTLINE_NAME;
  edgeLines.renderOrder = 1;
  mesh.add(edgeLines);
}

async function loadMeshObject(
  visual: UrdfVisual,
  color: THREE.Color,
  options: BuildRobotRenderableOptions,
): Promise<THREE.Object3D | undefined> {
  const geometry = visual.geometry as UrdfGeometryMesh;
  const sourcePath = geometry.filename;
  const meshUrl = options.resolveMeshUrl(sourcePath);
  const format = resolveMeshFormat(sourcePath, meshUrl);

  const asset = await loadMeshAsset(meshUrl, format);
  if (asset.ok === false) {
    options.warn(meshUrl, `${asset.reason} (source: ${sourcePath})`);
    return undefined;
  }

  try {
    let object: THREE.Object3D | undefined;
    if (asset.asset.kind === 'stl') {
      object = loadStl(asset.asset.buffer, color, options.meshUpAxis ?? DEFAULT_MESH_UP_AXIS);
    } else if (asset.asset.kind === 'obj') {
      object = loadObj(asset.asset.text, color, options.meshUpAxis ?? DEFAULT_MESH_UP_AXIS);
    } else {
      object = loadCollada(asset.asset.text, meshUrl, options.meshUpAxis ?? DEFAULT_MESH_UP_AXIS);
    }
    if (geometry.scale) {
      object.scale.set(geometry.scale.x, geometry.scale.y, geometry.scale.z);
    }

    object.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) {
        return;
      }
      if (mesh.geometry) {
        ensureMeshNormals(mesh.geometry);
      }
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      let usedFallbackMaterial = false;
      let hasTexturedMaterial = false;
      if (Array.isArray(mesh.material)) {
        return;
      }
      if (!mesh.material || mesh.material instanceof THREE.MeshBasicMaterial) {
        mesh.material = createFallbackMeshMaterial(color);
        usedFallbackMaterial = true;
      } else {
        hasTexturedMaterial = hasTextureMaterial(mesh.material);
      }
      if (
        asset.asset.kind === 'stl' ||
        asset.asset.kind === 'obj' ||
        (usedFallbackMaterial && !hasTexturedMaterial)
      ) {
        attachMeshOutline(mesh, options.outlineColor ?? '#94a3b8');
      }
    });

    return object;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    options.warn(meshUrl, reason);
    return undefined;
  }
}

async function loadMeshAsset(
  meshUrl: string,
  format: SupportedMeshExtension | undefined,
): Promise<MeshAssetLoadResult> {
  let cached = meshAssetCache.get(meshUrl);
  if (!cached) {
    cached = (async () => {
      if (!isSupportedMeshExtension(format)) {
        return {
          ok: false,
          reason: `unsupported mesh format: ${format ?? 'unknown'}`,
        } satisfies MeshAssetLoadResult;
      }
      try {
        const response = await fetch(meshUrl);
        if (!response.ok) {
          throw new Error(`${response.status} ${response.statusText}`);
        }
        if (format === 'stl') {
          return { ok: true, asset: { kind: 'stl', buffer: await response.arrayBuffer() } } satisfies MeshAssetLoadResult;
        }
        if (format === 'obj') {
          return { ok: true, asset: { kind: 'obj', text: await response.text() } } satisfies MeshAssetLoadResult;
        }
        return { ok: true, asset: { kind: 'dae', text: await response.text() } } satisfies MeshAssetLoadResult;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return { ok: false, reason } satisfies MeshAssetLoadResult;
      }
    })();
    meshAssetCache.set(meshUrl, cached);
  }
  return await cached;
}

function loadStl(buffer: ArrayBuffer, color: THREE.Color, meshUpAxis: MeshUpAxis): THREE.Object3D {
  const geometry = new STLLoader().parse(buffer);
  const mesh = makeLitMesh(geometry, color);
  const group = new THREE.Group();
  group.add(mesh);
  if (meshUpAxis === 'y_up') {
    group.rotateX(Math.PI / 2);
  }
  return group;
}

function loadObj(text: string, color: THREE.Color, meshUpAxis: MeshUpAxis): THREE.Object3D {
  const object = new OBJLoader().parse(text);
  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) {
      return;
    }
    if (!mesh.material || mesh.material instanceof THREE.MeshBasicMaterial) {
      mesh.material = createFallbackMeshMaterial(color);
    }
  });
  if (meshUpAxis === 'y_up') {
    object.rotateX(Math.PI / 2);
  }
  return object;
}

function loadCollada(text: string, meshUrl: string, meshUpAxis: MeshUpAxis): THREE.Object3D {
  const xml = new DOMParser().parseFromString(text, 'application/xml');
  const upAxis = (xml.querySelector('up_axis')?.textContent ?? 'Y_UP').trim().toUpperCase();
  const collada = new ColladaLoader().parse(xml.documentElement.outerHTML, meshUrl);
  if (!collada) {
    throw new Error(`Failed to parse Collada mesh: ${meshUrl}`);
  }
  if (meshUpAxis === 'y_up' && upAxis === 'Y_UP') {
    collada.scene.rotateX(Math.PI / 2);
  }
  return collada.scene;
}

function getMaterialColor(
  material: UrdfMaterial | undefined,
  parsed: ParsedUrdf,
): THREE.Color | undefined {
  const directColor = material?.color;
  if (directColor) {
    return new THREE.Color(directColor.r, directColor.g, directColor.b);
  }

  if (material?.name) {
    const namedMaterial = parsed.robot.materials.get(material.name);
    if (namedMaterial?.color) {
      return new THREE.Color(namedMaterial.color.r, namedMaterial.color.g, namedMaterial.color.b);
    }
  }
  return undefined;
}

export function applyTfMessage(model: RobotRenderable, tfMsg: TFMessage): void {
  for (const transform of tfMsg.transforms) {
    const parent = normalizeFrameId(transform.header.frame_id);
    const child = normalizeFrameId(transform.child_frame_id);
    const stamp = BigInt(transform.header.stamp.sec) * 1_000_000_000n + BigInt(transform.header.stamp.nsec);
    model.transformTree.addTransform(
      parent,
      child,
      stamp,
      transform.transform.translation,
      transform.transform.rotation,
    );
    model.hasRealtimeTf = true;
  }
}

export function applyJointStates(model: RobotRenderable, jointState: JointStateMsg | null): number {
  if (!jointState || model.hasRealtimeTf) {
    return 0;
  }

  let applied = 0;
  for (let index = 0; index < jointState.name.length; index += 1) {
    const jointName = jointState.name[index];
    const position = jointState.position[index];
    if (jointName == undefined || position == undefined) {
      continue;
    }
    const joint = model.parsed.robot.joints.get(jointName);
    if (!joint) {
      continue;
    }
    const transform = composeJointTransform(joint, position);
    model.transformTree.addTransform(joint.parent, joint.child, 0n, transform.translation, transform.rotation);
    model.kinematicState.localByChild.set(
      normalizeFrameId(joint.child),
      matrixFromPose(transform.translation, transform.rotation),
    );
    applied += 1;
  }
  if (applied > 0) {
    recomputeKinematicPoses(model.kinematicState, model.rootFrameId, model.parsed.frames);
  }
  return applied;
}

export function applyFramePoses(model: RobotRenderable, playbackTimeNs: bigint): void {
  const rootFrameId = resolveDisplayRootFrameId(model);

  if (!rootFrameId) {
    return;
  }

  const queryTime = model.hasRealtimeTf ? playbackTimeNs : 0n;
  const displayRootId = normalizeFrameId(rootFrameId);
  const rootPose = model.hasRealtimeTf ? undefined : model.kinematicState.poseByFrame.get(displayRootId);
  for (const entry of model.frameObjects) {
    if (!model.hasRealtimeTf) {
      const childPose = model.kinematicState.poseByFrame.get(normalizeFrameId(entry.frameId));
      if (childPose && rootPose) {
        SCRATCH_REL_MATRIX.copy(rootPose.matrix).invert().multiply(childPose.matrix);
        SCRATCH_REL_MATRIX.decompose(
          entry.object.position,
          entry.object.quaternion,
          SCRATCH_DECOMPOSE_SCALE,
        );
        entry.object.visible = true;
      } else {
        const ok = model.transformTree.getRelativeTransformInto(
          rootFrameId,
          entry.frameId,
          queryTime,
          entry.object.position,
          entry.object.quaternion,
        );
        entry.object.visible = ok;
      }
      continue;
    }
    // Write pose directly into the entry's object to avoid per-frame
    // Vector3/Quaternion/Matrix4 allocations (previously ~3 allocs * N
    // frameObjects * 60Hz = major GC pressure).
    const ok = model.transformTree.getRelativeTransformInto(
      rootFrameId,
      entry.frameId,
      queryTime,
      entry.object.position,
      entry.object.quaternion,
    );
    entry.object.visible = ok;
  }
}

function disposeMaterial(material: THREE.Material): void {
  // MeshStandardMaterial and its kin own texture references via numerous
  // optional slots (map, normalMap, roughnessMap, ...). THREE does NOT auto-
  // dispose them, so every URDF rebuild would otherwise leak GPU textures.
  const mat = material as unknown as Record<string, unknown>;
  for (const key of Object.keys(mat)) {
    const value = mat[key];
    if (value && typeof value === 'object' && 'isTexture' in value && (value as THREE.Texture).isTexture) {
      (value as THREE.Texture).dispose();
    }
  }
  material.dispose();
}

function disposeObjectMaterials(material: THREE.Material | THREE.Material[] | undefined): void {
  if (!material) return;
  if (Array.isArray(material)) {
    for (const entry of material) {
      disposeMaterial(entry);
    }
    return;
  }
  disposeMaterial(material);
}

export function disposeRobotRenderable(model: RobotRenderable | null): void {
  if (!model) {
    return;
  }
  model.root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.isMesh || (child as THREE.LineSegments).isLineSegments) {
      const renderObject = child as THREE.Mesh | THREE.LineSegments;
      if (renderObject.geometry) {
        renderObject.geometry.dispose();
      }
      disposeObjectMaterials(renderObject.material);
    }
  });
  model.root.clear();
}

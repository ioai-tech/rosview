import * as THREE from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import {
  CANVAS_CAMERA,
  CANVAS_GL,
  DEFAULT_GRID_SIZE,
  framePerspectiveCameraToGrid,
} from '@/features/panels/common/zUpSceneLayout';
import { attachOrbitControls } from './orbitControls';
import { createViewportAxesGizmo } from './viewportAxesGizmo';

export type ThreeCanvasSize = { width: number; height: number; dpr: number };

export type ThreeCanvasGlParams = {
  antialias?: boolean;
  alpha?: boolean;
  powerPreference?: WebGLPowerPreference;
};

/** Minimal renderer surface the demand loop and tests need. */
export type ThreeCanvasRenderer = Pick<
  THREE.WebGLRenderer,
  | 'render'
  | 'setSize'
  | 'setPixelRatio'
  | 'dispose'
  | 'forceContextLoss'
  | 'getContext'
  | 'shadowMap'
  | 'domElement'
  | 'autoClear'
  | 'clearDepth'
  | 'setScissor'
  | 'setScissorTest'
  | 'getScissor'
  | 'getScissorTest'
  | 'setViewport'
  | 'getViewport'
  | 'toneMapping'
  | 'outputColorSpace'
  | 'renderLists'
> &
  Partial<Pick<THREE.WebGLRenderer, 'info'>>;

export type ThreeCanvasRuntimeOptions = {
  canvas: HTMLCanvasElement;
  /** Matches R3F `<Canvas shadows>` — enables PCFSoftShadowMap. Default true. */
  shadows?: boolean;
  /**
   * Passed into `createRenderer`. Defaults match R3F `defaultProps`:
   * `{ antialias: true, alpha: true, powerPreference: 'high-performance' }`
   * plus `CANVAS_GL.antialias`.
   */
  gl?: ThreeCanvasGlParams;
  /** Initial perspective camera. Default `CANVAS_CAMERA`. */
  camera?: {
    position: [number, number, number];
    up: [number, number, number];
    fov: number;
    near: number;
    far: number;
  };
  /** When true (3D/Pose default), frame to DEFAULT_GRID_SIZE once size is non-zero. */
  autoFrameToGrid?: boolean;
  /** Gizmo label color from `getScenePanelThemeColors().gizmoLabelColor`. */
  gizmoLabelColor: string;
  /**
   * Test seam. Production omits this and uses `new THREE.WebGLRenderer({ canvas, ...params })`.
   * Happy-dom has no WebGL; unit tests inject a fake.
   */
  createRenderer?: (canvas: HTMLCanvasElement, params: ThreeCanvasGlParams) => ThreeCanvasRenderer;
};

export type ThreeCanvasRuntime = {
  readonly renderer: ThreeCanvasRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  /** Group for panel content (robot, clouds, markers). Chrome lives outside it. */
  readonly contentRoot: THREE.Group;
  readonly size: ThreeCanvasSize;
  setBackground(color: THREE.ColorRepresentation): void;
  setSize(width: number, height: number): void;
  setGizmoLabelColor(color: string): void;
  /**
   * Subscribe to CSS-pixel size changes (after `setSize`). Line2 materials
   * update `resolution` here; do **not** rebuild `LineGeometry` on resize.
   * Returns unsubscribe.
   */
  onResize(cb: (size: ThreeCanvasSize) => void): () => void;
  /** Coalesce N calls in one turn into one rAF. See demand-loop state machine. */
  invalidate: (frames?: number) => void;
  /**
   * Idempotent. Always releases controls/gizmo/renderer GPU objects.
   * `loseContext` defaults false; the React wrapper passes true only when the
   * canvas element is being removed (see Dispose).
   */
  dispose: (opts?: { loseContext?: boolean }) => void;
};

/**
 * React-facing subset. Hook consumers must be children of `<ThreeCanvas>`.
 * `onResize` is how Pose `BandLine` follows CSS size without rebuilding geometry.
 */
export type ThreeCanvasHandle = Pick<
  ThreeCanvasRuntime,
  | 'renderer'
  | 'scene'
  | 'camera'
  | 'controls'
  | 'contentRoot'
  | 'size'
  | 'invalidate'
  | 'setBackground'
  | 'setGizmoLabelColor'
  | 'onResize'
>;

const MAX_FRAMES = 60;
/** Demand-loop dt cap so an idle canvas does not snap the gizmo tween. */
const MAX_DT_SECONDS = 1 / 30;
const ORIGIN = new THREE.Vector3(0, 0, 0);

let activeThreeCanvasRuntimes = 0;

/** DEV leak counter: live runtimes that have not been disposed. */
export function getActiveThreeCanvasRuntimeCount(): number {
  return activeThreeCanvasRuntimes;
}

function clampDpr(value: number): number {
  return Math.min(2, Math.max(1, value));
}

function currentDpr(): number {
  if (typeof window === 'undefined') return 1;
  return clampDpr(window.devicePixelRatio || 1);
}

export function createThreeCanvasRuntime(options: ThreeCanvasRuntimeOptions): ThreeCanvasRuntime {
  const {
    canvas,
    shadows,
    gl,
    camera: cameraProps = CANVAS_CAMERA,
    autoFrameToGrid = true,
    gizmoLabelColor,
    createRenderer,
  } = options;

  const glParams: ThreeCanvasGlParams = {
    alpha: true,
    powerPreference: 'high-performance',
    ...CANVAS_GL,
    ...gl,
  };

  const renderer =
    createRenderer?.(canvas, glParams) ??
    new THREE.WebGLRenderer({ canvas, ...glParams });

  renderer.shadowMap.enabled = shadows !== false;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  THREE.ColorManagement.enabled = true;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;

  const scene = new THREE.Scene();
  const contentRoot = new THREE.Group();
  contentRoot.name = 'contentRoot';
  scene.add(contentRoot);

  const camera = new THREE.PerspectiveCamera(
    cameraProps.fov,
    1,
    cameraProps.near,
    cameraProps.far,
  );
  camera.up.set(cameraProps.up[0], cameraProps.up[1], cameraProps.up[2]);
  camera.position.set(cameraProps.position[0], cameraProps.position[1], cameraProps.position[2]);
  camera.lookAt(0, 0, 0);
  camera.updateProjectionMatrix();

  const size: ThreeCanvasSize = { width: 0, height: 0, dpr: 1 };
  const backgroundColor = new THREE.Color();
  const resizeListeners = new Set<(next: ThreeCanvasSize) => void>();
  let lastTickMs = performance.now();

  let pendingFrames = 0;
  let rafHandle: number | null = null;
  let inTick = false;
  let disposed = false;
  let didInitialFit = false;
  let consecutiveTicks = 0;
  let warnedStuckLoop = false;

  const tick = (): void => {
    rafHandle = null;
    if (disposed || size.width <= 0 || size.height <= 0) return;

    inTick = true;
    consecutiveTicks += 1;
    if (
      import.meta.env.DEV &&
      !warnedStuckLoop &&
      consecutiveTicks > 120
    ) {
      warnedStuckLoop = true;
      console.debug('ThreeCanvas demand loop still running after 120 frames');
    }

    const now = performance.now();
    const dt = Math.min(Math.max(0, (now - lastTickMs) / 1000), MAX_DT_SECONDS);
    lastTickMs = now;
    const moved = controls.enableDamping ? controls.update(dt) : false;
    gizmo.update(dt);

    renderer.render(scene, camera);
    // Points drawn in the last frame of the scene (not the gizmo): a cheap readout for
    // diagnostics and browser tests ("did the cloud reach the screen").
    const points = renderer.info?.render.points;
    if (points != undefined) renderer.domElement.dataset.renderedPoints = String(points);
    gizmo.render(renderer);

    pendingFrames = Math.max(0, pendingFrames - 1);
    const continueLoop = pendingFrames > 0 || moved === true || gizmo.animating;
    inTick = false;

    if (!disposed && continueLoop && rafHandle == null) {
      rafHandle = requestAnimationFrame(tick);
    }
  };

  const invalidate = (frames = 1): void => {
    if (disposed) return;
    if (!inTick) {
      consecutiveTicks = 0;
      warnedStuckLoop = false;
    }
    if (frames > 1) {
      pendingFrames = Math.min(MAX_FRAMES, pendingFrames + frames);
    } else if (inTick) {
      pendingFrames = 2;
    } else {
      pendingFrames = Math.max(pendingFrames, 1);
    }
    if (size.width <= 0 || size.height <= 0) {
      return;
    }
    if (rafHandle == null && !inTick) {
      rafHandle = requestAnimationFrame(tick);
    }
  };

  const controls = attachOrbitControls(camera, canvas, invalidate);
  const gizmo = createViewportAxesGizmo({
    canvas,
    camera,
    controls,
    labelColor: gizmoLabelColor,
    invalidate,
  });

  const setBackground = (color: THREE.ColorRepresentation): void => {
    backgroundColor.set(color);
    scene.background = backgroundColor;
  };

  const setGizmoLabelColor = (color: string): void => {
    gizmo.setLabelColor(color);
  };

  const setSize = (width: number, height: number): void => {
    if (disposed) return;
    size.width = width;
    size.height = height;
    if (width > 0 && height > 0) {
      const dpr = currentDpr();
      size.dpr = dpr;
      renderer.setPixelRatio(dpr);
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      if (autoFrameToGrid && !didInitialFit) {
        framePerspectiveCameraToGrid(camera, ORIGIN, DEFAULT_GRID_SIZE);
        controls.target.copy(ORIGIN);
        controls.update();
        didInitialFit = true;
      }
      gizmo.setSize(width, height);
    }
    for (const cb of resizeListeners) {
      cb(size);
    }
    if (pendingFrames > 0 && width > 0 && height > 0) {
      invalidate();
    }
  };

  const onResize = (cb: (next: ThreeCanvasSize) => void): (() => void) => {
    resizeListeners.add(cb);
    return () => {
      resizeListeners.delete(cb);
    };
  };

  const dispose = (opts?: { loseContext?: boolean }): void => {
    if (disposed) return;
    disposed = true;
    if (rafHandle != null) {
      cancelAnimationFrame(rafHandle);
      rafHandle = null;
    }
    controls.dispose();
    gizmo.dispose();
    renderer.renderLists.dispose?.();
    renderer.dispose();
    if (opts?.loseContext === true) {
      renderer.forceContextLoss?.();
    }
    resizeListeners.clear();
    if (import.meta.env.DEV) {
      activeThreeCanvasRuntimes = Math.max(0, activeThreeCanvasRuntimes - 1);
    }
  };

  if (import.meta.env.DEV) {
    activeThreeCanvasRuntimes += 1;
  }

  return {
    renderer,
    scene,
    camera,
    controls,
    contentRoot,
    size,
    setBackground,
    setSize,
    setGizmoLabelColor,
    onResize,
    invalidate,
    dispose,
  };
}

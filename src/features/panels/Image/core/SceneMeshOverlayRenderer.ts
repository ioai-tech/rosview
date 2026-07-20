import * as THREE from 'three';
import type { ImageRenderOptions } from './imageWorkerProtocol';
import {
  SCENE_MESH_SYNC_TOLERANCE_NS,
  selectSynchronizedSceneMeshes,
  type DoubleSphereCalibration,
  type SceneMeshPrimitive,
  type SceneMeshFrame,
} from './sceneMesh';

const MAX_CACHED_FRAMES = 120;

const VERTEX_SHADER = /* glsl */ `
  precision highp float;

  uniform mat4 uCameraFromReference;
  uniform vec4 uIntrinsics;
  uniform vec2 uXiAlpha;
  uniform vec2 uSourceSize;
  uniform vec2 uViewportSize;
  uniform vec2 uFlip;
  uniform vec2 uRotation;
  uniform vec2 uPixelOffset;
  uniform float uImageScale;
  uniform vec2 uDepthRange;

  varying vec3 vNormalCamera;
  varying vec3 vViewDirection;

  void main() {
    vec3 cameraPoint = (uCameraFromReference * vec4(position, 1.0)).xyz;
    float distanceOne = length(cameraPoint);
    float zXi = uXiAlpha.x * distanceOne + cameraPoint.z;
    float distanceTwo = length(vec3(cameraPoint.xy, zXi));
    float denominator = uXiAlpha.y * distanceTwo + (1.0 - uXiAlpha.y) * zXi;
    if (denominator <= 1e-7) {
      gl_Position = vec4(2.0, 2.0, 1.0, 1.0);
      return;
    }
    vec2 sourcePixel = vec2(
      uIntrinsics.x * cameraPoint.x / denominator + uIntrinsics.z,
      uIntrinsics.y * cameraPoint.y / denominator + uIntrinsics.w
    );
    vec2 imagePosition = (sourcePixel - uSourceSize * 0.5) * uImageScale * uFlip;
    imagePosition = vec2(
      uRotation.x * imagePosition.x - uRotation.y * imagePosition.y,
      uRotation.y * imagePosition.x + uRotation.x * imagePosition.y
    );
    vec2 viewportPixel = uViewportSize * 0.5 + imagePosition + uPixelOffset;
    vec2 ndc = vec2(
      viewportPixel.x / uViewportSize.x * 2.0 - 1.0,
      1.0 - viewportPixel.y / uViewportSize.y * 2.0
    );
    float depth = clamp(
      (distanceOne - uDepthRange.x) / (uDepthRange.y - uDepthRange.x),
      0.0,
      1.0
    ) * 2.0 - 1.0;
    gl_Position = vec4(ndc, depth, 1.0);
    vNormalCamera = normalize(mat3(uCameraFromReference) * normal);
    vViewDirection = normalize(-cameraPoint);
  }
`;

const MATERIAL_FRAGMENT_SHADER = /* glsl */ `
  precision highp float;

  uniform vec4 uColor;
  uniform vec3 uLightDirection;

  varying vec3 vNormalCamera;
  varying vec3 vViewDirection;

  void main() {
    vec3 normalDirection = normalize(vNormalCamera);
    float diffuse = abs(dot(normalDirection, normalize(uLightDirection)));
    float rim = pow(1.0 - abs(dot(normalDirection, normalize(vViewDirection))), 2.0);
    vec3 shaded = uColor.rgb * (0.36 + 0.64 * diffuse) + vec3(0.10) * rim;
    gl_FragColor = vec4(shaded, uColor.a);
  }
`;

const SHADOW_FRAGMENT_SHADER = /* glsl */ `
  precision highp float;
  uniform vec4 uColor;
  void main() {
    gl_FragColor = uColor;
  }
`;

interface MaterialUniforms extends Record<string, THREE.IUniform> {
  uCameraFromReference: THREE.IUniform<THREE.Matrix4>;
  uIntrinsics: THREE.IUniform<THREE.Vector4>;
  uXiAlpha: THREE.IUniform<THREE.Vector2>;
  uSourceSize: THREE.IUniform<THREE.Vector2>;
  uViewportSize: THREE.IUniform<THREE.Vector2>;
  uFlip: THREE.IUniform<THREE.Vector2>;
  uRotation: THREE.IUniform<THREE.Vector2>;
  uPixelOffset: THREE.IUniform<THREE.Vector2>;
  uImageScale: THREE.IUniform<number>;
  uDepthRange: THREE.IUniform<THREE.Vector2>;
  uColor: THREE.IUniform<THREE.Vector4>;
  uLightDirection: THREE.IUniform<THREE.Vector3>;
}

interface MeshBundle {
  id: string;
  geometry: THREE.BufferGeometry;
  material: THREE.ShaderMaterial;
  shadowMaterial: THREE.ShaderMaterial;
  mesh: THREE.Mesh;
  shadow: THREE.Mesh;
}

interface LastImageFrame {
  timestampNs: bigint;
  width: number;
  height: number;
}

export class SceneMeshOverlayRenderer {
  readonly #canvas: HTMLCanvasElement;
  readonly #renderer: THREE.WebGLRenderer;
  readonly #scene = new THREE.Scene();
  readonly #camera = new THREE.Camera();
  readonly #cameraFromReference = new THREE.Matrix4();
  readonly #referenceFromCameraTranslation = new THREE.Vector3();
  readonly #referenceFromCameraQuaternion = new THREE.Quaternion();
  readonly #unitScale = new THREE.Vector3(1, 1, 1);
  readonly #resizeObserver: ResizeObserver;
  #frames: SceneMeshFrame[] = [];
  #calibration: DoubleSphereCalibration | null = null;
  #options: ImageRenderOptions;
  #bundles: MeshBundle[] = [];
  #activeTimestampNs: bigint | null = null;
  #lastImageFrame: LastImageFrame | null = null;

  constructor(canvas: HTMLCanvasElement, options: ImageRenderOptions) {
    this.#canvas = canvas;
    this.#options = options;
    this.#renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: true,
      premultipliedAlpha: true,
      powerPreference: 'high-performance',
    });
    this.#renderer.setClearColor(0x000000, 0);
    this.#renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.#renderer.autoClear = true;
    this.#resizeObserver = new ResizeObserver(() => {
      this.#resize();
      this.#draw();
    });
    this.#resizeObserver.observe(canvas);
    this.#resize();
  }

  addFrame(frame: SceneMeshFrame): void {
    const oldestFrame = this.#frames[0];
    if (oldestFrame && frame.timestampNs < oldestFrame.timestampNs) {
      this.#frames = [];
      this.#activeTimestampNs = null;
      this.#disposeBundles();
    }
    const existing = this.#frames.findIndex((candidate) => candidate.timestampNs === frame.timestampNs);
    if (existing >= 0) {
      this.#frames[existing] = frame;
    } else {
      this.#frames.push(frame);
      this.#frames.sort((left, right) => left.timestampNs < right.timestampNs ? -1 : 1);
      if (this.#frames.length > MAX_CACHED_FRAMES) {
        this.#frames.splice(0, this.#frames.length - MAX_CACHED_FRAMES);
      }
    }
    const imageTimestampNs = this.#lastImageFrame?.timestampNs;
    if (imageTimestampNs !== undefined) {
      const delta = frame.timestampNs >= imageTimestampNs
        ? frame.timestampNs - imageTimestampNs
        : imageTimestampNs - frame.timestampNs;
      if (delta <= SCENE_MESH_SYNC_TOLERANCE_NS) this.#draw();
    }
  }

  clearFrames(): void {
    this.#frames = [];
    this.#activeTimestampNs = null;
    this.#disposeBundles();
    this.#clear();
  }

  setCalibration(calibration: DoubleSphereCalibration | null): void {
    this.#calibration = calibration;
    if (calibration) {
      this.#referenceFromCameraTranslation.set(...calibration.referenceFromCameraTranslation);
      this.#referenceFromCameraQuaternion.set(...calibration.referenceFromCameraQuaternion);
      this.#cameraFromReference.compose(
        this.#referenceFromCameraTranslation,
        this.#referenceFromCameraQuaternion,
        this.#unitScale,
      ).invert();
    }
    this.#canvas.dataset.sceneMeshCalibrated = calibration ? 'true' : 'false';
    this.#draw();
  }

  setOptions(options: ImageRenderOptions): void {
    this.#options = options;
    this.#draw();
  }

  renderImageFrame(timestampNs: bigint, width: number, height: number): void {
    this.#lastImageFrame = { timestampNs, width, height };
    this.#draw();
  }

  dispose(): void {
    this.#resizeObserver.disconnect();
    this.#disposeBundles();
    this.#renderer.dispose();
    this.#canvas.removeAttribute('data-scene-mesh-frame-ns');
    this.#canvas.removeAttribute('data-scene-mesh-count');
    this.#canvas.removeAttribute('data-scene-mesh-calibrated');
  }

  #draw(): void {
    const calibration = this.#calibration;
    const image = this.#lastImageFrame;
    if (!calibration || !image || this.#canvas.clientWidth <= 0 || this.#canvas.clientHeight <= 0) {
      this.#clear();
      return;
    }
    const frame = selectSynchronizedSceneMeshes(this.#frames, image.timestampNs);
    if (!frame) {
      this.#activeTimestampNs = null;
      this.#disposeBundles();
      this.#clear();
      return;
    }
    if (this.#activeTimestampNs !== frame.timestampNs) {
      this.#applyMeshes(frame.meshes);
      this.#activeTimestampNs = frame.timestampNs;
    }
    const viewportWidth = Math.max(1, this.#canvas.clientWidth);
    const viewportHeight = Math.max(1, this.#canvas.clientHeight);
    const rotationRad = ((this.#options.rotationDeg % 360) * Math.PI) / 180;
    const rotationCos = Math.cos(rotationRad);
    const rotationSin = Math.sin(rotationRad);
    const absCos = Math.abs(rotationCos);
    const absSin = Math.abs(rotationSin);
    const logicalWidth = image.width * absCos + image.height * absSin;
    const logicalHeight = image.width * absSin + image.height * absCos;
    const imageScale = this.#options.fitMode === 'contain'
      ? Math.min(viewportWidth / logicalWidth, viewportHeight / logicalHeight)
      : Math.max(viewportWidth / logicalWidth, viewportHeight / logicalHeight);
    const widthRatio = image.width / calibration.width;
    const heightRatio = image.height / calibration.height;
    const [fx, fy, cx, cy, xi, alpha] = calibration.intrinsics;
    for (const bundle of this.#bundles) {
      for (const material of [bundle.material, bundle.shadowMaterial]) {
        const uniforms = material.uniforms as unknown as MaterialUniforms;
        uniforms.uCameraFromReference.value.copy(this.#cameraFromReference);
        uniforms.uIntrinsics.value.set(
          fx * widthRatio,
          fy * heightRatio,
          cx * widthRatio,
          cy * heightRatio,
        );
        uniforms.uXiAlpha.value.set(xi, alpha);
        uniforms.uSourceSize.value.set(image.width, image.height);
        uniforms.uViewportSize.value.set(viewportWidth, viewportHeight);
        uniforms.uFlip.value.set(
          this.#options.flipHorizontal ? -1 : 1,
          this.#options.flipVertical ? -1 : 1,
        );
        uniforms.uRotation.value.set(rotationCos, rotationSin);
        uniforms.uImageScale.value = imageScale;
      }
    }
    this.#renderer.render(this.#scene, this.#camera);
    this.#canvas.dataset.sceneMeshFrameNs = frame.timestampNs.toString();
    this.#canvas.dataset.sceneMeshCount = String(frame.meshes.length);
  }

  #applyMeshes(meshes: readonly SceneMeshPrimitive[]): void {
    if (!this.#updateMeshes(meshes)) this.#replaceMeshes(meshes);
  }

  #updateMeshes(meshes: readonly SceneMeshPrimitive[]): boolean {
    if (meshes.length !== this.#bundles.length) return false;
    for (let index = 0; index < meshes.length; index += 1) {
      const primitive = meshes[index];
      const bundle = this.#bundles[index];
      if (!primitive || !bundle || bundle.id !== primitive.id) return false;
      const position = bundle.geometry.getAttribute('position');
      const indices = bundle.geometry.getIndex();
      if (
        !(position instanceof THREE.BufferAttribute) ||
        !indices ||
        position.array.length !== primitive.points.length ||
        indices.array.length !== primitive.indices.length
      ) return false;
    }
    for (let index = 0; index < meshes.length; index += 1) {
      const primitive = meshes[index];
      const bundle = this.#bundles[index];
      const position = bundle.geometry.getAttribute('position') as THREE.BufferAttribute;
      const indices = bundle.geometry.getIndex()!;
      (position.array as Float32Array).set(primitive.points);
      (indices.array as Uint32Array).set(primitive.indices);
      position.needsUpdate = true;
      indices.needsUpdate = true;
      bundle.geometry.computeVertexNormals();
      const uniforms = bundle.material.uniforms as unknown as MaterialUniforms;
      uniforms.uColor.value.set(...primitive.color);
    }
    return true;
  }

  #replaceMeshes(meshes: readonly SceneMeshPrimitive[]): void {
    this.#disposeBundles();
    this.#bundles = meshes.map((primitive, index) => {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(primitive.points, 3));
      geometry.setIndex(new THREE.BufferAttribute(primitive.indices, 1));
      geometry.computeVertexNormals();
      geometry.computeBoundingSphere();
      const material = this.#createMaterial(primitive.color, false);
      const shadowMaterial = this.#createMaterial([0.01, 0.015, 0.025, 0.30], true);
      const mesh = new THREE.Mesh(geometry, material);
      const shadow = new THREE.Mesh(geometry, shadowMaterial);
      shadow.frustumCulled = false;
      mesh.frustumCulled = false;
      shadow.renderOrder = index;
      mesh.renderOrder = 10 + index;
      this.#scene.add(shadow, mesh);
      return { id: primitive.id, geometry, material, shadowMaterial, mesh, shadow };
    });
  }

  #createMaterial(
    color: readonly [number, number, number, number],
    shadow: boolean,
  ): THREE.ShaderMaterial {
    const uniforms: MaterialUniforms = {
      uCameraFromReference: { value: new THREE.Matrix4() },
      uIntrinsics: { value: new THREE.Vector4() },
      uXiAlpha: { value: new THREE.Vector2() },
      uSourceSize: { value: new THREE.Vector2(1, 1) },
      uViewportSize: { value: new THREE.Vector2(1, 1) },
      uFlip: { value: new THREE.Vector2(1, 1) },
      uRotation: { value: new THREE.Vector2(1, 0) },
      uPixelOffset: { value: shadow ? new THREE.Vector2(3, 4) : new THREE.Vector2(0, 0) },
      uImageScale: { value: 1 },
      uDepthRange: { value: new THREE.Vector2(0.02, 5) },
      uColor: { value: new THREE.Vector4(...color) },
      uLightDirection: { value: new THREE.Vector3(-0.35, -0.55, 0.76).normalize() },
    };
    return new THREE.ShaderMaterial({
      uniforms,
      vertexShader: VERTEX_SHADER,
      fragmentShader: shadow ? SHADOW_FRAGMENT_SHADER : MATERIAL_FRAGMENT_SHADER,
      transparent: true,
      depthTest: !shadow,
      depthWrite: !shadow,
      side: THREE.DoubleSide,
      blending: THREE.NormalBlending,
    });
  }

  #disposeBundles(): void {
    for (const bundle of this.#bundles) {
      this.#scene.remove(bundle.mesh, bundle.shadow);
      bundle.material.dispose();
      bundle.shadowMaterial.dispose();
      bundle.geometry.dispose();
    }
    this.#bundles = [];
  }

  #resize(): void {
    const width = Math.max(1, this.#canvas.clientWidth);
    const height = Math.max(1, this.#canvas.clientHeight);
    this.#renderer.setPixelRatio(window.devicePixelRatio || 1);
    this.#renderer.setSize(width, height, false);
  }

  #clear(): void {
    this.#renderer.clear(true, true, true);
    this.#canvas.removeAttribute('data-scene-mesh-frame-ns');
    this.#canvas.dataset.sceneMeshCount = '0';
  }
}

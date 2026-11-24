import * as THREE from 'three';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import type { Vec3 } from './markers';

/**
 * LINE_STRIP / LINE_LIST markers drawn at their width, as RViz and Foxglove do: `scale.x` is the
 * line width in metres. `THREE.Line` is always one pixel wide, so a 1 cm head trajectory used to
 * look the same as a hairline at any distance.
 *
 * The lines are screen-facing quads (`LineSegments2` + `LineMaterial` in world units). Unlike
 * Foxglove, a line never gets thinner than {@link MIN_LINE_PIXELS} on screen: a far-away or
 * zero-width line stays visible instead of breaking up into sub-pixel dashes.
 */

/** Smallest on-screen width of a world-width line, in CSS pixels. */
export const MIN_LINE_PIXELS = 1.5;

type ShaderPatch = { find: string; replace: string };

/**
 * GLSL edits applied to three's LineMaterial (world-units path): the half width is floored at
 * `minPixelWidth` pixels at the vertex's depth, and the fragment's round-cap test uses that same
 * width (passed as a varying) instead of the raw `linewidth` uniform.
 */
const VERTEX_PATCHES: ShaderPatch[] = [
  {
    find: 'uniform vec2 resolution;',
    replace: 'uniform vec2 resolution;\n\t\tuniform float minPixelWidth;\n\t\tvarying float vLineWidth;',
  },
  {
    find: 'float hw = linewidth * 0.5;',
    replace: [
      // World size of one CSS pixel at this vertex: perspective scales with depth; ortho does not.
      'float pixelWorld = ( perspective ? max( - worldPos.z, 0.0 ) : 1.0 ) * 2.0 / ( resolution.y * projectionMatrix[ 1 ][ 1 ] );',
      'float lineWidth = max( linewidth, minPixelWidth * pixelWorld );',
      'vLineWidth = lineWidth;',
      'float hw = lineWidth * 0.5;',
    ].join('\n\t\t\t\t'),
  },
];

const FRAGMENT_PATCHES: ShaderPatch[] = [
  { find: 'uniform float linewidth;', replace: 'uniform float linewidth;\n\t\tvarying float vLineWidth;' },
  { find: 'float norm = len / linewidth;', replace: 'float norm = len / vLineWidth;' },
];

/**
 * Applies every patch exactly once; throws when three's shader no longer has the expected text.
 * The unit tests patch the `three` this repo builds against, so an upgrade fails there first.
 */
export function patchShaderSource(source: string, patches: readonly ShaderPatch[]): string {
  let out = source;
  for (const { find, replace } of patches) {
    const at = out.indexOf(find);
    if (at < 0 || out.indexOf(find, at + find.length) >= 0) {
      throw new Error(`markerLines: LineMaterial shader changed, cannot patch "${find}"`);
    }
    out = out.slice(0, at) + replace + out.slice(at + find.length);
  }
  return out;
}

export type WorldLineMaterial = LineMaterial & { uniforms: { minPixelWidth: { value: number } } };

type LineShaders = { vertex: string; fragment: string };

/** Last stock source seen and its patched form (null: three's shader no longer matches the patches). */
let shaderCache: { vertex: string; fragment: string; patched: LineShaders | null } | undefined;

/**
 * The world-width shaders for three's stock LineMaterial sources, or null when three changed the
 * patched lines. That is reported once with `console.warn`: the host's `three` is a peer
 * dependency, so a newer release must not take the whole 3D panel down with it.
 */
export function worldWidthLineShaders(vertex: string, fragment: string): LineShaders | null {
  if (shaderCache?.vertex === vertex && shaderCache.fragment === fragment) return shaderCache.patched;
  let patched: LineShaders | null;
  try {
    patched = {
      vertex: patchShaderSource(vertex, VERTEX_PATCHES),
      fragment: patchShaderSource(fragment, FRAGMENT_PATCHES),
    };
  } catch (error) {
    patched = null;
    console.warn(
      `ROS View 3D: ${error instanceof Error ? error.message : String(error)}. ` +
        `LINE_STRIP / LINE_LIST markers draw ${MIN_LINE_PIXELS} px wide instead of their scale.x width.`,
    );
  }
  shaderCache = { vertex, fragment, patched };
  return patched;
}

/**
 * A LineMaterial whose `linewidth` is in world units, never drawn thinner than `minPixels`.
 * When three's shader cannot be patched (see {@link worldWidthLineShaders}) the material draws
 * every line `minPixels` wide in screen space instead.
 */
export function createWorldLineMaterial(options: {
  color: THREE.ColorRepresentation;
  width: number;
  minPixels?: number;
}): WorldLineMaterial {
  const minPixels = options.minPixels ?? MIN_LINE_PIXELS;
  const material = new LineMaterial({
    color: options.color,
    linewidth: Math.max(0, options.width),
    worldUnits: true,
  }) as WorldLineMaterial;
  material.uniforms.minPixelWidth = { value: minPixels };
  const shaders = worldWidthLineShaders(material.vertexShader, material.fragmentShader);
  if (shaders) {
    material.vertexShader = shaders.vertex;
    material.fragmentShader = shaders.fragment;
  } else {
    material.worldUnits = false;
    material.linewidth = minPixels;
  }
  return material;
}

/**
 * Segment pairs for `LineSegmentsGeometry`: a strip `a b c` becomes `a b  b c`, a list `a b c d`
 * stays `a b  c d`. Written straight into one Float32Array: long trajectories (tens of thousands of
 * points) are rebuilt on every marker update.
 */
export function lineSegmentPositions(points: readonly Vec3[], mode: 'strip' | 'list'): Float32Array {
  if (mode === 'list') {
    const count = points.length - (points.length % 2);
    const out = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const p = points[i];
      out[i * 3] = p[0];
      out[i * 3 + 1] = p[1];
      out[i * 3 + 2] = p[2];
    }
    return out;
  }
  const segments = Math.max(0, points.length - 1);
  const out = new Float32Array(segments * 6);
  for (let i = 0; i < segments; i++) {
    const a = points[i];
    const b = points[i + 1];
    const o = i * 6;
    out[o] = a[0];
    out[o + 1] = a[1];
    out[o + 2] = a[2];
    out[o + 3] = b[0];
    out[o + 4] = b[1];
    out[o + 5] = b[2];
  }
  return out;
}

/** A world-width line object for a LINE_STRIP (`strip`) or LINE_LIST (`list`) marker. */
export function createWorldWidthLine(options: {
  points: readonly Vec3[];
  mode: 'strip' | 'list';
  color: THREE.ColorRepresentation;
  width: number;
}): LineSegments2 {
  const geometry = new LineSegmentsGeometry();
  geometry.setPositions(lineSegmentPositions(options.points, options.mode));
  const line = new LineSegments2(geometry, createWorldLineMaterial({ color: options.color, width: options.width }));
  return line;
}

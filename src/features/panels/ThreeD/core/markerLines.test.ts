import * as THREE from 'three';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { describe, expect, it, vi } from 'vitest';

import {
  createWorldLineMaterial,
  createWorldWidthLine,
  lineSegmentPositions,
  MIN_LINE_PIXELS,
  patchShaderSource,
  worldWidthLineShaders,
} from './markerLines';
import type { Vec3 } from './markers';

describe('createWorldLineMaterial', () => {
  it('draws in world units at the given width, floored at 1.5 px', () => {
    const material = createWorldLineMaterial({ color: 'rgb(255, 153, 26)', width: 0.01 });
    expect(material.worldUnits).toBe(true);
    expect(material.linewidth).toBe(0.01);
    expect(material.uniforms.minPixelWidth.value).toBe(MIN_LINE_PIXELS);
    expect(MIN_LINE_PIXELS).toBe(1.5);
    expect(material.color.getHexString()).toBe(new THREE.Color('rgb(255, 153, 26)').getHexString());
    material.dispose();
  });

  it("patches three's LineMaterial shaders: width floor in the vertex shader, same width in the fragment", () => {
    const material = createWorldLineMaterial({ color: '#fff', width: 0 });
    // If three changes these lines, this test fails here; at runtime the material falls back.
    expect(material.vertexShader).toContain('uniform float minPixelWidth;');
    expect(material.vertexShader).toContain('float lineWidth = max( linewidth, minPixelWidth * pixelWorld );');
    expect(material.vertexShader).toContain('float hw = lineWidth * 0.5;');
    expect(material.vertexShader).not.toContain('float hw = linewidth * 0.5;');
    expect(material.fragmentShader).toContain('float norm = len / vLineWidth;');
    expect(material.fragmentShader).not.toContain('float norm = len / linewidth;');
    // The stock material is untouched.
    const stock = new LineMaterial();
    expect(stock.vertexShader).toContain('float hw = linewidth * 0.5;');
    material.dispose();
    stock.dispose();
  });

  it('refuses a shader it cannot patch exactly once', () => {
    expect(() => patchShaderSource('void main() {}', [{ find: 'float hw', replace: 'x' }])).toThrow(/cannot patch/);
    expect(() => patchShaderSource('a a', [{ find: 'a', replace: 'b' }])).toThrow(/cannot patch/);
  });
});

describe('worldWidthLineShaders', () => {
  it("warns once and returns null when three's shader no longer matches, instead of throwing", () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(worldWidthLineShaders('void main() {}', 'void main() {}')).toBeNull();
      expect(worldWidthLineShaders('void main() {}', 'void main() {}')).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toMatch(/cannot patch.*1\.5 px wide/);
      // The stock sources still patch after a failure for other sources.
      const stock = new LineMaterial();
      expect(worldWidthLineShaders(stock.vertexShader, stock.fragmentShader)?.vertex).toContain('float hw = lineWidth * 0.5;');
      stock.dispose();
    } finally {
      warn.mockRestore();
    }
  });

  it('draws every line at the pixel floor when three changed its shader, instead of taking the panel down', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const line = THREE.ShaderLib.line as { vertexShader: string };
    const stockVertex = line.vertexShader;
    line.vertexShader = stockVertex.replace('float hw = linewidth * 0.5;', 'float hw = 0.5 * linewidth;');
    try {
      const material = createWorldLineMaterial({ color: '#fff', width: 0.01 });
      expect(material.worldUnits).toBe(false);
      expect(material.linewidth).toBe(MIN_LINE_PIXELS);
      expect(material.vertexShader).not.toContain('minPixelWidth');
      expect(warn).toHaveBeenCalledTimes(1);
      material.dispose();
    } finally {
      line.vertexShader = stockVertex;
      warn.mockRestore();
    }
  });
});

describe('lineSegmentPositions', () => {
  const p: Vec3[] = [
    [0, 0, 0],
    [1, 0, 0],
    [1, 1, 0],
  ];
  it('turns a strip into consecutive segments', () => {
    expect(Array.from(lineSegmentPositions(p, 'strip'))).toEqual([0, 0, 0, 1, 0, 0, 1, 0, 0, 1, 1, 0]);
  });
  it('keeps list pairs and drops an unpaired last point', () => {
    expect(Array.from(lineSegmentPositions(p, 'list'))).toEqual([0, 0, 0, 1, 0, 0]);
  });
});

describe('createWorldWidthLine', () => {
  it('builds screen-facing segments, not a one-pixel THREE.Line', () => {
    const line = createWorldWidthLine({
      points: [
        [0, 0, 0],
        [1, 0, 0],
        [1, 1, 0],
      ],
      mode: 'strip',
      color: '#ff0000',
      width: 0.02,
    });
    expect(line).toBeInstanceOf(LineSegments2);
    expect(line.material.linewidth).toBe(0.02);
    expect(line.geometry.getAttribute('instanceStart').count).toBe(2);
    line.geometry.dispose();
    line.material.dispose();
  });

  it('builds a long trajectory quickly (it is rebuilt on every marker update)', () => {
    // A 16-minute head trajectory at 30 Hz is ~29 k points; measure 100 k.
    const points: Vec3[] = Array.from({ length: 100_000 }, (_, i) => [Math.cos(i / 500), Math.sin(i / 500), 1.5]);
    const time = (build: () => { geometry: THREE.BufferGeometry }) => {
      const runs: number[] = [];
      for (let i = 0; i < 5; i++) {
        const t0 = performance.now();
        build().geometry.dispose();
        runs.push(performance.now() - t0);
      }
      return runs.sort((a, b) => a - b)[2];
    };
    const wide = time(() => createWorldWidthLine({ points, mode: 'strip', color: '#fff', width: 0.01 }));
    const thin = time(() => {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(points.flat(), 3));
      return new THREE.Line(geometry);
    });
    console.log(`100k-point line: world-width ${wide.toFixed(1)} ms, THREE.Line ${thin.toFixed(1)} ms (median of 5)`);
    expect(wide).toBeLessThan(250);
  });
});

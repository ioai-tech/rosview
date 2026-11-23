import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { expandBoxToMinimumSize, SceneCameraFit } from './zUpSceneLayout';

describe('SceneCameraFit (m-9: the default camera frames the markers)', () => {
  it('markers take the camera from a cloud that framed it first, once', () => {
    const fit = new SceneCameraFit();
    expect(fit.claim('cloud')).toBe(true);
    expect(fit.claim('markers')).toBe(true);
    expect(fit.by).toBe('markers');
    expect(fit.claim('markers')).toBe(false);
    expect(fit.claim('cloud')).toBe(false);
  });

  it('a cloud arriving after the markers does not take the camera back', () => {
    const fit = new SceneCameraFit();
    expect(fit.claim('markers')).toBe(true);
    expect(fit.claim('cloud')).toBe(false);
  });

  it('markers appearing after the user moved the camera do not take it', () => {
    const fit = new SceneCameraFit();
    expect(fit.claim('cloud')).toBe(true);
    fit.yieldToUser();
    expect(fit.by).toBe('user');
    expect(fit.claim('markers')).toBe(false);
    expect(fit.claim('cloud')).toBe(false);
  });

  it('a second cloud does not reframe the first', () => {
    const fit = new SceneCameraFit();
    expect(fit.claim('cloud')).toBe(true);
    expect(fit.claim('cloud')).toBe(false);
  });
});

describe('expandBoxToMinimumSize', () => {
  it('grows a hand-sized box to a human-scale neighbourhood about its centre', () => {
    const box = new THREE.Box3(new THREE.Vector3(0.3, -0.1, -0.3), new THREE.Vector3(0.5, 0.1, -0.29));
    expandBoxToMinimumSize(box, 1.5);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    expect(size.toArray()).toEqual([1.5, 1.5, 1.5]);
    expect(center.x).toBeCloseTo(0.4);
    expect(center.y).toBeCloseTo(0);
    expect(center.z).toBeCloseTo(-0.295);
  });

  it('leaves a larger box as it is', () => {
    const box = new THREE.Box3(new THREE.Vector3(-2, -2, 0), new THREE.Vector3(2, 2, 2));
    expandBoxToMinimumSize(box, 1.5);
    expect(box.getSize(new THREE.Vector3()).toArray()).toEqual([4, 4, 2]);
  });
});

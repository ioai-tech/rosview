import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { applyMarkerUpdate, markersToPrimitives, stampToNs, type ScenePrimitive } from './markers';

const header = (frame_id: string, sec = 1, nanosec = 5) => ({ frame_id, stamp: { sec, nanosec } });
const pts = (...xs: Array<[number, number, number]>) => xs.map(([x, y, z]) => ({ x, y, z }));

describe('markersToPrimitives', () => {
  it('places markers through their header frame at their stamp', () => {
    const seen: Array<[string, bigint]> = [];
    const resolve = (frameId: string, stampNs: bigint) => {
      seen.push([frameId, stampNs]);
      return new THREE.Matrix4().makeTranslation(10, 0, 0);
    };
    const update = markersToPrimitives(
      { markers: [{ header: header('head'), ns: 'h', id: 0, type: 5, action: 0, points: pts([0, 0, 0], [1, 0, 0]), scale: { x: 0.01 } }] },
      '/hands',
      '#fff',
      resolve,
    );
    expect(seen).toEqual([['head', 1_000_000_005n]]);
    expect(update.upserts[0]).toMatchObject({ kind: 'segments', key: '/hands|h:0', points: [[10, 0, 0], [11, 0, 0]] });
  });

  it('keeps raw coordinates when the frame is unknown', () => {
    const update = markersToPrimitives(
      { header: header('nowhere'), type: 7, points: pts([1, 2, 3]), scale: { x: 0.02, y: 0.02, z: 0.02 } },
      '/m',
      '#fff',
      () => undefined,
    );
    expect(update.upserts[0]).toMatchObject({ kind: 'instances', shape: 'sphere', points: [[1, 2, 3]], scale: [0.02, 0.02, 0.02] });
  });

  it('applies the marker pose before the frame', () => {
    const update = markersToPrimitives(
      { type: 1, pose: { position: { x: 1, y: 0, z: 0 }, orientation: { x: 0, y: 0, z: Math.SQRT1_2, w: Math.SQRT1_2 } }, scale: { x: 1, y: 2, z: 3 } },
      '/m',
      '#fff',
    );
    const box = update.upserts[0] as Extract<ScenePrimitive, { kind: 'orientedBox' }>;
    expect(box.kind).toBe('orientedBox');
    expect(box.position[0]).toBeCloseTo(1);
    expect(box.quaternion[2]).toBeCloseTo(Math.SQRT1_2);
  });

  it('deletes one marker and every marker of a namespace', () => {
    const map = new Map<string, ScenePrimitive>();
    const add = (ns: string, id: number) =>
      markersToPrimitives({ markers: [{ ns, id, type: 2, pose: { position: { x: 0, y: 0, z: 0 } } }] }, '/t', '#fff');
    applyMarkerUpdate(map, add('a', 0));
    applyMarkerUpdate(map, add('a', 1));
    applyMarkerUpdate(map, add('b', 0));
    applyMarkerUpdate(map, markersToPrimitives({ markers: [{ ns: 'a', id: 1, action: 2 }] }, '/t', '#fff'));
    expect([...map.keys()].sort()).toEqual(['/t|a:0', '/t|b:0']);
    applyMarkerUpdate(map, markersToPrimitives({ markers: [{ ns: 'a', action: 3 }] }, '/t', '#fff'));
    expect([...map.keys()]).toEqual(['/t|b:0']);
    applyMarkerUpdate(map, markersToPrimitives({ markers: [{ action: 3 }] }, '/t', '#fff'));
    expect(map.size).toBe(0);
  });

  it('drops line markers with fewer than two points', () => {
    expect(markersToPrimitives({ type: 4, points: pts([0, 0, 0]) }, '/m', '#fff').upserts).toEqual([]);
  });
});

describe('stampToNs', () => {
  it('reads ROS 1 and ROS 2 stamps', () => {
    expect(stampToNs({ sec: 2, nanosec: 3 })).toBe(2_000_000_003n);
    expect(stampToNs({ sec: 2, nsec: 3 })).toBe(2_000_000_003n);
    expect(stampToNs({ secs: 2, nsecs: 3 })).toBe(2_000_000_003n);
    expect(stampToNs(undefined)).toBeUndefined();
  });
});

import { describe, expect, it } from 'vitest';
import type { MessageEvent } from '@/core/types/ros';
import { buildRowsForMessageEvent, buildRowsForShape } from './shapeTree';

describe('buildRowsForMessageEvent', () => {
  it('includes log_time and publish_time rows before message', () => {
    const event: MessageEvent = {
      topic: '/camera/image',
      receiveTime: { sec: 10, nsec: 1 },
      publishTime: { sec: 9, nsec: 2 },
      message: { width: 640, height: 480 },
      schemaName: 'sensor_msgs/msg/Image',
    };

    const shape = buildRowsForMessageEvent(event, 4, 2000);
    expect(shape.rows.slice(0, 3).map((row) => row.key)).toEqual(['log_time', 'publish_time', 'message']);
    expect(shape.signature.startsWith('log_time:time|publish_time:time|')).toBe(true);
  });
});

describe('buildRowsForShape typed arrays', () => {
  it('expands Float64Array fields the same way as regular arrays', () => {
    const { rows } = buildRowsForShape(
      {
        name: ['abad_L_Joint', 'hip_L_Joint'],
        position: new Float64Array([-1.6e-10, 0.25]),
      },
      4,
      2000,
    );
    const byPath = new Map(rows.map((row) => [row.path, row]));

    expect(byPath.get('message.position')).toMatchObject({
      expandable: true,
      parentIsArray: false,
    });
    expect(byPath.get('message.position.0')).toMatchObject({
      key: '0',
      expandable: false,
      parentIsArray: true,
    });
    expect(byPath.has('message.position.1')).toBe(true);
  });

  it('keeps Uint8Array payloads as a non-expandable binary leaf', () => {
    const { rows } = buildRowsForShape({ data: new Uint8Array([1, 2, 3, 4]) }, 4, 2000);
    const dataRow = rows.find((row) => row.path === 'message.data');
    expect(dataRow).toMatchObject({ expandable: false });
    expect(rows.some((row) => row.path === 'message.data.0')).toBe(false);
  });
});

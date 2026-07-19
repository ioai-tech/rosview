import { describe, expect, it } from 'vitest';
import {
  drawImageAnnotations,
  isImageAnnotationsSchema,
  parseImageAnnotations,
  resolveImageAnnotationsTopic,
  selectSynchronizedImageAnnotations,
} from './imageAnnotations';

describe('foxglove.ImageAnnotations parsing', () => {
  it('normalizes numeric and named point annotation enums', () => {
    const parsed = parseImageAnnotations({
      points: [
        {
          timestamp: { seconds: '7', nanos: 11 },
          type: 'POINTS',
          points: [{ x: 12.5, y: 25.25 }],
          outlineColor: { r: 1, g: 1, b: 1, a: 1 },
          fillColor: { r: 0.1, g: 0.2, b: 0.3, a: 1 },
          thickness: 7,
        },
        {
          timestamp: { seconds: '7', nanos: 11 },
          type: 4,
          points: [{ x: 12.5, y: 25.25 }, { x: 15, y: 30 }],
          outline_color: { r: 1, g: 0.38, b: 0.1, a: 1 },
          fill_color: { r: 1, g: 0.38, b: 0.1, a: 0 },
          thickness: 4,
        },
      ],
    });

    expect(parsed?.timestampNs).toBe(7_000_000_011n);
    expect(parsed?.points.map((point) => point.kind)).toEqual(['points', 'line-list']);
    expect(parsed?.points[0]?.fillColor).toEqual({ r: 0.1, g: 0.2, b: 0.3, a: 1 });
  });

  it('uses the root timestamp when annotations are empty', () => {
    expect(parseImageAnnotations({ timestamp: { sec: 9, nsec: 3 }, points: [] })).toEqual({
      timestampNs: 9_000_000_003n,
      points: [],
    });
  });
});

describe('foxglove.ImageAnnotations topic resolution', () => {
  const topics = [
    { name: '/robot0/perception/handpose/camera4/image_annotations', type: 'foxglove.ImageAnnotations' },
    { name: '/robot0/perception/handpose/camera5/image_annotations', type: 'foxglove_msgs/msg/ImageAnnotations' },
  ];

  it('matches the selected image by camera name', () => {
    expect(
      resolveImageAnnotationsTopic('/robot0/sensor/camera5/compressed', '', topics),
    ).toBe('/robot0/perception/handpose/camera5/image_annotations');
  });

  it('prefers an explicit configured topic', () => {
    expect(resolveImageAnnotationsTopic('/camera/image', '/custom/annotations', topics)).toBe(
      '/custom/annotations',
    );
  });

  it('recognizes ROS and Foxglove schema spellings', () => {
    expect(isImageAnnotationsSchema('foxglove.ImageAnnotations')).toBe(true);
    expect(isImageAnnotationsSchema('foxglove_msgs/msg/ImageAnnotations')).toBe(true);
    expect(isImageAnnotationsSchema('sensor_msgs/msg/Image')).toBe(false);
  });
});

describe('annotation rendering and synchronization', () => {
  it('draws point circles and line-list segments', () => {
    const overlay = parseImageAnnotations({
      points: [
        {
          timestamp: { sec: 9, nsec: 0 },
          type: 1,
          points: [{ x: 100, y: 120 }],
          outline_color: { r: 0.12, g: 0.64, b: 1, a: 1 },
          fill_color: { r: 0.12, g: 0.64, b: 1, a: 1 },
          thickness: 7,
        },
        {
          timestamp: { sec: 9, nsec: 0 },
          type: 'LINE_LIST',
          points: [{ x: 100, y: 120 }, { x: 130, y: 150 }],
          outline_color: { r: 0.12, g: 0.64, b: 1, a: 1 },
          fill_color: { r: 0.12, g: 0.64, b: 1, a: 0 },
          thickness: 4,
        },
      ],
    });
    const calls: string[] = [];
    const context = {
      beginPath: () => calls.push('begin'),
      arc: (x: number, y: number, radius: number) => calls.push(`arc:${x},${y},${radius}`),
      fill: () => calls.push('fill'),
      stroke: () => calls.push('stroke'),
      moveTo: (x: number, y: number) => calls.push(`move:${x},${y}`),
      lineTo: (x: number, y: number) => calls.push(`line:${x},${y}`),
      closePath: () => calls.push('close'),
    } as unknown as CanvasRenderingContext2D;

    drawImageAnnotations(context, overlay!);
    expect(calls).toContain('arc:100,120,3.5');
    expect(calls).toContain('move:100,120');
    expect(calls).toContain('line:130,150');
  });

  it('selects the nearest annotation within the default eight-millisecond window', () => {
    const early = { timestampNs: 1_000_000_000n, points: [] };
    const late = { timestampNs: 1_033_000_000n, points: [] };
    expect(selectSynchronizedImageAnnotations([early, late], 1_034_000_000n)).toBe(late);
    expect(selectSynchronizedImageAnnotations([early, late], 1_050_000_000n)).toBeNull();
  });
});

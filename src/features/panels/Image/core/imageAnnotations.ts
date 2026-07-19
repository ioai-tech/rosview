const ANNOTATION_SYNC_TOLERANCE_NS = 8_000_000n;

interface AnnotationColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

interface AnnotationPoint {
  x: number;
  y: number;
}

type PointsAnnotationKind = 'points' | 'line-loop' | 'line-strip' | 'line-list';

interface PointsAnnotation {
  kind: PointsAnnotationKind;
  points: AnnotationPoint[];
  outlineColor: AnnotationColor;
  outlineColors: AnnotationColor[];
  fillColor: AnnotationColor;
  thickness: number;
}

export interface ImageAnnotationsFrame {
  timestampNs: bigint;
  points: PointsAnnotation[];
}
const POINTS_KIND_BY_ENUM: Readonly<Record<string, PointsAnnotationKind | undefined>> = {
  '1': 'points',
  POINTS: 'points',
  '2': 'line-loop',
  LINE_LOOP: 'line-loop',
  '3': 'line-strip',
  LINE_STRIP: 'line-strip',
  '4': 'line-list',
  LINE_LIST: 'line-list',
};

export function isImageAnnotationsSchema(schemaName: string): boolean {
  const normalized = schemaName.toLowerCase().replaceAll('_', '');
  return normalized.endsWith('imageannotations');
}


export function parseImageAnnotations(message: unknown): ImageAnnotationsFrame | null {
  if (!isRecord(message) || !Array.isArray(message.points)) return null;

  const points = message.points.map(parsePointsAnnotation).filter(isPresent);
  const timestampNs =
    readTimestampNs(message.timestamp) ?? firstAnnotationTimestampNs(message.points);
  if (timestampNs === undefined) return null;

  return { timestampNs, points };
}

export function selectSynchronizedImageAnnotations(
  overlays: readonly ImageAnnotationsFrame[],
  imageTimestampNs: bigint,
  toleranceNs = ANNOTATION_SYNC_TOLERANCE_NS,
): ImageAnnotationsFrame | null {
  let best: ImageAnnotationsFrame | null = null;
  let bestDelta = toleranceNs + 1n;
  for (const overlay of overlays) {
    const delta = overlay.timestampNs >= imageTimestampNs
      ? overlay.timestampNs - imageTimestampNs
      : imageTimestampNs - overlay.timestampNs;
    if (delta < bestDelta) {
      best = overlay;
      bestDelta = delta;
    }
  }
  return bestDelta <= toleranceNs ? best : null;
}

export function drawImageAnnotations(
  context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  overlay: ImageAnnotationsFrame,
): void {
  context.lineCap = 'round';
  context.lineJoin = 'round';
  for (const annotation of overlay.points) {
    drawPointsAnnotation(context, annotation);
  }
}

function drawPointsAnnotation(
  context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  annotation: PointsAnnotation,
): void {
  const { points } = annotation;
  if (points.length === 0) return;

  context.lineWidth = Math.max(1, annotation.thickness);
  context.strokeStyle = colorToCss(annotation.outlineColor);
  context.fillStyle = colorToCss(annotation.fillColor);

  switch (annotation.kind) {
    case 'points':
      for (let index = 0; index < points.length; index += 1) {
        const point = points[index];
        context.strokeStyle = colorToCss(
          annotation.outlineColors[index] ?? annotation.outlineColor,
        );
        context.beginPath();
        context.arc(point.x, point.y, Math.max(1, annotation.thickness / 2), 0, Math.PI * 2);
        context.fill();
        context.stroke();
      }
      return;
    case 'line-loop':
    case 'line-strip':
      context.beginPath();
      context.moveTo(points[0].x, points[0].y);
      for (const point of points.slice(1)) context.lineTo(point.x, point.y);
      if (annotation.kind === 'line-loop') {
        context.closePath();
        if (annotation.fillColor.a > 0) context.fill();
      }
      context.stroke();
      return;
    case 'line-list':
      for (let index = 0; index + 1 < points.length; index += 2) {
        context.beginPath();
        context.moveTo(points[index].x, points[index].y);
        context.lineTo(points[index + 1].x, points[index + 1].y);
        context.stroke();
      }
  }
}

function parsePointsAnnotation(value: unknown): PointsAnnotation | null {
  if (!isRecord(value) || !Array.isArray(value.points)) return null;
  const kind = POINTS_KIND_BY_ENUM[String(value.type)];
  if (!kind) return null;
  const points = value.points.map(parsePoint).filter(isPresent);
  const outlineColor = parseColor(value.outline_color ?? value.outlineColor) ?? {
    r: 1,
    g: 1,
    b: 1,
    a: 1,
  };
  const fillColor = parseColor(value.fill_color ?? value.fillColor) ?? outlineColor;
  const rawOutlineColors = value.outline_colors ?? value.outlineColors;
  const outlineColors = Array.isArray(rawOutlineColors)
    ? rawOutlineColors.map(parseColor).filter(isPresent)
    : [];
  return {
    kind,
    points,
    outlineColor,
    outlineColors,
    fillColor,
    thickness: Math.max(1, readNumber(value, ['thickness']) ?? 1),
  };
}

function readTimestampNs(value: unknown): bigint | undefined {
  if (!isRecord(value)) return undefined;
  const sec = readBigInt(value.sec ?? value.seconds);
  const nsec = readBigInt(value.nsec ?? value.nanosec ?? value.nanos);
  return sec !== undefined && nsec !== undefined ? sec * 1_000_000_000n + nsec : undefined;
}

function firstAnnotationTimestampNs(points: readonly unknown[]): bigint | undefined {
  for (const point of points) {
    if (!isRecord(point)) continue;
    const timestampNs = readTimestampNs(point.timestamp);
    if (timestampNs !== undefined) return timestampNs;
  }
  return undefined;
}

function parsePoint(value: unknown): AnnotationPoint | null {
  if (!isRecord(value) || !isFiniteNumber(value.x) || !isFiniteNumber(value.y)) return null;
  return { x: value.x, y: value.y };
}

function parseColor(value: unknown): AnnotationColor | null {
  if (
    !isRecord(value) ||
    !isFiniteNumber(value.r) ||
    !isFiniteNumber(value.g) ||
    !isFiniteNumber(value.b) ||
    !isFiniteNumber(value.a)
  ) return null;
  return { r: value.r, g: value.g, b: value.b, a: value.a };
}

function colorToCss(color: AnnotationColor): string {
  const red = Math.round(Math.max(0, Math.min(1, color.r)) * 255);
  const green = Math.round(Math.max(0, Math.min(1, color.g)) * 255);
  const blue = Math.round(Math.max(0, Math.min(1, color.b)) * 255);
  const alpha = Math.max(0, Math.min(1, color.a));
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

function readNumber(record: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    if (isFiniteNumber(record[key])) return record[key];
  }
  return undefined;
}

function readBigInt(value: unknown): bigint | undefined {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isPresent<T>(value: T | null): value is T {
  return value !== null;
}

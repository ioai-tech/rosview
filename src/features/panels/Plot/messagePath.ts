import type { Time } from '@/core/types/ros';

export interface ExtractedPlotValue {
  key: string;
  label: string;
  value: number;
}

export interface ParsedPlotPath {
  sourcePath: string;
  modifiers: string[];
}

type Selector =
  | { kind: 'none' }
  | { kind: 'index'; index: number }
  | { kind: 'slice'; start?: number; end?: number }
  | { kind: 'name'; name: string };

interface Segment {
  field: string;
  selector: Selector;
}

const SEGMENT_RE = /^([A-Za-z_$][\w$]*)(?:\[([^\]]*)\])?$/;

const mathFunctions: Record<string, (value: number) => number> = {
  abs: Math.abs,
  acos: Math.acos,
  asin: Math.asin,
  atan: Math.atan,
  ceil: Math.ceil,
  cos: Math.cos,
  deg2rad: (value) => (value * Math.PI) / 180,
  exp: Math.exp,
  floor: Math.floor,
  log: Math.log,
  log10: Math.log10,
  rad2deg: (value) => (value * 180) / Math.PI,
  round: Math.round,
  sin: Math.sin,
  sqrt: Math.sqrt,
  tan: Math.tan,
};

/** Split comma- or whitespace-separated Y paths (each segment may include `@` modifiers). */
export function splitPlotPathList(path: string): string[] {
  const trimmed = path.trim();
  if (!trimmed) return [];
  if (!/[,\s]/.test(trimmed)) return [trimmed];
  return trimmed
    .split(',')
    .flatMap((segment) => segment.trim().split(/\s+/))
    .map((part) => part.trim())
    .filter(Boolean);
}

export function parsePlotPath(path: string): ParsedPlotPath {
  const trimmed = path.trim();
  if (!trimmed) return { sourcePath: '', modifiers: [] };
  const parts = trimmed.split('@').map((part) => part.trim()).filter(Boolean);
  return {
    sourcePath: parts[0] ?? '',
    modifiers: parts.slice(1),
  };
}

function isArrayLike(value: unknown): value is ArrayLike<unknown> {
  if (Array.isArray(value)) return true;
  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) return true;
  return false;
}

function readNames(message: unknown): string[] {
  if (!message || typeof message !== 'object') return [];
  const names = (message as Record<string, unknown>).name;
  if (!isArrayLike(names)) return [];
  const out: string[] = [];
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    out.push(typeof name === 'string' && name.length > 0 ? name : `${i}`);
  }
  return out;
}

/** `position[1-2]` — hyphen range (both ends inclusive, same as `position[1:2]`). */
const SLICE_HYPHEN_RANGE_RE = /^(-?\d+)-(-?\d+)$/;
/** `position[2-]` — hyphen open end (same as `position[2:]`). */
const SLICE_HYPHEN_START_RE = /^(-?\d+)-$/;

function tryParseSliceSelector(selector: string): { start?: number; end?: number } | null {
  if (selector === '' || selector === ':' || selector === '-') {
    return { start: undefined, end: undefined };
  }
  if (selector.includes(':')) {
    const [startRaw, endRaw] = selector.split(':', 2);
    const start = startRaw ? Number(startRaw) : undefined;
    const end = endRaw ? Number(endRaw) : undefined;
    return {
      start: Number.isFinite(start) ? start : undefined,
      end: Number.isFinite(end) ? end : undefined,
    };
  }
  const hyphenRange = SLICE_HYPHEN_RANGE_RE.exec(selector);
  if (hyphenRange) {
    const start = Number(hyphenRange[1]);
    const end = Number(hyphenRange[2]);
    if (Number.isFinite(start) && Number.isFinite(end)) {
      return { start, end };
    }
  }
  const hyphenStart = SLICE_HYPHEN_START_RE.exec(selector);
  if (hyphenStart) {
    const start = Number(hyphenStart[1]);
    if (Number.isFinite(start)) return { start, end: undefined };
  }
  return null;
}

function parseSelector(raw: string | undefined): Selector {
  if (raw == null) return { kind: 'none' };
  const selector = raw.trim();
  const slice = tryParseSliceSelector(selector);
  if (slice) {
    return { kind: 'slice', start: slice.start, end: slice.end };
  }
  const index = Number(selector);
  if (Number.isInteger(index)) return { kind: 'index', index };
  return { kind: 'name', name: selector.replace(/^['"]|['"]$/g, '') };
}

function parseSegments(path: string): Segment[] {
  if (!path) return [];
  return path
    .split('.')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const match = SEGMENT_RE.exec(part);
      if (!match) {
        throw new Error(`Unsupported plot path segment: ${part}`);
      }
      return {
        field: match[1] ?? '',
        selector: parseSelector(match[2]),
      };
    });
}

function normalizeIndex(index: number, length: number): number | undefined {
  const normalized = index < 0 ? length + index : index;
  return normalized >= 0 && normalized < length ? normalized : undefined;
}

/** Foxglove-style slice bounds: both ends inclusive when specified. */
function resolveSliceBounds(
  selector: { start?: number; end?: number },
  length: number,
): { startIdx: number; endIdx: number } | null {
  if (length === 0) return null;

  const resolveBound = (index: number | undefined, fallback: number): number => {
    if (index === undefined) return fallback;
    const normalized = index < 0 ? length + index : index;
    if (normalized < 0) return -1;
    return Math.min(length - 1, normalized);
  };

  const startIdx = resolveBound(selector.start, 0);
  const endIdx = resolveBound(selector.end, length - 1);
  if (startIdx < 0 || endIdx < 0 || startIdx > endIdx) return null;
  return { startIdx, endIdx };
}

function selectorItems(
  value: unknown,
  selector: Selector,
  message: unknown,
  field: string,
): Array<{ key: string; label: string; value: unknown }> {
  if (selector.kind === 'none') return [{ key: field, label: field, value }];
  if (!isArrayLike(value)) return [];

  if (selector.kind === 'index') {
    const index = normalizeIndex(selector.index, value.length);
    return index == null ? [] : [{ key: `${field}[${index}]`, label: `${field}[${index}]`, value: value[index] }];
  }

  if (selector.kind === 'name') {
    const names = readNames(message);
    const index = names.indexOf(selector.name);
    return index < 0 || index >= value.length
      ? []
      : [{
          key: `${field}[${selector.name}]`,
          label: `${field}[${index}] (${selector.name})`,
          value: value[index],
        }];
  }

  const bounds = resolveSliceBounds(selector, value.length);
  if (!bounds) return [];
  const { startIdx, endIdx } = bounds;
  const names = readNames(message);
  const out: Array<{ key: string; label: string; value: unknown }> = [];
  for (let i = startIdx; i <= endIdx; i++) {
    const name = names[i];
    const label = name ? `${field}[${i}] (${name})` : `${field}[${i}]`;
    const key = name ? `${field}[${name}]` : `${field}[${i}]`;
    out.push({ key, label, value: value[i] });
  }
  return out;
}

function toNumericValue(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  if (value && typeof value === 'object') {
    const record = value as Partial<Time> & Record<string, unknown>;
    const nsec = record.nsec ?? record.nanosec;
    if (typeof record.sec === 'number' && typeof nsec === 'number') {
      return record.sec + nsec / 1e9;
    }
  }
  return undefined;
}

function applyModifiers(value: number, modifiers: string[]): number | undefined {
  let next = value;
  for (const modifier of modifiers) {
    if (modifier === 'derivative') continue;
    const fn = mathFunctions[modifier];
    if (!fn) return undefined;
    next = fn(next);
    if (!Number.isFinite(next)) return undefined;
  }
  return next;
}

export function hasDerivativeModifier(path: string): boolean {
  return splitPlotPathList(path).some((subPath) => parsePlotPath(subPath).modifiers.includes('derivative'));
}

/**
 * Heuristic: is a Plot Y-path likely to yield an array of values per message?
 *
 * Modes other than `timestamp` (index/custom/currentCustom) only produce
 * meaningful data when the Y-path expands to multiple values per message —
 * typically because it contains a slice selector (e.g. `[:]`, bounded `start:end`, or `start-end`).
 * Scalar paths like `data` or fixed-index paths like `position[0]` cannot
 * usefully drive the index/custom X axes; we use this to disable the
 * corresponding settings options up-front instead of producing a silent
 * empty chart.
 */
export function isArrayLikePlotPath(path: string): boolean {
  for (const subPath of splitPlotPathList(path)) {
    const { sourcePath } = parsePlotPath(subPath);
    if (!sourcePath) continue;
    const segments = sourcePath.split('.');
    for (const segment of segments) {
      const match = SEGMENT_RE.exec(segment);
      if (!match) continue;
      const selectorRaw = match[2];
      if (selectorRaw == null) continue;
      const selector = parseSelector(selectorRaw);
      if (selector.kind === 'slice') return true;
    }
  }
  return false;
}

function extractSinglePlotPathValues(message: unknown, path: string): ExtractedPlotValue[] {
  const parsed = parsePlotPath(path);
  if (!parsed.sourcePath) return [];
  let items: Array<{ key: string; label: string; value: unknown }> = [{ key: '', label: '', value: message }];
  const segments = parseSegments(parsed.sourcePath);

  for (const segment of segments) {
    const next: Array<{ key: string; label: string; value: unknown }> = [];
    for (const item of items) {
      if (!item.value || typeof item.value !== 'object') continue;
      const value = (item.value as Record<string, unknown>)[segment.field];
      for (const selected of selectorItems(value, segment.selector, message, segment.field)) {
        const key = item.key ? `${item.key}.${selected.key}` : selected.key;
        const label = item.label && selected.label === segment.field
          ? `${item.label}.${selected.label}`
          : selected.label;
        next.push({ key, label, value: selected.value });
      }
    }
    items = next;
  }

  return items.flatMap((item) => {
    const numeric = toNumericValue(item.value);
    if (numeric == null) return [];
    const value = applyModifiers(numeric, parsed.modifiers);
    return value == null ? [] : [{ key: item.key, label: item.label || item.key, value }];
  });
}

export function extractPlotPathValues(message: unknown, path: string): ExtractedPlotValue[] {
  const paths = splitPlotPathList(path);
  if (paths.length <= 1) {
    return extractSinglePlotPathValues(message, paths[0] ?? path);
  }

  const out: ExtractedPlotValue[] = [];
  const seen = new Set<string>();
  for (const subPath of paths) {
    for (const item of extractSinglePlotPathValues(message, subPath)) {
      const dedupeKey = `${subPath}|${item.key}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      out.push(item);
    }
  }
  return out;
}

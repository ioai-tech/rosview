import type { MessageEvent } from '@/core/types/ros';

export interface FlatRow {
  id: string;
  path: string;
  key: string;
  depth: number;
  expandable: boolean;
  parentIsArray: boolean;
}

export interface ShapeBuildResult {
  signature: string;
  rows: FlatRow[];
}

const MESSAGE_EVENT_META_ROWS: FlatRow[] = [
  { id: 'log_time', path: 'log_time', key: 'log_time', depth: 0, expandable: false, parentIsArray: false },
  { id: 'publish_time', path: 'publish_time', key: 'publish_time', depth: 0, expandable: false, parentIsArray: false },
];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

/** Arrays and numeric TypedArrays. Uint8Array stays binary so image payloads do not explode. */
export function isExpandableArray(value: unknown): value is ArrayLike<unknown> {
  if (Array.isArray(value)) return true;
  return ArrayBuffer.isView(value) && !(value instanceof DataView) && !(value instanceof Uint8Array);
}

export function buildRowsForShape(
  root: unknown,
  maxExpandedDepth: number,
  maxRows: number,
): ShapeBuildResult {
  const rows: FlatRow[] = [];
  const signatureParts: string[] = [];

  const pushRow = (row: FlatRow) => {
    if (rows.length < maxRows) {
      rows.push(row);
    }
  };

  const walk = (value: unknown, path: string, key: string, depth: number, parentIsArray: boolean): void => {
    if (rows.length >= maxRows) return;
    const typeToken =
      value instanceof Uint8Array
        ? 'u8'
        : value instanceof ArrayBuffer
          ? 'ab'
          : isExpandableArray(value)
            ? 'arr'
            : isPlainObject(value)
              ? 'obj'
              : typeof value;
    signatureParts.push(`${path}:${typeToken}`);

    if (value instanceof Uint8Array) {
      pushRow({ id: path, path, key, depth, expandable: false, parentIsArray });
      return;
    }
    if (value instanceof ArrayBuffer) {
      walk(new Uint8Array(value), path, key, depth, parentIsArray);
      return;
    }
    if (isExpandableArray(value)) {
      const expandable = value.length > 0;
      pushRow({ id: path, path, key, depth, expandable, parentIsArray });
      if (depth >= maxExpandedDepth) return;
      for (let i = 0; i < value.length; i++) {
        walk(value[i], `${path}.${i}`, `${i}`, depth + 1, true);
        if (rows.length >= maxRows) return;
      }
      return;
    }
    if (isPlainObject(value)) {
      const keys = Object.keys(value);
      const expandable = keys.length > 0;
      pushRow({ id: path, path, key, depth, expandable, parentIsArray });
      if (depth >= maxExpandedDepth) return;
      for (const childKey of keys) {
        walk(value[childKey], `${path}.${childKey}`, childKey, depth + 1, false);
        if (rows.length >= maxRows) return;
      }
      return;
    }
    pushRow({ id: path, path, key, depth, expandable: false, parentIsArray });
  };

  walk(root, 'message', 'message', 0, false);
  return { rows, signature: signatureParts.join('|') };
}

export function buildRowsForMessageEvent(
  event: MessageEvent,
  maxExpandedDepth: number,
  maxRows: number,
): ShapeBuildResult {
  const messageShape = buildRowsForShape(
    event.message,
    maxExpandedDepth,
    Math.max(0, maxRows - MESSAGE_EVENT_META_ROWS.length),
  );
  return {
    rows: [...MESSAGE_EVENT_META_ROWS, ...messageShape.rows],
    signature: `log_time:time|publish_time:time|${messageShape.signature}`,
  };
}

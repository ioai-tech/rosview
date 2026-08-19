import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { useIntl } from 'react-intl';
import { toast } from 'sonner';
import { messageBus } from '@/core/pipeline/messageBus';
import { useMessagePipeline } from '@/core/pipeline/useMessagePipeline';
import type { MessageEvent, Time } from '@/core/types/ros';
import type { MessagePipelineState } from '@/core/pipeline/store';
import type { Player } from '@/core/types/player';
import { pickDefaultRawMessagesTopic } from '@/features/layout/autoLayout/pickDefaultRawMessagesTopic';
import { isRosImageSchema } from '@/shared/ros/rosMessageTypes';
import { formatLocalTimestamp } from '@/shared/utils/time';
import { scheduleFrame } from '@/shared/utils/rafScheduler';
import { TopicQuickPicker } from '../framework/TopicQuickPicker';
import { PanelTopicBar } from '../framework/PanelTopicBar';
import type { RawMessagesConfig } from './defaults';
import { buildRowsForMessageEvent, isExpandableArray, type FlatRow } from './shapeTree';

interface RawMessagesPanelProps {
  player: Player;
  panelId: string;
  topic: string;
  uiRefreshHz?: number;
  pauseUpdates?: boolean;
  latestOnly?: boolean;
  maxExpandedDepth?: number;
  maxRows?: number;
  maxBinaryPreviewBytes?: number;
  binaryCopyFormat?: RawMessagesConfig['binaryCopyFormat'];
  setConfig: (next: RawMessagesConfig | ((prev: RawMessagesConfig) => RawMessagesConfig)) => void;
}

type BinaryCopyFormat = RawMessagesConfig['binaryCopyFormat'];
type ValueKind = 'string' | 'number' | 'boolean' | 'null' | 'binary' | 'object' | 'array' | 'unknown';

interface ValueVisual {
  text: string;
  kind: ValueKind;
}

interface ScrollWindow {
  startRow: number;
  endRow: number;
  totalRows: number;
}

interface DescribeValueOptions {
  hideBinaryHex?: boolean;
}

interface RawMessageRowProps {
  row: FlatRow;
  expanded: boolean;
  onToggle: (path: string) => void;
  onCopy: (path: string) => void;
  registerValueNode: (path: string, node: HTMLSpanElement | null) => void;
}

const ROW_HEIGHT = 22;
const OVERSCAN_ROWS = 8;
const MAX_VISIBLE_PATCH_ROWS = 1200;
const MAX_OBJECT_PREVIEW_FIELDS = 3;
const MAX_PREVIEW_STRING_LENGTH = 80;
const LARGE_BINARY_THRESHOLD = 1024;
const COMPACT_BINARY_PREVIEW_BYTES = 32;

function toHex(data: Uint8Array): string {
  let out = '';
  for (let i = 0; i < data.length; i++) {
    out += data[i].toString(16).padStart(2, '0');
  }
  return out;
}

function toBase64(data: Uint8Array): string {
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < data.length; i += chunkSize) {
    binary += String.fromCharCode(...data.subarray(i, Math.min(i + chunkSize, data.length)));
  }
  return btoa(binary);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

function pathToParts(path: string): string[] {
  return path.split('.').filter((part) => part.length > 0);
}

function isRosTime(value: unknown): value is Time {
  if (!isPlainObject(value)) return false;
  return typeof value.sec === 'number' && typeof value.nsec === 'number';
}

function formatRosTime(time: Time): string {
  const nsecPadded = time.nsec.toString().padStart(9, '0');
  return `${time.sec}.${nsecPadded} (${formatLocalTimestamp(time)})`;
}

function readValueAtPath(event: MessageEvent | null | undefined, path: string): unknown {
  if (!event) return undefined;
  if (path === 'log_time') return event.receiveTime;
  if (path === 'publish_time') return event.publishTime;
  if (!path || path === 'message') return event.message;
  if (!path.startsWith('message.')) return undefined;
  const parts = pathToParts(path.replace(/^message\./, ''));
  let current: unknown = event.message;
  for (const part of parts) {
    if (isExpandableArray(current)) {
      const idx = Number(part);
      if (!Number.isInteger(idx)) return undefined;
      current = current[idx];
      continue;
    }
    if (!isPlainObject(current)) return undefined;
    current = current[part];
  }
  return current;
}

function getVisibleRows(rows: FlatRow[], expandedPaths: Set<string>): FlatRow[] {
  const out: FlatRow[] = [];
  const collapseStack: number[] = [];
  for (const row of rows) {
    while (collapseStack.length > 0 && row.depth <= collapseStack[collapseStack.length - 1]) {
      collapseStack.pop();
    }
    if (collapseStack.length > 0) continue;
    out.push(row);
    if (row.expandable && !expandedPaths.has(row.path)) {
      collapseStack.push(row.depth);
    }
  }
  return out;
}

function computeScrollWindow(
  scrollTop: number,
  viewportHeight: number,
  totalRows: number,
): Pick<ScrollWindow, 'startRow' | 'endRow'> {
  const startRow = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN_ROWS);
  const visibleCount = Math.ceil(viewportHeight / ROW_HEIGHT) + OVERSCAN_ROWS * 2;
  const endRow = Math.min(totalRows, startRow + visibleCount);
  return { startRow, endRow };
}

function previewPrimitive(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') {
    const text = JSON.stringify(value);
    return text.length > MAX_PREVIEW_STRING_LENGTH ? `${text.slice(0, MAX_PREVIEW_STRING_LENGTH)}...` : text;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Uint8Array) return `Uint8Array(${value.byteLength})`;
  if (value instanceof ArrayBuffer) return `ArrayBuffer(${value.byteLength})`;
  if (isExpandableArray(value)) return `Array(${value.length})`;
  if (isPlainObject(value)) return `{${Object.keys(value).length} keys}`;
  if (typeof value === 'bigint') return `${value.toString()}n`;
  if (typeof value === 'function') return '[Function]';
  if (typeof value === 'symbol') return value.toString();
  if (value !== null && typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return Object.prototype.toString.call(value);
    }
  }
  if (value === undefined) {
    return 'undefined';
  }
  return Object.prototype.toString.call(value);
}

function previewObject(value: Record<string, unknown>): string | null {
  const keys = Object.keys(value);
  if (keys.length === 0) return '{}';

  const fields = keys.slice(0, MAX_OBJECT_PREVIEW_FIELDS).map((key) => `${JSON.stringify(key)}:${previewPrimitive(value[key])}`);
  return `{${fields.join(',')}${keys.length > MAX_OBJECT_PREVIEW_FIELDS ? ',...' : ''}}`;
}

export function describeValue(
  value: unknown,
  maxBinaryPreviewBytes: number,
  options?: DescribeValueOptions,
): ValueVisual {
  if (isRosTime(value)) {
    return { text: formatRosTime(value), kind: 'number' };
  }
  if (value instanceof Uint8Array) {
    const previewLength =
      options?.hideBinaryHex || value.byteLength > LARGE_BINARY_THRESHOLD
        ? COMPACT_BINARY_PREVIEW_BYTES
        : Math.min(value.byteLength, maxBinaryPreviewBytes);
    const head = value.subarray(0, previewLength);
    return {
      text: `Uint8Array(${value.byteLength}) 0x${toHex(head)}${value.byteLength > head.byteLength ? '...' : ''}`,
      kind: 'binary',
    };
  }
  if (value instanceof ArrayBuffer) {
    return describeValue(new Uint8Array(value), maxBinaryPreviewBytes, options);
  }
  if (isExpandableArray(value)) return { text: `Array(${value.length})`, kind: 'array' };
  if (isPlainObject(value)) {
    return { text: previewObject(value) ?? `{${Object.keys(value).length} keys}`, kind: 'object' };
  }
  if (value === null) return { text: 'null', kind: 'null' };
  if (typeof value === 'string') return { text: JSON.stringify(value), kind: 'string' };
  if (typeof value === 'number') return { text: String(value), kind: 'number' };
  if (typeof value === 'boolean') return { text: value ? 'true' : 'false', kind: 'boolean' };
  if (typeof value === 'bigint') return { text: `${value.toString()}n`, kind: 'unknown' };
  if (typeof value === 'function') return { text: '[Function]', kind: 'unknown' };
  if (typeof value === 'symbol') return { text: value.toString(), kind: 'unknown' };
  if (value !== null && typeof value === 'object') {
    try {
      return { text: JSON.stringify(value), kind: 'unknown' };
    } catch {
      return { text: Object.prototype.toString.call(value), kind: 'unknown' };
    }
  }
  if (value === undefined) {
    return { text: 'undefined', kind: 'unknown' };
  }
  return { text: Object.prototype.toString.call(value), kind: 'unknown' };
}

function valueColor(kind: ValueKind): string {
  switch (kind) {
    case 'string':
      return 'rgb(163 230 53)'; // lime-300
    case 'number':
      return 'rgb(125 211 252)'; // sky-300
    case 'boolean':
      return 'rgb(196 181 253)'; // violet-300
    case 'null':
      return 'rgb(248 113 113)'; // red-400
    case 'binary':
      return 'rgb(251 191 36)'; // amber-400
    case 'object':
    case 'array':
      return 'rgb(203 213 225)'; // slate-300
    default:
      return 'rgb(229 231 235)'; // gray-200
  }
}

function serializeForCopy(value: unknown, binaryFormat: BinaryCopyFormat): unknown {
  if (value instanceof Uint8Array) {
    if (binaryFormat === 'hex') return { __type: 'Uint8Array', encoding: 'hex', data: toHex(value) };
    if (binaryFormat === 'base64') return { __type: 'Uint8Array', encoding: 'base64', data: toBase64(value) };
    return { __type: 'Uint8Array', data: Array.from(value) };
  }
  if (value instanceof ArrayBuffer) return serializeForCopy(new Uint8Array(value), binaryFormat);
  if (isExpandableArray(value)) {
    return Array.from(value, (entry) => serializeForCopy(entry, binaryFormat));
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) out[key] = serializeForCopy(entry, binaryFormat);
    return out;
  }
  return value;
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function applyValueVisual(node: HTMLSpanElement, visual: ValueVisual): void {
  node.textContent = visual.text;
  if (node.dataset.kind !== visual.kind) {
    node.dataset.kind = visual.kind;
    node.style.color = valueColor(visual.kind);
  }
}

const RawMessageRow = React.memo(function RawMessageRow({
  row,
  expanded,
  onToggle,
  onCopy,
  registerValueNode,
}: RawMessageRowProps) {
  const handleToggle = useCallback(() => {
    if (row.expandable) onToggle(row.path);
  }, [onToggle, row.expandable, row.path]);

  const handleCopy = useCallback(() => {
    void onCopy(row.path);
  }, [onCopy, row.path]);

  const valueRef = useCallback(
    (node: HTMLSpanElement | null) => {
      registerValueNode(row.path, node);
    },
    [registerValueNode, row.path],
  );

  return (
    <div
      className="group flex h-[22px] items-center border-b border-border/30"
      style={{ paddingLeft: row.depth * 14 }}
    >
      <button
        type="button"
        className={`mr-1 inline-flex h-4 w-4 items-center justify-center rounded ${row.expandable ? 'hover:bg-muted' : 'opacity-20'}`}
        onClick={handleToggle}
      >
        {row.expandable ? (
          <ChevronRight className={`size-3 transition-transform ${expanded ? 'rotate-90' : ''}`} />
        ) : null}
      </button>
      <span className="mr-2 text-cyan-300">{row.key}:</span>
      <span ref={valueRef} className="truncate" />
      <button
        type="button"
        className="ml-2 rounded px-1 text-[10px] text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground group-hover:opacity-100"
        onClick={handleCopy}
      >
        COPY
      </button>
    </div>
  );
});

export const RawMessagesPanel: React.FC<RawMessagesPanelProps> = ({
  player,
  panelId,
  topic,
  uiRefreshHz = 10,
  pauseUpdates = false,
  latestOnly = true,
  maxExpandedDepth = 4,
  maxRows = 2000,
  maxBinaryPreviewBytes = 256,
  binaryCopyFormat = 'uint8array',
  setConfig,
}) => {
  const { formatMessage } = useIntl();
  const topics = useMessagePipeline((state: MessagePipelineState) => state.sortedTopics);
  const didAutoPickTopicRef = useRef(false);
  const isImageTopic = useMemo(() => {
    const topicType = topics.find((entry) => entry.name === topic)?.type ?? '';
    return isRosImageSchema(topicType);
  }, [topic, topics]);

  const latestRef = useRef<MessageEvent | null>(messageBus.getLastMessage(topic));
  const pendingRef = useRef(0);
  const lastDisplayedAtRef = useRef(0);
  const pausedRef = useRef(pauseUpdates);
  const uiRefreshHzRef = useRef(uiRefreshHz);
  const latestOnlyRef = useRef(latestOnly);
  const hasMessageRef = useRef(!!messageBus.getLastMessage(topic));
  const shapeRowsRef = useRef<FlatRow[]>([]);
  const shapeSignatureRef = useRef('');
  const expandedPathsRef = useRef<Set<string>>(new Set(['message']));
  const scrollTopRef = useRef(0);
  const viewportHeightRef = useRef(240);
  const scrollWindowRef = useRef<ScrollWindow>({ startRow: 0, endRow: 0, totalRows: 0 });
  const configRef = useRef({
    maxExpandedDepth,
    maxRows,
    maxBinaryPreviewBytes,
    isImageTopic,
  });
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const valueNodeRefs = useRef<Map<string, HTMLSpanElement>>(new Map());
  const latestValueVisualRef = useRef<Map<string, ValueVisual>>(new Map());
  const pendingPatchRef = useRef<Map<string, ValueVisual>>(new Map());
  const flushPendingRef = useRef<() => void>(() => {});
  const didInitializeExpansionRef = useRef(false);

  const [hasMessage, setHasMessage] = useState(() => !!messageBus.getLastMessage(topic));
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => new Set(['message']));
  const [shapeRows, setShapeRows] = useState<FlatRow[]>([]);
  const [shapeSignature, setShapeSignature] = useState('');
  const [scrollWindow, setScrollWindow] = useState<ScrollWindow>({ startRow: 0, endRow: 0, totalRows: 0 });

  useEffect(() => {
    pausedRef.current = pauseUpdates;
  }, [pauseUpdates]);

  useEffect(() => {
    uiRefreshHzRef.current = uiRefreshHz;
  }, [uiRefreshHz]);

  useEffect(() => {
    latestOnlyRef.current = latestOnly;
  }, [latestOnly]);

  useEffect(() => {
    configRef.current = {
      maxExpandedDepth,
      maxRows,
      maxBinaryPreviewBytes,
      isImageTopic,
    };
  }, [isImageTopic, maxBinaryPreviewBytes, maxExpandedDepth, maxRows]);

  useEffect(() => {
    expandedPathsRef.current = expandedPaths;
  }, [expandedPaths]);

  useEffect(() => {
    shapeRowsRef.current = shapeRows;
  }, [shapeRows]);

  useEffect(() => {
    shapeSignatureRef.current = shapeSignature;
  }, [shapeSignature]);

  useEffect(() => {
    if (didAutoPickTopicRef.current) return;
    if (topic && topic.trim().length > 0) {
      didAutoPickTopicRef.current = true;
      return;
    }
    if (topics.length === 0) return;
    const autoTopic = pickDefaultRawMessagesTopic(topics);
    if (!autoTopic) return;
    didAutoPickTopicRef.current = true;
    setConfig((prev) => ({ ...prev, topic: autoTopic }));
  }, [setConfig, topic, topics]);

  useEffect(() => {
    if (!topic || topic.trim().length === 0) {
      player.unregisterSubscriptions(panelId);
      return;
    }
    player.registerSubscriptions(panelId, [{ topic, subscriberId: panelId }]);
    return () => player.unregisterSubscriptions(panelId);
  }, [player, panelId, topic]);

  const applyDomPatch = useCallback(() => {
    for (const [path, visual] of pendingPatchRef.current) {
      const node = valueNodeRefs.current.get(path);
      if (node) {
        applyValueVisual(node, visual);
      }
    }
    pendingPatchRef.current.clear();
  }, []);

  const patchVisibleValues = useCallback(
    (message: MessageEvent) => {
      const visible = getVisibleRows(shapeRowsRef.current, expandedPathsRef.current);
      const { startRow, endRow } = scrollWindowRef.current;
      const patchRows = visible.slice(startRow, endRow);
      const maxPatchRows = Math.min(patchRows.length, MAX_VISIBLE_PATCH_ROWS);
      const { maxBinaryPreviewBytes: previewBytes, isImageTopic: hideHex } = configRef.current;

      for (let i = 0; i < maxPatchRows; i++) {
        const row = patchRows[i];
        if (!row) continue;
        const value = readValueAtPath(message, row.path);
        const visual = describeValue(value, previewBytes, { hideBinaryHex: hideHex });
        latestValueVisualRef.current.set(row.path, visual);
        const previousText = valueNodeRefs.current.get(row.path)?.textContent ?? null;
        if (previousText !== visual.text) {
          pendingPatchRef.current.set(row.path, visual);
        }
      }

      if (pendingPatchRef.current.size > 0) {
        scheduleFrame(applyDomPatch);
      }
    },
    [applyDomPatch],
  );

  const applyScrollWindow = useCallback(() => {
    const visible = getVisibleRows(shapeRowsRef.current, expandedPathsRef.current);
    const totalRows = visible.length;
    const nextWindow = computeScrollWindow(scrollTopRef.current, viewportHeightRef.current, totalRows);
    const next: ScrollWindow = { ...nextWindow, totalRows };

    setScrollWindow((prev) => {
      if (
        prev.startRow === next.startRow &&
        prev.endRow === next.endRow &&
        prev.totalRows === next.totalRows
      ) {
        return prev;
      }
      scrollWindowRef.current = next;
      return next;
    });
  }, []);

  const flushPending = useCallback(() => {
    const now = performance.now();
    const minInterval = 1000 / Math.max(1, uiRefreshHzRef.current);

    if (pausedRef.current) {
      return;
    }

    if (pendingRef.current <= 0) {
      return;
    }

    if (now - lastDisplayedAtRef.current < minInterval) {
      scheduleFrame(() => {
        flushPendingRef.current();
      });
      return;
    }

    pendingRef.current = 0;
    lastDisplayedAtRef.current = now;

    const message = latestRef.current;
    if (!message) {
      return;
    }

    const { maxExpandedDepth: depth, maxRows: rowLimit } = configRef.current;
    const nextShape = buildRowsForMessageEvent(message, depth, rowLimit);
    if (nextShape.signature !== shapeSignatureRef.current) {
      shapeSignatureRef.current = nextShape.signature;
      shapeRowsRef.current = nextShape.rows;
      setShapeRows(nextShape.rows);
      setShapeSignature(nextShape.signature);

      if (!didInitializeExpansionRef.current) {
        const nextExpanded = new Set<string>(['message']);
        for (const row of nextShape.rows) {
          if (row.depth === 1 && row.expandable && row.path.startsWith('message.')) {
            nextExpanded.add(row.path);
          }
        }
        expandedPathsRef.current = nextExpanded;
        setExpandedPaths(nextExpanded);
        didInitializeExpansionRef.current = true;
      }

      applyScrollWindow();
      scheduleFrame(() => {
        if (latestRef.current) {
          patchVisibleValues(latestRef.current);
        }
      });
      return;
    }

    patchVisibleValues(message);
  }, [applyScrollWindow, patchVisibleValues]);

  useEffect(() => {
    flushPendingRef.current = flushPending;
  });

  useEffect(() => {
    if (!pauseUpdates && pendingRef.current > 0) {
      scheduleFrame(flushPending);
    }
  }, [flushPending, pauseUpdates]);

  useEffect(() => {
    latestRef.current = messageBus.getLastMessage(topic);
    pendingRef.current = 0;
    lastDisplayedAtRef.current = performance.now();

    const initial = latestRef.current;
    if (initial) {
      pendingRef.current = 1;
      scheduleFrame(flushPending);
    }

    const unsubscribe = messageBus.subscribeTopic(topic, () => {
      latestRef.current = messageBus.getLastMessage(topic);
      pendingRef.current = latestOnlyRef.current ? 1 : pendingRef.current + 1;
      if (latestRef.current && !hasMessageRef.current) {
        hasMessageRef.current = true;
        setHasMessage(true);
      }
      scheduleFrame(flushPending);
    });

    return unsubscribe;
  }, [flushPending, topic]);

  useEffect(() => {
    if (!viewportRef.current) return;

    let cancelScheduledResize: (() => void) | null = null;
    const observer = new ResizeObserver((entries) => {
      const height = entries[0]?.contentRect.height;
      if (!height || height <= 0) return;
      viewportHeightRef.current = height;
      cancelScheduledResize?.();
      cancelScheduledResize = scheduleFrame(applyScrollWindow);
    });

    observer.observe(viewportRef.current);
    return () => {
      cancelScheduledResize?.();
      observer.disconnect();
    };
  }, [applyScrollWindow]);

  useEffect(() => {
    latestRef.current = messageBus.getLastMessage(topic);
    hasMessageRef.current = !!latestRef.current;
    setHasMessage(!!latestRef.current);
    setShapeSignature('');
    setShapeRows([]);
    shapeRowsRef.current = [];
    shapeSignatureRef.current = '';
    latestValueVisualRef.current.clear();
    valueNodeRefs.current.clear();
    pendingPatchRef.current.clear();
    scrollTopRef.current = 0;
    scrollWindowRef.current = { startRow: 0, endRow: 0, totalRows: 0 };
    setScrollWindow({ startRow: 0, endRow: 0, totalRows: 0 });
    expandedPathsRef.current = new Set(['message']);
    setExpandedPaths(new Set(['message']));
    didInitializeExpansionRef.current = false;
    pendingRef.current = latestRef.current ? 1 : 0;
    lastDisplayedAtRef.current = performance.now();
    if (latestRef.current) {
      scheduleFrame(flushPending);
    }
  }, [flushPending, topic]);

  useEffect(() => {
    applyScrollWindow();
  }, [applyScrollWindow, expandedPaths, shapeRows]);

  useEffect(() => {
    if (!latestRef.current) return;
    latestValueVisualRef.current.clear();
    pendingRef.current = Math.max(pendingRef.current, 1);
    scheduleFrame(flushPending);
  }, [flushPending, isImageTopic, maxBinaryPreviewBytes, maxExpandedDepth, maxRows]);

  const visibleRows = useMemo(() => {
    if (shapeRows.length === 0) return [];
    return getVisibleRows(shapeRows, expandedPaths);
  }, [expandedPaths, shapeRows]);

  const windowRows = visibleRows.slice(scrollWindow.startRow, scrollWindow.endRow);

  const registerValueNode = useCallback((path: string, node: HTMLSpanElement | null) => {
    if (node) {
      valueNodeRefs.current.set(path, node);
      let initial = latestValueVisualRef.current.get(path);
      if (initial == null && latestRef.current) {
        const value = readValueAtPath(latestRef.current, path);
        const { maxBinaryPreviewBytes: previewBytes, isImageTopic: hideHex } = configRef.current;
        initial = describeValue(value, previewBytes, { hideBinaryHex: hideHex });
        latestValueVisualRef.current.set(path, initial);
      }
      if (initial != null) {
        applyValueVisual(node, initial);
      }
    } else {
      valueNodeRefs.current.delete(path);
    }
  }, []);

  const toggleExpand = useCallback((path: string) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      expandedPathsRef.current = next;
      return next;
    });
  }, []);

  const copyField = useCallback(
    async (path: string) => {
      const value = readValueAtPath(latestRef.current, path);
      const serialized = serializeForCopy(value, binaryCopyFormat);
      const text =
        typeof serialized === 'string' || typeof serialized === 'number' || typeof serialized === 'boolean'
          ? String(serialized)
          : (JSON.stringify(serialized, null, 2) ?? 'undefined');
      const ok = await copyText(text);
      if (ok) {
        toast.success(formatMessage({ id: 'panels.rawMessages.copy.success' }, { path }));
      } else {
        toast.error(formatMessage({ id: 'panels.rawMessages.copy.error' }));
      }
    },
    [binaryCopyFormat, formatMessage],
  );

  const handleScroll = useCallback(
    (event: React.UIEvent<HTMLDivElement>) => {
      scrollTopRef.current = event.currentTarget.scrollTop;
      scheduleFrame(applyScrollWindow);
    },
    [applyScrollWindow],
  );

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      <PanelTopicBar>
        <TopicQuickPicker
          value={topic}
          topics={topics}
          onChange={(nextTopic) => setConfig((prev) => ({ ...prev, topic: nextTopic }))}
          placeholder={formatMessage({ id: 'panels.framework.topicPicker.placeholder' })}
          className="min-w-0 w-full"
        />
      </PanelTopicBar>

      <div
        ref={viewportRef}
        className="min-h-0 flex-1 overflow-auto p-2 font-mono text-[11px]"
        onScroll={handleScroll}
      >
        {hasMessage && scrollWindow.totalRows > 0 ? (
          <div style={{ height: scrollWindow.totalRows * ROW_HEIGHT, position: 'relative' }}>
            <div style={{ transform: `translateY(${scrollWindow.startRow * ROW_HEIGHT}px)` }}>
              {windowRows.map((row) => (
                <RawMessageRow
                  key={row.id}
                  row={row}
                  expanded={expandedPaths.has(row.path)}
                  onToggle={toggleExpand}
                  onCopy={copyField}
                  registerValueNode={registerValueNode}
                />
              ))}
            </div>
          </div>
        ) : (
          <div className="flex h-full items-center justify-center text-xs italic text-muted-foreground">
            Waiting for messages...
          </div>
        )}
      </div>
    </div>
  );
};

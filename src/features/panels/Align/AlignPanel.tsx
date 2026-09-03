import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import { useShallow } from 'zustand/react/shallow';
import { messageBus } from '@/core/pipeline/messageBus';
import { useSubscriberSeq } from '@/core/pipeline/useMessageBus';
import { useMessagePipeline } from '@/core/pipeline/useMessagePipeline';
import type { MessagePipelineState } from '@/core/pipeline/store';
import type { Player } from '@/core/types/player';
import type { Time } from '@/core/types/ros';
import { isRosImageSchema } from '@/shared/ros/rosMessageTypes';
import { addMs, formatLocalTimestamp, fromNano, toNano } from '@/shared/utils/time';
import { scheduleFrame } from '@/shared/utils/rafScheduler';
import {
  filterPointsInWindow,
  formatOffsetMs,
  messageToAlignPoint,
  type AlignPoint,
} from './core/alignTimeUtils';
import type { AlignConfig } from './defaults';

const MAX_POINTS = 60_000;
/** Top/bottom padding inside the plot (no toolbar or lane labels). */
const PLOT_MARGIN_Y = 6;

function pointDedupeKey(p: AlignPoint): string {
  return `${p.topic}|${p.plotNs.toString()}|${p.receiveNs.toString()}`;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

export type AlignPanelProps = AlignConfig & {
  player: Player;
  panelId: string;
  setConfig: (next: AlignConfig | ((prev: AlignConfig) => AlignConfig)) => void;
};

export const AlignPanel: React.FC<AlignPanelProps> = (props) => {
  const { player, panelId, setConfig, topics: configTopics, timeMode, windowHalfMs, dotRadius, dotOpacity } = props;
  const { formatMessage } = useIntl();

  const { sortedTopics, startTime, endTime } = useMessagePipeline(
    useShallow((state: MessagePipelineState) => ({
      sortedTopics: state.sortedTopics,
      startTime: state.playerState.activeData?.startTime,
      endTime: state.playerState.activeData?.endTime,
    })),
  );

  const centerTimeRef = useRef<Time>(player.getCurrentTime() ?? { sec: 0, nsec: 0 });
  const [centerTick, setCenterTick] = useState(0);
  const isPlaying = useMessagePipeline((state) => state.playerState.activeData?.isPlaying ?? false);
  const fetchAbortRef = useRef<AbortController | null>(null);

  const imageTopicNames = useMemo(
    () => sortedTopics.filter((t) => isRosImageSchema(t.type)).map((t) => t.name),
    [sortedTopics],
  );

  const activeTopics = useMemo(() => {
    if (configTopics.length > 0) {
      const set = new Set(imageTopicNames);
      return configTopics.filter((t) => set.has(t));
    }
    return imageTopicNames;
  }, [configTopics, imageTopicNames]);

  const activeTopicsKey = activeTopics.join('\0');

  useEffect(() => {
    const subs = activeTopics.map((topic) => ({ topic, subscriberId: panelId }));
    if (subs.length > 0) {
      player.registerSubscriptions(panelId, subs);
    }
    return () => {
      player.unregisterSubscriptions(panelId);
    };
  }, [player, panelId, activeTopicsKey, activeTopics]);

  const panelSeq = useSubscriberSeq(panelId);

  const [points, setPoints] = useState<AlignPoint[]>([]);
  const [hover, setHover] = useState<{
    x: number;
    y: number;
    point: AlignPoint;
    centerTime: Time;
  } | null>(null);
  const [containerSize, setContainerSize] = useState({ w: 300, h: 120 });

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const debounceTimerRef = useRef<number | undefined>(undefined);
  const lastRangeFetchKeyRef = useRef<string>('');

  useEffect(() => {
    return player.subscribeCurrentTime((time) => {
      const previous = centerTimeRef.current;
      centerTimeRef.current = time;
      const previousNs = toNano(previous);
      const nextNs = toNano(time);
      const jumped = nextNs + 5_000_000n < previousNs || nextNs > previousNs + 200_000_000n;
      if (isPlaying && !jumped) {
        return;
      }
      if (debounceTimerRef.current != null) {
        window.clearTimeout(debounceTimerRef.current);
      }
      debounceTimerRef.current = window.setTimeout(() => {
        debounceTimerRef.current = undefined;
        setCenterTick((v) => v + 1);
      }, 180);
    });
  }, [isPlaying, player]);

  const wasPlayingRef = useRef(isPlaying);
  useEffect(() => {
    const wasPlaying = wasPlayingRef.current;
    wasPlayingRef.current = isPlaying;
    if (wasPlaying && !isPlaying) {
      setCenterTick((value) => value + 1);
    }
  }, [isPlaying]);

  const fetchRange = useCallback(async () => {
    if (activeTopics.length === 0 || !player.getMessagesInTimeRange) {
      lastRangeFetchKeyRef.current = '';
      setPoints([]);
      return;
    }
    const center = centerTimeRef.current;
    const start = addMs(center, -windowHalfMs);
    const end = addMs(center, windowHalfMs);
    const key = `${activeTopicsKey}|${windowHalfMs}|${timeMode}|${start.sec}:${start.nsec}|${end.sec}:${end.nsec}`;
    if (key === lastRangeFetchKeyRef.current) {
      return;
    }
    fetchAbortRef.current?.abort();
    const controller = new AbortController();
    fetchAbortRef.current = controller;
    try {
      const msgs = await player.getMessagesInTimeRange({
        start,
        end,
        topics: activeTopics,
        signal: controller.signal,
      });
      if (controller.signal.aborted) {
        return;
      }
      lastRangeFetchKeyRef.current = key;
      const next = msgs.map((m) => messageToAlignPoint(m, timeMode));
      setPoints(next);
    } catch (e) {
      if (controller.signal.aborted || (e instanceof DOMException && e.name === 'AbortError')) {
        return;
      }
      console.warn('AlignPanel: range read failed', e);
    }
  }, [activeTopics, activeTopicsKey, player, timeMode, windowHalfMs]);

  useEffect(() => {
    void fetchRange();
  }, [fetchRange, centerTick, startTime, endTime]);

  useEffect(() => {
    if (activeTopics.length === 0) {
      return;
    }
    const batch = messageBus.getSubscriberMessages(panelId);
    if (!batch || batch.length === 0) {
      return;
    }
    const topicSet = new Set(activeTopics);
    const centerNs = toNano(centerTimeRef.current);
    const halfWindowNs = BigInt(Math.round(windowHalfMs * 1_000_000));
    const incoming = batch
      .filter((m) => topicSet.has(m.topic))
      .map((m) => messageToAlignPoint(m, timeMode));

    setPoints((prev) => {
      const map = new Map<string, AlignPoint>();
      for (const p of prev) {
        map.set(pointDedupeKey(p), p);
      }
      for (const p of incoming) {
        map.set(pointDedupeKey(p), p);
      }
      let merged = [...map.values()];
      merged = filterPointsInWindow(merged, centerNs, halfWindowNs);
      if (merged.length > MAX_POINTS) {
        merged = merged.slice(merged.length - MAX_POINTS);
      }
      return merged;
    });
  }, [panelSeq, panelId, activeTopics, timeMode, windowHalfMs]);

  const laneTopics = useMemo(() => [...activeTopics].sort((a, b) => a.localeCompare(b)), [activeTopics]);

  const paint = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) {
      return;
    }
    const rect = container.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const cssW = Math.max(1, rect.width);
    const cssH = Math.max(1, rect.height);
    if (canvas.width !== Math.floor(cssW * dpr) || canvas.height !== Math.floor(cssH * dpr)) {
      canvas.width = Math.floor(cssW * dpr);
      canvas.height = Math.floor(cssH * dpr);
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const isDark = document.documentElement.classList.contains('dark');
    const bg = isDark ? '#0a0a0a' : '#f8fafc';
    const grid = isDark ? '#27272a' : '#e2e8f0';
    const accent = isDark ? '#38bdf8' : '#0284c7';

    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, cssW, cssH);

    const plotY = PLOT_MARGIN_Y;
    const plotH = Math.max(1, cssH - PLOT_MARGIN_Y * 2);
    const centerNs = toNano(centerTimeRef.current);
    const halfWindowNs = BigInt(Math.round(windowHalfMs * 1_000_000));
    const windowStartNs = centerNs - halfWindowNs;
    const windowSpanNs = halfWindowNs * 2n;
    const spanNumber = Number(windowSpanNs);
    const laneCount = Math.max(1, laneTopics.length);
    const laneH = plotH / laneCount;

    ctx.strokeStyle = grid;
    ctx.lineWidth = 1;
    for (let i = 0; i <= laneCount; i++) {
      const y = plotY + i * laneH;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(cssW, y);
      ctx.stroke();
    }

    const cx = cssW / 2;
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(cx, plotY);
    ctx.lineTo(cx, plotY + plotH);
    ctx.stroke();

    const topicIndex = new Map(laneTopics.map((t, i) => [t, i]));
    ctx.fillStyle = accent;
    ctx.globalAlpha = dotOpacity;
    for (const p of points) {
      const lane = topicIndex.get(p.topic);
      if (lane == null) {
        continue;
      }
      const rel = Number(p.plotNs - windowStartNs) / spanNumber;
      const x = rel * cssW;
      const yCenter = plotY + lane * laneH + laneH / 2;
      if (x < -2 || x > cssW + 2) {
        continue;
      }
      ctx.beginPath();
      ctx.arc(x, yCenter, dotRadius, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    if (hover) {
      ctx.strokeStyle = isDark ? '#fbbf24' : '#d97706';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(hover.x, hover.y, 6, 0, Math.PI * 2);
      ctx.stroke();
    }
  }, [dotOpacity, dotRadius, hover, laneTopics, points, windowHalfMs]);

  useEffect(() => {
    paint();
  }, [paint, centerTick, points, hover]);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) {
      return;
    }
    const syncSize = () => {
      const { clientWidth, clientHeight } = el;
      setContainerSize((prev) =>
        prev.w === clientWidth && prev.h === clientHeight ? prev : { w: clientWidth, h: clientHeight },
      );
    };
    syncSize();
    const ro = new ResizeObserver(() => {
      syncSize();
      scheduleFrame(paint);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [paint]);

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    const rect = container.getBoundingClientRect();
    const cssW = Math.max(1, rect.width);
    const cssH = Math.max(1, rect.height);
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;

    const plotY = PLOT_MARGIN_Y;
    const plotH = Math.max(1, cssH - PLOT_MARGIN_Y * 2);
    const centerNs = toNano(centerTimeRef.current);
    const halfWindowNs = BigInt(Math.round(windowHalfMs * 1_000_000));
    const windowStartNs = centerNs - halfWindowNs;
    const windowSpanNs = halfWindowNs * 2n;
    const spanNumber = Number(windowSpanNs);
    const laneCount = Math.max(1, laneTopics.length);
    const laneH = plotH / laneCount;
    const topicIndex = new Map(laneTopics.map((t, i) => [t, i]));

    let best: { dist: number; x: number; y: number; point: AlignPoint } | null = null;
    const hitR = 10;
    for (const p of points) {
      const lane = topicIndex.get(p.topic);
      if (lane == null) {
        continue;
      }
      const rel = Number(p.plotNs - windowStartNs) / spanNumber;
      const x = rel * cssW;
      const y = plotY + lane * laneH + laneH / 2;
      const dx = px - x;
      const dy = py - y;
      const dist = Math.hypot(dx, dy);
      if (dist <= hitR && (!best || dist < best.dist)) {
        best = { dist, x, y, point: p };
      }
    }
    setHover(
      best
        ? { x: best.x, y: best.y, point: best.point, centerTime: centerTimeRef.current }
        : null,
    );
  };

  const onWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    e.preventDefault();
    const factor = e.deltaY > 0 ? 1.12 : 1 / 1.12;
    setConfig((c) => ({
      ...c,
      windowHalfMs: clamp(Math.round(c.windowHalfMs * factor), 50, 30_000),
    }));
    lastRangeFetchKeyRef.current = '';
  };

  return (
    <div
      ref={containerRef}
      className="flex flex-col h-full min-h-0 bg-background text-foreground border-t border-border/60"
      onWheel={onWheel}
    >
      <div className="relative flex-1 min-h-0">
        <canvas
          ref={canvasRef}
          className="absolute inset-0 w-full h-full block touch-none"
          onPointerMove={onPointerMove}
          onPointerLeave={() => setHover(null)}
        />
        {hover ? (
          <div
            className="absolute z-20 pointer-events-none rounded border border-border bg-card/95 px-2 py-1 text-[10px] font-mono shadow max-w-[min(360px,90vw)]"
            style={{
              left: clamp(hover.x + 8, 4, containerSize.w - 200),
              top: clamp(hover.y + 8, 4, containerSize.h - 80),
            }}
          >
            <div className="font-semibold truncate" title={hover.point.topic}>
              {hover.point.topic}
            </div>
            <div>
              {formatMessage(
                { id: 'panels.align.overlay.plot' },
                { value: formatOffsetMs(hover.point.plotNs, toNano(hover.centerTime)) },
              )}
            </div>
            <div>
              {formatMessage(
                { id: 'panels.align.overlay.receive' },
                { value: formatLocalTimestamp(fromNano(hover.point.receiveNs)) },
              )}
            </div>
            {hover.point.stampNs != null ? (
              <div>
                {formatMessage(
                  { id: 'panels.align.overlay.stamp' },
                  { value: formatLocalTimestamp(fromNano(hover.point.stampNs)) },
                )}
              </div>
            ) : (
              <div className="text-muted-foreground">{formatMessage({ id: 'panels.align.overlay.stampNone' })}</div>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
};

import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import type { ClockEvidenceWindow, ClockPoint, DataQualityIssueRange, Time } from '@/core/types/ros';
import { formatRelativeTime, fromNano, toNano } from '@/shared/utils/time';

interface QualityIssueChartProps {
  range: DataQualityIssueRange;
  evidenceWindow?: ClockEvidenceWindow;
  timelineStart?: Time;
}

const VIEW_H = 108;
const DEFAULT_PLOT_W = 320;
const MIN_PLOT_W = 120;
const PAD_X = 12;
const PAD_Y = 10;

export type QualityChartPoint = {
  zone: 'before' | 'anomaly' | 'after';
  index: number;
  order: number;
  logTimeNs?: bigint;
  timeNs: bigint;
  deltaMs?: number;
  deviationMs: number;
  isRollback: boolean;
  isDroppedEstimate: boolean;
  isAnomaly: boolean;
};

type MappedPoint = {
  index: number;
  point: QualityChartPoint;
  x: number;
  y: number;
};

function msFromNs(ns?: string): number | undefined {
  if (!ns) return undefined;
  return Number(BigInt(ns)) / 1e6;
}

function pointLogNs(point: ClockPoint, fallbackIndex: number): bigint {
  return point.logTimeNs ? BigInt(point.logTimeNs) : BigInt(point.index ?? fallbackIndex) * 1_000_000n;
}

function formatSignedMs(value: number): string {
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(Math.abs(value) >= 10 ? 0 : 1)} ms`;
}

function formatTooltip(point: QualityChartPoint, timelineStartNs?: bigint): string {
  const time = point.logTimeNs ?? point.timeNs;
  const timeText =
    timelineStartNs != undefined
      ? formatRelativeTime(fromNano(time), fromNano(timelineStartNs))
      : formatRelativeTime(fromNano(time), fromNano(0n));
  return `${timeText} · ${formatSignedMs(point.deviationMs)}`;
}

export function buildQualityChartPoints(
  evidenceWindow: ClockEvidenceWindow,
  baselineMs?: number,
): QualityChartPoint[] {
  const raw = [
    ...(evidenceWindow.beforeNormal ?? []).map((point) => ({ point, zone: 'before' as const })),
    ...(evidenceWindow.anomaly ?? []).map((point) => ({ point, zone: 'anomaly' as const })),
    ...(evidenceWindow.afterNormal ?? []).map((point) => ({ point, zone: 'after' as const })),
  ].sort((a, b) => {
    const aLog = pointLogNs(a.point, a.point.index);
    const bLog = pointLogNs(b.point, b.point.index);
    return aLog < bLog ? -1 : aLog > bLog ? 1 : a.point.index - b.point.index;
  });

  if (raw.length === 0) return [];
  return raw.map(({ point, zone }, fallbackIndex): QualityChartPoint => {
    const logTimeNs = point.logTimeNs ? BigInt(point.logTimeNs) : undefined;
    const timeNs = BigInt(point.timeNs);
    return {
      zone,
      index: point.index,
      order: fallbackIndex,
      logTimeNs,
      timeNs,
      deltaMs: point.deltaNs ? Number(BigInt(point.deltaNs)) / 1e6 : undefined,
      deviationMs:
        point.deltaNs != undefined
          ? Number(BigInt(point.deltaNs)) / 1e6 - (baselineMs ?? 0)
          : 0,
      isRollback: point.isRollback ?? false,
      isDroppedEstimate: point.isDroppedEstimate ?? false,
      isAnomaly: point.isAnomaly ?? zone === 'anomaly',
    };
  });
}

export const QualityIssueChart: React.FC<QualityIssueChartProps> = React.memo(function QualityIssueChart({
  range,
  evidenceWindow,
  timelineStart,
}) {
  const { formatMessage } = useIntl();
  const plotHostRef = useRef<HTMLDivElement>(null);
  const [plotW, setPlotW] = useState(DEFAULT_PLOT_W);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [tooltip, setTooltip] = useState<{ x: number; y: number; label: string } | undefined>();
  const [zoomDomain, setZoomDomain] = useState<{ minOrder: number; maxOrder: number } | undefined>();
  const [dragSelection, setDragSelection] = useState<{ startX: number; currentX: number } | undefined>();
  const baselineMs = msFromNs(range.summaryStats?.baselineIntervalNs);

  useLayoutEffect(() => {
    const el = plotHostRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w != undefined && w > 0) {
        setPlotW(Math.max(MIN_PLOT_W, Math.floor(w)));
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const activeEvidence = evidenceWindow ?? range.evidenceWindow;

  const points = useMemo(
    () => buildQualityChartPoints(activeEvidence, baselineMs),
    [activeEvidence, baselineMs],
  );

  useEffect(() => {
    setHoverIndex(null);
    setTooltip(undefined);
    setZoomDomain(undefined);
    setDragSelection(undefined);
  }, [activeEvidence, range.id]);

  const visiblePoints = useMemo(() => {
    if (!zoomDomain) return points;
    const filtered = points.filter((point) => point.order >= zoomDomain.minOrder && point.order <= zoomDomain.maxOrder);
    return filtered.length > 0 ? filtered : points;
  }, [points, zoomDomain]);

  const geometry = useMemo(() => {
    if (visiblePoints.length === 0) {
      return {
        mapped: [] as MappedPoint[],
        segments: [],
        minOrder: 0,
        maxOrder: 1,
        zeroY: undefined as number | undefined,
      };
    }
    const minOrder = visiblePoints.reduce((acc, point) => Math.min(acc, point.order), visiblePoints[0].order);
    const maxOrder0 = visiblePoints.reduce((acc, point) => Math.max(acc, point.order), visiblePoints[0].order);
    const maxOrder = maxOrder0 > minOrder ? maxOrder0 : minOrder + 1;
    const minDeviation = Math.min(0, ...visiblePoints.map((point) => point.deviationMs));
    const maxDeviation = Math.max(0, ...visiblePoints.map((point) => point.deviationMs));
    const span = Math.max(1, maxDeviation - minDeviation);
    const y0 = minDeviation - span * 0.14;
    const y1 = maxDeviation + span * 0.14;
    const dy = Math.max(1, y1 - y0);
    const innerW = plotW - PAD_X * 2;
    const innerH = VIEW_H - PAD_Y * 2;
    const xOf = (order: number) => PAD_X + ((order - minOrder) / (maxOrder - minOrder)) * innerW;
    const yOf = (value: number) => PAD_Y + (1 - (value - y0) / dy) * innerH;
    const mapped = visiblePoints.map((point, index) => ({
      index,
      point,
      x: xOf(point.order),
      y: yOf(point.deviationMs),
    }));
    const zeroY = yOf(0);
    const segments = mapped.slice(1).map((curr, idx) => {
      const prev = mapped[idx];
      return {
        from: prev,
        to: curr,
        isRollback: curr.point.deltaMs != undefined && curr.point.deltaMs < 0,
        isGap: curr.point.deviationMs > 0 && curr.point.isAnomaly,
        isAnomaly: curr.point.isAnomaly || prev.point.isAnomaly,
      };
    });
    return { mapped, segments, minOrder, maxOrder, zeroY };
  }, [visiblePoints, plotW]);

  const viewXFromClient = (xClient: number, host: HTMLDivElement): number => {
    const rect = host.getBoundingClientRect();
    if (rect.width <= 0) return 0;
    return Math.min(plotW, Math.max(0, ((xClient - rect.left) / rect.width) * plotW));
  };

  const orderFromViewX = (x: number): number => {
    const innerW = plotW - PAD_X * 2;
    const clamped = Math.min(PAD_X + innerW, Math.max(PAD_X, x));
    const ratio = (clamped - PAD_X) / innerW;
    return geometry.minOrder + (geometry.maxOrder - geometry.minOrder) * ratio;
  };

  const nearestPoint = (xClient: number, host: HTMLDivElement): number | null => {
    if (geometry.mapped.length === 0) return null;
    const xInView = viewXFromClient(xClient, host);
    let bestIndex = 0;
    let bestDist = Number.POSITIVE_INFINITY;
    for (const item of geometry.mapped) {
      const dist = Math.abs(item.x - xInView);
      if (dist < bestDist) {
        bestDist = dist;
        bestIndex = item.index;
      }
    }
    return bestIndex;
  };

  const hoverMapped = hoverIndex == undefined || hoverIndex < 0 ? undefined : geometry.mapped[hoverIndex];
  const timelineStartNs = timelineStart ? toNano(timelineStart) : undefined;
  const beforeCount = activeEvidence.beforeNormal.length;
  const anomalyCount = activeEvidence.anomaly.length;
  const afterCount = activeEvidence.afterNormal.length;
  const selectionRect = dragSelection
    ? {
        x: Math.min(dragSelection.startX, dragSelection.currentX),
        width: Math.abs(dragSelection.currentX - dragSelection.startX),
      }
    : undefined;
  const axisLabel = formatMessage({ id: 'quality.chart.axis.deviation' });

  return (
    <div className="w-full">
      <div className="mb-1 flex items-center justify-between gap-2 px-0.5 text-[10px] text-muted-foreground">
        <span>{axisLabel}</span>
        <div className="flex items-center gap-2">
          {zoomDomain ? (
            <button
              type="button"
              className="rounded border border-border/60 px-1 text-[10px] text-foreground hover:bg-accent"
              onClick={(event) => {
                event.stopPropagation();
                setZoomDomain(undefined);
              }}
            >
              {formatMessage({ id: 'quality.chart.resetZoom' })}
            </button>
          ) : (
            <span>{formatMessage({ id: 'quality.chart.zoomHint' })}</span>
          )}
          <span className="font-mono" data-testid="quality-chart-balanced-legend">
            {formatMessage(
              { id: 'quality.chart.balancedLegend' },
              { b: beforeCount, a: anomalyCount, n: afterCount },
            )}
          </span>
        </div>
      </div>
      <div
        ref={plotHostRef}
        className="relative h-[108px] w-full min-w-0 cursor-crosshair select-none rounded border border-border/60 bg-background/70"
        data-testid="quality-issue-chart"
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={() => setZoomDomain(undefined)}
        onMouseDown={(event) => {
          if (geometry.mapped.length < 2) return;
          const host = event.currentTarget;
          const x = viewXFromClient(event.clientX, host);
          setDragSelection({ startX: x, currentX: x });
        }}
        onMouseLeave={() => {
          if (!dragSelection) {
            setHoverIndex(null);
            setTooltip(undefined);
          }
        }}
        onMouseMove={(event) => {
          const host = event.currentTarget;
          if (dragSelection) {
            setDragSelection((prev) => (prev ? { ...prev, currentX: viewXFromClient(event.clientX, host) } : prev));
          }
          const next = nearestPoint(event.clientX, host);
          setHoverIndex((prev) => (prev === next ? prev : next));
          const mapped = next == undefined ? undefined : geometry.mapped[next];
          setTooltip(
            mapped
              ? {
                  x: mapped.x,
                  y: mapped.y,
                  label: formatTooltip(mapped.point, timelineStartNs),
                }
              : undefined,
          );
        }}
        onMouseUp={() => {
          if (!dragSelection) return;
          if (selectionRect && selectionRect.width > 8) {
            const start = orderFromViewX(selectionRect.x);
            const end = orderFromViewX(selectionRect.x + selectionRect.width);
            const minOrder = Math.floor(Math.min(start, end));
            const maxOrder = Math.ceil(Math.max(start, end));
            if (maxOrder > minOrder) {
              setZoomDomain({ minOrder, maxOrder });
              setHoverIndex(null);
              setTooltip(undefined);
            }
          }
          setDragSelection(undefined);
        }}
      >
        {geometry.mapped.length === 0 ? (
          <div className="h-full rounded border border-dashed border-border/60 bg-muted/20" />
        ) : (
          <svg viewBox={`0 0 ${plotW} ${VIEW_H}`} className="h-full w-full">
            <rect x={0} y={0} width={plotW} height={VIEW_H} className="fill-background/40" />
            {selectionRect && selectionRect.width > 0 && (
              <rect
                x={selectionRect.x}
                y={0}
                width={selectionRect.width}
                height={VIEW_H}
                className="fill-primary/15 stroke-primary/60"
                strokeWidth={1}
              />
            )}
            <line x1={0} y1={VIEW_H * 0.33} x2={plotW} y2={VIEW_H * 0.33} className="stroke-border/30" strokeWidth={1} />
            <line x1={0} y1={VIEW_H * 0.66} x2={plotW} y2={VIEW_H * 0.66} className="stroke-border/30" strokeWidth={1} />
            {geometry.zeroY != undefined && geometry.zeroY < VIEW_H && (
              <>
                {range.type === 'timestamp_rollback' && (
                  <rect
                    x={0}
                    y={geometry.zeroY}
                    width={plotW}
                    height={Math.max(0, VIEW_H - geometry.zeroY)}
                    className="fill-destructive/10"
                  />
                )}
                {range.type !== 'timestamp_rollback' && (
                  <rect
                    x={0}
                    y={0}
                    width={plotW}
                    height={Math.max(0, geometry.zeroY)}
                    className="fill-transparent"
                  />
                )}
                <line
                  x1={0}
                  y1={geometry.zeroY}
                  x2={plotW}
                  y2={geometry.zeroY}
                  className="stroke-primary/50"
                  strokeWidth={1}
                  strokeDasharray="4 3"
                />
              </>
            )}
            {geometry.segments.map((segment, idx) => (
              <line
                key={`seg-${idx}`}
                x1={segment.from.x}
                y1={segment.from.y}
                x2={segment.to.x}
                y2={segment.to.y}
                stroke={
                  segment.isRollback
                    ? 'hsl(var(--destructive))'
                    : segment.isGap
                      ? '#f59e0b'
                      : segment.isAnomaly
                      ? '#f59e0b'
                      : 'hsl(var(--muted-foreground))'
                }
                strokeWidth={segment.isRollback || segment.isAnomaly ? 2.4 : 1.7}
                strokeLinecap="round"
              />
            ))}
            {geometry.mapped.map((item, idx) => (
              <circle
                key={`pt-${idx}`}
                cx={item.x}
                cy={item.y}
                r={item.point.isAnomaly ? 2.7 : 1.8}
                className={
                  item.point.deltaMs != undefined && item.point.deltaMs < 0
                    ? 'fill-destructive'
                    : item.point.isAnomaly
                      ? 'fill-amber-500'
                    : item.point.zone === 'before'
                      ? 'fill-emerald-500/80'
                      : 'fill-cyan-500/80'
                }
              />
            ))}
            {hoverMapped && (
              <>
                <line
                  x1={hoverMapped.x}
                  y1={0}
                  x2={hoverMapped.x}
                  y2={VIEW_H}
                  className="stroke-primary/50"
                  strokeWidth={1}
                  strokeDasharray="3 2"
                />
                <circle cx={hoverMapped.x} cy={hoverMapped.y} r={3.3} className="fill-primary" />
              </>
            )}
          </svg>
        )}
        {tooltip && (
          <div
            className="pointer-events-none absolute z-10 rounded border border-border/70 bg-popover px-1.5 py-0.5 font-mono text-[10px] text-popover-foreground shadow-sm"
            style={{
              left: `${Math.min(88, Math.max(2, (tooltip.x / plotW) * 100))}%`,
              top: `${Math.min(82, Math.max(4, (tooltip.y / VIEW_H) * 100))}%`,
              transform: 'translate(8px, -50%)',
            }}
          >
            {tooltip.label}
          </div>
        )}
      </div>
    </div>
  );
});

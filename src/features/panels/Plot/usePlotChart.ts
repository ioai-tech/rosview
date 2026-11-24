import { useCallback, useEffect, useRef, type RefObject } from 'react';
import uPlot from 'uplot';
import { timeToSec } from '@/core/analysis/timeSeries';
import type { Player } from '@/core/types/player';
import type { Time } from '@/core/types/ros';
import { scheduleFrame } from '@/shared/utils/rafScheduler';
import type { PlotDataset, PlotRuntimeSeries } from './datasets';
import type { PlotConfig } from './defaults';
import { displaySeriesLabels, type PlotTooltipSeries } from './plotSeriesDisplay';
import {
  buildPlotSeriesOption,
  createPlotUplotOptions,
  mountPlotChart,
  panScale,
  readPlotChartColors,
  resetPlotYScaleLock,
  zoomScaleAroundCursor,
  type PlotScaleRange,
} from './plotChart';

export interface UsePlotChartArgs {
  containerRef: RefObject<HTMLDivElement | null>;
  player: Player;
  panelId: string;
  config: PlotConfig;
  dataset: PlotDataset;
  hiddenSeries: Set<number>;
  xRange?: { min: number; max: number };
  logStart?: Time;
  /**
   * True while a range read is streaming in. Used to keep the Y scale stable
   * (extending only) so the chart does not visibly jitter as new points
   * arrive, and to suppress chart re-creation when the only change is data
   * appending.
   */
  loading?: boolean;
  /** UI-language names of known series fields (JointState position / velocity / effort). */
  seriesFieldLabels?: Readonly<Record<string, string>>;
  onViewportStateChange?: (state: PlotViewportState) => void;
}

export interface PlotViewportState {
  x: boolean;
  y: boolean;
}

export interface UsePlotChartResult {
  chartRef: RefObject<uPlot | null>;
  resetViewport: () => void;
}

interface SeriesSignature {
  /** identity used for diffing additions/removals across renders */
  key: string;
  /** full visual signature; if any field changes for the *same key*, we remount */
  meta: string;
  show: boolean;
}

function seriesSignatures(
  dataset: PlotDataset,
  hiddenSeries: Set<number>,
): SeriesSignature[] {
  return dataset.series.map((s, index) => ({
    key: s.key,
    meta: `${s.label}|${s.color}|${s.lineStyle}|${s.lineSize}`,
    show: !hiddenSeries.has(index),
  }));
}

type DiffResult =
  | { kind: 'identical' }
  | { kind: 'styleUpdate'; changed: number[] }
  | { kind: 'pureAdd'; added: SeriesSignature[]; addedAt: number }
  | { kind: 'pureDel'; removedFrom: number; removedCount: number }
  | { kind: 'remount' };

/**
 * Cheap topology diff so we can keep uPlot mounted across the most common
 * cases: new series buckets appearing late during a range read (e.g. a
 * JointState topic exposing additional joints), and pure visual changes
 * (line style/size/color) on existing series. Anything more complex than
 * a clean append/truncate at the tail falls back to a remount.
 *
 * Exported for unit testing.
 */
export function diffSeriesTopology(
  prev: SeriesSignature[],
  next: SeriesSignature[],
): DiffResult {
  if (prev.length === next.length) {
    let keysMatch = true;
    const changed: number[] = [];
    for (let i = 0; i < prev.length; i++) {
      if (prev[i].key !== next[i].key) {
        keysMatch = false;
        break;
      }
      if (prev[i].meta !== next[i].meta) changed.push(i);
    }
    if (keysMatch) {
      // Same series identities & order: either nothing changed, or only
      // visual metadata changed (apply in place, no remount).
      return changed.length === 0 ? { kind: 'identical' } : { kind: 'styleUpdate', changed };
    }
  }

  // Pure appended series at the tail
  if (next.length > prev.length) {
    let prefixMatches = true;
    for (let i = 0; i < prev.length; i++) {
      if (prev[i].key !== next[i].key || prev[i].meta !== next[i].meta) {
        prefixMatches = false;
        break;
      }
    }
    if (prefixMatches) {
      return {
        kind: 'pureAdd',
        added: next.slice(prev.length),
        addedAt: prev.length,
      };
    }
  }

  // Pure trailing removal
  if (next.length < prev.length) {
    let prefixMatches = true;
    for (let i = 0; i < next.length; i++) {
      if (prev[i].key !== next[i].key || prev[i].meta !== next[i].meta) {
        prefixMatches = false;
        break;
      }
    }
    if (prefixMatches) {
      return {
        kind: 'pureDel',
        removedFrom: next.length,
        removedCount: prev.length - next.length,
      };
    }
  }

  return { kind: 'remount' };
}

export type { SeriesSignature };

/** uPlot index 0 is the X series; Y series count is `chart.series.length - 1`. */
export function plotChartYSeriesCount(chart: uPlot): number {
  return chart.series.length - 1;
}

/** Mutable view of a uPlot series including its internal path cache. */
type MutablePlotSeries = uPlot.Series & { _paths?: unknown };

/**
 * Apply a series' visual config (color/width/dash/label) onto a live uPlot
 * series in place. uPlot's `setSeries` only supports `show`/`focus`, so style
 * changes must mutate the series object directly: `width`/`dash` are read each
 * draw, `stroke` is re-resolved via `cacheStrokeFill`, and nulling `_paths`
 * forces a path rebuild for the new width. The caller must `redraw(true)`.
 */
function applyRuntimeSeriesStyle(chart: uPlot, index: number, series: PlotRuntimeSeries): void {
  const target = chart.series[index + 1] as MutablePlotSeries | undefined;
  if (!target) return;
  target.label = series.label;
  target.stroke = () => series.color;
  target.width = series.lineSize;
  target.dash = series.lineStyle === 'dashed' ? [6, 4] : [];
  target._paths = null;
}

/**
 * Returns true when incremental add/del would be unsafe and the chart should remount.
 * Exported for unit tests.
 */
export function shouldRemountForIncrementalSeriesUpdate(
  chartYCount: number,
  prevSignatureCount: number,
  diff: DiffResult,
  nextSignatureCount: number,
): boolean {
  if (chartYCount !== prevSignatureCount) return true;
  if (diff.kind === 'pureDel' && diff.removedCount > chartYCount - nextSignatureCount) {
    return true;
  }
  return false;
}

/**
 * Whether incremental updates should pin the X axis to the full log range.
 * Skipped when playhead-following mode owns the X scale.
 */
export function shouldPinPlotXScaleToLogRange(
  xRange: { min: number; max: number } | undefined,
  followingViewWidthSec: number,
): xRange is { min: number; max: number } {
  return xRange != null && followingViewWidthSec <= 0;
}

/** Keep the X viewport on the full recording duration during range reads. */
export function pinPlotXScaleToLogRange(
  chart: uPlot,
  xRange: { min: number; max: number },
): void {
  chart.setScale('x', xRange);
}

export function hasManualPlotViewport(state: PlotViewportState): boolean {
  return state.x || state.y;
}

export function plotInteractionAxes(event: Pick<WheelEvent | PointerEvent, 'shiftKey' | 'ctrlKey' | 'metaKey'>): Array<'x' | 'y'> {
  if (event.ctrlKey || event.metaKey) return ['x', 'y'];
  if (event.shiftKey) return ['y'];
  return ['x'];
}

export function usePlotChart({
  containerRef,
  player,
  panelId,
  config,
  dataset,
  hiddenSeries,
  xRange,
  logStart,
  loading,
  onViewportStateChange,
  seriesFieldLabels,
}: UsePlotChartArgs): UsePlotChartResult {
  const uplotRef = useRef<uPlot | null>(null);
  const currentTimeSecRef = useRef<number | undefined>(
    (() => {
      const time = player.getCurrentTime();
      return time ? timeToSec(time) : undefined;
    })(),
  );
  const cancelPlayheadFrameRef = useRef<(() => void) | null>(null);
  const followingViewWidthRef = useRef(config.followingViewWidthSec);
  const xAxisModeRef = useRef(config.xAxisMode);
  const seriesSignaturesRef = useRef<SeriesSignature[]>([]);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const interactionCleanupRef = useRef<(() => void) | null>(null);
  const loadingRef = useRef(!!loading);
  const mountedYUnitRef = useRef<string | undefined>(undefined);
  const tooltipSeriesRef = useRef<PlotTooltipSeries[]>([]);
  const manualViewportRef = useRef<PlotViewportState>({ x: false, y: false });
  const xRangeRef = useRef(xRange);
  const onViewportStateChangeRef = useRef(onViewportStateChange);
  useEffect(() => {
    loadingRef.current = !!loading;
  }, [loading]);
  useEffect(() => {
    xRangeRef.current = xRange;
  }, [xRange]);
  useEffect(() => {
    onViewportStateChangeRef.current = onViewportStateChange;
  }, [onViewportStateChange]);

  const notifyViewportState = useCallback(() => {
    onViewportStateChangeRef.current?.({ ...manualViewportRef.current });
  }, []);

  const markManualViewport = useCallback((axis: 'x' | 'y') => {
    const prev = manualViewportRef.current;
    if (prev[axis]) return;
    manualViewportRef.current = { ...prev, [axis]: true };
    notifyViewportState();
  }, [notifyViewportState]);

  const resetViewport = useCallback(() => {
    const chart = uplotRef.current;
    manualViewportRef.current = { x: false, y: false };
    notifyViewportState();
    if (!chart) return;

    resetPlotYScaleLock(chart);
    chart.setData(chart.data, true);

    if (config.xAxisMode === 'timestamp' && config.followingViewWidthSec > 0) {
      const end = currentTimeSecRef.current;
      if (end != null && Number.isFinite(end)) {
        chart.setScale('x', { min: end - config.followingViewWidthSec, max: end });
      }
    } else if (xRangeRef.current) {
      chart.setScale('x', xRangeRef.current);
    }
  }, [config.followingViewWidthSec, config.xAxisMode, notifyViewportState]);

  const attachChartInteractions = useCallback((chart: uPlot) => {
    const over = chart.over;
    let drag:
      | {
          pointerId: number;
          clientX: number;
          clientY: number;
          scales: Partial<Record<'x' | 'y', PlotScaleRange>>;
          axes: Array<'x' | 'y'>;
          moved: boolean;
        }
      | null = null;

    const currentScale = (axis: 'x' | 'y'): PlotScaleRange | undefined => {
      const min = chart.scales[axis].min;
      const max = chart.scales[axis].max;
      return typeof min === 'number' && typeof max === 'number' ? { min, max } : undefined;
    };

    const setManualScale = (axis: 'x' | 'y', scale: PlotScaleRange) => {
      markManualViewport(axis);
      chart.setScale(axis, scale);
    };

    const onWheel = (event: WheelEvent) => {
      const axes = plotInteractionAxes(event);
      event.preventDefault();
      const rect = over.getBoundingClientRect();
      const factor = event.deltaY > 0 ? 1.18 : 1 / 1.18;
      if (axes.includes('x')) {
        const scale = currentScale('x');
        if (scale) {
          const cursorVal = chart.posToVal(event.clientX - rect.left, 'x');
          setManualScale('x', zoomScaleAroundCursor(scale, cursorVal, factor, xRangeRef.current));
        }
      }
      if (axes.includes('y')) {
        const scale = currentScale('y');
        if (scale) {
          const cursorVal = chart.posToVal(event.clientY - rect.top, 'y');
          setManualScale('y', zoomScaleAroundCursor(scale, cursorVal, factor));
        }
      }
    };

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0 || event.altKey) return;
      const axes = plotInteractionAxes(event);
      const scales = Object.fromEntries(
        axes.flatMap((axis) => {
          const scale = currentScale(axis);
          return scale ? [[axis, scale]] : [];
        }),
      ) as Partial<Record<'x' | 'y', PlotScaleRange>>;
      if (Object.keys(scales).length === 0) return;
      drag = {
        pointerId: event.pointerId,
        clientX: event.clientX,
        clientY: event.clientY,
        scales,
        axes,
        moved: false,
      };
      over.setPointerCapture(event.pointerId);
      over.style.cursor = 'grabbing';
      event.preventDefault();
    };

    const onPointerMove = (event: PointerEvent) => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      const deltaPx = event.clientX - drag.clientX;
      const deltaY = event.clientY - drag.clientY;
      if (Math.hypot(deltaPx, deltaY) < 2) return;
      drag.moved = true;
      if (drag.axes.includes('x') && drag.scales.x) {
        setManualScale('x', panScale(drag.scales.x, deltaPx, chart.bbox.width, xRangeRef.current));
      }
      if (drag.axes.includes('y') && drag.scales.y) {
        setManualScale('y', panScale(drag.scales.y, -deltaY, chart.bbox.height));
      }
    };

    const finishDrag = (event: PointerEvent) => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      over.releasePointerCapture(event.pointerId);
      over.style.cursor = '';
      drag = null;
    };

    const onDoubleClick = (event: MouseEvent) => {
      event.preventDefault();
      resetViewport();
    };

    over.addEventListener('wheel', onWheel, { passive: false });
    over.addEventListener('pointerdown', onPointerDown);
    over.addEventListener('pointermove', onPointerMove);
    over.addEventListener('pointerup', finishDrag);
    over.addEventListener('pointercancel', finishDrag);
    over.addEventListener('dblclick', onDoubleClick);

    return () => {
      over.removeEventListener('wheel', onWheel);
      over.removeEventListener('pointerdown', onPointerDown);
      over.removeEventListener('pointermove', onPointerMove);
      over.removeEventListener('pointerup', finishDrag);
      over.removeEventListener('pointercancel', finishDrag);
      over.removeEventListener('dblclick', onDoubleClick);
      over.style.cursor = '';
    };
  }, [markManualViewport, resetViewport]);

  const destroyChart = useCallback(() => {
    interactionCleanupRef.current?.();
    interactionCleanupRef.current = null;
    resizeObserverRef.current?.disconnect();
    resizeObserverRef.current = null;
    const chart = uplotRef.current;
    if (chart) {
      resetPlotYScaleLock(chart);
      chart.destroy();
    }
    uplotRef.current = null;
    seriesSignaturesRef.current = [];
  }, []);

  const mountChart = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    destroyChart();

    const colors = readPlotChartColors();
    const options = createPlotUplotOptions(dataset, hiddenSeries, {
      panelId,
      xAxisMode: config.xAxisMode,
      xRange,
      logStart,
      getCurrentTimeSec: () => currentTimeSecRef.current,
      colors,
      isLoading: () => loadingRef.current,
      getTooltipSeries: () => tooltipSeriesRef.current,
    });
    mountedYUnitRef.current = dataset.yUnit;

    const chart = mountPlotChart(container, dataset, options, xRange);
    uplotRef.current = chart;
    interactionCleanupRef.current = attachChartInteractions(chart);
    seriesSignaturesRef.current = seriesSignatures(dataset, hiddenSeries);
    if (
      loadingRef.current
      && !manualViewportRef.current.x
      && shouldPinPlotXScaleToLogRange(xRange, followingViewWidthRef.current)
    ) {
      pinPlotXScaleToLogRange(chart, xRange);
    }

    const observer = new ResizeObserver(() => {
      const chart = uplotRef.current;
      if (!container || !chart) return;
      chart.setSize({
        width: container.offsetWidth || 400,
        height: Math.max(container.offsetHeight || 200, 100),
      });
    });
    observer.observe(container);
    resizeObserverRef.current = observer;
  }, [attachChartInteractions, config.xAxisMode, containerRef, dataset, destroyChart, hiddenSeries, logStart, panelId, xRange]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || dataset.series.length === 0) {
      destroyChart();
      return;
    }

    const chart = uplotRef.current;
    const xAxisModeChanged = xAxisModeRef.current !== config.xAxisMode;
    followingViewWidthRef.current = config.followingViewWidthSec;
    xAxisModeRef.current = config.xAxisMode;

    const displayLabels = displaySeriesLabels(
      dataset.series.map((s) => s.label),
      seriesFieldLabels,
    );
    tooltipSeriesRef.current = dataset.series.map((s, index) => ({
      label: displayLabels[index] ?? s.label,
      color: s.color,
      unit: s.unit,
      show: !hiddenSeries.has(index),
    }));

    // The axis title is part of the chart DOM; a unit change needs a remount.
    if (!chart || xAxisModeChanged || mountedYUnitRef.current !== dataset.yUnit) {
      mountChart();
      return;
    }

    const nextSignatures = seriesSignatures(dataset, hiddenSeries);
    const diff = diffSeriesTopology(seriesSignaturesRef.current, nextSignatures);

    if (diff.kind === 'remount') {
      mountChart();
      return;
    }

    const chartYCount = plotChartYSeriesCount(chart);
    const prevSignatureCount = seriesSignaturesRef.current.length;
    if (shouldRemountForIncrementalSeriesUpdate(
      chartYCount,
      prevSignatureCount,
      diff,
      nextSignatures.length,
    )) {
      mountChart();
      return;
    }

    if (diff.kind === 'pureAdd') {
      // Insert tail series without recreating the chart, preserving zoom/pan state.
      diff.added.forEach((sig, offset) => {
        chart.addSeries(buildPlotSeriesOption(
          dataset.series[diff.addedAt + offset],
          sig.show,
        ), diff.addedAt + offset + 1);
      });
    } else if (diff.kind === 'pureDel') {
      for (let i = 0; i < diff.removedCount; i++) {
        // Remove from the tail; uPlot series indices are 1-based (0 = x-axis).
        chart.delSeries(diff.removedFrom + 1);
      }
    } else if (diff.kind === 'styleUpdate') {
      // Pure visual change (line style/size/color): mutate series in place
      // instead of remounting, preserving zoom/pan state.
      for (const index of diff.changed) {
        applyRuntimeSeriesStyle(chart, index, dataset.series[index]);
      }
    }

    // Sync show flags for stable indices.
    for (let index = 0; index < nextSignatures.length; index++) {
      chart.setSeries(index + 1, { show: nextSignatures[index].show });
    }

    // setData second arg = false avoids a hard scale reset every batch, which is
    // what made the chart flash while data was streaming in.
    chart.setData(dataset.data, false);
    // setData(false) can shrink X to the loaded points only; pin to the full log
    // range so the axis stays 0…duration while curves grow incrementally.
    if (
      loadingRef.current
      && !manualViewportRef.current.x
      && shouldPinPlotXScaleToLogRange(xRange, followingViewWidthRef.current)
    ) {
      pinPlotXScaleToLogRange(chart, xRange);
    }
    // Style mutations are read at draw time, so force one rebuild+redraw to
    // surface the new width/dash/stroke immediately.
    if (diff.kind === 'styleUpdate') {
      chart.redraw(true);
    } else if (loadingRef.current) {
      chart.redraw(false);
    }
    seriesSignaturesRef.current = nextSignatures;
  }, [
    config.followingViewWidthSec,
    config.xAxisMode,
    containerRef,
    dataset,
    destroyChart,
    hiddenSeries,
    mountChart,
    seriesFieldLabels,
    xRange,
  ]);

  // When loading completes, force one Y-scale recompute so the locked-min/max
  // is replaced with the natural auto-fit range.
  useEffect(() => {
    if (loading || manualViewportRef.current.y) return;
    const chart = uplotRef.current;
    if (!chart) return;
    resetPlotYScaleLock(chart);
    chart.redraw(true, true);
  }, [loading]);

  useEffect(() => () => destroyChart(), [destroyChart]);

  useEffect(() => {
    const unsub = player.subscribeCurrentTime((time) => {
      currentTimeSecRef.current = timeToSec(time);
      if (cancelPlayheadFrameRef.current) return;

      cancelPlayheadFrameRef.current = scheduleFrame(() => {
        cancelPlayheadFrameRef.current = null;
        const chart = uplotRef.current;
        if (!chart) return;

        if (
          !manualViewportRef.current.x
          && xAxisModeRef.current === 'timestamp'
          && followingViewWidthRef.current > 0
        ) {
          const end = currentTimeSecRef.current;
          if (end != null && Number.isFinite(end)) {
            chart.setScale('x', {
              min: end - followingViewWidthRef.current,
              max: end,
            });
          }
        }

        chart.redraw(false);
      });
    });

    return () => {
      unsub();
      cancelPlayheadFrameRef.current?.();
      cancelPlayheadFrameRef.current = null;
    };
  }, [player]);

  useEffect(() => {
    const chart = uplotRef.current;
    if (!chart || config.xAxisMode !== 'timestamp') return;
    if (manualViewportRef.current.x) return;
    if (config.followingViewWidthSec > 0) {
      const end = currentTimeSecRef.current;
      if (end != null && Number.isFinite(end)) {
        chart.setScale('x', { min: end - config.followingViewWidthSec, max: end });
      }
    } else if (xRange) {
      chart.setScale('x', xRange);
    }
  }, [config.followingViewWidthSec, config.xAxisMode, xRange]);

  useEffect(() => {
    const chart = uplotRef.current;
    if (!chart) return;
    for (let index = 0; index < dataset.series.length; index++) {
      chart.setSeries(index + 1, { show: !hiddenSeries.has(index) });
    }
  }, [dataset.series.length, hiddenSeries]);

  return { chartRef: uplotRef, resetViewport };
}

import { useCallback, useEffect, useRef, type RefObject } from 'react';
import uPlot from 'uplot';
import { timeToSec } from '@/core/analysis/timeSeries';
import type { Player } from '@/core/types/player';
import type { Time } from '@/core/types/ros';
import { scheduleFrame } from '@/shared/utils/rafScheduler';
import type { PlotDataset, PlotRuntimeSeries } from './datasets';
import type { PlotConfig } from './defaults';
import {
  buildPlotSeriesOption,
  createPlotUplotOptions,
  mountPlotChart,
  readPlotChartColors,
  resetPlotYScaleLock,
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
}: UsePlotChartArgs): RefObject<uPlot | null> {
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
  const loadingRef = useRef(!!loading);
  useEffect(() => {
    loadingRef.current = !!loading;
  }, [loading]);

  const destroyChart = useCallback(() => {
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
    });

    uplotRef.current = mountPlotChart(container, dataset, options, xRange);
    seriesSignaturesRef.current = seriesSignatures(dataset, hiddenSeries);

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
  }, [config.xAxisMode, containerRef, dataset, destroyChart, hiddenSeries, logStart, panelId, xRange]);

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

    if (!chart || xAxisModeChanged) {
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
    // Style mutations are read at draw time, so force one rebuild+redraw to
    // surface the new width/dash/stroke immediately.
    if (diff.kind === 'styleUpdate') {
      chart.redraw(true);
    }
    seriesSignaturesRef.current = nextSignatures;
  }, [config.followingViewWidthSec, config.xAxisMode, containerRef, dataset, destroyChart, hiddenSeries, mountChart]);

  // When loading completes, force one Y-scale recompute so the locked-min/max
  // is replaced with the natural auto-fit range.
  useEffect(() => {
    if (loading) return;
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

        if (xAxisModeRef.current === 'timestamp' && followingViewWidthRef.current > 0) {
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

  return uplotRef;
}

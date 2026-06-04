import uPlot from 'uplot';
import { timeToSec } from '@/core/analysis/timeSeries';
import type { Time } from '@/core/types/ros';
import { formatDurationNs } from '@/shared/utils/time';
import type { PlotDataset, PlotRuntimeSeries } from './datasets';
import type { PlotXAxisMode } from './defaults';

export interface PlotChartColors {
  axisStroke: string;
  gridStroke: string;
  playheadStroke: string;
  cursorLabelText: string;
  cursorLabelBg: string;
  cursorLabelBorder: string;
}

function readCssColor(variable: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback;
  const raw = getComputedStyle(document.documentElement).getPropertyValue(variable).trim();
  if (!raw) return fallback;
  return raw.startsWith('hsl') ? raw : `hsl(${raw})`;
}

export function readPlotChartColors(): PlotChartColors {
  const muted = readCssColor('--muted-foreground', '#888888');
  const gridStroke = muted.startsWith('hsl')
    ? muted.replace(')', ' / 0.12)').replace('hsl(', 'hsla(')
    : `hsl(${muted} / 0.12)`;
  return {
    axisStroke: muted,
    gridStroke,
    playheadStroke: readCssColor('--primary', '#f59e0b'),
    cursorLabelText: readCssColor('--popover-foreground', '#f8fafc'),
    cursorLabelBg: readCssColor('--popover', 'hsl(222 47% 11%)'),
    cursorLabelBorder: readCssColor('--border', 'hsl(217 33% 17%)'),
  };
}

export function secToTime(sec: number): Time {
  const nsec = BigInt(Math.round(sec * 1e9));
  return { sec: Number(nsec / 1_000_000_000n), nsec: Number(nsec % 1_000_000_000n) };
}

export function formatPlotYValue(value: number): string {
  if (!Number.isFinite(value)) return '';
  const abs = Math.abs(value);
  if (abs >= 10_000) return value.toFixed(0);
  if (abs >= 100) return value.toFixed(1);
  if (abs >= 1) return value.toFixed(3);
  if (abs >= 0.001) return value.toFixed(4);
  return value.toExponential(2);
}

export function formatPlotXValue(
  value: number,
  xAxisMode: PlotXAxisMode,
  logStart?: Time,
): string {
  if (!Number.isFinite(value)) return '';
  if (xAxisMode === 'timestamp') {
    if (logStart) {
      const deltaNs = BigInt(Math.round((value - timeToSec(logStart)) * 1e9));
      return formatDurationNs(deltaNs < 0n ? 0n : deltaNs);
    }
    return new Date(value * 1000).toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      fractionalSecondDigits: 3,
    });
  }
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(3);
}

/** uPlot X-axis tick labels; reuses formatPlotXValue so ticks match hover labels. */
export function formatPlotXAxisTicks(
  splits: number[],
  xAxisMode: PlotXAxisMode,
  logStart?: Time,
): string[] {
  return splits.map((value) => formatPlotXValue(value, xAxisMode, logStart));
}

const RELATIVE_TIME_INCRS_SEC = [
  0.001, 0.002, 0.005,
  0.01, 0.02, 0.05,
  0.1, 0.2, 0.5,
  1, 2, 5, 10, 15, 30,
  60, 120, 300, 600, 900, 1800, 3600,
  7200, 14_400, 21_600, 43_200,
] as const;

/** Pick a human-friendly tick step (seconds) for relative-time axes. */
export function pickRelativeTimeIncrement(rawStepSec: number): number {
  if (!Number.isFinite(rawStepSec) || rawStepSec <= 0) return 1;
  for (const step of RELATIVE_TIME_INCRS_SEC) {
    if (step >= rawStepSec) return step;
  }
  const magnitude = 10 ** Math.ceil(Math.log10(rawStepSec));
  return magnitude;
}

/**
 * Grid/tick positions aligned to log-relative time (0, step, 2*step, …),
 * returned as absolute epoch seconds for uPlot positioning.
 */
export function computeRelativeTimeSplits(
  scaleMin: number,
  scaleMax: number,
  originSec: number,
  minSpacePx: number,
  plotWidthPx: number,
): number[] {
  const relMin = scaleMin - originSec;
  const relMax = scaleMax - originSec;
  if (!Number.isFinite(relMin) || !Number.isFinite(relMax) || relMax <= relMin) {
    return [scaleMin];
  }

  const targetCount = Math.max(2, Math.floor(plotWidthPx / Math.max(minSpacePx, 30)));
  const incr = pickRelativeTimeIncrement((relMax - relMin) / targetCount);

  const splits: number[] = [];
  const firstIdx = Math.ceil(relMin / incr - 1e-12);
  const lastIdx = Math.floor(relMax / incr + 1e-12);
  for (let idx = firstIdx; idx <= lastIdx; idx++) {
    const rel = idx * incr;
    if (rel >= relMin - incr * 1e-9 && rel <= relMax + incr * 1e-9) {
      splits.push(originSec + rel);
    }
  }

  if (relMin <= 0 && relMax >= 0) {
    const zero = originSec;
    if (!splits.some((value) => Math.abs(value - zero) < incr * 1e-9)) {
      splits.push(zero);
      splits.sort((a, b) => a - b);
    }
  }

  return splits.length > 0 ? splits : [scaleMin];
}

interface CursorLabelElements {
  x: HTMLDivElement;
  y: HTMLDivElement;
}

const cursorLabelsByChart = new WeakMap<uPlot, CursorLabelElements>();

function applyCursorLabelStyle(el: HTMLDivElement, colors: PlotChartColors): void {
  el.style.position = 'absolute';
  el.style.display = 'none';
  el.style.font = '10px ui-sans-serif, system-ui, sans-serif';
  el.style.lineHeight = '1.2';
  el.style.padding = '2px 6px';
  el.style.borderRadius = '4px';
  el.style.background = colors.cursorLabelBg;
  el.style.color = colors.cursorLabelText;
  el.style.border = `1px solid ${colors.cursorLabelBorder}`;
  el.style.boxShadow = '0 1px 4px rgba(0, 0, 0, 0.45)';
  el.style.pointerEvents = 'none';
  el.style.whiteSpace = 'nowrap';
  el.style.zIndex = '20';
}

function initCursorLabels(u: uPlot, colors: PlotChartColors): void {
  if (cursorLabelsByChart.has(u)) return;

  const xLabel = document.createElement('div');
  const yLabel = document.createElement('div');
  applyCursorLabelStyle(xLabel, colors);
  applyCursorLabelStyle(yLabel, colors);

  u.over.appendChild(xLabel);
  u.over.appendChild(yLabel);
  cursorLabelsByChart.set(u, { x: xLabel, y: yLabel });
}

function hideCursorLabels(u: uPlot): void {
  const labels = cursorLabelsByChart.get(u);
  if (!labels) return;
  labels.x.style.display = 'none';
  labels.y.style.display = 'none';
}

function updateCursorLabels(
  u: uPlot,
  xAxisMode: PlotXAxisMode,
  logStart: Time | undefined,
): void {
  const labels = cursorLabelsByChart.get(u);
  if (!labels) return;

  const cx = u.cursor.left ?? -1;
  const cy = u.cursor.top ?? -1;
  const plotW = u.bbox.width;
  const plotH = u.bbox.height;

  if (cx < 0 || cy < 0 || cx > plotW || cy > plotH) {
    hideCursorLabels(u);
    return;
  }

  const xVal = u.posToVal(cx, 'x');
  const yVal = u.posToVal(cy, 'y');

  labels.x.textContent = formatPlotXValue(xVal, xAxisMode, logStart);
  labels.x.style.display = 'block';
  labels.x.style.left = `${cx}px`;
  labels.x.style.top = `${plotH}px`;
  labels.x.style.transform = 'translate(-50%, calc(-100% - 4px))';

  labels.y.textContent = formatPlotYValue(yVal);
  labels.y.style.display = 'block';
  labels.y.style.left = '4px';
  labels.y.style.top = `${cy}px`;
  labels.y.style.transform = 'translateY(-50%)';
}

function destroyCursorLabels(u: uPlot): void {
  const labels = cursorLabelsByChart.get(u);
  if (!labels) return;
  labels.x.remove();
  labels.y.remove();
  cursorLabelsByChart.delete(u);
}

function drawPlayhead(
  u: uPlot,
  getCurrentTimeSec: () => number | undefined,
  stroke: string,
): void {
  const timeSec = getCurrentTimeSec();
  if (timeSec == null || !Number.isFinite(timeSec)) return;

  const xPos = u.valToPos(timeSec, 'x', true);
  const { top, height, left, width } = u.bbox;
  if (xPos < left || xPos > left + width) return;

  const ctx = u.ctx;
  ctx.save();
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 1.5;
  ctx.globalAlpha = 0.9;
  ctx.beginPath();
  ctx.moveTo(xPos, top);
  ctx.lineTo(xPos, top + height);
  ctx.stroke();
  ctx.restore();
}

export interface PlotChartBuildContext {
  panelId: string;
  xAxisMode: PlotXAxisMode;
  xRange?: { min: number; max: number };
  logStart?: Time;
  getCurrentTimeSec: () => number | undefined;
  colors: PlotChartColors;
  /**
   * When provided and returning true, the Y scale is *extended* across data
   * updates rather than recomputed — this prevents the chart from visibly
   * jumping while a range read is still streaming in. When the predicate
   * returns false (i.e. the data is no longer growing), normal auto-fit
   * behaviour resumes on the next setData/redraw.
   */
  isLoading?: () => boolean;
}

export type PlotUplotOptions = Omit<uPlot.Options, 'width' | 'height'>;

export function buildPlotSeriesOption(series: PlotRuntimeSeries, show: boolean): uPlot.Series {
  return {
    label: series.label,
    stroke: series.color,
    width: series.lineSize,
    show,
    points: { show: false },
    dash: series.lineStyle === 'dashed' ? [6, 4] : undefined,
    spanGaps: true,
  };
}

/**
 * State held outside the chart so the Y scale can extend smoothly across
 * incremental setData() calls during a range read instead of jittering as
 * each batch arrives.
 */
interface YScaleLockState {
  min: number;
  max: number;
}

const yScaleLockByChart = new WeakMap<uPlot, YScaleLockState>();

export function resetPlotYScaleLock(chart: uPlot): void {
  yScaleLockByChart.delete(chart);
}

function buildYScaleRange(
  ctx: PlotChartBuildContext,
): (u: uPlot, dataMin: number, dataMax: number) => uPlot.Range.MinMax {
  const isLoading = ctx.isLoading;
  return (u, dataMin, dataMax) => {
    const finite = Number.isFinite(dataMin) && Number.isFinite(dataMax) && dataMax >= dataMin;
    const fallback: uPlot.Range.MinMax = finite
      ? uPlot.rangeNum(dataMin, dataMax, 0.1, true)
      : [0, 1];

    if (!isLoading || !isLoading()) {
      yScaleLockByChart.delete(u);
      return fallback;
    }

    const next = yScaleLockByChart.get(u);
    if (!finite) {
      return next ? [next.min, next.max] : fallback;
    }
    const autoMin = fallback[0];
    const autoMax = fallback[1];
    if (autoMin == null || autoMax == null) {
      return next ? [next.min, next.max] : fallback;
    }
    if (!next) {
      yScaleLockByChart.set(u, { min: autoMin, max: autoMax });
      return [autoMin, autoMax];
    }
    const merged = {
      min: Math.min(next.min, autoMin),
      max: Math.max(next.max, autoMax),
    };
    yScaleLockByChart.set(u, merged);
    return [merged.min, merged.max];
  };
}

export function createPlotUplotOptions(
  dataset: PlotDataset,
  hiddenSeries: Set<number>,
  ctx: PlotChartBuildContext,
): PlotUplotOptions {
  const { colors, xAxisMode, xRange, logStart, getCurrentTimeSec, panelId } = ctx;

  const useRelativeTimeAxis = xAxisMode === 'timestamp' && logStart != null;
  const logStartSec = useRelativeTimeAxis ? timeToSec(logStart) : undefined;

  const xAxisValues =
    useRelativeTimeAxis
      ? (_u: uPlot, splits: number[]) => formatPlotXAxisTicks(splits, xAxisMode, logStart)
      : undefined;

  const xAxisSplits =
    useRelativeTimeAxis && logStartSec != null
      ? (u: uPlot, _axisIdx: number, scaleMin: number, scaleMax: number, _foundIncr: number, foundSpace: number) =>
          computeRelativeTimeSplits(scaleMin, scaleMax, logStartSec, foundSpace, u.bbox.width)
      : undefined;

  return {
    id: panelId,
    series: [
      { label: dataset.xLabel },
      ...dataset.series.map((series, index) =>
        buildPlotSeriesOption(series, !hiddenSeries.has(index)),
      ),
    ],
    axes: [
      {
        grid: { show: true, stroke: colors.gridStroke, width: 1 },
        stroke: colors.axisStroke,
        font: '10px sans-serif',
        ...(xAxisValues ? { values: xAxisValues } : {}),
        ...(xAxisSplits ? { splits: xAxisSplits } : {}),
      },
      {
        grid: { show: true, stroke: colors.gridStroke, width: 1 },
        stroke: colors.axisStroke,
        font: '10px sans-serif',
      },
    ],
    cursor: {
      drag: { setScale: true },
      x: true,
      y: true,
      points: { show: false },
    },
    legend: { show: false },
    scales: {
      x: {
        // Relative-time ticks are generated in computeRelativeTimeSplits; epoch alignment breaks at log start.
        time: xAxisMode === 'timestamp' && !useRelativeTimeAxis,
        ...(xRange ?? {}),
      },
      y: {
        range: buildYScaleRange(ctx),
      },
    },
    hooks: {
      ready: [(u) => initCursorLabels(u, colors)],
      setCursor: [(u) => updateCursorLabels(u, xAxisMode, logStart)],
      destroy: [(u) => destroyCursorLabels(u)],
      draw: [(u) => drawPlayhead(u, getCurrentTimeSec, colors.playheadStroke)],
    },
  };
}

export function mountPlotChart(
  container: HTMLElement,
  dataset: PlotDataset,
  options: PlotUplotOptions,
  xRange?: { min: number; max: number },
): uPlot {
  const height = Math.max(container.offsetHeight || 200, 100);
  const width = container.offsetWidth || 400;
  const chart = new uPlot({ ...options, width, height }, dataset.data, container);
  if (xRange) {
    chart.setScale('x', xRange);
  }
  return chart;
}

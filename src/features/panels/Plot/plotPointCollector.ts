import {
  resolvePlotEventTimestamp,
  timeToSec,
} from '@/core/analysis/timeSeries';
import type { MessageEvent, Time } from '@/core/types/ros';
import { extractPlotPathValues, hasDerivativeModifier } from './messagePath';
import { LASER_SCAN_ANGLE_X_PATH } from './adapters';
import { paletteColor, type PlotConfig, type PlotSeriesConfig } from './defaults';
import type { PlotDatasetWarning } from './plotWarnings';
import type { PlotRuntimeSeries, PointBucket } from './types';
import { getLatestEventForTopic, indexEventsByTopic } from './plotEventIndex';

export function isEnabledSeries(series: PlotSeriesConfig): boolean {
  return series.enabled && series.topic.length > 0 && series.path.trim().length > 0;
}

/**
 * A series is "configured" — has a topic + path — but may be disabled by
 * the user. Use this for accumulator ingestion so toggling visibility
 * is a no-op for the data layer.
 */
export function isConfiguredSeries(series: PlotSeriesConfig): boolean {
  return series.topic.length > 0 && series.path.trim().length > 0;
}

/** Millisecond grid avoids float-key mismatches when merging multi-series timelines. */
export function quantizePlotX(sec: number): number {
  return Math.round(sec * 1000) / 1000;
}

function legendLabel(series: PlotSeriesConfig, labelSuffix: string): string {
  if (labelSuffix && labelSuffix !== series.path) return labelSuffix;
  if (series.label.trim()) return series.label.trim();
  const pathLabel = labelSuffix || series.path || 'value';
  return series.topic ? `${series.topic} · ${pathLabel}` : pathLabel;
}

export function extractXValues(message: unknown, xAxisPath: string) {
  if (xAxisPath === LASER_SCAN_ANGLE_X_PATH) {
    if (!message || typeof message !== 'object') return [];
    const record = message as Record<string, unknown>;
    const ranges = record.ranges;
    const angleMin = typeof record.angle_min === 'number' ? record.angle_min : 0;
    const angleIncrement = typeof record.angle_increment === 'number' ? record.angle_increment : 0;
    if (!Array.isArray(ranges)) return [];
    return ranges.map((_, index) => ({
      key: `angle[${index}]`,
      label: `angle[${index}]`,
      value: angleMin + index * angleIncrement,
    }));
  }
  return extractPlotPathValues(message, xAxisPath);
}

export function pushPoint(
  buckets: Map<string, PointBucket>,
  series: PlotSeriesConfig,
  keySuffix: string,
  labelSuffix: string,
  x: number,
  y: number | null,
): void {
  const key = `${series.id}:${keySuffix}`;
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = {
      series: {
        key,
        label: legendLabel(series, labelSuffix),
        color: series.color,
        lineStyle: series.lineStyle,
        lineSize: series.lineSize,
        enabled: series.enabled,
      },
      points: [],
      derivative: hasDerivativeModifier(series.path),
      seriesConfigId: series.id,
    };
    buckets.set(key, bucket);
  }
  bucket.points.push({ x, y });
}

/**
 * Overlay live config visuals (line style/size/color) onto already-accumulated
 * buckets. The accumulator captures visuals at ingest time, so without this
 * a later config change (e.g. dashed -> solid, thicker line) would not surface
 * until a full re-read. Color is applied before {@link assignBucketColors} so
 * the palette still wins for multi-bucket series (e.g. JointState arrays).
 */
export function applySeriesConfigVisuals(
  buckets: Iterable<PointBucket>,
  config: PlotConfig,
): void {
  const seriesById = new Map(config.series.map((series) => [series.id, series]));
  for (const bucket of buckets) {
    const series = seriesById.get(bucket.seriesConfigId);
    if (!series) continue;
    bucket.series.lineStyle = series.lineStyle;
    bucket.series.lineSize = series.lineSize;
    if (series.color) bucket.series.color = series.color;
  }
}

export function assignBucketColors(buckets: Map<string, PointBucket>): void {
  const bucketsBySeries = new Map<string, PointBucket[]>();
  for (const bucket of buckets.values()) {
    const list = bucketsBySeries.get(bucket.seriesConfigId) ?? [];
    list.push(bucket);
    bucketsBySeries.set(bucket.seriesConfigId, list);
  }

  let paletteIndex = 0;
  for (const seriesBuckets of bucketsBySeries.values()) {
    if (seriesBuckets.length === 1) {
      const bucket = seriesBuckets[0];
      if (!bucket.series.color) {
        bucket.series.color = paletteColor(paletteIndex++);
      }
      continue;
    }
    for (const bucket of seriesBuckets) {
      bucket.series.color = paletteColor(paletteIndex++);
    }
  }
}

export function collectTimestampPoints(
  events: MessageEvent[],
  config: PlotConfig,
  warnings: PlotDatasetWarning[],
  logStart?: Time,
  logEnd?: Time,
): Map<string, PointBucket> {
  const buckets = new Map<string, PointBucket>();
  const byTopic = indexEventsByTopic(events);
  const enabled = config.series.filter(isEnabledSeries);

  for (const series of enabled) {
    const topicEvents = byTopic.get(series.topic) ?? [];
    let foundForSeries = false;

    for (const event of topicEvents) {
      const x = quantizePlotX(
        timeToSec(resolvePlotEventTimestamp(event, series.timestampMode, logStart, logEnd).time),
      );
      const values = extractPlotPathValues(event.message, series.path);
      for (const item of values) {
        pushPoint(buckets, series, item.key, item.label, x, item.value);
        foundForSeries = true;
      }
    }

    if (topicEvents.length > 0 && !foundForSeries) {
      warnings.push({ kind: 'noNumericValues', topic: series.topic, path: series.path });
    }
  }
  return buckets;
}

export function collectIndexPoints(events: MessageEvent[], config: PlotConfig): Map<string, PointBucket> {
  const buckets = new Map<string, PointBucket>();
  const byTopic = indexEventsByTopic(events);

  for (const series of config.series.filter(isEnabledSeries)) {
    const latest = getLatestEventForTopic(byTopic, series.topic);
    if (!latest) continue;
    const values = extractPlotPathValues(latest.message, series.path);
    values.forEach((item, index) => {
      pushPoint(buckets, series, item.key || `${index}`, item.label, index, item.value);
    });
  }
  return buckets;
}

export function collectCustomPoints(
  events: MessageEvent[],
  config: PlotConfig,
  latestOnly: boolean,
  warnings: PlotDatasetWarning[],
): Map<string, PointBucket> {
  const buckets = new Map<string, PointBucket>();
  const byTopic = indexEventsByTopic(events);

  for (const series of config.series.filter(isEnabledSeries)) {
    const xAxisPath = series.xAxisPath?.trim();
    if (!xAxisPath) {
      warnings.push({ kind: 'missingXPath', topic: series.topic, path: series.path });
      continue;
    }
    const topicEvents = byTopic.get(series.topic) ?? [];
    const lastEvent = topicEvents.at(-1);
    const sourceEvents = latestOnly
      ? lastEvent ? [lastEvent] : []
      : topicEvents;

    for (const event of sourceEvents) {
      const xs = extractXValues(event.message, xAxisPath);
      const ys = extractPlotPathValues(event.message, series.path);
      const count = Math.min(xs.length, ys.length);
      if (xs.length !== ys.length) {
        warnings.push({
          kind: 'mismatchedXY',
          topic: series.topic,
          xPath: xAxisPath,
          yPath: series.path,
        });
      }
      const singleCurve = xs.length > 1 && ys.length > 1;
      for (let i = 0; i < count; i++) {
        const x = xs[i]?.value;
        const y = ys[i]?.value;
        if (x == null || y == null) continue;
        pushPoint(
          buckets,
          series,
          singleCurve ? 'value' : (ys[i]?.key ?? `${i}`),
          singleCurve ? '' : (ys[i]?.label ?? `${i}`),
          x,
          y,
        );
      }
    }
  }
  return buckets;
}

export type { PlotRuntimeSeries, PointBucket };

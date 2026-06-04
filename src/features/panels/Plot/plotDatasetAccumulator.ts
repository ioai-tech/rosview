import {
  resolvePlotEventTimestamp,
  timeToSec,
} from '@/core/analysis/timeSeries';
import type { MessageEvent } from '@/core/types/ros';
import type { BuildPlotDatasetOptions, PlotDataset, PointBucket } from './types';
import { alignBuckets } from './plotAlign';
import {
  applySeriesConfigVisuals,
  assignBucketColors,
  collectCustomPoints,
  collectIndexPoints,
  extractXValues,
  isConfiguredSeries,
  pushPoint,
  quantizePlotX,
} from './plotPointCollector';
import type { PlotConfig, PlotSeriesConfig } from './defaults';
import { extractPlotPathValues } from './messagePath';
import { plotWarningKey, type PlotDatasetWarning } from './plotWarnings';

const EMPTY_DATASET: PlotDataset = {
  xLabel: 'time',
  series: [],
  data: [[]],
  pointCount: 0,
  sampleRatio: 1,
  warnings: [],
};

export type PlotDatasetAccumulatorOptions = BuildPlotDatasetOptions;

function countPoints(data: PlotDataset['data']): number {
  let pointCount = 0;
  for (let i = 1; i < data.length; i++) {
    const arr = data[i] as Array<number | null>;
    for (let j = 0; j < arr.length; j++) {
      if (arr[j] != null) pointCount++;
    }
  }
  return pointCount;
}

function datasetFromBuckets(
  buckets: Map<string, PointBucket>,
  config: PlotConfig,
  options: PlotDatasetAccumulatorOptions,
  warnings: PlotDatasetWarning[],
  enabledSeriesIds?: ReadonlySet<string>,
  visualConfig?: PlotConfig,
): PlotDataset {
  // Filter buckets to those whose owning series is currently enabled.
  // The accumulator deliberately ingests buckets for *all configured* series
  // (so visibility toggling never invalidates accumulated state), and applies
  // the enabled filter only at build time.
  const filteredBuckets =
    enabledSeriesIds == null
      ? buckets
      : new Map(
          [...buckets.entries()].filter(([, bucket]) =>
            enabledSeriesIds.has(bucket.seriesConfigId),
          ),
        );

  // Apply live visuals before palette assignment so user color overrides on
  // single-bucket series are respected while multi-bucket series still get
  // palette colors.
  applySeriesConfigVisuals(filteredBuckets.values(), visualConfig ?? config);
  assignBucketColors(filteredBuckets);
  const seriesBuckets = [...filteredBuckets.values()];
  const shouldDownsample = options.forceDownsample === true || config.downsampleMode === 'minMaxLast';
  const { data, sampleRatio } = alignBuckets(seriesBuckets, config.maxPoints, shouldDownsample);
  return {
    xLabel: config.xAxisMode === 'timestamp' ? 'time' : config.xAxisMode === 'index' ? 'index' : 'x',
    series: seriesBuckets.map((bucket) => bucket.series),
    data,
    pointCount: countPoints(data),
    sampleRatio,
    warnings: Array.from(new Map(warnings.map((w) => [plotWarningKey(w), w])).values()),
  };
}

export class PlotDatasetAccumulator {
  private _buckets = new Map<string, PointBucket>();
  private _latestByTopic = new Map<string, MessageEvent>();
  private _warnings = new Map<string, PlotDatasetWarning>();
  private _messageCount = 0;
  private _topicEventCounts = new Map<string, number>();
  private _timestampFoundBySeries = new Map<string, boolean>();
  private readonly _config: PlotConfig;
  private readonly _options: PlotDatasetAccumulatorOptions;

  constructor(
    config: PlotConfig,
    options: PlotDatasetAccumulatorOptions = {},
  ) {
    this._config = config;
    this._options = options;
    for (const warning of options.extraWarnings ?? []) {
      this._addWarning(warning);
    }
  }

  append(messages: MessageEvent[]): void {
    if (messages.length === 0) return;
    for (const event of messages) {
      this._messageCount++;
      this._latestByTopic.set(event.topic, event);
      this._topicEventCounts.set(event.topic, (this._topicEventCounts.get(event.topic) ?? 0) + 1);

      if (this._config.xAxisMode === 'timestamp') {
        this._appendTimestampEvent(event);
      } else if (this._config.xAxisMode === 'custom') {
        this._appendCustomEvent(event);
      }
    }
  }

  /**
   * Build a dataset snapshot. When `enabledSeriesIds` is provided, only
   * buckets owned by those series are emitted — letting callers re-render
   * after visibility toggles without re-ingesting data.
   */
  buildDataset(
    enabledSeriesIds?: ReadonlySet<string>,
    visualConfig?: PlotConfig,
  ): PlotDataset {
    // Live config used only to overlay current visuals (line style/size/color).
    // Structure (paths, axis mode, ...) still comes from the ingest-time config.
    const visuals = visualConfig ?? this._config;
    if (this._messageCount === 0) {
      return {
        ...EMPTY_DATASET,
        xLabel: this._config.xAxisMode === 'timestamp' ? 'time' : this._config.xAxisMode === 'index' ? 'index' : 'x',
        warnings: Array.from(this._warnings.values()),
      };
    }

    const seriesFilter = (series: PlotSeriesConfig): boolean =>
      isConfiguredSeries(series)
      && (enabledSeriesIds ? enabledSeriesIds.has(series.id) : series.enabled);

    if (this._config.xAxisMode === 'index') {
      const warnings = Array.from(this._warnings.values());
      // Re-collect at build time so we can apply the live enabled filter.
      const filteredConfig = this._configWithSeriesFilter(seriesFilter);
      const buckets = collectIndexPoints([...this._latestByTopic.values()], filteredConfig);
      return datasetFromBuckets(buckets, filteredConfig, this._options, warnings, undefined, visuals);
    }

    if (this._config.xAxisMode === 'currentCustom') {
      const warnings = Array.from(this._warnings.values());
      const filteredConfig = this._configWithSeriesFilter(seriesFilter);
      const buckets = collectCustomPoints(
        [...this._latestByTopic.values()],
        filteredConfig,
        true,
        warnings,
      );
      return datasetFromBuckets(buckets, filteredConfig, this._options, warnings, undefined, visuals);
    }

    const warnings = Array.from(this._warnings.values());
    if (this._config.xAxisMode === 'timestamp') {
      for (const series of this._config.series.filter(seriesFilter)) {
        if ((this._topicEventCounts.get(series.topic) ?? 0) > 0 && !this._timestampFoundBySeries.get(series.id)) {
          warnings.push({ kind: 'noNumericValues', topic: series.topic, path: series.path });
        }
      }
    }

    return datasetFromBuckets(
      this._buckets,
      this._config,
      this._options,
      warnings,
      new Set(this._config.series.filter(seriesFilter).map((s) => s.id)),
      visuals,
    );
  }

  getMessageCount(): number {
    return this._messageCount;
  }

  /** Build a config view with `series.enabled` rewritten by the supplied predicate. */
  private _configWithSeriesFilter(predicate: (series: PlotSeriesConfig) => boolean): PlotConfig {
    return {
      ...this._config,
      series: this._config.series.map((series) =>
        predicate(series) ? series : { ...series, enabled: false },
      ),
    };
  }

  private _appendTimestampEvent(event: MessageEvent): void {
    // Ingest for ALL configured series — visibility filtering happens at buildDataset time.
    for (const series of this._config.series.filter(isConfiguredSeries)) {
      if (series.topic !== event.topic) continue;
      const x = quantizePlotX(
        timeToSec(
          resolvePlotEventTimestamp(
            event,
            series.timestampMode,
            this._options.logStart,
            this._options.logEnd,
          ).time,
        ),
      );
      const values = extractPlotPathValues(event.message, series.path);
      if (values.length > 0) {
        this._timestampFoundBySeries.set(series.id, true);
      }
      for (const item of values) {
        pushPoint(this._buckets, series, item.key, item.label, x, item.value);
      }
    }
  }

  private _appendCustomEvent(event: MessageEvent): void {
    for (const series of this._config.series.filter(isConfiguredSeries)) {
      if (series.topic !== event.topic) continue;
      const xAxisPath = series.xAxisPath?.trim();
      if (!xAxisPath) {
        this._addWarning({ kind: 'missingXPath', topic: series.topic, path: series.path });
        continue;
      }
      const xs = extractXValues(event.message, xAxisPath);
      const ys = extractPlotPathValues(event.message, series.path);
      const count = Math.min(xs.length, ys.length);
      if (xs.length !== ys.length) {
        this._addWarning({
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
          this._buckets,
          series,
          singleCurve ? 'value' : (ys[i]?.key ?? `${i}`),
          singleCurve ? '' : (ys[i]?.label ?? `${i}`),
          x,
          y,
        );
      }
    }
  }

  private _addWarning(warning: PlotDatasetWarning): void {
    this._warnings.set(plotWarningKey(warning), warning);
  }
}

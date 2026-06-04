import type { TopicInfo } from '@/core/types/ros';
import { isJointStateSchema } from '@/shared/ros/rosMessageTypes';
import type { PlotConfig, PlotSeriesConfig } from './defaults';
import { isPlottableTopic } from './plottableSchemas';

export function buildTopicByName(topics: ReadonlyArray<TopicInfo>): Map<string, TopicInfo> {
  const map = new Map<string, TopicInfo>();
  for (const topic of topics) map.set(topic.name, topic);
  return map;
}

export function hasEnabledPlotPaths(config: PlotConfig): boolean {
  return config.series.some(
    (series) => series.enabled && series.topic && series.path.trim().length > 0,
  );
}

/**
 * Whether at least one series is fully configured (topic + path), regardless
 * of `enabled`. Used as the gate for data ingest, so that toggling visibility
 * of a single series in a multi-series panel doesn't tear down the read.
 */
export function hasConfiguredPlotPaths(config: PlotConfig): boolean {
  return config.series.some(
    (series) => series.topic && series.path.trim().length > 0,
  );
}

export function selectPrimarySeries(config: PlotConfig): PlotSeriesConfig | undefined {
  return config.series[0];
}

export function selectActivePlotTopics(
  config: PlotConfig,
  topicByName: ReadonlyMap<string, TopicInfo>,
): string[] {
  return Array.from(
    new Set(
      config.series
        // Include all configured series (even disabled) so toggling visibility
        // does not invalidate the active topic set and does not trigger a
        // redundant range re-read.
        .filter((series) => series.topic && series.path.trim().length > 0)
        .map((series) => series.topic)
        .filter((topic) => {
          const info = topicByName.get(topic);
          return info ? isPlottableTopic(info) : false;
        }),
    ),
  ).sort();
}

export function isPrimaryJointState(
  config: PlotConfig,
  topicByName: ReadonlyMap<string, TopicInfo>,
): boolean {
  const primary = selectPrimarySeries(config);
  const schema = primary?.topic ? topicByName.get(primary.topic)?.type : undefined;
  return schema ? isJointStateSchema(schema) : false;
}

/**
 * Stable key for config fields that affect range read + dataset build.
 *
 * NB: deliberately excludes `series.enabled` and `hiddenLegendKeys`. Toggling
 * those should re-render but never trigger a full range re-read; the
 * accumulator filters disabled series at build time.
 */
export function plotDataConfigKey(config: PlotConfig): string {
  const seriesKey = config.series
    .map(
      (s) =>
        `${s.id}|${s.topic}|${s.path}|${s.xAxisPath ?? ''}|${s.timestampMode}`,
    )
    .join(';');
  return JSON.stringify({
    xAxisMode: config.xAxisMode,
    maxPoints: config.maxPoints,
    downsampleMode: config.downsampleMode,
    nonIndexedMaxMessages: config.nonIndexedMaxMessages,
    jointStateFields: config.jointStateFields,
    series: seriesKey,
  });
}

/** Stable key for the set of enabled series ids. Cheap rebuild trigger. */
export function plotEnabledSeriesKey(config: PlotConfig): string {
  return config.series
    .filter((s) => s.enabled)
    .map((s) => s.id)
    .sort()
    .join('|');
}

/** Set of enabled series ids — passed to the dataset accumulator at build time. */
export function plotEnabledSeriesIds(config: PlotConfig): Set<string> {
  return new Set(config.series.filter((s) => s.enabled).map((s) => s.id));
}

/**
 * Stable key for per-series visual config (label/color/line style/size).
 *
 * Changing these should re-render the dataset visuals (a cheap rebuild) but
 * never trigger a range re-read — that is why it is tracked separately from
 * {@link plotDataConfigKey}.
 */
export function plotSeriesVisualKey(config: PlotConfig): string {
  return config.series
    .map((s) => `${s.id}|${s.label}|${s.color}|${s.lineStyle}|${s.lineSize}`)
    .join(';');
}

/** Stable key for uPlot series topology (rebuild when this changes). */
export function plotChartTopologyKey(dataset: {
  series: ReadonlyArray<{
    key: string;
    label: string;
    color: string;
    lineStyle: string;
    lineSize: number;
  }>;
}): string {
  return dataset.series
    .map((s) => `${s.key}|${s.label}|${s.color}|${s.lineStyle}|${s.lineSize}`)
    .join(';');
}

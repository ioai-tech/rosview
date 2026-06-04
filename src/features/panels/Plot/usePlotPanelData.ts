import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Player } from '@/core/types/player';
import type { Time } from '@/core/types/ros';
import type { PlotDataset } from './datasets';
import type { PlotConfig } from './defaults';
import { PlotDatasetAccumulator } from './plotDatasetAccumulator';
import {
  plotDataConfigKey,
  plotEnabledSeriesIds,
  plotEnabledSeriesKey,
  plotSeriesVisualKey,
} from './plotConfigSelectors';
import { readPlotRangeIncremental, type PlotRangeReadProgress } from './rangeReader';
import type { PlotDatasetWarning } from './plotWarnings';

const MIN_DATASET_FLUSH_MS = 150;

const EMPTY_DATASET: PlotDataset = {
  xLabel: 'time',
  series: [],
  data: [[]],
  pointCount: 0,
  sampleRatio: 1,
  warnings: [],
};

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

export interface UsePlotPanelDataArgs {
  player: Player;
  config: PlotConfig;
  activeTopics: string[];
  hasPlotPaths: boolean;
  startTime?: Time;
  endTime?: Time;
  randomAccessByTopic?: boolean;
}

export interface UsePlotPanelDataResult {
  dataset: PlotDataset;
  loading: boolean;
  progress: PlotRangeReadProgress | null;
  error: string | null;
}

export function usePlotPanelData({
  player,
  config,
  activeTopics,
  hasPlotPaths,
  startTime,
  endTime,
  randomAccessByTopic,
}: UsePlotPanelDataArgs): UsePlotPanelDataResult {
  const [dataset, setDataset] = useState<PlotDataset>(EMPTY_DATASET);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<PlotRangeReadProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  const dataConfigKey = useMemo(() => plotDataConfigKey(config), [config]);
  const enabledSeriesKey = useMemo(() => plotEnabledSeriesKey(config), [config]);
  const seriesVisualKey = useMemo(() => plotSeriesVisualKey(config), [config]);
  const enabledSeriesIds = useMemo(() => plotEnabledSeriesIds(config), [config]);
  const enabledSeriesIdsRef = useRef(enabledSeriesIds);
  useEffect(() => {
    enabledSeriesIdsRef.current = enabledSeriesIds;
  }, [enabledSeriesIds]);
  // Latest config for live visual overlays (line style/size/color) applied at
  // dataset build time without re-ingesting data.
  const configRef = useRef(config);
  useEffect(() => {
    configRef.current = config;
  }, [config]);
  const accumulatorRef = useRef<PlotDatasetAccumulator | null>(null);

  const progressRef = useRef<PlotRangeReadProgress | null>(null);
  const progressFrameRef = useRef<number | null>(null);
  const datasetFrameRef = useRef<number | null>(null);
  const datasetTimeoutRef = useRef<ReturnType<typeof globalThis.setTimeout> | null>(null);
  const lastDatasetFlushMsRef = useRef(0);

  const flushProgress = useCallback(() => {
    progressFrameRef.current = null;
    if (progressRef.current) {
      setProgress(progressRef.current);
    }
  }, []);

  const onProgress = useCallback(
    (next: PlotRangeReadProgress) => {
      progressRef.current = next;
      if (progressFrameRef.current != null) return;
      progressFrameRef.current = requestAnimationFrame(flushProgress);
    },
    [flushProgress],
  );

  const cancelDatasetFlush = useCallback(() => {
    if (datasetFrameRef.current != null) {
      cancelAnimationFrame(datasetFrameRef.current);
      datasetFrameRef.current = null;
    }
    if (datasetTimeoutRef.current != null) {
      globalThis.clearTimeout(datasetTimeoutRef.current);
      datasetTimeoutRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!startTime || !endTime || activeTopics.length === 0 || !hasPlotPaths) {
      setDataset(EMPTY_DATASET);
      setLoading(false);
      setProgress(null);
      setError(null);
      return;
    }

    const controller = new AbortController();
    setDataset(EMPTY_DATASET);
    setLoading(true);
    setProgress(null);
    setError(null);
    lastDatasetFlushMsRef.current = 0;

    const isIndexed = randomAccessByTopic !== false;
    const maxMessages = isIndexed ? undefined : config.nonIndexedMaxMessages;
    const extraWarnings: PlotDatasetWarning[] = isIndexed
      ? []
      : [{ kind: 'nonIndexedSource' }];
    const accumulator = new PlotDatasetAccumulator(config, {
      forceDownsample: !isIndexed,
      extraWarnings,
      logStart: startTime,
      logEnd: endTime,
    });
    accumulatorRef.current = accumulator;

    const flushDataset = () => {
      datasetFrameRef.current = null;
      datasetTimeoutRef.current = null;
      if (controller.signal.aborted) return;
      lastDatasetFlushMsRef.current = performance.now();
      setDataset(accumulator.buildDataset(enabledSeriesIdsRef.current, configRef.current));
    };

    const scheduleDatasetFlush = () => {
      if (datasetFrameRef.current != null || datasetTimeoutRef.current != null) return;
      const elapsedMs = performance.now() - lastDatasetFlushMsRef.current;
      const delayMs = Math.max(0, MIN_DATASET_FLUSH_MS - elapsedMs);
      datasetTimeoutRef.current = globalThis.setTimeout(() => {
        datasetTimeoutRef.current = null;
        datasetFrameRef.current = requestAnimationFrame(flushDataset);
      }, delayMs);
    };

    void readPlotRangeIncremental({
      player,
      start: startTime,
      end: endTime,
      topics: activeTopics,
      signal: controller.signal,
      onProgress,
      maxMessages,
      onBatch: ({ messages }) => {
        accumulator.append(messages);
        scheduleDatasetFlush();
      },
    })
      .then(() => {
        if (controller.signal.aborted) return;
        cancelDatasetFlush();
        flushDataset();
      })
      .catch((err: unknown) => {
        if (!isAbortError(err)) {
          setDataset(EMPTY_DATASET);
          setError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setLoading(false);
          if (progressFrameRef.current != null) {
            cancelAnimationFrame(progressFrameRef.current);
            progressFrameRef.current = null;
          }
          cancelDatasetFlush();
        }
      });

    return () => {
      controller.abort();
      if (progressFrameRef.current != null) {
        cancelAnimationFrame(progressFrameRef.current);
        progressFrameRef.current = null;
      }
      cancelDatasetFlush();
      accumulatorRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- dataConfigKey captures data-affecting config fields
  }, [
    activeTopics,
    dataConfigKey,
    endTime,
    hasPlotPaths,
    cancelDatasetFlush,
    onProgress,
    player,
    randomAccessByTopic,
    startTime,
  ]);

  // Toggling series visibility (`series.enabled`) re-renders the dataset with
  // the new enabled filter but never re-ingests data, which keeps the chart
  // smooth and avoids the "loading" flash on every checkbox click.
  useEffect(() => {
    const accumulator = accumulatorRef.current;
    if (!accumulator) return;
    setDataset(accumulator.buildDataset(enabledSeriesIdsRef.current, configRef.current));
  }, [enabledSeriesKey]);

  // Changing a series' visual config (line style/size/color/label) rebuilds the
  // dataset with the live visuals overlaid — a cheap re-render that never
  // re-ingests data and lets the chart apply styles incrementally.
  useEffect(() => {
    const accumulator = accumulatorRef.current;
    if (!accumulator) return;
    setDataset(accumulator.buildDataset(enabledSeriesIdsRef.current, configRef.current));
  }, [seriesVisualKey]);

  return { dataset, loading, progress, error };
}

import React, { useEffect, useMemo, useRef } from 'react';
import { useIntl } from 'react-intl';
import { useShallow } from 'zustand/react/shallow';
import 'uplot/dist/uPlot.min.css';
import type { MessagePipelineState } from '@/core/pipeline/store';
import { useMessagePipeline } from '@/core/pipeline/useMessagePipeline';
import type { Player } from '@/core/types/player';
import { TopicQuickPicker } from '../framework';
import type { JointStateField, PlotConfig } from './defaults';
import { JOINT_STATE_FIELDS } from './defaults';
import { filterPlottableTopics } from './plottableSchemas';
import { pickDefaultPlotTopic } from './pickDefaultPlotTopic';
import { secToTime } from './plotChart';
import { applyJointStateFieldsToConfig, pruneHiddenLegendKeysForDataset } from './plotConfigActions';
import {
  buildTopicByName,
  hasConfiguredPlotPaths,
  hasEnabledPlotPaths,
  isPrimaryJointState,
  selectActivePlotTopics,
  selectPrimarySeries,
} from './plotConfigSelectors';
import { hiddenSeriesIndices } from './plotLegendVisibility';
import {
  clearPlotLegendEntries,
  setPlotLegendEntries,
} from './plotPanelRuntimeStore';
import { formatPlotDatasetWarning } from './plotWarnings';
import { usePlotChart } from './usePlotChart';
import { usePlotPanelData } from './usePlotPanelData';
import { usePlotTopicDetection } from './usePlotTopicDetection';
import { timeToSec } from '@/core/analysis/timeSeries';

/** Stable empty array for activeTopics when no topics are configured. */
const EMPTY_TOPICS: string[] = [];

interface PlotPanelProps {
  player: Player;
  panelId: string;
  config: PlotConfig;
  setConfig: (next: PlotConfig | ((prev: PlotConfig) => PlotConfig)) => void;
}

function JointStateFieldChips({
  fields,
  fieldLabels,
  onChange,
}: {
  fields: JointStateField[];
  fieldLabels: Record<JointStateField, string>;
  onChange: (fields: JointStateField[]) => void;
}): React.ReactNode {
  return (
    <div className="flex items-center gap-0.5">
      {JOINT_STATE_FIELDS.map((field) => {
        const active = fields.includes(field);
        return (
          <button
            key={field}
            type="button"
            onClick={() => {
              const next = active ? fields.filter((f) => f !== field) : [...fields, field];
              onChange(next.length > 0 ? next : ['position']);
            }}
            className={`rounded px-1.5 py-0.5 text-[10px] capitalize ${
              active ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:bg-accent'
            }`}
          >
            {fieldLabels[field]}
          </button>
        );
      })}
    </div>
  );
}

export const PlotPanel: React.FC<PlotPanelProps> = ({ player, panelId, config, setConfig }) => {
  const { formatMessage } = useIntl();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const autoTopicAppliedRef = useRef(false);

  const { startTime, endTime, randomAccessByTopic, topics } = useMessagePipeline(
    useShallow((state: MessagePipelineState) => ({
      startTime: state.playerState.activeData?.startTime,
      endTime: state.playerState.activeData?.endTime,
      randomAccessByTopic: state.playerState.activeData?.randomAccessByTopic,
      topics: state.playerState.activeData?.topics ?? [],
    })),
  );

  const plottableTopics = useMemo(() => filterPlottableTopics(topics), [topics]);
  const topicByName = useMemo(() => buildTopicByName(topics), [topics]);
  const activeTopicsKey = useMemo(
    () => selectActivePlotTopics(config, topicByName).join('\n'),
    [config, topicByName],
  );
  const activeTopics = useMemo(
    () => (activeTopicsKey === '' ? EMPTY_TOPICS : activeTopicsKey.split('\n')),
    [activeTopicsKey],
  );
  const hasPlotPaths = useMemo(() => hasConfiguredPlotPaths(config), [config]);
  const hasEnabledSeries = useMemo(() => hasEnabledPlotPaths(config), [config]);
  const primary = selectPrimarySeries(config);
  const showJointStateFields = isPrimaryJointState(config, topicByName);

  const xRange = useMemo(() => {
    if (!startTime || !endTime || config.xAxisMode !== 'timestamp') return undefined;
    return { min: timeToSec(startTime), max: timeToSec(endTime) };
  }, [config.xAxisMode, endTime, startTime]);

  const { detectingTopic, applyTopicDetection } = usePlotTopicDetection({
    player,
    config,
    setConfig,
    topicByName,
    startTime,
    endTime,
  });

  const { dataset, loading, progress, error } = usePlotPanelData({
    player,
    config,
    activeTopics,
    hasPlotPaths,
    startTime,
    endTime,
    randomAccessByTopic,
  });

  const hiddenSeries = useMemo(
    () => hiddenSeriesIndices(dataset.series, config.hiddenLegendKeys),
    [config.hiddenLegendKeys, dataset.series],
  );

  const uplotRef = usePlotChart({
    containerRef,
    player,
    panelId,
    config,
    dataset,
    hiddenSeries,
    xRange,
    logStart: startTime,
    loading,
  });

  useEffect(() => {
    const subscriptions = activeTopics.map((topic) => ({ topic, subscriberId: panelId }));
    if (subscriptions.length > 0) {
      player.registerSubscriptions(panelId, subscriptions);
    }
    return () => player.unregisterSubscriptions(panelId);
  }, [player, panelId, activeTopics]);

  useEffect(() => {
    const entries = dataset.series.map((series) => ({
      key: series.key,
      label: series.label,
      color: series.color,
    }));
    setPlotLegendEntries(panelId, entries);

    const keys = entries.map((entry) => entry.key);
    setConfig((prev) => pruneHiddenLegendKeysForDataset(prev, keys));
  }, [dataset.series, panelId, setConfig]);

  useEffect(() => () => clearPlotLegendEntries(panelId), [panelId]);

  useEffect(() => {
    if (autoTopicAppliedRef.current || !startTime || !endTime) return;
    if (primary?.topic) {
      autoTopicAppliedRef.current = true;
      return;
    }
    const defaultTopic = pickDefaultPlotTopic(plottableTopics);
    if (!defaultTopic || !config.series[0]?.id) return;
    autoTopicAppliedRef.current = true;
    void applyTopicDetection(config.series[0].id, defaultTopic);
  }, [applyTopicDetection, config.series, endTime, plottableTopics, primary?.topic, startTime]);

  const updatePrimaryTopic = (topic: string) => {
    const primaryId = config.series[0]?.id;
    if (primaryId) void applyTopicDetection(primaryId, topic);
  };

  const handleJointStateFieldsChange = (fields: JointStateField[]) => {
    setConfig((prev) => applyJointStateFieldsToConfig(prev, topicByName, fields));
  };

  const jointFieldLabels = useMemo(
    (): Record<JointStateField, string> => ({
      position: formatMessage({ id: 'panels.jointStatePlot.toolbar.field.position' }),
      velocity: formatMessage({ id: 'panels.jointStatePlot.toolbar.field.velocity' }),
      effort: formatMessage({ id: 'panels.jointStatePlot.toolbar.field.effort' }),
    }),
    [formatMessage],
  );

  const primaryWarning = dataset.warnings[0];
  const warningText = primaryWarning
    ? formatPlotDatasetWarning(primaryWarning, formatMessage)
    : undefined;

  const hasSeries = activeTopics.length > 0 && hasEnabledSeries;
  const status = detectingTopic
    ? formatMessage({ id: 'panels.plot.status.detectingPaths' })
    : loading
      ? progress
        ? formatMessage(
            { id: 'panels.plot.status.loadingProgress' },
            { count: progress.messages.toLocaleString() },
          )
        : formatMessage({ id: 'panels.plot.status.loading' })
      : error
        ? error
        : hasSeries && dataset.sampleRatio < 1
          ? formatMessage(
              { id: 'panels.plot.status.sampling' },
              { percent: Math.round(dataset.sampleRatio * 100) },
            )
          : null;

  const handleChartClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const chart = uplotRef.current;
    if (!chart || config.xAxisMode !== 'timestamp') return;
    // posToVal expects a position relative to the plotting area (the `over`
    // element), which is what hover/cursor uses. Using `root` here would add the
    // left Y-axis width as a fixed offset, shifting the seek target to the right.
    const rect = chart.over.getBoundingClientRect();
    const x = chart.posToVal(event.clientX - rect.left, 'x');
    if (Number.isFinite(x)) {
      player.seek(secToTime(x));
    }
  };

  const showLoadingOverlay = loading && dataset.pointCount === 0;
  const progressFraction =
    progress && progress.total > 0 ? Math.min(1, progress.completed / progress.total) : null;

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex shrink-0 items-center gap-2 border-b border-border bg-muted px-2 py-1">
        <div className="min-w-0 flex-1 max-w-xs">
          <TopicQuickPicker
            value={primary?.topic ?? ''}
            onChange={updatePrimaryTopic}
            topics={plottableTopics}
            placeholder={formatMessage({ id: 'panels.plot.toolbar.selectTopic' })}
            triggerClassName="h-[24px] text-[11px] px-2"
          />
        </div>
        {showJointStateFields && (
          <JointStateFieldChips
            fields={config.jointStateFields}
            fieldLabels={jointFieldLabels}
            onChange={handleJointStateFieldsChange}
          />
        )}
        {status && (
          <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">{status}</span>
        )}
      </div>
      <div className="relative min-h-0 flex-1 flex flex-col">
        {/* Slim progress bar that runs across the top while the range read streams in. */}
        {loading && (
          <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-0.5 bg-transparent">
            {progressFraction == null ? (
              <div className="h-full w-1/3 animate-pulse rounded-r-full bg-primary/60" />
            ) : (
              <div
                className="h-full bg-primary/70 transition-[width] duration-150 ease-linear"
                style={{ width: `${Math.round(progressFraction * 100)}%` }}
              />
            )}
          </div>
        )}
        <div
          ref={containerRef}
          className="min-h-0 flex-1 w-full overflow-hidden"
          onClick={handleChartClick}
        />
        {!hasSeries && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-4 text-center text-xs text-muted-foreground">
            {formatMessage({ id: 'panels.plot.empty.selectTopic' })}
          </div>
        )}
        {/* Centered overlay only on first paint; subsequent batches stream in on top of the chart. */}
        {showLoadingOverlay && hasSeries && !error && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-4 text-center text-xs text-muted-foreground">
            {progress
              ? formatMessage(
                  { id: 'panels.plot.status.loadingProgress' },
                  { count: progress.messages.toLocaleString() },
                )
              : formatMessage({ id: 'panels.plot.status.loading' })}
          </div>
        )}
        {hasSeries && !loading && !detectingTopic && !error && dataset.pointCount === 0 && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-4 text-center text-xs text-muted-foreground">
            {formatMessage({ id: 'panels.plot.empty.noNumericData' })}
          </div>
        )}
        {warningText && (
          <div className="absolute bottom-1 left-1 max-w-[70%] rounded border border-border bg-card/90 px-2 py-1 text-[10px] text-muted-foreground">
            {warningText}
          </div>
        )}
      </div>
    </div>
  );
};

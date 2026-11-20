import React, { useEffect, useMemo, useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { useIntl } from 'react-intl';
import { useShallow } from 'zustand/react/shallow';
import type { MessagePipelineState } from '@/core/pipeline/store';
import { useMessagePipeline } from '@/core/pipeline/useMessagePipeline';
import type { Time, TopicInfo } from '@/core/types/ros';
import { isJointStateSchema } from '@/shared/ros/rosMessageTypes';
import type { PanelSettingsContext } from '../framework/types';
import {
  SettingsField,
  SettingsNumber,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
  SettingsText,
  TopicAutocomplete,
} from '../framework/settings';
import {
  JOINT_STATE_FIELDS,
  MAX_PLOT_POINTS,
  MIN_PLOT_POINTS,
  PLOT_LINE_STYLES,
  type JointStateField,
  type PlotConfig,
  type PlotLineStyle,
  type PlotSeriesConfig,
  type PlotXAxisMode,
} from './defaults';
import { exportPlotCsvFromConfig } from './exportCsv';
import { PlotCsvExportButton } from './PlotCsvExportButton';
import { isArrayLikePlotPath, splitPlotPathList } from './messagePath';
import { detectPlotPaths } from './autoDetect';
import { filterPlottableTopics, isPlottableSchema } from './plottableSchemas';
import {
  addPlotSeriesToConfig,
  applyJointStateFieldsToConfig,
  toggleSeriesEnabled,
  updateSeriesInConfig,
} from './plotConfigActions';
import { buildTopicByName } from './plotConfigSelectors';
import { PlotLegendSettings } from './PlotLegendSettings';
import { sampleTopicMessage } from './plotTopicService';
import { usePlotTopicDetection } from './usePlotTopicDetection';

interface FieldTreeNode {
  label: string;
  path?: string;
  children: FieldTreeNode[];
}

/** Tree segments of a field path; `@` modifiers (which may contain dotted paths) stay on the leaf. */
function pathSegments(path: string): string[] {
  const at = path.indexOf('@');
  const source = at < 0 ? path : path.slice(0, at);
  const segments = source
    .split('.')
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (at >= 0 && segments.length > 0) segments[segments.length - 1] += path.slice(at);
  return segments;
}

function buildFieldTree(paths: string[]): FieldTreeNode[] {
  const root: FieldTreeNode = { label: '', children: [] };

  for (const path of paths) {
    let cursor = root;
    const segments = pathSegments(path);
    for (let i = 0; i < segments.length; i++) {
      const label = segments[i] ?? '';
      let next = cursor.children.find((child) => child.label === label);
      if (!next) {
        next = { label, children: [] };
        cursor.children.push(next);
      }
      if (i === segments.length - 1) next.path = path;
      cursor = next;
    }
  }

  const sortChildren = (node: FieldTreeNode) => {
    node.children.sort((a, b) => a.label.localeCompare(b.label));
    node.children.forEach(sortChildren);
  };
  sortChildren(root);
  return root.children;
}

function togglePath(path: string, currentPath: string): string {
  const selected = new Set(splitPlotPathList(currentPath));
  if (selected.has(path)) {
    selected.delete(path);
  } else {
    selected.add(path);
  }
  return Array.from(selected).join(',');
}

function FieldTreeRows({
  nodes,
  selected,
  onToggle,
  depth = 0,
}: {
  nodes: FieldTreeNode[];
  selected: Set<string>;
  onToggle: (path: string) => void;
  depth?: number;
}): React.ReactNode {
  return nodes.map((node) => (
    <div key={`${depth}:${node.label}:${node.path ?? ''}`}>
      <div
        className="flex min-h-6 items-center gap-1 rounded px-1 text-[11px] hover:bg-accent/60"
        style={{ paddingLeft: `${depth * 12 + 4}px` }}
      >
        {node.path ? (
          <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5">
            <input
              type="checkbox"
              className="h-3 w-3"
              checked={selected.has(node.path)}
              onChange={() => onToggle(node.path ?? '')}
            />
            <span className="truncate font-mono">{node.label}</span>
          </label>
        ) : (
          <span className="truncate text-muted-foreground">{node.label}</span>
        )}
      </div>
      {node.children.length > 0 && (
        <FieldTreeRows nodes={node.children} selected={selected} onToggle={onToggle} depth={depth + 1} />
      )}
    </div>
  ));
}

function TopicFieldTree({
  player,
  series,
  topicByName,
  startTime,
  endTime,
  jointStateFields,
  onPathChange,
}: {
  player: PanelSettingsContext<PlotConfig>['player'];
  series: PlotSeriesConfig;
  topicByName: ReadonlyMap<string, TopicInfo>;
  startTime?: Time;
  endTime?: Time;
  jointStateFields: JointStateField[];
  onPathChange: (path: string) => void;
}): React.ReactNode {
  const { formatMessage } = useIntl();
  const schemaName = series.topic ? topicByName.get(series.topic)?.type : undefined;
  const [sample, setSample] = useState<unknown>();
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setSample(undefined);
    if (!series.topic || !startTime || !endTime) return;

    setLoading(true);
    void sampleTopicMessage({ player, topic: series.topic, startTime, endTime })
      .then((message) => {
        if (!cancelled) setSample(message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [endTime, player, series.topic, startTime]);

  const fields = useMemo(() => {
    if (!schemaName) return [];
    return detectPlotPaths({
      schemaName,
      sample,
      jointStateFields: isJointStateSchema(schemaName) ? jointStateFields : undefined,
    });
  }, [jointStateFields, sample, schemaName]);

  const selected = useMemo(() => new Set(splitPlotPathList(series.path)), [series.path]);
  const tree = useMemo(() => buildFieldTree(fields.map((field) => field.path)), [fields]);

  if (!series.topic) return null;

  return (
    <SettingsField
      label={formatMessage({ id: 'panels.plot.settings.field.topicFields', defaultMessage: 'Topic fields' })}
      help={formatMessage({
        id: 'panels.plot.settings.field.topicFields.help',
        defaultMessage: 'Select numeric message fields to plot.',
      })}
    >
      <div className="max-h-48 overflow-auto rounded border border-border bg-background p-1">
        {loading && tree.length === 0 ? (
          <div className="px-2 py-1 text-[11px] text-muted-foreground">
            {formatMessage({ id: 'panels.plot.settings.field.topicFields.loading', defaultMessage: 'Detecting fields…' })}
          </div>
        ) : tree.length === 0 ? (
          <div className="px-2 py-1 text-[11px] text-muted-foreground">
            {formatMessage({ id: 'panels.plot.settings.field.topicFields.empty', defaultMessage: 'No numeric fields detected.' })}
          </div>
        ) : (
          <FieldTreeRows
            nodes={tree}
            selected={selected}
            onToggle={(path) => onPathChange(togglePath(path, series.path))}
          />
        )}
      </div>
    </SettingsField>
  );
}

export function PlotPanelSettings({
  config,
  setConfig,
  topics,
  player,
  panelId,
}: PanelSettingsContext<PlotConfig>): React.ReactNode {
  const { formatMessage } = useIntl();
  const { startTime, endTime, randomAccessByTopic } = useMessagePipeline(
    useShallow((state: MessagePipelineState) => ({
      startTime: state.playerState.activeData?.startTime,
      endTime: state.playerState.activeData?.endTime,
      randomAccessByTopic: state.playerState.activeData?.randomAccessByTopic,
    })),
  );

  const plottableTopics = useMemo(() => filterPlottableTopics(topics), [topics]);
  const topicByName = useMemo(() => buildTopicByName(topics), [topics]);

  const { applyTopicDetection } = usePlotTopicDetection({
    player,
    config,
    setConfig,
    topicByName,
    startTime,
    endTime,
  });

  const xAxisOptions = useMemo(() => {
    const primary = config.series[0];
    const pathLooksArray = isArrayLikePlotPath(primary?.path ?? '');
    const hasXPath = (primary?.xAxisPath ?? '').trim().length > 0;

    const arrayHint = formatMessage({ id: 'panels.plot.settings.enum.xAxis.requiresArrayHint' });
    const xPathHint = formatMessage({ id: 'panels.plot.settings.enum.xAxis.requiresXPathHint' });

    return [
      {
        value: 'timestamp' as const,
        label: formatMessage({ id: 'panels.plot.settings.enum.xAxis.timestamp' }),
      },
      {
        value: 'index' as const,
        label:
          formatMessage({ id: 'panels.plot.settings.enum.xAxis.index' })
          + (pathLooksArray ? '' : ` ${arrayHint}`),
        disabled: !pathLooksArray,
      },
      {
        value: 'custom' as const,
        label:
          formatMessage({ id: 'panels.plot.settings.enum.xAxis.custom' })
          + (pathLooksArray ? (hasXPath ? '' : ` ${xPathHint}`) : ` ${arrayHint}`),
        disabled: !pathLooksArray || !hasXPath,
      },
      {
        value: 'currentCustom' as const,
        label:
          formatMessage({ id: 'panels.plot.settings.enum.xAxis.currentCustom' })
          + (pathLooksArray ? (hasXPath ? '' : ` ${xPathHint}`) : ` ${arrayHint}`),
        disabled: !pathLooksArray || !hasXPath,
      },
    ];
  }, [config.series, formatMessage]);

  const timestampOptions = useMemo(
    () => [
      { value: 'headerStamp' as const, label: formatMessage({ id: 'panels.plot.settings.enum.timestamp.headerStamp' }) },
      { value: 'receiveTime' as const, label: formatMessage({ id: 'panels.plot.settings.enum.timestamp.receiveTime' }) },
      { value: 'publishTime' as const, label: formatMessage({ id: 'panels.plot.settings.enum.timestamp.publishTime' }) },
    ],
    [formatMessage],
  );

  const lineStyleOptions = useMemo(
    () =>
      PLOT_LINE_STYLES.map((style) => ({
        value: style,
        label: formatMessage({
          id: style === 'solid'
            ? 'panels.plot.settings.enum.lineStyle.solid'
            : 'panels.plot.settings.enum.lineStyle.dashed',
        }),
      })),
    [formatMessage],
  );

  const jointFieldOptions = useMemo(
    () =>
      JOINT_STATE_FIELDS.map((field) => ({
        value: field,
        label: formatMessage({
          id:
            field === 'position'
              ? 'panels.jointStatePlot.toolbar.field.position'
              : field === 'velocity'
                ? 'panels.jointStatePlot.toolbar.field.velocity'
                : 'panels.jointStatePlot.toolbar.field.effort',
        }),
      })),
    [formatMessage],
  );

  return (
    <div className="space-y-2">
      <SettingsSection title={formatMessage({ id: 'panels.plot.settings.section.plot' })}>
        <SettingsField label={formatMessage({ id: 'panels.plot.settings.field.xAxis' })}>
          <SettingsSelect<PlotXAxisMode>
            value={config.xAxisMode}
            options={xAxisOptions}
            onChange={(xAxisMode) => setConfig({ ...config, xAxisMode })}
          />
        </SettingsField>
        <SettingsField
          label={formatMessage(
            { id: 'panels.plot.settings.field.maxPoints' },
            { count: config.maxPoints.toLocaleString() },
          )}
        >
          <SettingsNumber
            value={config.maxPoints}
            min={MIN_PLOT_POINTS}
            max={MAX_PLOT_POINTS}
            step={1000}
            onChange={(maxPoints) => setConfig({ ...config, maxPoints })}
          />
        </SettingsField>
        <SettingsField
          label={formatMessage(
            { id: 'panels.plot.settings.field.nonIndexedMaxMessages' },
            { count: config.nonIndexedMaxMessages.toLocaleString() },
          )}
          help={formatMessage({ id: 'panels.plot.settings.field.nonIndexedMaxMessages.help' })}
        >
          <SettingsNumber
            value={config.nonIndexedMaxMessages}
            min={1000}
            max={MAX_PLOT_POINTS}
            step={1000}
            onChange={(nonIndexedMaxMessages) => setConfig({ ...config, nonIndexedMaxMessages })}
          />
        </SettingsField>
        <SettingsField
          label={formatMessage({ id: 'panels.plot.settings.field.jointStateFields' })}
          help={formatMessage({ id: 'panels.plot.settings.field.jointStateFields.help' })}
        >
          <div className="flex flex-wrap gap-1">
            {jointFieldOptions.map((option) => {
              const active = config.jointStateFields.includes(option.value);
              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => {
                    const next: JointStateField[] = active
                      ? config.jointStateFields.filter((f) => f !== option.value)
                      : [...config.jointStateFields, option.value];
                    const fields = next.length > 0 ? next : (['position'] as JointStateField[]);
                    setConfig((prev) => applyJointStateFieldsToConfig(prev, topicByName, fields));
                  }}
                  className={`rounded border px-2 py-0.5 text-[10px] capitalize ${
                    active ? 'border-primary bg-primary/10 text-primary' : 'border-border'
                  }`}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
        </SettingsField>
        <SettingsField
          label={formatMessage({ id: 'panels.plot.settings.field.followingWindow' })}
          help={formatMessage({ id: 'panels.plot.settings.field.followingWindow.help' })}
        >
          <SettingsNumber
            value={config.followingViewWidthSec}
            min={0}
            max={86_400}
            step={1}
            onChange={(followingViewWidthSec) => setConfig({ ...config, followingViewWidthSec })}
          />
        </SettingsField>
        <SettingsField label={formatMessage({ id: 'panels.plot.settings.field.syncX' })} orientation="row">
          <SettingsSwitch
            checked={config.syncX}
            onChange={(syncX) => setConfig({ ...config, syncX })}
          />
        </SettingsField>
        <SettingsField label={formatMessage({ id: 'panels.plot.settings.field.export' })}>
          <PlotCsvExportButton
            disabled={!startTime || !endTime}
            run={async () => {
              if (!startTime || !endTime) return;
              await exportPlotCsvFromConfig({
                player,
                config,
                startTime,
                endTime,
                forceDownsample: randomAccessByTopic === false,
              });
            }}
          />
        </SettingsField>
      </SettingsSection>

      <SettingsSection title={formatMessage({ id: 'panels.plot.settings.section.series' })}>
        {config.series.map((series, index) => (
          <div
            key={series.id}
            className={`rounded border border-border p-2 space-y-2 ${series.enabled ? '' : 'opacity-60'}`}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold">
                {formatMessage({ id: 'panels.plot.settings.series.title' }, { index: index + 1 })}
              </span>
              <button
                type="button"
                onClick={() => setConfig((prev) => toggleSeriesEnabled(prev, series.id))}
                className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded hover:bg-accent"
                aria-label={formatMessage(
                  {
                    id: series.enabled
                      ? 'panels.plot.settings.series.hide'
                      : 'panels.plot.settings.series.show',
                  },
                  { index: index + 1 },
                )}
                title={formatMessage(
                  {
                    id: series.enabled
                      ? 'panels.plot.settings.series.hide'
                      : 'panels.plot.settings.series.show',
                  },
                  { index: index + 1 },
                )}
              >
                {series.enabled ? (
                  <Eye className="h-3.5 w-3.5 text-foreground" />
                ) : (
                  <EyeOff className="h-3.5 w-3.5 text-muted-foreground" />
                )}
              </button>
            </div>
            <SettingsField label={formatMessage({ id: 'panels.plot.settings.field.topic' })}>
              <TopicAutocomplete
                value={series.topic}
                topics={plottableTopics}
                topicTypeMatches={isPlottableSchema}
                onChange={(topic) => {
                  void applyTopicDetection(series.id, topic);
                }}
                placeholder="/topic"
              />
            </SettingsField>
            <TopicFieldTree
              player={player}
              series={series}
              topicByName={topicByName}
              startTime={startTime}
              endTime={endTime}
              jointStateFields={config.jointStateFields}
              onPathChange={(path) =>
                setConfig((prev) => updateSeriesInConfig(prev, series.id, { path }))
              }
            />
            <SettingsField
              label={formatMessage({ id: 'panels.plot.settings.field.yPath' })}
              help={formatMessage({ id: 'panels.plot.settings.field.yPath.help' })}
            >
              <SettingsText
                value={series.path}
                onChange={(path) => setConfig((prev) => updateSeriesInConfig(prev, series.id, { path }))}
                placeholder={formatMessage({ id: 'panels.plot.settings.field.yPath.placeholder' })}
              />
            </SettingsField>
            {(config.xAxisMode === 'custom' || config.xAxisMode === 'currentCustom') && (
              <SettingsField label={formatMessage({ id: 'panels.plot.settings.field.xPath' })}>
                <SettingsText
                  value={series.xAxisPath ?? ''}
                  onChange={(xAxisPath) =>
                    setConfig((prev) => updateSeriesInConfig(prev, series.id, { xAxisPath }))
                  }
                  placeholder={formatMessage({ id: 'panels.plot.settings.field.xPath.placeholder' })}
                />
              </SettingsField>
            )}
            <SettingsField label={formatMessage({ id: 'panels.plot.settings.field.label' })}>
              <SettingsText
                value={series.label}
                onChange={(label) => setConfig((prev) => updateSeriesInConfig(prev, series.id, { label }))}
                placeholder={formatMessage({ id: 'panels.plot.settings.field.label.placeholder' })}
              />
            </SettingsField>
            <SettingsField label={formatMessage({ id: 'panels.plot.settings.field.timestampSource' })}>
              <SettingsSelect
                value={series.timestampMode}
                options={timestampOptions}
                onChange={(timestampMode) =>
                  setConfig((prev) => updateSeriesInConfig(prev, series.id, { timestampMode }))
                }
              />
            </SettingsField>
            <SettingsField label={formatMessage({ id: 'panels.plot.settings.field.lineStyle' })}>
              <SettingsSelect<PlotLineStyle>
                value={series.lineStyle}
                options={lineStyleOptions}
                onChange={(lineStyle) =>
                  setConfig((prev) => updateSeriesInConfig(prev, series.id, { lineStyle }))
                }
              />
            </SettingsField>
            <SettingsField label={formatMessage({ id: 'panels.plot.settings.field.lineSize' })}>
              <SettingsNumber
                value={series.lineSize}
                min={0.5}
                max={8}
                step={0.5}
                onChange={(lineSize) =>
                  setConfig((prev) => updateSeriesInConfig(prev, series.id, { lineSize }))
                }
              />
            </SettingsField>
            <PlotLegendSettings
              panelId={panelId}
              seriesId={series.id}
              config={config}
              setConfig={setConfig}
            />
          </div>
        ))}
        <button
          type="button"
          onClick={() => setConfig((prev) => addPlotSeriesToConfig(prev))}
          className="w-full rounded border border-border bg-background px-2 py-1 text-xs hover:bg-accent"
        >
          {formatMessage({ id: 'panels.plot.settings.addSeries' })}
        </button>
      </SettingsSection>
    </div>
  );
}

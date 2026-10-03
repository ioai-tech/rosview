import React, { useMemo, useState } from 'react';
import type { IntlShape } from 'react-intl';
import { useIntl } from 'react-intl';
import type {
  ClockEvidenceWindow,
  DataQualityExplainPayload,
  DataQualityIssueRange,
  DataQualityIssueType,
  DataQualityReport,
  Time,
} from '@/core/types/ros';
import { CheckCircle2 } from 'lucide-react';
import type { QualityFilter } from '@/shared/hooks/useSidebarStore';
import { Button } from '@/shared/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/shared/ui/dropdown-menu';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/shared/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/shared/ui/tabs';
import { buildQualityChartPoints, QualityIssueChart } from './QualityIssueChart';

interface QualitySidebarProps {
  report?: DataQualityReport;
  filter?: QualityFilter;
  timelineStart?: Time;
  autoDataQualityScan: boolean;
  onAutoDataQualityScanChange: (enabled: boolean) => void;
  onRequestScan: () => void;
  onFilterChange: (filter: QualityFilter | undefined) => void;
  onSeek: (time: Time) => void;
}

const ISSUE_TYPES: DataQualityIssueType[] = [
  'timestamp_rollback',
  'topic_frame_drop',
];

function rangeSeverityClass(range: DataQualityIssueRange): string {
  return range.severity === 'error'
    ? 'border-destructive/60 bg-destructive/10'
    : 'border-amber-500/40 bg-amber-500/10';
}

function formatQualityExplain(
  formatMessage: IntlShape['formatMessage'],
  range: DataQualityIssueRange,
): string | null {
  const payload = range.explainPayload;
  if (payload) {
    const clock = formatMessage({ id: `quality.clock.${range.clockSource}` });
    return formatMessage({ id: payload.key }, { clock, ...payload.values });
  }
  return null;
}

function formatPayload(
  formatMessage: IntlShape['formatMessage'],
  payload?: DataQualityExplainPayload,
): string | undefined {
  return payload ? formatMessage({ id: payload.key }, payload.values) : undefined;
}

function headerTimeFromPoint(range: DataQualityIssueRange, timeNs: bigint): string {
  if (range.clockSource !== 'header') return '-';
  return timeNs.toString();
}

function formatSignedMs(value?: number): string {
  if (value == undefined) return '--';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(Math.abs(value) >= 10 ? 0 : 1)} ms`;
}

function maxDeviationMs(window: ClockEvidenceWindow): number | undefined {
  const values = [...window.beforeNormal, ...window.anomaly, ...window.afterNormal]
    .map((point) => {
      if (!point.deltaNs) return 0;
      return Math.abs(Number(BigInt(point.deltaNs)) / 1e6);
    })
    .filter((v) => Number.isFinite(v));
  if (values.length === 0) return undefined;
  return Math.max(...values);
}

function compactTypeLabel(type: DataQualityIssueType, formatMessage: IntlShape['formatMessage']): string {
  return formatMessage({ id: `quality.type.${type}` });
}

function severityRank(range: DataQualityIssueRange): number {
  return range.severity === 'error' ? 0 : 1;
}

function sortQualityRanges(a: DataQualityIssueRange, b: DataQualityIssueRange): number {
  const severity = severityRank(a) - severityRank(b);
  if (severity !== 0) return severity;
  if (a.start.sec !== b.start.sec) return a.start.sec - b.start.sec;
  return a.start.nsec - b.start.nsec;
}

export const QualitySidebar: React.FC<QualitySidebarProps> = ({
  report,
  filter,
  timelineStart,
  autoDataQualityScan,
  onAutoDataQualityScanChange,
  onRequestScan,
  onFilterChange,
  onSeek,
}) => {
  const { formatMessage } = useIntl();
  const [selectedTopicByRange, setSelectedTopicByRange] = useState<Record<string, string>>({});
  const [viewByRange, setViewByRange] = useState<Record<string, 'chart' | 'table'>>({});

  const ranges = useMemo(() => [...(report?.incidents ?? report?.ranges ?? [])].sort(sortQualityRanges), [report]);
  const filteredRanges = useMemo(() => {
    const query = filter?.query?.trim().toLowerCase();
    return ranges.filter((range) => {
      if (filter?.severity && filter.severity !== 'all' && range.severity !== filter.severity) {
        return false;
      }
      if (filter?.type && range.type !== filter.type) {
        return false;
      }
      if (filter?.topic && !range.topicNames.includes(filter.topic)) {
        return false;
      }
      if (query) {
        const title = formatPayload(formatMessage, range.titlePayload);
        const impact = formatPayload(formatMessage, range.impactPayload);
        const haystack = [range.topicGroup, title, impact, ...range.topicNames].filter(Boolean).join(' ').toLowerCase();
        if (!haystack.includes(query)) {
          return false;
        }
      }
      return true;
    });
  }, [filter, formatMessage, ranges]);

  const typeOptions = useMemo(
    () => ISSUE_TYPES.filter((type) => (report?.issueCounts[type] ?? 0) > 0),
    [report?.issueCounts],
  );

  const severityValue = filter?.severity ?? 'all';
  const typeValue = filter?.type ?? 'all';
  const severityLabel =
    severityValue === 'error'
      ? formatMessage({ id: 'quality.filter.error' })
      : severityValue === 'warn'
        ? formatMessage({ id: 'quality.filter.warn' })
        : formatMessage({ id: 'quality.filter.all' });
  const typeLabel =
    typeValue === 'all'
      ? formatMessage({ id: 'quality.filter.allTypes' })
      : compactTypeLabel(typeValue, formatMessage);

  if (!report) {
    return (
      <div className="p-3 text-xs text-muted-foreground">
        {formatMessage({ id: 'quality.empty' })}
      </div>
    );
  }

  const totalMsgs = report.totalMessages;
  const totalNum = typeof totalMsgs === 'number' ? totalMsgs : undefined;
  const pct =
    totalNum != undefined && totalNum > 0
      ? Math.min(100, Math.round((report.scannedMessages / totalNum) * 100))
      : undefined;
  const scanLeft =
    pct != undefined
      ? formatMessage(
          { id: 'quality.header.scanWithPct' },
          {
            scanned: report.scannedMessages,
            total: totalNum,
            pct,
            suffix: report.status === 'scanning' ? '…' : '',
          },
        )
      : formatMessage(
          { id: 'quality.header.scanNoPct' },
          {
            scanned: report.scannedMessages,
            total: totalMsgs ?? '?',
            suffix: report.status === 'scanning' ? '…' : '',
          },
        );
  const isScanning = report.status === 'scanning';
  const isIdle = report.status === 'idle';
  const scanButtonLabel =
    report.status === 'ready'
      ? formatMessage({ id: 'quality.scan.rescan' })
      : formatMessage({ id: 'quality.scan.start' });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-border/60 p-2">
        <div className="flex items-baseline justify-between gap-2 text-[10px] text-muted-foreground">
          <span className="min-w-0 truncate font-mono tabular-nums">{scanLeft}</span>
          <span
            className={
              ranges.length === 0 && !isScanning
                ? 'shrink-0 text-right text-emerald-500'
                : 'shrink-0 text-right text-muted-foreground'
            }
          >
            {formatMessage({ id: 'quality.incidentCount' }, { count: ranges.length })}
          </span>
        </div>
      </div>
      <div className="space-y-2 border-b border-border/60 p-2">
        <label className="flex items-center gap-2 text-[11px] text-foreground/90">
          <input
            type="checkbox"
            checked={autoDataQualityScan}
            onChange={(event) => onAutoDataQualityScanChange(event.currentTarget.checked)}
          />
          {formatMessage({ id: 'quality.scan.auto' })}
        </label>
        <Button
          type="button"
          size="sm"
          className="h-7 w-full text-[11px]"
          disabled={isScanning}
          onClick={onRequestScan}
        >
          {scanButtonLabel}
        </Button>
      </div>
      {isIdle ? (
        <div className="p-3 text-xs text-muted-foreground">
          {report.noticePayload
            ? formatPayload(formatMessage, report.noticePayload)
            : formatMessage({ id: 'quality.scan.idleHint' })}
        </div>
      ) : (
        <>
      {ranges.length > 0 && (
      <div className="space-y-2 border-b border-border/60 p-2">
        <div className="grid grid-cols-[0.85fr_1fr] gap-1">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 justify-between px-2 text-[10px] font-normal"
              >
                <span className="truncate">{severityLabel}</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-28">
              <DropdownMenuRadioGroup
                value={severityValue}
                onValueChange={(value) =>
                  onFilterChange({ ...filter, severity: value as QualityFilter['severity'] })
                }
              >
                <DropdownMenuRadioItem value="all" className="text-xs">
                  {formatMessage({ id: 'quality.filter.all' })}
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="error" className="text-xs">
                  {formatMessage({ id: 'quality.filter.error' })}
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="warn" className="text-xs">
                  {formatMessage({ id: 'quality.filter.warn' })}
                </DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 justify-between px-2 text-[10px] font-normal"
              >
                <span className="truncate">{typeLabel}</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="max-h-[min(18rem,60vh)] min-w-48 overflow-y-auto">
              <DropdownMenuRadioGroup
                value={typeValue}
                onValueChange={(value) =>
                  onFilterChange({ ...filter, type: value === 'all' ? undefined : (value as DataQualityIssueType) })
                }
              >
                <DropdownMenuRadioItem value="all" className="text-xs">
                  {formatMessage({ id: 'quality.filter.allTypes' })}
                </DropdownMenuRadioItem>
                {typeOptions.map((type) => (
                  <DropdownMenuRadioItem key={type} value={type} className="text-xs">
                    {formatMessage({ id: `quality.type.${type}` })} · {report.issueCounts[type] ?? 0}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <input
          value={filter?.query ?? ''}
          placeholder={formatMessage({ id: 'quality.filter.search' })}
          className="h-7 w-full rounded border border-border/70 bg-background px-2 text-[10px]"
          onChange={(event) => onFilterChange({ ...filter, query: event.currentTarget.value })}
        />
      </div>
      )}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-2">
        {filteredRanges.length === 0 ? (
          ranges.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-6 text-center text-xs text-emerald-500">
              <CheckCircle2 size={28} strokeWidth={1.5} className="shrink-0" aria-hidden />
              <span>{formatMessage({ id: 'quality.noMatches' })}</span>
            </div>
          ) : (
            <div className="p-2 text-xs text-muted-foreground">
              {formatMessage({ id: 'quality.noFilterMatches' })}
            </div>
          )
        ) : (
          filteredRanges.map((range) => {
            const explainLine = formatQualityExplain(formatMessage, range);
            const title = formatPayload(formatMessage, range.titlePayload) ?? formatMessage({ id: `quality.type.${range.type}` });
            const impact = formatPayload(formatMessage, range.impactPayload) ?? explainLine;
            const topicOptions =
              range.topicNames.length > 0 ? range.topicNames : Object.keys(range.topicEvidence ?? {});
            const selectedTopic = selectedTopicByRange[range.id] ?? topicOptions[0] ?? '';
            const selectedEvidence = selectedTopic ? range.topicEvidence?.[selectedTopic] ?? range.evidenceWindow : range.evidenceWindow;
            const baselineMs = range.summaryStats?.baselineIntervalNs
              ? Number(BigInt(range.summaryStats.baselineIntervalNs)) / 1e6
              : undefined;
            const sharedPoints = buildQualityChartPoints(selectedEvidence, baselineMs);
            const currentView = viewByRange[range.id] ?? 'chart';
            const anomalyPoints = selectedEvidence.anomaly.length;
            const topicCount = range.topicNames.length;
            const maxDeviation = maxDeviationMs(selectedEvidence);
            const hasEvidence = sharedPoints.length > 0;
            return (
              <div
                key={range.id}
                className={`mb-2 rounded border p-2 text-left text-[11px] ${rangeSeverityClass(range)}`}
              >
                <div
                  role="button"
                  tabIndex={0}
                  className="cursor-pointer rounded-sm outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
                  onClick={() => onSeek(range.start)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      onSeek(range.start);
                    }
                  }}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold">
                        {title}
                      </div>
                    </div>
                    <div className="shrink-0 rounded bg-background/70 px-1.5 py-0.5 font-mono text-[10px]">
                      {formatMessage({ id: 'quality.count' }, { count: range.summaryStats?.rawAnomalyCount ?? range.count })}
                    </div>
                  </div>
                  <div className="mt-1 text-[10px] leading-snug text-foreground/90">
                    {impact}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-1 text-[10px] text-muted-foreground">
                    {hasEvidence && (
                      <>
                        <span className="rounded bg-background/70 px-1.5 py-0.5 font-mono">
                          {formatMessage({ id: 'quality.metric.anomalyPoints' }, { count: anomalyPoints })}
                        </span>
                        <span className="rounded bg-background/70 px-1.5 py-0.5 font-mono">
                          {formatMessage({ id: 'quality.metric.maxDeviation' }, { value: maxDeviation?.toFixed(1) ?? '--' })}
                        </span>
                      </>
                    )}
                    <span className="rounded bg-background/70 px-1.5 py-0.5 font-mono">
                      {formatMessage({ id: 'quality.metric.topicCount' }, { count: topicCount })}
                    </span>
                  </div>
                </div>
                {hasEvidence && <div className="mt-2 space-y-2">
                  <div className="flex items-center gap-2">
                    <span className="shrink-0 text-[10px] text-muted-foreground">
                      {formatMessage({ id: 'quality.details.topic' })}
                    </span>
                    <Select
                      value={selectedTopic || undefined}
                      onValueChange={(value) =>
                        setSelectedTopicByRange((prev) => ({ ...prev, [range.id]: value }))
                      }
                    >
                      <SelectTrigger size="sm" className="h-7 min-w-0 flex-1 text-[10px]" disabled={topicOptions.length === 0}>
                        <SelectValue placeholder={formatMessage({ id: 'quality.details.noTopic' })} />
                      </SelectTrigger>
                      <SelectContent>
                        {topicOptions.map((topic) => (
                          <SelectItem key={topic} value={topic}>
                            {topic}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <Tabs
                    value={currentView}
                    onValueChange={(value) =>
                      setViewByRange((prev) => ({
                        ...prev,
                        [range.id]: value === 'table' ? 'table' : 'chart',
                      }))
                    }
                  >
                    <TabsList variant="line" className="w-full justify-start gap-3 border-b border-border/60 px-1">
                      <TabsTrigger value="chart" variant="line" className="px-1 py-1 text-[10px]">
                        {formatMessage({ id: 'quality.tabs.chart' })}
                      </TabsTrigger>
                      <TabsTrigger value="table" variant="line" className="px-1 py-1 text-[10px]">
                        {formatMessage({ id: 'quality.tabs.table' })}
                      </TabsTrigger>
                    </TabsList>
                    <TabsContent value="chart" className="mt-2 min-w-0">
                      <QualityIssueChart range={range} evidenceWindow={selectedEvidence} timelineStart={timelineStart} />
                    </TabsContent>
                    <TabsContent value="table" className="mt-2">
                      <div className="max-h-44 overflow-auto rounded border border-border/60">
                        <table className="w-full border-collapse text-[10px]">
                          <thead className="sticky top-0 bg-muted text-muted-foreground">
                            <tr>
                              <th className="border-b border-border/50 px-2 py-1 text-left font-medium">
                                {formatMessage({ id: 'quality.details.table.zone' })}
                              </th>
                              <th className="border-b border-border/50 px-2 py-1 text-left font-medium">
                                {formatMessage({ id: 'quality.details.table.index' })}
                              </th>
                              <th className="border-b border-border/50 px-2 py-1 text-left font-medium">
                                {formatMessage({ id: 'quality.details.table.logTime' })}
                              </th>
                              <th className="border-b border-border/50 px-2 py-1 text-left font-medium">
                                {formatMessage({ id: 'quality.details.table.headerTime' })}
                              </th>
                              <th className="border-b border-border/50 px-2 py-1 text-left font-medium">
                                {formatMessage({ id: 'quality.details.table.deviation' })}
                              </th>
                            </tr>
                          </thead>
                          <tbody>
                            {sharedPoints.length === 0 ? (
                              <tr>
                                <td colSpan={5} className="px-2 py-2 text-muted-foreground">
                                  {formatMessage({ id: 'quality.details.noRows' })}
                                </td>
                              </tr>
                            ) : (
                              sharedPoints.map((point, idx) => {
                                return (
                                  <React.Fragment key={`${point.zone}-${point.index}-${idx}`}>
                                    <tr>
                                      <td className="border-t border-border/40 px-2 py-1 font-mono">
                                        {formatMessage({ id: `quality.evidence.zone.${point.zone}` })}
                                      </td>
                                      <td className="border-t border-border/40 px-2 py-1 font-mono">
                                        {point.index}
                                      </td>
                                      <td className="border-t border-border/40 px-2 py-1 font-mono">
                                        {(point.logTimeNs ?? point.timeNs).toString()}
                                      </td>
                                      <td className="border-t border-border/40 px-2 py-1 font-mono">
                                        {headerTimeFromPoint(range, point.timeNs)}
                                      </td>
                                      <td className="border-t border-border/40 px-2 py-1 font-mono">
                                        {formatSignedMs(point.deviationMs)}
                                      </td>
                                    </tr>
                                  </React.Fragment>
                                );
                              })
                            )}
                          </tbody>
                        </table>
                      </div>
                    </TabsContent>
                  </Tabs>
                </div>}
              </div>
            );
          })
        )}
        {filter && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="mt-1 h-6 justify-start px-1 text-[10px]"
            onClick={() => onFilterChange(undefined)}
          >
            {formatMessage({ id: 'quality.clearFilter' })}
          </Button>
        )}
      </div>
        </>
      )}
    </div>
  );
};

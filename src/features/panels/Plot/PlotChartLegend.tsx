import React, { useMemo, useState } from 'react';
import { ChevronDown, ChevronUp, Eye, EyeOff } from 'lucide-react';
import { useIntl } from 'react-intl';
import type { PlotConfig } from './defaults';
import {
  isPlotLegendVisible,
  setOnlyPlotLegendVisible,
  setPlotLegendGroupVisible,
  setPlotLegendVisible,
  visiblePlotLegendCount,
} from './plotLegendVisibility';
import { usePlotLegendEntries, type PlotLegendEntry } from './plotPanelRuntimeStore';

const COLLAPSED_LIMIT = 1;

interface PlotChartLegendProps {
  panelId: string;
  config: PlotConfig;
  setConfig: (next: PlotConfig | ((prev: PlotConfig) => PlotConfig)) => void;
}

function stopPanelInteraction(event: React.SyntheticEvent) {
  event.stopPropagation();
}

export function filterPlotLegendEntries(
  entries: readonly PlotLegendEntry[],
  query: string,
): PlotLegendEntry[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...entries];
  return entries.filter((entry) => entry.label.toLowerCase().includes(needle));
}

export function collapsedPlotLegendEntries(
  entries: readonly PlotLegendEntry[],
  hiddenKeys: readonly string[],
  limit = COLLAPSED_LIMIT,
): PlotLegendEntry[] {
  const visible = entries.filter((entry) => isPlotLegendVisible(hiddenKeys, entry.key));
  const hidden = entries.filter((entry) => !isPlotLegendVisible(hiddenKeys, entry.key));
  return [...visible, ...hidden].slice(0, limit);
}

function LegendRow({
  entry,
  visible,
  onToggle,
  onOnly,
  showOnlyAction,
}: {
  entry: PlotLegendEntry;
  visible: boolean;
  onToggle: () => void;
  onOnly?: () => void;
  showOnlyAction?: boolean;
}): React.ReactNode {
  const { formatMessage } = useIntl();
  return (
    <div className={`flex min-w-0 items-center gap-1.5 rounded px-1.5 py-0.5 ${visible ? '' : 'opacity-55'}`}>
      <button
        type="button"
        className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded hover:bg-accent"
        onClick={onToggle}
        title={formatMessage({
          id: visible ? 'panels.plot.legend.hideCurve' : 'panels.plot.legend.showCurve',
        })}
        aria-label={formatMessage({
          id: visible ? 'panels.plot.legend.hideCurve' : 'panels.plot.legend.showCurve',
        })}
      >
        {visible ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
      </button>
      <span
        className="inline-block h-2 w-2 shrink-0 rounded-sm ring-1 ring-border/60"
        style={{ backgroundColor: entry.color }}
        aria-hidden
      />
      <button
        type="button"
        className="min-w-0 flex-1 truncate text-left text-[11px] leading-tight text-foreground hover:underline"
        onClick={onToggle}
        title={entry.label}
      >
        {entry.label}
      </button>
      {showOnlyAction && onOnly && (
        <button
          type="button"
          className="shrink-0 rounded px-1 text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={onOnly}
          title={formatMessage({ id: 'panels.plot.legend.onlyThis' })}
        >
          {formatMessage({ id: 'panels.plot.legend.only' })}
        </button>
      )}
      {!showOnlyAction && (
        <span className="invisible shrink-0 rounded px-1 text-[10px]" aria-hidden>
          {formatMessage({ id: 'panels.plot.legend.only' })}
        </span>
      )}
    </div>
  );
}

export function PlotChartLegend({
  panelId,
  config,
  setConfig,
}: PlotChartLegendProps): React.ReactNode {
  const { formatMessage } = useIntl();
  const entries = usePlotLegendEntries(panelId);
  const [expanded, setExpanded] = useState(false);
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => filterPlotLegendEntries(entries, query), [entries, query]);
  const hiddenKeys = config.hiddenLegendKeys;
  const collapsedEntries = useMemo(
    () => collapsedPlotLegendEntries(entries, hiddenKeys),
    [entries, hiddenKeys],
  );
  const allKeys = useMemo(() => entries.map((entry) => entry.key), [entries]);
  const visibleCount = visiblePlotLegendCount(entries, hiddenKeys);

  if (entries.length <= 1) return null;

  const setHiddenKeys = (next: string[]) => {
    setConfig((prev) => ({ ...prev, hiddenLegendKeys: next }));
  };

  const toggleEntry = (entry: PlotLegendEntry) => {
    setHiddenKeys(setPlotLegendVisible(hiddenKeys, entry.key, !isPlotLegendVisible(hiddenKeys, entry.key)));
  };

  const showOnly = (entry: PlotLegendEntry) => {
    setHiddenKeys(setOnlyPlotLegendVisible(hiddenKeys, allKeys, entry.key));
  };

  return (
    <div
      className={`absolute left-2 top-2 z-20 w-80 max-w-[min(28rem,70%)] rounded border border-border bg-card/80 text-foreground opacity-65 shadow-xs backdrop-blur-sm transition-opacity hover:bg-card/95 hover:opacity-100 focus-within:bg-card/95 focus-within:opacity-100 ${
        expanded ? 'bottom-2 flex flex-col' : ''
      }`}
      onClick={stopPanelInteraction}
      onDoubleClick={stopPanelInteraction}
      onPointerDown={stopPanelInteraction}
      onWheel={stopPanelInteraction}
    >
      <div className="flex items-center gap-2 border-b border-border/70 px-2 py-1">
        <span className="min-w-0 flex-1 truncate text-[11px] font-medium">
          {formatMessage(
            { id: 'panels.plot.legend.visibleCount' },
            { visible: visibleCount, total: entries.length },
          )}
        </span>
        <button
          type="button"
          className="inline-flex h-5 items-center gap-1 rounded px-1 text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={() => setExpanded((value) => !value)}
          title={formatMessage({
            id: expanded ? 'panels.plot.legend.collapse' : 'panels.plot.legend.expand',
          })}
          aria-label={formatMessage({
            id: expanded ? 'panels.plot.legend.collapse' : 'panels.plot.legend.expand',
          })}
        >
          {entries.length > COLLAPSED_LIMIT && !expanded ? `+${entries.length - COLLAPSED_LIMIT}` : null}
          {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
        </button>
      </div>

      {expanded ? (
        <>
          <div className="space-y-1 border-b border-border/70 p-2">
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="h-7 w-full rounded border border-border bg-background px-2 text-[11px] outline-hidden focus:border-primary"
              placeholder={formatMessage({ id: 'panels.plot.legend.searchPlaceholder' })}
              aria-label={formatMessage({ id: 'panels.plot.legend.searchPlaceholder' })}
            />
            <div className="flex items-center gap-1">
              <button
                type="button"
                className="rounded border border-border px-1.5 py-0.5 text-[10px] hover:bg-accent"
                onClick={() => setHiddenKeys(setPlotLegendGroupVisible(hiddenKeys, allKeys, true))}
              >
                {formatMessage({ id: 'panels.plot.legend.showAll' })}
              </button>
              <button
                type="button"
                className="rounded border border-border px-1.5 py-0.5 text-[10px] hover:bg-accent"
                onClick={() => setHiddenKeys(setPlotLegendGroupVisible(hiddenKeys, allKeys, false))}
              >
                {formatMessage({ id: 'panels.plot.legend.hideAll' })}
              </button>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-1">
            {filtered.length === 0 ? (
              <div className="px-2 py-2 text-[11px] text-muted-foreground">
                {formatMessage({ id: 'panels.plot.legend.noMatches' })}
              </div>
            ) : (
              filtered.map((entry) => (
                <LegendRow
                  key={entry.key}
                  entry={entry}
                  visible={isPlotLegendVisible(hiddenKeys, entry.key)}
                  onToggle={() => toggleEntry(entry)}
                  onOnly={() => showOnly(entry)}
                  showOnlyAction
                />
              ))
            )}
          </div>
        </>
      ) : (
        <div className="p-1">
          {collapsedEntries.map((entry) => (
            <LegendRow
              key={entry.key}
              entry={entry}
              visible={isPlotLegendVisible(hiddenKeys, entry.key)}
              onToggle={() => toggleEntry(entry)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

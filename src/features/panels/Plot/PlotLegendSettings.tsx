import React, { useEffect, useMemo, useRef } from 'react';
import { useIntl } from 'react-intl';
import { ScrollArea } from '@/shared/ui/scroll-area';
import type { PlotConfig } from './defaults';
import {
  isPlotLegendVisible,
  plotLegendSelectionState,
  setPlotLegendGroupVisible,
  setPlotLegendVisible,
} from './plotLegendVisibility';
import { usePlotLegendEntries } from './plotPanelRuntimeStore';

interface PlotLegendSettingsProps {
  panelId: string;
  seriesId: string;
  config: PlotConfig;
  setConfig: (next: PlotConfig | ((prev: PlotConfig) => PlotConfig)) => void;
}

function legendKeyPrefix(seriesId: string): string {
  return `${seriesId}:`;
}

function legendInputId(panelId: string, seriesId: string, index: number): string {
  return `plot-legend-${panelId}-${seriesId}-${index}`;
}

export function PlotLegendSettings({
  panelId,
  seriesId,
  config,
  setConfig,
}: PlotLegendSettingsProps): React.ReactNode {
  const { formatMessage } = useIntl();
  const allEntries = usePlotLegendEntries(panelId);
  const prefix = legendKeyPrefix(seriesId);
  const entries = useMemo(
    () => allEntries.filter((entry) => entry.key.startsWith(prefix)),
    [allEntries, prefix],
  );
  const hiddenKeys = config.hiddenLegendKeys;
  const selectAllRef = useRef<HTMLInputElement>(null);
  const selectAllId = `plot-legend-${panelId}-${seriesId}-all`;

  const selection = useMemo(
    () => plotLegendSelectionState(entries, hiddenKeys),
    [entries, hiddenKeys],
  );

  const visibleCount = useMemo(
    () => entries.filter((entry) => isPlotLegendVisible(hiddenKeys, entry.key)).length,
    [entries, hiddenKeys],
  );

  useEffect(() => {
    const input = selectAllRef.current;
    if (!input) return;
    input.indeterminate = selection === 'partial';
  }, [selection]);

  if (entries.length <= 1) {
    return null;
  }

  const setHiddenKeys = (next: string[]) => {
    setConfig((prev) => ({ ...prev, hiddenLegendKeys: next }));
  };

  const toggleEntry = (key: string, visible: boolean) => {
    setHiddenKeys(setPlotLegendVisible(hiddenKeys, key, visible));
  };

  const toggleAll = (visible: boolean) => {
    setHiddenKeys(
      setPlotLegendGroupVisible(
        hiddenKeys,
        entries.map((entry) => entry.key),
        visible,
      ),
    );
  };

  return (
    <div className="space-y-1 border-t border-border pt-2">
      <p className="text-[10px] font-medium text-muted-foreground">
        {formatMessage({ id: 'panels.plot.settings.series.legend.title' })}
      </p>
      <p className="px-0.5 text-[10px] text-muted-foreground">
        {formatMessage({ id: 'panels.plot.settings.legend.description' })}
      </p>
      <>
          <div className="flex items-center gap-2 rounded border border-border bg-muted/30 px-2 py-1">
            <input
              ref={selectAllRef}
              id={selectAllId}
              type="checkbox"
              checked={selection === 'all'}
              onChange={(event) => toggleAll(event.target.checked)}
              className="h-3.5 w-3.5 shrink-0 accent-primary"
              aria-label={formatMessage({ id: 'panels.plot.settings.legend.selectAllAria' })}
            />
            <label htmlFor={selectAllId} className="min-w-0 flex-1 cursor-pointer text-[11px] text-muted-foreground">
              {formatMessage(
                { id: 'panels.plot.settings.legend.selectedCount' },
                { visible: visibleCount, total: entries.length },
              )}
            </label>
          </div>
          <ScrollArea className="max-h-48 rounded border border-border">
            <div className="flex flex-col py-0.5">
              {entries.map((entry, index) => {
                const inputId = legendInputId(panelId, seriesId, index);
                const visible = isPlotLegendVisible(hiddenKeys, entry.key);
                return (
                  <label
                    key={entry.key}
                    htmlFor={inputId}
                    className="flex cursor-pointer items-center gap-1.5 px-2 py-0.5 hover:bg-accent/50"
                  >
                    <input
                      id={inputId}
                      type="checkbox"
                      checked={visible}
                      onChange={(event) => toggleEntry(entry.key, event.target.checked)}
                      className="h-3.5 w-3.5 shrink-0 accent-primary"
                    />
                    <span
                      className="inline-block h-2 w-2 shrink-0 rounded-sm ring-1 ring-border/60"
                      style={{ backgroundColor: entry.color }}
                      aria-hidden
                    />
                    <span
                      className="min-w-0 flex-1 truncate text-[11px] leading-tight text-foreground"
                      title={entry.label}
                    >
                      {entry.label}
                    </span>
                  </label>
                );
              })}
            </div>
          </ScrollArea>
      </>
    </div>
  );
}

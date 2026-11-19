import React, { useEffect, useRef, useState } from 'react';
import { useIntl } from 'react-intl';

/**
 * The CSV export button: it shows that an export is running (reading a whole remote recording takes
 * a while) and says why it failed, instead of doing nothing.
 */
export const PlotCsvExportButton: React.FC<{ disabled: boolean; run: () => Promise<void> }> = ({ disabled, run }) => {
  const { formatMessage } = useIntl();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const onClick = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await run();
    } catch (err) {
      if (mounted.current) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  return (
    <div className="space-y-1">
      <button
        type="button"
        disabled={disabled || busy}
        aria-busy={busy}
        onClick={() => void onClick()}
        data-testid="plot-csv-export"
        className="rounded border border-border bg-background px-2 py-1 text-xs hover:bg-accent disabled:opacity-50"
      >
        {formatMessage({ id: busy ? 'panels.plot.settings.export.busy' : 'panels.plot.settings.export.download' })}
      </button>
      {error && (
        <p role="alert" data-testid="plot-csv-export-error" className="text-[11px] text-destructive break-words">
          {formatMessage({ id: 'panels.plot.settings.export.failed' }, { reason: error })}
        </p>
      )}
    </div>
  );
};

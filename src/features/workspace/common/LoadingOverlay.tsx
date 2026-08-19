import React from 'react';
import { useIntl } from 'react-intl';
import { useMessagePipeline } from '@/core/pipeline/useMessagePipeline';
import { Button } from '@/shared/ui/button';
import { Card, CardFooter, CardHeader, CardTitle } from '@/shared/ui/card';
import { Spinner } from '@/shared/ui/spinner';
import { formatBytes } from '@/shared/utils/formatBytes';
import { estimateEtaSeconds, formatEtaParts } from '@/shared/utils/formatEta';
import { sourceDisplayName } from '@/shared/utils/sourceDisplayName';
import { useTransferRate } from './useTransferRate';

interface LoadingOverlayProps {
  sourceName?: string;
  onCancel?: () => void;
}

export const LoadingOverlay: React.FC<LoadingOverlayProps> = ({ sourceName, onCancel }) => {
  const { formatMessage } = useIntl();
  const loadedBytes = useMessagePipeline((state) => state.playerState.progress.loadedBytes);
  const totalBytes = useMessagePipeline((state) => state.playerState.progress.totalBytes);
  const bytesPerSecond = useTransferRate(loadedBytes);
  const displayName = sourceDisplayName(sourceName);
  const hasTotal = typeof totalBytes === 'number' && totalBytes > 0;
  const hasLoaded = typeof loadedBytes === 'number' && loadedBytes >= 0;
  const percent = hasTotal && hasLoaded ? Math.min(100, (loadedBytes / totalBytes) * 100) : undefined;
  const loadedLabel = hasLoaded ? formatBytes(loadedBytes) : undefined;
  const totalLabel = hasTotal ? formatBytes(totalBytes) : undefined;
  const speedLabel =
    bytesPerSecond != null && bytesPerSecond > 0
      ? formatMessage({ id: 'welcome.loadingSpeed' }, { speed: formatBytes(bytesPerSecond) ?? '' })
      : undefined;
  const etaSeconds =
    hasTotal && hasLoaded && bytesPerSecond != null
      ? estimateEtaSeconds(totalBytes - loadedBytes, bytesPerSecond)
      : undefined;
  const etaParts = etaSeconds != null ? formatEtaParts(etaSeconds) : undefined;
  const etaLabel = etaParts
    ? formatMessage(
        {
          id:
            etaParts.unit === 'hours'
              ? 'welcome.loadingEtaHours'
              : etaParts.unit === 'minutes'
                ? 'welcome.loadingEtaMinutes'
                : 'welcome.loadingEtaSeconds',
        },
        { n: etaParts.n },
      )
    : undefined;
  const stats = [loadedLabel && totalLabel ? `${loadedLabel} / ${totalLabel}` : loadedLabel, speedLabel, etaLabel]
    .filter((part): part is string => Boolean(part))
    .join(' · ');

  return (
    <div
      className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-background/50"
      role="status"
      aria-live="polite"
      aria-busy="true"
      data-testid="rosview-loading-overlay"
    >
      <Card className="pointer-events-auto w-full max-w-sm border-border shadow-none">
        <CardHeader className="gap-2 pb-4 text-center">
          <Spinner className="mx-auto size-8 text-primary" aria-hidden />
          <CardTitle className="text-base font-semibold tracking-tight">
            {formatMessage({ id: 'welcome.loadingTitle' })}
          </CardTitle>
          {displayName ? (
            <p className="truncate text-xs text-muted-foreground" title={sourceName}>
              {displayName}
            </p>
          ) : null}
          {percent != null ? (
            <div
              className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
              data-testid="rosview-loading-progress-bar"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(percent)}
            >
              <div
                className="h-full bg-primary transition-[width] duration-150 ease-out"
                style={{ width: `${percent}%` }}
              />
            </div>
          ) : (
            <div
              className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
              data-testid="rosview-loading-progress-indeterminate"
            >
              <div className="h-full w-full animate-pulse bg-primary/40" />
            </div>
          )}
          {stats ? (
            <p className="text-xs text-muted-foreground" data-testid="rosview-loading-stats">
              {stats}
            </p>
          ) : null}
        </CardHeader>
        {onCancel ? (
          <CardFooter className="justify-center pt-0">
            <Button type="button" variant="outline" size="sm" onClick={onCancel}>
              {formatMessage({ id: 'welcome.cancelLoading' })}
            </Button>
          </CardFooter>
        ) : null}
      </Card>
    </div>
  );
};

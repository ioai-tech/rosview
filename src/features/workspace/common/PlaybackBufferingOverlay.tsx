import React, { useEffect, useState } from 'react';
import { useIntl } from 'react-intl';
import type { Player } from '@/core/types/player';
import { useMessagePipeline } from '@/core/pipeline/useMessagePipeline';
import { Button } from '@/shared/ui/button';
import { Spinner } from '@/shared/ui/spinner';
import { readErrorDetail, readErrorText } from '@/features/panels/common/readErrorText';

interface PlaybackBufferingOverlayProps {
  player: Player;
}

export const PlaybackBufferingOverlay: React.FC<PlaybackBufferingOverlayProps> = ({ player }) => {
  const { formatMessage } = useIntl();
  const buffering = useMessagePipeline((state) => state.playerState.progress.buffering === true);
  const playbackError = useMessagePipeline((state) => state.playerState.progress.playbackError);
  const playbackErrorKind = useMessagePipeline((state) => state.playerState.progress.playbackErrorKind);
  const reconnecting = useMessagePipeline((state) => state.playerState.progress.reconnecting === true);

  if (playbackError) {
    return (
      <div
        className="pointer-events-none absolute inset-x-0 top-3 z-20 flex justify-center px-3"
        role="alert"
        data-testid="rosview-playback-error"
      >
        <div className="pointer-events-auto flex max-w-lg items-center gap-3 rounded-md border border-border bg-card px-3 py-2 text-xs shadow-xs">
          <p className="min-w-0 flex-1 text-destructive" title={readErrorDetail(playbackError, playbackErrorKind)}>
            {readErrorText(formatMessage, playbackError, playbackErrorKind)}
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              if (player.retry) player.retry();
              else player.play();
            }}
          >
            {formatMessage({ id: 'playback.retry' })}
          </Button>
        </div>
      </div>
    );
  }

  if (reconnecting) {
    // Not a failure: reads wait for the network and resume by themselves.
    return (
      <div
        className="pointer-events-none absolute inset-0 z-10 flex items-start justify-center pt-3"
        role="status"
        aria-live="polite"
        aria-busy="true"
        data-testid="rosview-playback-reconnecting"
      >
        <div className="flex items-center gap-2 rounded-full border border-border/70 bg-background/80 px-3 py-1 text-xs text-muted-foreground">
          <Spinner className="size-3.5" aria-hidden />
          <ReconnectingText />
        </div>
      </div>
    );
  }

  if (!buffering) {
    return null;
  }

  return (
    <div
      className="pointer-events-none absolute inset-0 z-10 flex items-start justify-center pt-3"
      role="status"
      aria-live="polite"
      aria-busy="true"
      data-testid="rosview-playback-buffering"
    >
      <div className="flex items-center gap-2 rounded-full border border-border/70 bg-background/80 px-3 py-1 text-xs text-muted-foreground">
        <Spinner className="size-3.5" aria-hidden />
        {formatMessage({ id: 'playback.buffering' })}
      </div>
    </div>
  );
};

/** From this long on, the reconnecting status says for how long the connection has been lost. */
const RECONNECTING_ELAPSED_AFTER_MS = 10_000;

/** `m:ss` (or `h:mm:ss`) of a non-negative duration. */
function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/**
 * "Connection lost. Reconnecting…", and once that has lasted a while, for how long: the wait has no
 * deadline (reads resume by themselves whenever the network or server is back), so a long outage,
 * or a server that went down while the browser stays online, shows that it is still going on.
 */
const ReconnectingText: React.FC = () => {
  const { formatMessage } = useIntl();
  const [since] = useState(() => Date.now());
  const [now, setNow] = useState(since);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);
  const elapsedMs = now - since;
  return (
    <span data-testid="rosview-playback-reconnecting-text">
      {elapsedMs >= RECONNECTING_ELAPSED_AFTER_MS
        ? formatMessage({ id: 'playback.reconnectingFor' }, { elapsed: formatElapsed(elapsedMs) })
        : formatMessage({ id: 'playback.reconnecting' })}
    </span>
  );
};

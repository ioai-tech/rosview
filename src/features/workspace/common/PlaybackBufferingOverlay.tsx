import React from 'react';
import { useIntl } from 'react-intl';
import type { Player } from '@/core/types/player';
import { useMessagePipeline } from '@/core/pipeline/useMessagePipeline';
import { Button } from '@/shared/ui/button';
import { Spinner } from '@/shared/ui/spinner';

interface PlaybackBufferingOverlayProps {
  player: Player;
}

export const PlaybackBufferingOverlay: React.FC<PlaybackBufferingOverlayProps> = ({ player }) => {
  const { formatMessage } = useIntl();
  const buffering = useMessagePipeline((state) => state.playerState.progress.buffering === true);
  const playbackError = useMessagePipeline((state) => state.playerState.progress.playbackError);

  if (playbackError) {
    return (
      <div
        className="pointer-events-none absolute inset-x-0 top-3 z-20 flex justify-center px-3"
        role="alert"
        data-testid="rosview-playback-error"
      >
        <div className="pointer-events-auto flex max-w-lg items-center gap-3 rounded-md border border-border bg-card px-3 py-2 text-xs shadow-sm">
          <p className="min-w-0 flex-1 text-destructive">{playbackError}</p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              player.play();
            }}
          >
            {formatMessage({ id: 'playback.retry' })}
          </Button>
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

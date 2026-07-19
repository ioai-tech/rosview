import { useEffect, useRef } from 'react';
import type { Player } from '@/core/types/player';
import { MAX_PLAYBACK_SPEED } from '@/core/types/player';
import { useMessagePipeline } from '@/core/pipeline/useMessagePipeline';
import type { MessagePipelineState } from '@/core/pipeline/store';
import { resolveStepMsFromModifiers } from '@/shared/utils/playbackStep';
import { useShallow } from 'zustand/react/shallow';

export function useKeyboardShortcuts(player: Player) {
  const { isPlaying, speed } = useMessagePipeline(
    useShallow((state: MessagePipelineState) => ({
      isPlaying: state.playerState.activeData?.isPlaying ?? false,
      speed: state.playerState.activeData?.speed ?? 1,
    })),
  );
  const isPlayingRef = useRef(isPlaying);
  const speedRef = useRef(speed);

  useEffect(() => {
    isPlayingRef.current = isPlaying;
    speedRef.current = speed;
  }, [isPlaying, speed]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ignore if typing in an input or textarea
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }

      switch (e.code) {
        case 'Space':
          e.preventDefault();
          if (isPlayingRef.current) {
            player.pause();
          } else {
            player.play();
          }
          break;
        case 'ArrowLeft':
          e.preventDefault();
          if (e.altKey) {
            player.stepBy(-resolveStepMsFromModifiers(e));
          } else {
            player.stepMessage(-1);
          }
          break;
        case 'ArrowRight':
          e.preventDefault();
          if (e.altKey) {
            player.stepBy(resolveStepMsFromModifiers(e));
          } else {
            player.stepMessage(1);
          }
          break;
        case 'BracketLeft': {
          e.preventDefault();
          const cur = speedRef.current;
          if (cur > 8) {
            player.setSpeed(8);
          } else {
            player.setSpeed(Math.max(0.1, cur / 2));
          }
          break;
        }
        case 'BracketRight': {
          e.preventDefault();
          const cur = speedRef.current;
          if (cur >= 8) {
            player.setSpeed(MAX_PLAYBACK_SPEED);
          } else {
            player.setSpeed(Math.min(8, cur * 2));
          }
          break;
        }
      }
    };

    // Capture phase so playback shortcuts still run if Dockview stops propagation in bubble phase.
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [player]);
}

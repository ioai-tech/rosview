import { afterEach, describe, expect, it } from 'vitest';
import { MinimalPlayer } from './MinimalPlayer';
import { useMessagePipelineStore } from '@/core/pipeline/store';

describe('MinimalPlayer', () => {
  let player: MinimalPlayer | null = null;

  afterEach(() => {
    player?.close();
    player = null;
  });

  it('starts in ready state with empty topics', () => {
    player = new MinimalPlayer();
    const state = useMessagePipelineStore.getState();
    expect(state.playerState.presence).toBe('ready');
    expect(state.sortedTopics).toEqual([]);
  });

  it('subscribeCurrentTime emits immediately with zero time', () => {
    player = new MinimalPlayer();
    let received: { sec: number; nsec: number } | null = null;
    const unsub = player.subscribeCurrentTime((time) => {
      received = time;
    });
    expect(received).toEqual({ sec: 0, nsec: 0 });
    unsub();
  });

  it('close sets presence to closed', () => {
    player = new MinimalPlayer();
    player.close();
    expect(useMessagePipelineStore.getState().playerState.presence).toBe('closed');
  });
});

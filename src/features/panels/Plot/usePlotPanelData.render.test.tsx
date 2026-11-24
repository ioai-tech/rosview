/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useMessagePipelineStore } from '@/core/pipeline/store';
import type { Player, PlayerState } from '@/core/types/player';
import { defaultPlotConfig } from './defaults';
import { usePlotPanelData, type UsePlotPanelDataResult } from './usePlotPanelData';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const start = { sec: 0, nsec: 0 };
const end = { sec: 10, nsec: 0 };
const topics = ['/imu'];
const config = defaultPlotConfig();

function setProgress(progress: PlayerState['progress']): void {
  useMessagePipelineStore.getState().setPlayerState({
    presence: 'ready',
    progress,
    activeData: {
      topics: [{ name: '/imu', schemaName: 'sensor_msgs/msg/Imu' }] as never,
      datatypes: new Map() as never,
      publishersByTopic: new Map(),
      startTime: start,
      endTime: end,
      currentTime: start,
      isPlaying: false,
      isLooping: false,
      speed: 1,
      problems: [],
    },
  });
}

describe('usePlotPanelData after a failed read (m-3)', () => {
  let container: HTMLDivElement;
  let root: Root;
  let result: UsePlotPanelDataResult | undefined;

  function Probe({ player }: { player: Player }) {
    result = usePlotPanelData({ player, config, activeTopics: topics, hasPlotPaths: true, startTime: start, endTime: end });
    return null;
  }

  /** Until the read that is running has ended. */
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 200; i++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      if (result && !result.loading) return;
    }
    throw new Error('the plot read did not end');
  };

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    result = undefined;
    setProgress({});
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('reads its window again when the user retries, without a seek', async () => {
    let failing = true;
    const getMessagesInTimeRange = vi.fn(async () => {
      if (failing) throw new TypeError('Failed to fetch');
      return [];
    });
    const player = { getMessagesInTimeRange } as unknown as Player;
    await act(async () => root.render(<Probe player={player} />));
    await settle();
    expect(result?.error).toBe('Failed to fetch');
    expect(result?.errorKind).toBe('network');
    const callsAfterFailure = getMessagesInTimeRange.mock.calls.length;

    failing = false;
    await act(async () => setProgress({ retryCount: 1 }));
    await settle();
    // Before the fix the Plot stayed on "Failed to fetch" until the playhead moved.
    expect(getMessagesInTimeRange.mock.calls.length).toBeGreaterThan(callsAfterFailure);
    expect(result?.error).toBeNull();
    expect(result?.loading).toBe(false);
  });

  it('a plot whose read succeeded does not read again on a retry', async () => {
    const getMessagesInTimeRange = vi.fn(async () => []);
    const player = { getMessagesInTimeRange } as unknown as Player;
    await act(async () => root.render(<Probe player={player} />));
    await settle();
    const calls = getMessagesInTimeRange.mock.calls.length;
    expect(result?.error).toBeNull();

    await act(async () => setProgress({ retryCount: 1 }));
    await settle();
    expect(getMessagesInTimeRange.mock.calls.length).toBe(calls);
  });
});

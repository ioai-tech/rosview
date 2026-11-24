/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { IntlProvider } from 'react-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getRosViewMessages } from '@/shared/intl/loadRosViewMessages';
import { useMessagePipelineStore } from '@/core/pipeline/store';
import type { Player } from '@/core/types/player';
import { defaultAlignConfig } from './defaults';
import { AlignPanel } from './AlignPanel';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('AlignPanel read errors', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    useMessagePipelineStore.getState().setPlayerState({
      presence: 'ready',
      progress: {},
      activeData: {
        topics: [{ name: '/camera', type: 'sensor_msgs/msg/CompressedImage' }] as never,
        datatypes: new Map() as never,
        publishersByTopic: new Map(),
        startTime: { sec: 0, nsec: 0 },
        endTime: { sec: 10, nsec: 0 },
        currentTime: { sec: 0, nsec: 0 },
        isPlaying: false,
        isLooping: false,
        speed: 1,
        problems: [],
      },
    });
    globalThis.ResizeObserver ??= class {
      observe(): void {}
      disconnect(): void {}
    } as never;
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('drops the error of an earlier read once its topics are emptied', async () => {
    const reason = 'No data arrived from the server for 20 s while reading rec (bytes 0–1), also after a retry.';
    const player = {
      getCurrentTime: () => ({ sec: 1, nsec: 0 }),
      getMessagesInTimeRange: vi.fn(async () => {
        throw Object.assign(new Error(reason), { name: 'RangeStallError' });
      }),
      subscribeCurrentTime: vi.fn(() => () => undefined),
      registerSubscriptions: vi.fn(),
      unregisterSubscriptions: vi.fn(),
    } as unknown as Player;
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const render = async (topics: string[]): Promise<void> => {
      await act(async () => {
        root.render(
          <IntlProvider locale="en" messages={getRosViewMessages('en')}>
            <AlignPanel {...defaultAlignConfig()} topics={topics} player={player} panelId="Align!1" setConfig={vi.fn()} />
          </IntlProvider>,
        );
      });
      await act(async () => {
        await Promise.resolve();
      });
    };

    await render(['/camera']);
    expect(container.querySelector('[data-testid="panel-read-error"]')?.textContent).toBe(
      'Could not read the recording: The server stopped sending data.',
    );
    expect(container.querySelector('[data-testid="panel-read-error"]')?.getAttribute('title')).toBe(reason);

    // A topic that is not in the recording: nothing is read any more.
    await render(['/gone']);
    expect(container.querySelector('[data-testid="panel-read-error"]')).toBeNull();
  });
});

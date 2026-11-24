/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { IntlProvider } from 'react-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getRosViewMessages } from '@/shared/intl/loadRosViewMessages';
import { useMessagePipelineStore } from '@/core/pipeline/store';
import type { Player, PlayerState } from '@/core/types/player';
import { PlaybackBufferingOverlay } from './PlaybackBufferingOverlay';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('PlaybackBufferingOverlay', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const render = async (progress: PlayerState['progress'], player: Player, locale: 'en' | 'zh' = 'en') => {
    useMessagePipelineStore.getState().setPlayerState({ presence: 'ready', progress });
    await act(async () => {
      root.render(
        <IntlProvider locale={locale} messages={getRosViewMessages(locale)}>
          <PlaybackBufferingOverlay player={player} />
        </IntlProvider>,
      );
    });
  };

  it('says the viewer is reconnecting while the network is down, not that it failed', async () => {
    await render({ reconnecting: true, buffering: true }, {} as Player);
    expect(container.querySelector('[data-testid="rosview-playback-reconnecting"]')?.textContent).toBe(
      'Connection lost. Reconnecting…',
    );
    expect(container.querySelector('[data-testid="rosview-playback-error"]')).toBeNull();
  });

  it('says for how long the connection has been lost once the outage lasts, and stops counting when it ends', async () => {
    vi.useFakeTimers();
    try {
      await render({ reconnecting: true, buffering: true }, {} as Player, 'zh');
      const text = () => container.querySelector('[data-testid="rosview-playback-reconnecting-text"]')?.textContent;
      expect(text()).toBe('网络连接已断开，正在重新连接…');
      await act(async () => vi.advanceTimersByTime(9_000));
      expect(text()).toBe('网络连接已断开，正在重新连接…');
      await act(async () => vi.advanceTimersByTime(66_000));
      expect(text()).toBe('网络连接已断开 1:15，正在重新连接…');

      await render({ buffering: false }, {} as Player, 'zh');
      expect(container.querySelector('[data-testid="rosview-playback-reconnecting"]')).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
      // A new outage counts from its own start.
      await render({ reconnecting: true, buffering: true }, {} as Player, 'en');
      expect(text()).toBe('Connection lost. Reconnecting…');
      await act(async () => vi.advanceTimersByTime(3_725_000));
      expect(text()).toBe('Connection lost for 1:02:05. Reconnecting…');
    } finally {
      vi.useRealTimers();
    }
  });

  it("says a network failure in the viewer's language; the browser's words are only the detail", async () => {
    await render({ playbackError: 'Failed to fetch', playbackErrorKind: 'network' }, {} as Player, 'zh');
    const text = container.querySelector('[data-testid="rosview-playback-error"] p');
    expect(text?.textContent).toBe('无法连接到服务器，请检查网络连接。');
    expect(text?.getAttribute('title')).toBe('Failed to fetch');
  });

  it('Retry retries every failed read through Player.retry, or plays when the player has none', async () => {
    const retry = vi.fn();
    const play = vi.fn();
    await render({ playbackError: 'Corrupt chunk' }, { retry, play } as unknown as Player);
    expect(container.querySelector('[data-testid="rosview-playback-error"] p')?.textContent).toBe('Corrupt chunk');
    await act(async () => container.querySelector('button')!.click());
    expect(retry).toHaveBeenCalledTimes(1);
    expect(play).not.toHaveBeenCalled();

    await render({ playbackError: 'Corrupt chunk' }, { play } as unknown as Player);
    await act(async () => container.querySelector('button')!.click());
    expect(play).toHaveBeenCalledTimes(1);
  });
});

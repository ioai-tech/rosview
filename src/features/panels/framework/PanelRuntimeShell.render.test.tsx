/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { IntlProvider } from 'react-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getRosViewMessages } from '@/shared/intl/loadRosViewMessages';
import { useMessagePipelineStore } from '@/core/pipeline/store';
import type { Player, TopicReadError } from '@/core/types/player';
import { rawMessagesPanelDefinition } from '../RawMessages/definition';
import { PanelRuntimeShell } from './PanelRuntimeShell';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TOPIC = '/tf_static';
const reason = 'No data arrived from the server for 20 s while reading rec (bytes 0–1), also after a retry.';

function setPanelReadErrors(panelReadErrors: Record<string, TopicReadError[]> | undefined): void {
  useMessagePipelineStore.getState().setPlayerState({
    presence: 'ready',
    progress: {},
    activeData: {
      topics: [{ name: TOPIC, type: 'tf2_msgs/msg/TFMessage' }] as never,
      datatypes: new Map() as never,
      publishersByTopic: new Map(),
      startTime: { sec: 0, nsec: 0 },
      endTime: { sec: 10, nsec: 0 },
      currentTime: { sec: 0, nsec: 0 },
      isPlaying: false,
      isLooping: false,
      speed: 1,
      problems: [],
      panelReadErrors,
    },
  });
}

describe('PanelRuntimeShell read errors', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    globalThis.ResizeObserver ??= class {
      observe(): void {}
      disconnect(): void {}
    } as never;
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('says which topic of a panel could not be read, and the panel stops waiting for it', async () => {
    const player = {
      registerSubscriptions: vi.fn(),
      unregisterSubscriptions: vi.fn(),
      getCurrentTime: () => ({ sec: 0, nsec: 0 }),
      subscribeCurrentTime: vi.fn(() => () => undefined),
    } as unknown as Player;
    setPanelReadErrors(undefined);
    const config = { ...rawMessagesPanelDefinition.createDefaultConfig(), topic: TOPIC };
    await act(async () => {
      root.render(
        <IntlProvider locale="en" messages={getRosViewMessages('en')}>
          <PanelRuntimeShell
            player={player}
            panelId="RawMessages!1"
            panelTitle="Raw"
            definition={rawMessagesPanelDefinition}
            initialConfig={config}
            onDuplicate={vi.fn()}
            onClose={vi.fn()}
          />
        </IntlProvider>,
      );
    });
    // The panel body is lazy: wait for it.
    for (let i = 0; i < 100 && !container.textContent?.includes('Waiting for messages'); i++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    }
    expect(container.textContent).toContain('Waiting for messages…');
    expect(container.querySelector('[data-testid="panel-topic-read-error"]')).toBeNull();

    await act(async () => {
      setPanelReadErrors({ 'RawMessages!1': [{ topic: TOPIC, message: reason }] });
    });
    const alert = container.querySelector('[data-testid="panel-topic-read-error"]');
    expect(alert?.getAttribute('role')).toBe('alert');
    expect(alert?.textContent).toBe(`Could not read ${TOPIC}: ${reason}`);
    expect(container.textContent).not.toContain('Waiting for messages');

    // Another panel's error is not this panel's.
    await act(async () => {
      setPanelReadErrors({ 'Image!2': [{ topic: '/cam', message: reason }] });
    });
    expect(container.querySelector('[data-testid="panel-topic-read-error"]')).toBeNull();
    expect(container.textContent).toContain('Waiting for messages…');
  });
});

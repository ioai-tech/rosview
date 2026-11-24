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
import { TimelinePanel } from './TimelinePanel';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('TimelinePanel read errors', () => {
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
        topics: [{ name: '/camera', schemaName: 'sensor_msgs/msg/CompressedImage' }] as never,
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
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('shows why the topic time ranges could not be read instead of empty rows', async () => {
    const reason = 'No data arrived from the server for 20 s while reading rec (bytes 0–1), also after a retry.';
    const player = {
      getMessagesInTimeRange: vi.fn(async () => {
        throw Object.assign(new Error(reason), { name: 'RangeStallError' });
      }),
      subscribeCurrentTime: vi.fn(() => () => undefined),
    } as unknown as Player;
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    globalThis.ResizeObserver ??= class {
      observe(): void {}
      disconnect(): void {}
    } as never;
    await act(async () => {
      root.render(
        <IntlProvider locale="en" messages={getRosViewMessages('en')}>
          <TimelinePanel player={player} config={{ showDrops: false }} />
        </IntlProvider>,
      );
    });
    await act(async () => {
      await Promise.resolve();
    });
    const alert = container.querySelector('[data-testid="panel-read-error"]');
    expect(alert?.getAttribute('role')).toBe('alert');
    // A stall is said in the viewer's language; the raw message is the detail.
    expect(alert?.textContent).toBe('Could not read the recording: The server stopped sending data.');
    expect(alert?.getAttribute('title')).toBe(reason);
  });
});

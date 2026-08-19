/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IntlProvider } from 'react-intl';
import { useMessagePipelineStore } from '@/core/pipeline/store';
import { getRosViewMessages } from '@/shared/intl/loadRosViewMessages';
import { LoadingOverlay } from './LoadingOverlay';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const enMessages = getRosViewMessages('en');

describe('LoadingOverlay', () => {
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
    useMessagePipelineStore.setState({
      playerState: { presence: 'preinit', progress: {} },
    });
  });

  function renderOverlay(sourceName?: string): void {
    act(() => {
      root.render(
        <IntlProvider locale="en" messages={enMessages}>
          <LoadingOverlay sourceName={sourceName} />
        </IntlProvider>,
      );
    });
  }

  it('shows the file basename and determinate progress, not Preparing', () => {
    useMessagePipelineStore.getState().setPlayerState({
      presence: 'initializing',
      progress: {
        loadedBytes: 12_582_912,
        totalBytes: 52_428_800,
        initPhase: 'downloading',
      },
    });

    renderOverlay(
      'https://rosview-samples-1328702871.cos.accelerate.myqcloud.com/RealMan_PicknPlace.mcap',
    );

    expect(container.textContent).toContain('Loading');
    expect(container.textContent).toContain('RealMan_PicknPlace.mcap');
    expect(container.textContent).not.toContain('Preparing');
    expect(container.textContent).not.toContain('https://rosview-samples');
    expect(container.querySelector('[data-testid="rosview-loading-progress-bar"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="rosview-loading-stats"]')?.textContent).toContain(
      '12.0 MB / 50.0 MB',
    );
  });

  it('uses an indeterminate bar before byte totals are known', () => {
    renderOverlay();
    expect(container.querySelector('[data-testid="rosview-loading-progress-indeterminate"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="rosview-loading-progress-bar"]')).toBeNull();
    expect(container.textContent).not.toContain('Preparing');
  });
});

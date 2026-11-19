/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { IntlProvider } from 'react-intl';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getRosViewMessages } from '@/shared/intl/loadRosViewMessages';
import { PlotCsvExportButton } from './PlotCsvExportButton';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('Plot CSV export button', () => {
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

  it('shows that it is exporting, then why the export failed, with no unhandled rejection', async () => {
    let fail!: (error: Error) => void;
    const run = (): Promise<void> => new Promise((_, reject) => (fail = reject));
    const unhandled: unknown[] = [];
    const onUnhandled = (event: PromiseRejectionEvent): void => void unhandled.push(event.reason);
    window.addEventListener('unhandledrejection', onUnhandled);
    try {
      await act(async () => {
        root.render(
          <IntlProvider locale="en" messages={getRosViewMessages('en')}>
            <PlotCsvExportButton disabled={false} run={run} />
          </IntlProvider>,
        );
      });
      const button = container.querySelector<HTMLButtonElement>('[data-testid="plot-csv-export"]')!;
      await act(async () => {
        button.click();
      });
      expect(button.textContent).toBe('Exporting…');
      expect(button.disabled).toBe(true);
      expect(button.getAttribute('aria-busy')).toBe('true');

      const reason = 'No data arrived from the server for 20 s while reading rec (bytes 0–1), also after a retry.';
      await act(async () => {
        fail(Object.assign(new Error(reason), { name: 'RangeStallError' }));
        await Promise.resolve();
      });
      expect(button.textContent).toBe('Download CSV');
      expect(button.disabled).toBe(false);
      expect(container.querySelector('[data-testid="plot-csv-export-error"]')?.textContent).toBe(`Export failed: ${reason}`);
      expect(unhandled).toEqual([]);
    } finally {
      window.removeEventListener('unhandledrejection', onUnhandled);
    }
  });
});

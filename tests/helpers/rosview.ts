import { expect, type Page } from '@playwright/test';

export type BrowserDiagnostics = {
  pageErrors: string[];
  consoleErrors: string[];
};

export function attachBrowserDiagnostics(page: Page): BrowserDiagnostics {
  const diagnostics: BrowserDiagnostics = {
    pageErrors: [],
    consoleErrors: [],
  };

  page.on('pageerror', (error) => {
    diagnostics.pageErrors.push(error.message);
  });

  page.on('console', (message) => {
    if (message.type() === 'error') {
      diagnostics.consoleErrors.push(message.text());
    }
  });

  return diagnostics;
}

function formatDiagnostics(diagnostics: BrowserDiagnostics): string {
  const lines: string[] = [];
  if (diagnostics.pageErrors.length > 0) {
    lines.push(`page errors:\n${diagnostics.pageErrors.map((e) => `  - ${e}`).join('\n')}`);
  }
  if (diagnostics.consoleErrors.length > 0) {
    lines.push(`console errors:\n${diagnostics.consoleErrors.map((e) => `  - ${e}`).join('\n')}`);
  }
  return lines.join('\n');
}

export type OpenFixtureOptions = {
  timeoutMs?: number;
  waitUntil?: 'load' | 'domcontentloaded' | 'networkidle';
  diagnostics?: BrowserDiagnostics;
  /** Extra query params merged with `url=`. */
  query?: Record<string, string>;
};

export async function openFixtureByUrl(
  page: Page,
  url: string,
  options: OpenFixtureOptions = {},
): Promise<void> {
  const { waitUntil = 'domcontentloaded', query = {} } = options;
  const params = new URLSearchParams({ url, ...query });
  await page.goto(`/?${params.toString()}`, { waitUntil });
  await waitForRosviewReady(page, options);
}

export async function waitForRosviewReady(
  page: Page,
  options: OpenFixtureOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const diagnostics = options.diagnostics;

  try {
    await expect(page.locator('#rosview-root')).toHaveAttribute('data-player-presence', 'ready', {
      timeout: timeoutMs,
    });
    await expect(page.getByTestId('rosview-dockview')).toBeVisible({ timeout: timeoutMs });
    await expect(page.getByRole('button', { name: 'Play playback' })).toBeVisible({
      timeout: timeoutMs,
    });
  } catch (error) {
    if (diagnostics && (diagnostics.pageErrors.length > 0 || diagnostics.consoleErrors.length > 0)) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\n${formatDiagnostics(diagnostics)}`,
        { cause: error },
      );
    }
    throw error;
  }
}

export async function expectDockviewTopic(
  page: Page,
  substring: string,
  timeoutMs = 30_000,
): Promise<void> {
  await expect(page.getByTestId('rosview-dockview')).toContainText(substring, {
    timeout: timeoutMs,
  });
}

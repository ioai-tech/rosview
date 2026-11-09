import { test, expect, type Page } from '@playwright/test';
import { MCAP_WHOLE_BODY, MCAP_WHOLE_BODY_URL, requireFixture } from './fixturePaths';
import { attachBrowserDiagnostics, openFixtureByUrl, waitForRosviewReady, type BrowserDiagnostics } from './helpers/rosview';

test.describe.configure({ timeout: 120_000 });

test.beforeAll(() => {
  requireFixture(MCAP_WHOLE_BODY);
});

const DERIVED_TOPICS = [
  '/whole_body/colors/color_0',
  '/whole_body/colors/color_1',
  '/whole_body/joint_states',
  '/whole_body/base_pose',
];

async function expectWholeBodyLoaded(page: Page, diagnostics: BrowserDiagnostics): Promise<void> {
  for (const topic of DERIVED_TOPICS) {
    await expect(page.getByText(topic, { exact: true }).first()).toBeVisible({ timeout: 30_000 });
  }

  const play = page.getByRole('button', { name: 'Play playback' });
  if (await play.isVisible().catch(() => false)) {
    await play.click();
  }

  const status = page.getByTestId('image-panel-status');
  await expect(status).toHaveCount(2, { timeout: 60_000 });
  await expect(status.first()).toHaveText(/^1x1/i, { timeout: 60_000 });
  await expect(page.getByText(/Image decode failed|No image data provided|not indexed/i)).toHaveCount(0);
  expect(diagnostics.pageErrors).toEqual([]);
  expect(diagnostics.consoleErrors.filter((entry) => /decode|not indexed|McapWorker/i.test(entry))).toEqual([]);
}

test('unindexed whole-body MCAP over HTTP exposes camera and joint topics', async ({ page }) => {
  const diagnostics = attachBrowserDiagnostics(page);
  await openFixtureByUrl(page, MCAP_WHOLE_BODY_URL, { diagnostics });
  await expectWholeBodyLoaded(page, diagnostics);
});

test('unindexed whole-body MCAP opened as a local file plays', async ({ page }) => {
  const diagnostics = attachBrowserDiagnostics(page);
  await page.goto('/');
  await page.locator('#rosview-landing-file').setInputFiles(MCAP_WHOLE_BODY);
  await waitForRosviewReady(page, { diagnostics });
  await expectWholeBodyLoaded(page, diagnostics);
});

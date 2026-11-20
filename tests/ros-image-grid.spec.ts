import { test, expect } from '@playwright/test';
import { MCAP_3CAM_URL, requireFixture, MCAP_3CAM } from './fixturePaths';
import { attachBrowserDiagnostics, openFixtureByUrl } from './helpers/rosview';

test.describe.configure({ timeout: 120_000 });

test.beforeAll(() => {
  requireFixture(MCAP_3CAM);
});

test('loads the three-camera compressed image sample without empty decoder payloads', async ({ page }) => {
  const diagnostics = attachBrowserDiagnostics(page);
  await openFixtureByUrl(page, MCAP_3CAM_URL, { diagnostics });

  const imagePanels = page.getByTestId('image-panel');
  await expect(imagePanels).toHaveCount(3, { timeout: 60_000 });
  await expect(page.getByText(/Failed to construct 'ImageDecoder'|No image data provided/i)).toHaveCount(0);

  const play = page.getByRole('button', { name: 'Play playback' });
  if (await play.isVisible().catch(() => false)) {
    await play.click();
  }

  await expect(page.getByTestId('image-panel-status')).toHaveCount(3, { timeout: 90_000 });
  const statusTexts = await page.getByTestId('image-panel-status').allTextContents();
  expect(statusTexts).toEqual(expect.arrayContaining([
    expect.stringMatching(/^\d+x\d+/),
    expect.stringMatching(/^\d+x\d+/),
    expect.stringMatching(/^\d+x\d+/),
  ]));

  await page.waitForTimeout(4_000);
  await expect(page.getByTestId('image-panel-status')).toHaveCount(3);
  await expect(page.getByText(/Image decode failed|Compressed image payload is empty|No image data provided/i)).toHaveCount(0);
  expect(diagnostics.pageErrors.filter((entry) => /ImageDecoder|No image data provided/i.test(entry))).toEqual([]);
  expect(diagnostics.consoleErrors.filter((entry) => /ImageDecoder|No image data provided/i.test(entry))).toEqual([]);
});

test('frame details (size, encoding) are shown beside the picture, never drawn over it', async ({ page }) => {
  await openFixtureByUrl(page, MCAP_3CAM_URL);
  await expect(page.getByTestId('image-panel-status')).toHaveCount(3, { timeout: 90_000 });
  const overlaps = await page.getByTestId('image-panel').evaluateAll((panels) =>
    panels.map((panel) => {
      const canvas = panel.querySelector('[data-testid="image-panel-canvas"]')!.getBoundingClientRect();
      const info = panel.querySelector('[data-testid="image-panel-status"]')!.getBoundingClientRect();
      return info.bottom > canvas.top && info.top < canvas.bottom && info.right > canvas.left && info.left < canvas.right;
    }),
  );
  expect(overlaps).toEqual([false, false, false]);
});

test('a narrow image panel gives its bar to the topic and hides the frame details', async ({ page }) => {
  await openFixtureByUrl(page, MCAP_3CAM_URL);
  await expect(page.getByTestId('image-panel-status')).toHaveCount(3, { timeout: 90_000 });
  const panel = page.getByTestId('image-panel').first();
  await expect(panel.getByTestId('image-panel-status')).toBeVisible();
  await panel.evaluate((el) => {
    (el as HTMLElement).style.width = '160px';
  });
  await expect(panel.getByTestId('image-panel-status')).toBeHidden();
  // The topic keeps most of the bar.
  const bar = await panel.getByTestId('panel-topic-bar').boundingBox();
  const picker = await panel.getByTestId('panel-topic-bar').locator('button').first().boundingBox();
  expect(picker!.width).toBeGreaterThan(bar!.width * 0.7);
});

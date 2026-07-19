import { test, expect } from '@playwright/test';
import { MCAP_H264_URL, requireFixture, MCAP_H264 } from './fixturePaths';
import { openFixtureByUrl } from './helpers/rosview';

test.describe.configure({ timeout: 120_000 });

test.beforeAll(() => {
  requireFixture(MCAP_H264);
});

test('H.264 CompressedImage decodes without error', async ({ page }) => {
  await openFixtureByUrl(page, MCAP_H264_URL);

  const play = page.getByRole('button', { name: 'Play playback' });
  if (await play.isVisible().catch(() => false)) {
    await play.click();
  }

  const progressFill = page.getByTestId('playback-progress-fill');
  const progressWidths: number[] = [];
  for (let sample = 0; sample < 6; sample += 1) {
    const width = await progressFill.evaluate((element) =>
      Number.parseFloat((element as HTMLElement).style.width),
    );
    expect(Number.isFinite(width)).toBe(true);
    progressWidths.push(width);
    await page.waitForTimeout(200);
  }
  const meaningfulAdvances = progressWidths
    .slice(1)
    .filter((width, index) => width - progressWidths[index] >= 0.1);
  expect(meaningfulAdvances.length).toBeGreaterThanOrEqual(2);
  expect(Math.max(...progressWidths) - Math.min(...progressWidths)).toBeGreaterThanOrEqual(1);

  await expect(page.locator('canvas')).not.toHaveCount(0, { timeout: 90_000 });

  const hasDecodeFailure = await page.getByText(/decode failed|could not be decoded/i).count();
  expect(hasDecodeFailure).toBe(0);

  const imageStatus = page.getByTestId('image-panel-status');
  const imagePanel = page.getByTestId('image-panel');
  if (await imagePanel.isVisible().catch(() => false)) {
    await expect(imageStatus).toBeVisible({ timeout: 90_000 });
    await expect(imageStatus).toHaveText(/\d+x\d+/);

    await expect(imagePanel).toHaveAttribute('data-h264-pressure', /^(normal|degraded|recovery)$/, {
      timeout: 90_000,
    });
    const metrics = await imagePanel.evaluate((element) => ({
      queueFrames: Number(element.getAttribute('data-h264-queue-frames')),
      droppedFrames: Number(element.getAttribute('data-h264-dropped-frames')),
      decodeQueueSize: Number(element.getAttribute('data-h264-decode-queue')),
      mediaLagMs: Number(element.getAttribute('data-h264-media-lag-ms')),
      resyncCount: Number(element.getAttribute('data-h264-resync-count')),
      renderedFrames: Number(element.getAttribute('data-h264-rendered-frames')),
    }));
    expect(Number.isInteger(metrics.queueFrames)).toBe(true);
    expect(metrics.queueFrames).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(metrics.droppedFrames)).toBe(true);
    expect(metrics.droppedFrames).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(metrics.decodeQueueSize)).toBe(true);
    expect(metrics.decodeQueueSize).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(metrics.mediaLagMs)).toBe(true);
    expect(metrics.mediaLagMs).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(metrics.resyncCount)).toBe(true);
    expect(metrics.resyncCount).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(metrics.renderedFrames)).toBe(true);
    expect(metrics.renderedFrames).toBeGreaterThanOrEqual(0);

    await page.getByTestId('playback-speed-trigger').click();
    await page.getByRole('menuitem', { name: '8x', exact: true }).click();
    const resume = page.getByRole('button', { name: 'Play playback' });
    if (await resume.isVisible().catch(() => false)) {
      await resume.click();
    }
    await page.waitForTimeout(1_000);
    await expect(imageStatus).toBeVisible();
    await expect(imagePanel).toHaveAttribute('data-h264-pressure', /^(normal|degraded|recovery)$/);
    expect(await page.getByText(/decode failed|could not be decoded/i).count()).toBe(0);
  }
});

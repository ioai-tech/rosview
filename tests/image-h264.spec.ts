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

  const imagePanel = page.getByTestId('image-panel');
  if (await imagePanel.isVisible().catch(() => false)) {
    await expect
      .poll(
        async () => Number(await imagePanel.getAttribute('data-h264-rendered-frames')),
        { timeout: 5_000 },
      )
      .toBeGreaterThan(0);
  }

  const hasDecodeFailure = await page.getByText(/decode failed|could not be decoded/i).count();
  expect(hasDecodeFailure).toBe(0);

  const imageStatus = page.getByTestId('image-panel-status');
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

/**
 * Records what the page posts to its workers: for each H.264 bootstrap batch, the receive time of
 * its first frame (the keyframe the decoder restarts from).
 */
async function recordH264Bootstraps(page: import('@playwright/test').Page): Promise<void> {
  await page.addInitScript(() => {
    const log: number[] = [];
    (window as unknown as { __h264Bootstraps: number[] }).__h264Bootstraps = log;
    const NativeWorker = window.Worker;
    class RecordingWorker extends NativeWorker {
      override postMessage(message: unknown, options?: unknown): void {
        const request = message as { type?: string; frames?: Array<{ receiveTime: { sec: number; nsec: number } }> };
        if (request?.type === 'bootstrapH264' && request.frames?.[0]) {
          const { sec, nsec } = request.frames[0].receiveTime;
          log.push(sec + nsec / 1e9);
        }
        super.postMessage(message, options as StructuredSerializeOptions);
      }
    }
    window.Worker = RecordingWorker;
  });
}

test('a paused forward seek decodes from the keyframe before the new time, not on the old references', async ({
  page,
}) => {
  // The fixture: keyframes at 1.0 s, 3.0 s and 5.0 s, deltas at 1.1, 1.2 and 3.1 s. Opened paused,
  // the decoder holds the 1.0 s keyframe only. A seek to 3.15 s shows the 3.1 s delta, which
  // references the 3.0 s keyframe: decoding it on the 1.0 s picture smears it (m-5).
  await recordH264Bootstraps(page);
  await openFixtureByUrl(page, MCAP_H264_URL);
  const imageStatus = page.getByTestId('image-panel-status');
  await expect(imageStatus).toHaveText(/\d+x\d+/, { timeout: 60_000 });
  const pause = page.getByRole('button', { name: 'Pause playback' });
  if (await pause.isVisible().catch(() => false)) await pause.click();
  const bootstraps = () => page.evaluate(() => (window as unknown as { __h264Bootstraps: number[] }).__h264Bootstraps);
  await expect.poll(bootstraps, { timeout: 30_000 }).toEqual([1]);

  const track = page.getByTestId('playback-track');
  const box = (await track.boundingBox())!;
  // The recording spans 1.0–5.0 s: 3.15 s is 53.75 % of the track.
  await track.click({ position: { x: box.width * 0.5375, y: box.height / 2 } });

  await expect.poll(async () => (await bootstraps()).slice(1), { timeout: 15_000 }).toEqual([3]);
  await expect(page.getByTestId('image-panel').locator('[data-frame-time]')).toHaveAttribute('data-frame-time', /^3\.1/, {
    timeout: 15_000,
  });
  expect(await page.getByText(/decode failed|could not be decoded/i).count()).toBe(0);
});

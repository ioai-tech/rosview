import { expect, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type PlaybackPerfMetrics = {
  id: string;
  url: string;
  readyMs: number;
  playAdvanceMs: number;
  progressDelta1s: number;
  seekAdvanceMs: number;
  bufferingStuckMs: number;
};

export async function readProgressPercent(page: Page): Promise<number | null> {
  const fill = page.getByTestId('playback-progress-fill');
  if ((await fill.count()) === 0) {
    return null;
  }
  return fill.evaluate((element) => {
    const value = Number.parseFloat((element as HTMLElement).style.width);
    return Number.isFinite(value) ? value : null;
  });
}

async function waitForProgressChange(
  page: Page,
  from: number | null,
  timeoutMs: number,
  minDelta = 0.1,
): Promise<number> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const next = await readProgressPercent(page);
    if (next != null && from != null && Math.abs(next - from) >= minDelta) {
      return Date.now() - started;
    }
    if (next != null && from == null) {
      return Date.now() - started;
    }
    await page.waitForTimeout(50);
  }
  throw new Error(`progress did not advance within ${timeoutMs}ms (from=${from})`);
}

async function clickPlay(page: Page): Promise<void> {
  const play = page.getByRole('button', { name: 'Play playback' });
  if (await play.isVisible().catch(() => false)) {
    await play.click();
  }
}

async function clickPause(page: Page): Promise<void> {
  const pause = page.getByRole('button', { name: 'Pause playback' });
  if (await pause.isVisible().catch(() => false)) {
    await pause.click();
  }
}

export type MeasurePlaybackPerfOptions = {
  readyTimeoutMs?: number;
  playTimeoutMs?: number;
};

export async function measurePlaybackPerf(
  page: Page,
  id: string,
  url: string,
  options: MeasurePlaybackPerfOptions = {},
): Promise<PlaybackPerfMetrics> {
  const readyTimeoutMs = options.readyTimeoutMs ?? 60_000;
  const playTimeoutMs = options.playTimeoutMs ?? 10_000;
  const started = Date.now();
  await page.goto(`/?url=${encodeURIComponent(url)}`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#rosview-root')).toHaveAttribute('data-player-presence', 'ready', {
    timeout: readyTimeoutMs,
  });
  await expect(page.getByRole('button', { name: 'Play playback' })).toBeVisible({ timeout: 30_000 });
  const readyMs = Date.now() - started;

  const beforePlay = await readProgressPercent(page);
  await clickPlay(page);
  const playAdvanceMs = await waitForProgressChange(page, beforePlay, playTimeoutMs);

  const beforeHold = await readProgressPercent(page);
  await page.waitForTimeout(1_000);
  const afterHold = await readProgressPercent(page);
  const progressDelta1s =
    beforeHold != null && afterHold != null ? Math.max(0, afterHold - beforeHold) : 0;

  await clickPause(page);
  const track = page.getByTestId('playback-track');
  await expect(track).toBeVisible();
  const box = await track.boundingBox();
  if (!box) {
    throw new Error('playback-track has no bounding box');
  }
  await track.click({
    position: {
      x: Math.max(1, Math.min(box.width - 1, box.width * 0.4)),
      y: box.height / 2,
    },
  });
  const afterSeek = await readProgressPercent(page);
  await clickPlay(page);
  const seekAdvanceMs = await waitForProgressChange(page, afterSeek, playTimeoutMs);

  const bufferingStarted = Date.now();
  let bufferingStuckMs = 0;
  const root = page.locator('#rosview-root');
  const bufferingAttr = await root.getAttribute('data-player-buffering');
  if (bufferingAttr === 'true') {
    try {
      await expect(root).toHaveAttribute('data-player-buffering', 'false', { timeout: 3_000 });
      bufferingStuckMs = Date.now() - bufferingStarted;
    } catch {
      bufferingStuckMs = Date.now() - bufferingStarted;
    }
  }

  await clickPause(page);

  return {
    id,
    url,
    readyMs,
    playAdvanceMs,
    progressDelta1s,
    seekAdvanceMs,
    bufferingStuckMs,
  };
}

export async function writePlaybackPerfReport(
  label: string,
  fixtures: PlaybackPerfMetrics[],
  outputPath: string,
): Promise<void> {
  await mkdir(path.dirname(outputPath), { recursive: true });
  const report = {
    schemaVersion: 1,
    label,
    generatedAt: new Date().toISOString(),
    fixtures,
  };
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

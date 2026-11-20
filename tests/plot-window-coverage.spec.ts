import { test, expect, type Page } from '@playwright/test';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { waitForRosviewReady } from './helpers/rosview';

/**
 * A teleop recording over a link: three cameras and the joints share every chunk, so a Plot's
 * window (+/- 30 s, here the whole recording) costs most of the file. The plots must show the
 * shape of the whole window early, after a small part of the file, not fill it left to right
 * (judged by bytes delivered, so the host's speed does not matter).
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const SECONDS = 12;
const JPEG_KIB = 40;
const MBPS = 80;
/** By this share of the file delivered, every plot must have points across its whole window. */
const SHARE = 0.25;
/** "Across the whole window": no stretch without a point wider than this share of it. */
const MAX_GAP = 0.3;

test.describe.configure({ mode: 'serial', timeout: 120_000 });

type LogEntry = { start: number; end: number; t1: number };

let dir: string;
let server: ChildProcess;
let origin: string;
let fileSize: number;

async function delivered(): Promise<number> {
  const log = (await (await fetch(`${origin}/__log`)).json()) as LogEntry[];
  return log.filter((r) => r.t1 > 0).reduce((n, r) => n + (r.end - r.start + 1), 0);
}

async function plots(page: Page): Promise<Array<{ points: number; gap: number }>> {
  return page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="plot-chart"]')].map((el) => ({
      points: Number(el.getAttribute('data-point-count') ?? 0),
      gap: Number(el.getAttribute('data-x-gap') ?? 1),
    })),
  );
}

test.beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'rosview-plot-window-'));
  const file = path.join(dir, 'robot.mcap');
  execFileSync('node', [path.join(here, '../scripts/gen-test-mcap-stream-3cam.mjs'), file, String(SECONDS), String(JPEG_KIB)], {
    stdio: 'ignore',
  });
  fileSize = statSync(file).size;
  server = spawn('node', [path.join(here, '../scripts/throttled-range-server.mjs'), dir, '--port', '0', '--mbps', String(MBPS)], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  origin = await new Promise<string>((resolve, reject) => {
    server.once('exit', (code) => reject(new Error(`range server exited (${code})`)));
    server.stdout!.on('data', (data: Buffer) => {
      const m = /on :(\d+)/.exec(data.toString());
      if (m) resolve(`http://127.0.0.1:${m[1]}`);
    });
  });
});

test.afterAll(() => {
  server?.kill();
  rmSync(dir, { recursive: true, force: true });
});

test('remote plots show their whole window after a quarter of the file, and fill in from there', async ({ page }) => {
  await fetch(`${origin}/__log`, { method: 'DELETE' });
  await page.goto(`/?url=${encodeURIComponent(`${origin}/robot.mcap`)}`);
  await waitForRosviewReady(page);
  await expect(page.getByTestId('plot-window-hint').first()).toBeVisible({ timeout: 30_000 });

  const counts: number[] = [];
  let atShare: Array<{ points: number; gap: number }> | undefined;
  let bytesAtShare = 0;
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const bytes = await delivered();
    const now = await plots(page);
    counts.push(now.reduce((n, p) => n + p.points, 0));
    if (bytes >= fileSize * SHARE) {
      atShare = now;
      bytesAtShare = bytes;
      break;
    }
    await page.waitForTimeout(100);
  }
  expect(atShare, 'a quarter of the file was delivered').toBeDefined();
  console.log(
    `at ${(bytesAtShare / 1e6).toFixed(1)} of ${(fileSize / 1e6).toFixed(1)} MB: widest gaps ${atShare!.map((p) => p.gap.toFixed(2)).join(', ')}; points ${atShare!.map((p) => p.points).join(', ')}`,
  );
  expect(atShare!.length).toBeGreaterThanOrEqual(2);
  for (const plot of atShare!) {
    expect(plot.points).toBeGreaterThan(0);
    expect(plot.gap).toBeLessThanOrEqual(MAX_GAP);
  }
  // The points arrived in steps on the way there, not all at once.
  expect(new Set(counts.filter((c) => c > 0)).size).toBeGreaterThanOrEqual(3);
});

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
 * shape of the whole window early, after a small part of the file, not fill it left to right.
 *
 * The server delivers an exact byte budget and then holds every response; the test waits until
 * the plots hold all they can from those bytes and judges the data they hold (`data-x-gap`: the
 * widest stretch of the window without a point, from the plot's dataset). So neither the host's
 * speed nor when the chart repaints matters.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const SECONDS = 12;
const JPEG_KIB = 40;
/** Two budgets: an eighth of the file, then a quarter. */
const SHARES = [0.125, 0.25];
/** After a quarter of the file: no stretch of the window without a point wider than this share. */
const MAX_GAP = 0.3;

test.describe.configure({ mode: 'serial', timeout: 120_000 });

type PlotData = { points: number; gap: number };

let dir: string;
let server: ChildProcess;
let origin: string;
let fileSize: number;

async function plots(page: Page): Promise<PlotData[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="plot-chart"]')].map((el) => ({
      points: Number(el.getAttribute('data-point-count') ?? 0),
      gap: Number(el.getAttribute('data-x-gap') ?? 1),
    })),
  );
}

/** Lets the server send up to `total` body bytes in all, then waits until the plots stop changing. */
async function deliverAndSettle(page: Page, total: number): Promise<PlotData[]> {
  const { sent } = (await (await fetch(`${origin}/__budget`)).json()) as { sent: number };
  await fetch(`${origin}/__budget?bytes=${Math.max(0, total - sent)}`, { method: 'PUT' });
  let last = '';
  let quietSince = Date.now();
  for (;;) {
    await page.waitForTimeout(250);
    const budget = (await (await fetch(`${origin}/__budget`)).json()) as { remaining: number };
    const now = await plots(page);
    const key = JSON.stringify(now);
    if (key !== last || budget.remaining > 0) {
      last = key;
      quietSince = Date.now();
    } else if (Date.now() - quietSince >= 2_000) {
      return now;
    }
  }
}

test.beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'rosview-plot-window-'));
  const file = path.join(dir, 'robot.mcap');
  execFileSync('node', [path.join(here, '../scripts/gen-test-mcap-stream-3cam.mjs'), file, String(SECONDS), String(JPEG_KIB)], {
    stdio: 'ignore',
  });
  fileSize = statSync(file).size;
  server = spawn('node', [path.join(here, '../scripts/throttled-range-server.mjs'), dir, '--port', '0', '--mbps', '400'], {
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
  await fetch(`${origin}/__budget?bytes=${Math.round(fileSize * SHARES[0])}`, { method: 'PUT' });
  await page.goto(`/?url=${encodeURIComponent(`${origin}/robot.mcap`)}`);
  await waitForRosviewReady(page);
  // The auto layout's plots (two JointState topics and the Imu) read remote windows.
  await expect.poll(() => page.getByTestId('plot-chart').count(), { timeout: 30_000 }).toBeGreaterThanOrEqual(2);
  await expect(page.getByTestId('plot-window-hint')).toHaveCount(await page.getByTestId('plot-chart').count());

  const stages: PlotData[][] = [];
  for (const share of SHARES) stages.push(await deliverAndSettle(page, Math.round(fileSize * share)));
  await fetch(`${origin}/__budget`, { method: 'DELETE' });
  console.log(
    stages
      .map((plotsAt, i) => `${SHARES[i] * 100}% of ${(fileSize / 1e6).toFixed(1)} MB: gaps ${plotsAt.map((p) => p.gap.toFixed(2)).join(', ')}; points ${plotsAt.map((p) => p.points).join(', ')}`)
      .join('\n'),
  );

  const [first, second] = stages;
  expect(second.length).toBeGreaterThanOrEqual(2);
  expect(first.length).toBe(second.length);
  second.forEach((plot, i) => {
    // Progressive: points after an eighth, more after a quarter.
    expect(first[i].points).toBeGreaterThan(0);
    expect(plot.points).toBeGreaterThan(first[i].points);
    // Spread: after a quarter of the file the points span the whole window.
    expect(plot.gap).toBeLessThanOrEqual(MAX_GAP);
  });
});

import { test, expect } from '@playwright/test';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { waitForRosviewReady } from './helpers/rosview';

/**
 * A teleop robot recording (three 30 Hz cameras, two JointState topics, an Imu; a fraction of a
 * second per chunk) behind a 20 Mbps link, opened with the default auto layout as the EmbodiFlow
 * console does. Each chunk takes longer to arrive than a playback tick waits, which is what a remote
 * recording looks like: the auto-layout Plots must still plot every message of their window.
 */
const SECONDS = 12;
/** Values each plot holds once its window (the whole 12 s recording) is read: messages x curves. */
const EXPECTED_VALUES = [
  { topic: '/joint_states', values: SECONDS * 100 * 14 },
  { topic: '/joint_cmd', values: SECONDS * 200 * 14 },
  { topic: '/imu/data', values: SECONDS * 120 * 6 },
];
const here = path.dirname(fileURLToPath(import.meta.url));

test.describe.configure({ mode: 'serial', timeout: 120_000 });

let dir: string;
let server: ChildProcess;
let origin: string;

test.beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'rosview-plots-'));
  execFileSync('node', [path.join(here, '../scripts/gen-test-mcap-stream-3cam.mjs'), path.join(dir, 'robot.mcap'), String(SECONDS), '40'], {
    stdio: 'ignore',
  });
  server = spawn('node', [path.join(here, '../scripts/throttled-range-server.mjs'), dir, '--port', '0', '--mbps', '20'], {
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

test('auto-layout plots of a remote robot recording plot their JointState and Imu series', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.addInitScript(() => {
    (window as unknown as { __rosviewHostProps: unknown }).__rosviewHostProps = {
      preferAutoLayout: true,
      preferencePersistence: 'off',
      layoutPersistence: 'off',
    };
  });
  const opened = Date.now();
  await page.goto(`/?url=${encodeURIComponent(`${origin}/robot.mcap`)}`);
  await waitForRosviewReady(page);

  const charts = page.getByTestId('plot-chart');
  await expect(charts).toHaveCount(3, { timeout: 30_000 });
  for (let i = 0; i < 3; i++) {
    await expect
      .poll(async () => Number(await charts.nth(i).getAttribute('data-point-count')), { timeout: 30_000 })
      .toBeGreaterThan(0);
  }
  console.log(`auto-layout plots: every plot has points ${((Date.now() - opened) / 1000).toFixed(1)} s after open`);
  for (const { topic, values } of EXPECTED_VALUES) {
    const chart = page.getByTestId('plot-panel').filter({ has: page.getByRole('combobox').filter({ hasText: topic }) }).getByTestId('plot-chart');
    await expect(chart).toHaveAttribute('data-loading', 'false', { timeout: 90_000 });
    // Every message of the window, not the prefix that happened to be cached when the read started.
    expect(Number(await chart.getAttribute('data-point-count'))).toBeGreaterThanOrEqual(values * 0.95);
  }
  console.log(`auto-layout plots: every window read ${((Date.now() - opened) / 1000).toFixed(1)} s after open`);
  await expect(page.getByText('No numeric data found')).toHaveCount(0);

  // Three plots share a row; each still shows which topic it plots.
  for (const topic of ['/joint_states', '/joint_cmd', '/imu/data']) {
    const picker = page.getByRole('combobox').filter({ hasText: topic }).first();
    await expect(picker).toBeVisible();
    expect((await picker.boundingBox())!.width).toBeGreaterThanOrEqual(100);
  }
});

import { test, expect, type Page } from '@playwright/test';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachBrowserDiagnostics, waitForRosviewReady } from './helpers/rosview';

/**
 * M-2: the network drops for 10 s while a remote recording plays, and the user seeks meanwhile.
 * Requests fail the way a real cut fails them ("Failed to fetch"). The viewer says it is
 * reconnecting (not that it failed), and once the network is back it plays on from the seek by
 * itself: no Retry, no seek, no error left behind. Once through Playwright aborting the requests
 * (the browser does not know it is offline, so no `online` event) and once offline.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const CUT_MS = 10_000;

test.describe.configure({ mode: 'serial', timeout: 180_000 });

let dir: string;
let server: ChildProcess;
let origin: string;

test.beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'rosview-outage-'));
  // 120 s of camera, cloud and /tf: far more than a few seconds of read-ahead hold.
  execFileSync('node', [path.join(here, '../scripts/gen-test-mcap-ego-scene.mjs'), path.join(dir, 'ego.mcap'), '120', '2', '48'], {
    stdio: 'ignore',
  });
  server = spawn('node', [path.join(here, '../scripts/throttled-range-server.mjs'), dir, '--port', '0', '--mbps', '200'], {
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

/** Playback time in seconds from the time line ("mm:ss.sss / mm:ss.sss"). */
async function playbackSeconds(page: Page): Promise<number> {
  const text = (await page.getByTestId('playback-time-line').textContent()) ?? '';
  const m = /(\d+):(\d+(?:\.\d+)?)/.exec(text);
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
}

async function openAndPlay(page: Page): Promise<void> {
  await page.goto(`/?url=${encodeURIComponent(`${origin}/ego.mcap`)}`);
  await waitForRosviewReady(page);
  await expect(page.getByTestId('image-panel-status').first()).toHaveText(/^\d+x\d+/, { timeout: 30_000 });
  await page.getByRole('button', { name: 'Play playback' }).click();
  await expect.poll(() => playbackSeconds(page), { timeout: 15_000 }).toBeGreaterThan(1);
}

async function seekTo(page: Page, fraction: number): Promise<void> {
  const track = page.getByTestId('playback-track');
  const box = (await track.boundingBox())!;
  await track.click({ position: { x: box.width * fraction, y: box.height / 2 } });
}

async function cutAndRecover(
  page: Page,
  cut: () => Promise<void>,
  restore: () => Promise<void>,
  recoverWithinMs: number,
  options: { seek: boolean } = { seek: true },
) {
  await cut();
  if (options.seek) await seekTo(page, 0.8); // a part of the recording that was never read
  const cutAt = await playbackSeconds(page);
  if (options.seek) expect(cutAt).toBeGreaterThan(80);

  // During the cut: reconnecting once the read-ahead is used up, never a failure, and the playhead
  // waits where it is (it does not run on without the frames).
  await expect(page.getByTestId('rosview-playback-reconnecting')).toBeVisible({ timeout: CUT_MS });
  const reconnectingAt = await playbackSeconds(page);
  await page.waitForTimeout(CUT_MS - 2_000);
  await expect(page.getByTestId('rosview-playback-error')).toHaveCount(0);
  await expect(page.getByTestId('panel-topic-read-error')).toHaveCount(0);
  const heldAt = await playbackSeconds(page);
  expect(heldAt - reconnectingAt).toBeLessThan(1.5);

  const restoredAt = Date.now();
  await restore();
  // The network is back: the viewer plays on by itself from where it waited, not as far ahead as
  // the cut lasted.
  await expect(page.getByTestId('rosview-playback-reconnecting')).toHaveCount(0, { timeout: recoverWithinMs });
  expect(await playbackSeconds(page)).toBeLessThan(heldAt + 3);
  await expect.poll(() => playbackSeconds(page), { timeout: recoverWithinMs }).toBeGreaterThan(heldAt + 1);
  console.log(`recovered ${Date.now() - restoredAt} ms after the network came back (held at ${heldAt} s)`);
  await expect(page.getByTestId('rosview-playback-error')).toHaveCount(0);
  await expect(page.getByTestId('panel-topic-read-error')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Pause playback' })).toBeVisible();
}

test('requests aborted for 10 s (no online event): Raw reconnects and plays on by itself', async ({ page }) => {
  const diagnostics = attachBrowserDiagnostics(page);
  await openAndPlay(page);
  const pattern = `${origin}/**`;
  await cutAndRecover(
    page,
    async () => {
      await page.route(pattern, (route) => route.abort('internetdisconnected'));
    },
    () => page.unroute(pattern),
    // At most one 3 s backoff step, plus reading the frame.
    8_000,
  );
  expect(diagnostics.pageErrors).toEqual([]);
});

test('offline for 10 s while playing, no seek: Raw waits at the playhead and plays on', async ({ page, context }) => {
  const diagnostics = attachBrowserDiagnostics(page);
  await openAndPlay(page);
  await cutAndRecover(
    page,
    () => context.setOffline(true),
    () => context.setOffline(false),
    5_000,
    { seek: false },
  );
  expect(diagnostics.pageErrors).toEqual([]);
});

test('offline for 10 s: Raw reconnects at once on the online event', async ({ page, context }) => {
  const diagnostics = attachBrowserDiagnostics(page);
  await openAndPlay(page);
  const offline = (value: boolean) => context.setOffline(value);
  await cutAndRecover(
    page,
    () => offline(true),
    () => offline(false),
    5_000,
  );
  expect(diagnostics.pageErrors).toEqual([]);
});

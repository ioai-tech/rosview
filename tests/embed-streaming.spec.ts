import { test, expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MCAP_3CAM, requireFixture } from './fixturePaths';
import { waitForRosviewReady } from './helpers/rosview';

const here = path.dirname(fileURLToPath(import.meta.url));
test.describe.configure({ timeout: 120_000 });

type RangeLog = Array<{ url: string; start: number; end: number; status: number }>;

/** Serves `file` at `urlPath` with HTTP Range support; `isValid(url)` decides 200/206 vs 403. */
async function serveRanged(
  page: Page,
  urlPath: string,
  file: Buffer,
  log: RangeLog,
  isValid: (url: URL) => boolean = () => true,
): Promise<void> {
  await page.route(`**${urlPath}*`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const m = /bytes=(\d+)-(\d*)/.exec(request.headers().range ?? '');
    const start = m ? Number(m[1]) : 0;
    const end = m && m[2] ? Math.min(Number(m[2]), file.length - 1) : file.length - 1;
    const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'Content-Range, Content-Length, ETag', ETag: '"fixture-1"' };
    if (!isValid(url)) {
      log.push({ url: request.url(), start, end, status: 403 });
      await route.fulfill({ status: 403, headers, body: 'expired' });
      return;
    }
    log.push({ url: request.url(), start, end, status: 206 });
    await route.fulfill({
      status: m ? 206 : 200,
      headers: { ...headers, 'Accept-Ranges': 'bytes', ...(m ? { 'Content-Range': `bytes ${start}-${end}/${file.length}` } : {}) },
      body: file.subarray(start, end + 1),
    });
  });
}

async function firstImage(page: Page): Promise<void> {
  await expect(page.getByTestId('image-panel-status').first()).toHaveText(/^\d+x\d+/, { timeout: 60_000 });
}

test.describe('embedding: streaming and URL renewal', () => {
  let big: Buffer;
  let dir: string;

  test.beforeAll(() => {
    requireFixture(MCAP_3CAM);
    dir = mkdtempSync(path.join(tmpdir(), 'rosview-stream-'));
    const out = path.join(dir, 'big.mcap');
    // 3 cameras, ~20 s, 120 KiB JPEGs: tens of MiB, indexed, many chunks.
    execFileSync('node', [path.join(here, '../scripts/gen-test-mcap-stream-3cam.mjs'), out, '6', '120'], { stdio: 'ignore' });
    big = readFileSync(out);
    expect(statSync(out).size).toBeGreaterThan(30 * 1024 * 1024);
  });

  test.afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('shows the first image after reading a small part of a large indexed MCAP', async ({ page }) => {
    const log: RangeLog = [];
    await serveRanged(page, '/stream/big.mcap', big, log);
    await page.goto(`/?url=${encodeURIComponent('/stream/big.mcap')}`);
    await waitForRosviewReady(page);
    await firstImage(page);
    const requested = log.reduce((n, r) => n + (r.end - r.start + 1), 0);
    expect(requested).toBeLessThan(big.length * 0.4);
    // No request may ask for more than a few MiB: no whole-file or 50 MiB block reads.
    expect(Math.max(...log.map((r) => r.end - r.start + 1))).toBeLessThanOrEqual(8 * 1024 * 1024);
  });

  test('reopening the same sourceKey in the same tab is served from memory', async ({ page }) => {
    const log: RangeLog = [];
    await serveRanged(page, '/stream/big.mcap', big, log);
    await page.goto(`/?url=${encodeURIComponent('/stream/big.mcap')}&sourceKey=rec-1`);
    await waitForRosviewReady(page);
    await firstImage(page);
    const firstOpenRequested = log.reduce((n, r) => n + (r.end - r.start + 1), 0);

    // Leave the viewer and open the same recording again, without reloading the page.
    await page.evaluate(() => {
      history.pushState({}, '', '/?url=');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await page.waitForTimeout(500);
    log.length = 0;
    await page.evaluate((u) => {
      history.pushState({}, '', u);
      window.dispatchEvent(new PopStateEvent('popstate'));
    }, `/?url=${encodeURIComponent('/stream/big.mcap')}&sourceKey=rec-1`);
    await firstImage(page);
    const requested = log.reduce((n, r) => n + (r.end - r.start + 1), 0);
    // The index and first chunks come from the in-tab cache; only the size probe and read-ahead hit the network.
    expect(requested).toBeLessThan(firstOpenRequested);
    expect(log.filter((r) => r.start === 0).length).toBeLessThanOrEqual(1);
  });

  test('keeps no recording bytes in IndexedDB, Cache Storage or OPFS', async ({ page }) => {
    const log: RangeLog = [];
    await serveRanged(page, '/stream/big.mcap', big, log);
    await page.addInitScript(() => {
      (window as unknown as { __rosviewHostProps: unknown }).__rosviewHostProps = { preferencePersistence: 'off' };
    });
    await page.goto(`/?url=${encodeURIComponent('/stream/big.mcap')}&sourceKey=rec-2`);
    await firstImage(page);
    const storage = await page.evaluate(async () => {
      const dbs = (await indexedDB.databases?.()) ?? [];
      const caches_ = await caches.keys();
      let opfs = 0;
      try {
        const root = await navigator.storage.getDirectory();
         
        for await (const _ of (root as unknown as { keys(): AsyncIterable<string> }).keys()) opfs++;
      } catch {
        /* OPFS unavailable */
      }
      return { dbs: dbs.map((d) => d.name), caches: caches_, opfs };
    });
    expect(storage.caches).toEqual([]);
    expect(storage.opfs).toBe(0);
    expect(storage.dbs, JSON.stringify(storage.dbs)).toEqual([]);
  });

  test('renews an expired presigned URL once, keeping position and layout', async ({ page }) => {
    const file = big;
    const log: RangeLog = [];
    let expired = false;
    await serveRanged(page, '/signed/rec.mcap', file, log, (url) => !expired || url.searchParams.get('token') === 'fresh');
    await page.addInitScript(() => {
      (window as unknown as { __refreshCalls: string[][] }).__refreshCalls = [];
      (window as unknown as { __rosviewHostProps: unknown }).__rosviewHostProps = {
        refreshUrls: async (urls: string[]) => {
          (window as unknown as { __refreshCalls: string[][] }).__refreshCalls.push(urls);
          return urls.map((u) => u.replace('token=old', 'token=fresh'));
        },
      };
    });
    await page.goto(`/?url=${encodeURIComponent('/signed/rec.mcap?token=old')}`);
    await waitForRosviewReady(page);
    await firstImage(page);
    const panelsBefore = await page.getByTestId('image-panel').count();

    expired = true; // the old token stops working; blocks already cached keep working
    const track = page.getByTestId('playback-track');
    const box = await track.boundingBox();
    await page.getByRole('button', { name: 'Pause playback' }).click({ timeout: 2000 }).catch(() => undefined);
    await track.click({ position: { x: box!.width * 0.9, y: box!.height / 2 } });
    await expect.poll(() => page.evaluate(() => performance.getEntriesByName('rosview:seek').length)).toBeGreaterThan(0);

    const calls = await page.evaluate(() => (window as unknown as { __refreshCalls: string[][] }).__refreshCalls);
    expect(log.some((r) => r.status === 403)).toBe(true);
    expect(calls.length).toBe(1);
    expect(calls[0][0]).toContain('token=old');
    expect(log.some((r) => r.url.includes('token=fresh'))).toBe(true);
    await expect(page.locator('#rosview-root')).toHaveAttribute('data-player-presence', 'ready');
    expect(await page.getByTestId('image-panel').count()).toBe(panelsBefore);
  });

  test('a renewed URL that fails too shows the ordinary source error', async ({ page }) => {
    const file = readFileSync(MCAP_3CAM);
    const log: RangeLog = [];
    await serveRanged(page, '/signed/rec.mcap', file, log, () => false);
    await page.addInitScript(() => {
      (window as unknown as { __rosviewHostProps: unknown }).__rosviewHostProps = {
        refreshUrls: async (urls: string[]) => urls.map((u) => `${u}&again=1`),
      };
    });
    await page.goto(`/?url=${encodeURIComponent('/signed/rec.mcap?token=old')}`);
    await expect(page.getByText(/403|Forbidden|Failed to/i).first()).toBeVisible({ timeout: 30_000 });
    expect(log.filter((r) => r.url.includes('again=1')).length).toBeGreaterThan(0);
    // One renewal only: the renewed URL failed as well, so the viewer does not keep asking.
    expect(log.filter((r) => r.url.includes('again=1&again=1')).length).toBe(0);
  });

  test('messages prop replaces copy and the embedded root has no main landmark', async ({ page }) => {
    await page.addInitScript(() => {
      (window as unknown as { __rosviewHostProps: unknown }).__rosviewHostProps = {
        messages: { 'layout.viewerRegion': 'Custom region label' },
      };
    });
    await page.goto(`/?url=${encodeURIComponent('/examples/test_3cam.mcap')}`);
    await waitForRosviewReady(page);
    await expect(page.getByRole('region', { name: 'Custom region label' })).toBeVisible();
    // The standalone shell owns the page's only <main>; RosView itself renders none.
    expect(await page.locator('main').count()).toBe(1);
  });
});

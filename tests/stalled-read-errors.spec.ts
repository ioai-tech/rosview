import { test, expect, type Page } from '@playwright/test';
import { McapIndexedReader } from '@mcap/core';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachBrowserDiagnostics, waitForRosviewReady } from './helpers/rosview';

/**
 * A server that stops sending in the middle of a response. The egocentric scene recording keeps
 * the map and /tf_static in its last chunk; the server stalls every read of that chunk's data (it
 * sends 64 KiB, then holds the response open) and leaves the rest alone. The viewer, with its
 * stall timeout shortened to 1 s through the e2e seam, must show the image, say in every panel that
 * reads a stalled topic why it has no data (and not claim to wait for it), and read the topic
 * again on a seek once the server answers.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const MAP_MIB = 4;
const MAP_POINTS = (MAP_MIB * 1024 * 1024) / 16;
const BLOCK = 512 * 1024; // RangeSource block size: the summary's blocks must not stall
const STALL_TIMEOUT_MS = 1000;

test.describe.configure({ mode: 'serial', timeout: 120_000 });

let dir: string;
let server: ChildProcess;
let origin: string;
let stallFrom: number;
let stallTo: number;

async function renderedPoints(page: Page): Promise<number> {
  return page.evaluate(() =>
    Number(document.querySelector('[data-testid="three-canvas"] canvas')?.getAttribute('data-rendered-points') ?? 0),
  );
}

test.beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'rosview-stall-'));
  const file = path.join(dir, 'ego.mcap');
  execFileSync('node', [path.join(here, '../scripts/gen-test-mcap-ego-scene.mjs'), file, '30', String(MAP_MIB)], {
    stdio: 'ignore',
  });
  const bytes = readFileSync(file);
  const reader = await McapIndexedReader.Initialize({
    readable: {
      size: async () => BigInt(bytes.length),
      read: async (offset, length) => bytes.subarray(Number(offset), Number(offset + length)),
    },
  });
  const tail = [...reader.chunkIndexes].sort((a, b) => Number(b.chunkStartOffset - a.chunkStartOffset))[0];
  stallFrom = Number(tail.chunkStartOffset);
  // The last chunk's data, short of the blocks that also hold the summary (read when opening).
  stallTo = Math.min(stallFrom + Number(tail.chunkLength), Math.floor(Number(reader.footer.summaryStart) / BLOCK) * BLOCK) - 1;
  expect(stallTo - stallFrom).toBeGreaterThan(MAP_MIB * 1024 * 1024 * 0.5);

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

test('a stalled read: the image shows, each panel says why its topic is missing, a seek reads it again', async ({ page }) => {
  const diagnostics = attachBrowserDiagnostics(page);
  await fetch(`${origin}/__stall?from=${stallFrom}&to=${stallTo}`, { method: 'PUT' });
  await page.addInitScript((ms) => {
    (window as unknown as { __rosviewStallTimeoutMs: number }).__rosviewStallTimeoutMs = ms;
  }, STALL_TIMEOUT_MS);
  await page.goto(`/?url=${encodeURIComponent(`${origin}/ego.mcap`)}`);
  await waitForRosviewReady(page);

  // The image's chunk is not stalled.
  await expect(page.getByTestId('image-panel-status').first()).toHaveText(/^\d+x\d+/, { timeout: 30_000 });

  // The 3D panel names the reason (the stall, after one retry).
  const reason = /Could not read \/(tf_static|scene\/map): No data arrived from the server for 1 s while reading .*also after a retry\./;
  const threeDError = page.locator('[data-panel-type="3D"] [data-testid="panel-topic-read-error"]');
  await expect(threeDError).toHaveText(reason, { timeout: 30_000 });

  // Every panel that reads a stalled topic says so, and none says it is waiting for it.
  const failingPanels = page.locator('[data-panel-id]:has([data-testid="panel-topic-read-error"])');
  const failing = await failingPanels.evaluateAll((panels) =>
    panels.map((panel) => ({
      type: panel.getAttribute('data-panel-type'),
      text: panel.textContent ?? '',
    })),
  );
  console.log(`panels with a read error: ${failing.map((p) => p.type).join(', ')}`);
  expect(failing.length).toBeGreaterThanOrEqual(1);
  for (const panel of failing) expect(panel.text, `${panel.type} panel`).not.toMatch(/Waiting|等待|待機/);
  await expect(page.getByText(/Waiting for messages/)).toHaveCount(0);
  // The image panel reads nothing that stalled.
  await expect(page.locator('[data-panel-type="Image"] [data-testid="panel-topic-read-error"]')).toHaveCount(0);

  // The server answers again; a paused seek reads the topics anew: the errors go and the map is drawn.
  await fetch(`${origin}/__stall`, { method: 'DELETE' });
  const track = page.getByTestId('playback-track');
  const box = (await track.boundingBox())!;
  await track.click({ position: { x: box.width * 0.5, y: box.height / 2 } });
  await expect(page.getByTestId('panel-topic-read-error')).toHaveCount(0, { timeout: 15_000 });
  await expect.poll(() => renderedPoints(page), { timeout: 30_000 }).toBeGreaterThanOrEqual(MAP_POINTS);
  await expect(page.getByTestId('panel-topic-read-error')).toHaveCount(0);

  expect(diagnostics.pageErrors).toEqual([]);
});

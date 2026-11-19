import { test, expect, type Page } from '@playwright/test';
import { McapIndexedReader } from '@mcap/core';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { waitForRosviewReady } from './helpers/rosview';

/**
 * An egocentric scene recording opened paused over a slow link (the shape of an EmbodiFlow
 * ego-vis MCAP behind a signed URL): many small chunks, then a last chunk that spans the whole
 * recording because the map and /tf_static, stamped at the first frame, are written when it ends.
 * The paused viewer must read the chunks its frame needs (the first chunk and that last one),
 * show the image and the 3D scene, and then stop reading.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const MBPS = 8;
const MAP_MIB = 20;
const MAP_POINTS = (MAP_MIB * 1024 * 1024) / 16;
const MIB = 1024 * 1024;

test.describe.configure({ mode: 'serial', timeout: 180_000 });

type LogEntry = { path: string; start: number; end: number; status: number };

let dir: string;
let server: ChildProcess;
let origin: string;
let fileSize: number;
let tailChunkBytes: number;
let firstChunkBytes: number;

async function rangeLog(): Promise<LogEntry[]> {
  return (await (await fetch(`${origin}/__log`)).json()) as LogEntry[];
}

function requestedBytes(log: LogEntry[]): number {
  return log.reduce((n, r) => n + (r.end - r.start + 1), 0);
}

/** Waits until no new request reached the server for `quietMs`; returns the log then. */
async function settledLog(page: Page, quietMs: number): Promise<LogEntry[]> {
  let last = (await rangeLog()).length;
  let quietSince = Date.now();
  for (;;) {
    await page.waitForTimeout(250);
    const log = await rangeLog();
    if (log.length !== last) {
      last = log.length;
      quietSince = Date.now();
    } else if (Date.now() - quietSince >= quietMs) {
      return log;
    }
  }
}

async function renderedPoints(page: Page): Promise<number> {
  return page.evaluate(() =>
    Number(document.querySelector('[data-testid="three-canvas"] canvas')?.getAttribute('data-rendered-points') ?? 0),
  );
}

test.beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'rosview-ego-'));
  const file = path.join(dir, 'ego.mcap');
  execFileSync('node', [path.join(here, '../scripts/gen-test-mcap-ego-scene.mjs'), file, '120', String(MAP_MIB)], {
    stdio: 'ignore',
  });
  const bytes = readFileSync(file);
  fileSize = bytes.length;
  const reader = await McapIndexedReader.Initialize({
    readable: {
      size: async () => BigInt(bytes.length),
      read: async (offset, length) => bytes.subarray(Number(offset), Number(offset + length)),
    },
  });
  const byOffset = [...reader.chunkIndexes].sort((a, b) => Number(a.chunkStartOffset - b.chunkStartOffset));
  const tail = byOffset[byOffset.length - 1];
  // The fixture's shape: the last chunk spans the recording and is most of the bytes a paused frame needs.
  expect(tail.messageStartTime).toBe(byOffset[0].messageStartTime);
  expect(tail.messageEndTime).toBe(reader.chunkIndexes.reduce((m, c) => (c.messageEndTime > m ? c.messageEndTime : m), 0n));
  expect(byOffset.length).toBeGreaterThan(50);
  tailChunkBytes = Number(tail.chunkLength + tail.messageIndexLength);
  firstChunkBytes = Number(byOffset[0].chunkLength + byOffset[0].messageIndexLength);

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

test('paused: shows the image and the 3D scene at the playhead, reads only what that frame needs, then stops', async ({
  page,
}) => {
  await fetch(`${origin}/__log`, { method: 'DELETE' });
  const opened = Date.now();
  await page.goto(`/?url=${encodeURIComponent(`${origin}/ego.mcap`)}`);
  await waitForRosviewReady(page);
  await expect(page.getByRole('button', { name: 'Play playback' })).toBeVisible();

  await expect(page.getByTestId('image-panel-status').first()).toHaveText(/^\d+x\d+/, { timeout: 60_000 });
  // The map (in the last chunk) is drawn: its points reach the screen.
  await expect.poll(() => renderedPoints(page), { timeout: 60_000 }).toBeGreaterThanOrEqual(MAP_POINTS);
  const renderedAfterS = (Date.now() - opened) / 1000;

  const log = await settledLog(page, 4_000);
  const read = requestedBytes(log);
  // The frame needs the summary, the first chunk and the last chunk; 512 KiB block rounding and the
  // message indexes of a few neighbouring chunks are the slack. A whole-file read is ~3x this.
  const budget = tailChunkBytes + firstChunkBytes + 6 * MIB;
  console.log(
    `paused open: rendered in ${renderedAfterS.toFixed(1)} s, read ${(read / MIB).toFixed(1)} MiB of ${(fileSize / MIB).toFixed(1)} MiB (budget ${(budget / MIB).toFixed(1)} MiB)`,
  );
  expect(read).toBeLessThanOrEqual(budget);

  // Paused: nothing more is read.
  await page.waitForTimeout(5_000);
  expect((await rangeLog()).length).toBe(log.length);
});

test('paused seek reads the chunks at the new time only; playback read-ahead is bounded and stops on pause', async ({
  page,
}) => {
  await page.goto(`/?url=${encodeURIComponent(`${origin}/ego.mcap`)}`);
  await waitForRosviewReady(page);
  await expect(page.getByTestId('image-panel-status').first()).toHaveText(/^\d+x\d+/, { timeout: 60_000 });
  await expect.poll(() => renderedPoints(page), { timeout: 60_000 }).toBeGreaterThanOrEqual(MAP_POINTS);
  const beforeSeek = requestedBytes(await settledLog(page, 3_000));

  // Seek to the middle while paused. The last chunk is cached; only the chunks around 60 s are new.
  const track = page.getByTestId('playback-track');
  const box = (await track.boundingBox())!;
  await track.click({ position: { x: box.width * 0.5, y: box.height / 2 } });
  await expect.poll(() => page.evaluate(() => performance.getEntriesByName('rosview:seek').length)).toBeGreaterThan(0);
  const afterSeekLog = await settledLog(page, 4_000);
  const seekRead = requestedBytes(afterSeekLog) - beforeSeek;
  console.log(`paused seek: read ${(seekRead / MIB).toFixed(1)} MiB`);
  expect(seekRead).toBeLessThanOrEqual(4 * MIB);
  await expect(page.getByTestId('image-panel-status').first()).toHaveText(/^\d+x\d+/);
  await page.waitForTimeout(3_000);
  expect((await rangeLog()).length).toBe(afterSeekLog.length);

  // Play for a few seconds, then pause: read-ahead covers seconds of recording, never the file.
  await page.getByRole('button', { name: 'Play playback' }).click();
  await page.waitForTimeout(4_000);
  await page.getByRole('button', { name: 'Pause playback' }).click();
  const afterPlayLog = await settledLog(page, 4_000);
  const playRead = requestedBytes(afterPlayLog) - requestedBytes(afterSeekLog);
  console.log(`4 s of playback: read ${(playRead / MIB).toFixed(1)} MiB`);
  // ~0.33 MiB per second of recording; 4 s played plus a 5 s read-ahead window, with block rounding.
  expect(playRead).toBeLessThanOrEqual(8 * MIB);
  await page.waitForTimeout(3_000);
  expect((await rangeLog()).length).toBe(afterPlayLog.length);
});

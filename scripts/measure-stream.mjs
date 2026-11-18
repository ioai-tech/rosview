/**
 * Streaming budget measurement over the throttled Range server (throttled-range-server.mjs).
 *   node scripts/measure-stream.mjs <fileUrl> [--seeks 10] [--reopen 1] [--play-seconds 0] [--timeout 180]
 *        [--app http://127.0.0.1:4173] [--log http://127.0.0.1:4180/__log] [--url-suffix "&sourceKey=..."]
 * Reports: first image, seek p50/p90 (click -> frames delivered, from the rosview:seek user-timing entry),
 * same-tab reopen (navigating inside the page back to the same URL), JS heap after playback + seeks.
 * CHROME_PATH selects the browser binary.
 */
import { execFileSync } from 'node:child_process';
import { chromium } from '@playwright/test';

const argv = process.argv.slice(2);
const fileUrl = argv[0];
const opt = (n, d) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);
const app = opt('app', 'http://127.0.0.1:4173');
const logUrl = opt('log', 'http://127.0.0.1:4180/__log');
const timeoutMs = Number(opt('timeout', 180)) * 1000;
const seeks = Number(opt('seeks', 10));
const playSeconds = Number(opt('play-seconds', 0));
const suffix = opt('url-suffix', '');
const hostProps = opt('host-props', '');
const settleMs = Number(opt('settle', 0));
const idleSeconds = Number(opt('idle', 0));
const target = `${app}/?url=${encodeURIComponent(fileUrl)}${suffix}`;

const profileDir = `${process.env.TMPDIR || '.'}/rv-measure-${process.pid}`;
const context = await chromium.launchPersistentContext(profileDir, {
  executablePath: process.env.CHROME_PATH || undefined,
  args: ['--enable-precise-memory-info', '--js-flags=--expose-gc'],
  viewport: { width: 1400, height: 900 },
});
const browser = { close: () => context.close() };
const page = context.pages()[0] ?? (await context.newPage());
const cdp = await context.newCDPSession(page);

async function firstImage(t0) {
  const deadline = t0 + timeoutMs;
  let ready;
  while (Date.now() < deadline) {
    const status = await page.getByTestId('image-panel-status').allTextContents().catch(() => []);
    ready ??= (await page.locator('#rosview-root').getAttribute('data-player-presence').catch(() => null)) === 'ready' ? Date.now() - t0 : undefined;
    if (status.some((s) => /^\d+x\d+/.test(s))) return { ready, firstImage: Date.now() - t0 };
    await page.waitForTimeout(50);
  }
  return { ready, firstImage: null };
}

/** Resident memory of the browser process tree (main, renderers, workers, GPU), rooted at this run's profile dir. */
async function browserRssMiB() {
  const rows = execFileSync('ps', ['-eo', 'pid=,ppid=,rss=,args='])
    .toString()
    .split('\n')
    .map((l) => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(l))
    .filter(Boolean)
    .map((m) => ({ pid: +m[1], ppid: +m[2], rss: +m[3], args: m[4] }));
  const roots = rows.filter((r) => r.args.includes(profileDir) && !r.args.includes('--type='));
  const tree = new Set(roots.map((r) => r.pid));
  for (let grew = true; grew; ) {
    grew = false;
    for (const r of rows) if (tree.has(r.ppid) && !tree.has(r.pid)) (tree.add(r.pid), (grew = true));
  }
  return Math.round(rows.filter((r) => tree.has(r.pid)).reduce((n, r) => n + r.rss, 0) / 1024);
}

const out = {};
if (hostProps) await page.addInitScript((p) => { window.__rosviewHostProps = JSON.parse(p); }, hostProps);
await fetch(logUrl, { method: 'DELETE' });
let t0 = Date.now();
await page.goto(target);
Object.assign(out, await firstImage(t0));
const log = await (await fetch(logUrl)).json();
out.requests = log.length;
out.requestedMiB = +(log.reduce((s, e) => s + (e.end - e.start + 1), 0) / 2 ** 20).toFixed(1);

if (idleSeconds > 0) {
  // Let default-layout panels (plots) load for a while, then count what crossed the link.
  await page.waitForTimeout(Math.max(0, idleSeconds * 1000 - (Date.now() - t0)));
  const l = await (await fetch(logUrl)).json();
  out.bytesFirstWindowMiB = +(l.filter((e) => e.t0 <= t0 + idleSeconds * 1000).reduce((n, e) => n + (e.end - e.start + 1), 0) / 2 ** 20).toFixed(1);
  out.windowSeconds = idleSeconds;
  out.plotPanels = await page.locator('.uplot').count();
}

// Seeks: pause, click the track at spread positions.
await page.getByRole('button', { name: 'Pause playback' }).click({ timeout: 2000 }).catch(() => {});
const track = page.getByTestId('playback-track');
const box = await track.boundingBox();
const seekMs = [];
const frameMs = [];
for (let i = 0; i < seeks; i++) {
  const frac = [0.5, 0.2, 0.8, 0.35, 0.65, 0.1, 0.9, 0.45, 0.75, 0.3][i % 10];
  if (settleMs > 0) await page.waitForTimeout(settleMs); // nothing from the previous seek in flight
  const before = await page.evaluate(() => performance.getEntriesByName('rosview:seek').length);
  await track.click({ position: { x: Math.max(1, box.width * frac), y: box.height / 2 } });
  const started = Date.now();
  for (;;) {
    const n = await page.evaluate(() => performance.getEntriesByName('rosview:seek').length);
    if (n > before) break;
    if (Date.now() - started > 60000) break;
    await page.waitForTimeout(20);
  }
  const entries = await page.evaluate(() => performance.getEntriesByName('rosview:seek').map((e) => e.duration));
  seekMs.push(Math.round(entries[entries.length - 1]));
  const frames = await page.evaluate(() => performance.getEntriesByName('rosview:seek:frames').map((e) => e.duration));
  if (frames.length > frameMs.length) frameMs.push(Math.round(frames[frames.length - 1]));
}
if (seekMs.length) {
  const sorted = [...seekMs].sort((a, b) => a - b);
  out.seekMs = seekMs;
  out.seekP50 = sorted[Math.floor(sorted.length * 0.5)];
  out.seekP90 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))];
}
if (frameMs.length) {
  const f = [...frameMs].sort((a, b) => a - b);
  out.framesMs = frameMs;
  out.framesP50 = f[Math.floor(f.length * 0.5)];
  out.framesP90 = f[Math.min(f.length - 1, Math.floor(f.length * 0.9))];
}

if (playSeconds > 0) {
  await page.getByRole('button', { name: 'Play playback' }).click().catch(() => {});
  await page.waitForTimeout(playSeconds * 1000);
}
await cdp.send('HeapProfiler.collectGarbage').catch(() => {});
const heap = await page.evaluate(() => performance.memory?.usedJSHeapSize ?? null);
out.mainHeapMiB = heap == null ? null : +(heap / 2 ** 20).toFixed(0);
out.browserRssMiB = await browserRssMiB();

// Same-tab reopen: leave the viewer and open the same recording again (no page reload).
if (Number(opt('reopen', 1)) > 0) {
  await page.evaluate(() => history.pushState({}, '', '/?url='));
  await page.evaluate(() => window.dispatchEvent(new PopStateEvent('popstate')));
  await page.waitForTimeout(500);
  await fetch(logUrl, { method: 'DELETE' });
  t0 = Date.now();
  await page.evaluate((u) => {
    history.pushState({}, '', u);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, `/?url=${encodeURIComponent(fileUrl)}${suffix}`);
  const reopen = await firstImage(t0);
  out.reopenFirstImageMs = reopen.firstImage;
  const log2 = await (await fetch(logUrl)).json();
  out.reopenRequests = log2.length;
  out.reopenRequestedMiB = +(log2.reduce((s, e) => s + (e.end - e.start + 1), 0) / 2 ** 20).toFixed(1);
}
console.log(JSON.stringify(out));
await browser.close();

/**
 * Static file server with HTTP Range support and a shared bandwidth / latency throttle,
 * for streaming measurements and the expiring-URL tests.
 *
 *   node scripts/throttled-range-server.mjs <dir> [--port 4180 (0: any free port)] [--mbps 20] [--latency-ms 20]
 *
 * Request log: GET /__log returns JSON [{ path, start, end, t0, t1, status }], DELETE /__log clears it.
 * `?exp=<epochMs>` on a data URL answers 403 after that time (simulates an expired presigned URL).
 * Stall: PUT /__stall?from=<byte>&to=<byte>&after=<bytes> makes every request whose range overlaps
 * [from, to] send `after` bytes (default 65536) and then hold the response open until the client
 * gives up; DELETE /__stall ends it (held responses stay held). Logged entries get `stalled: true`.
 * Budget: PUT /__budget?bytes=<n> lets the server deliver n more body bytes in all, then holds
 * every response (mid-body too) until the budget is raised; DELETE /__budget lifts it. GET
 * /__budget returns { remaining, sent }.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const root = path.resolve(args[0] ?? '.');
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : dflt;
};
const port = opt('port', 4180);
const bytesPerMs = (opt('mbps', 20) * 1e6) / 8 / 1000;
const latencyMs = opt('latency-ms', 20);
const SLICE = 16 * 1024;

const log = [];
/** @type {{ from: number, to: number, after: number } | null} */
let stall = null;
let budget = Infinity; // body bytes the server may still send
let sentTotal = 0;
let nextFree = 0; // shared link: serialises slices across connections
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function paced(res, stream, onEnd, limit = Infinity) {
  let sent = 0;
  for await (const buf of stream) {
    for (let o = 0; o < buf.length; ) {
      if (sent >= limit) return; // stalled: hold the response open; the client's close ends it
      while (budget <= 0) {
        // Out of budget: hold the response (mid-body too) until it is raised or the client leaves.
        await sleep(20);
        if (res.destroyed) return onEnd();
      }
      const slice = buf.subarray(o, o + Math.min(SLICE, limit - sent, budget));
      o += slice.length;
      budget -= slice.length;
      sentTotal += slice.length;
      sent += slice.length;
      const now = performance.now();
      nextFree = Math.max(nextFree, now) + slice.length / bytesPerMs;
      const wait = nextFree - now;
      if (wait > 1) await sleep(wait);
      if (res.destroyed) return onEnd();
      if (!res.write(slice)) await new Promise((r) => res.once('drain', r));
    }
  }
  res.end();
  onEnd();
}

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Range');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges');
    if (req.method === 'OPTIONS') return res.writeHead(204).end();
    if (url.pathname === '/__budget') {
      if (req.method === 'DELETE') budget = Infinity;
      else if (req.method === 'PUT') budget = Number(url.searchParams.get('bytes') ?? 0);
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ remaining: Number.isFinite(budget) ? budget : null, sent: sentTotal }));
    }
    if (url.pathname === '/__stall') {
      if (req.method === 'DELETE') stall = null;
      else if (req.method === 'PUT') {
        const n = (k, d) => (url.searchParams.has(k) ? Number(url.searchParams.get(k)) : d);
        stall = { from: n('from', 0), to: n('to', Number.MAX_SAFE_INTEGER), after: n('after', 65536) };
      }
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify(stall));
    }
    if (url.pathname === '/__log') {
      if (req.method === 'DELETE') log.length = 0;
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify(log));
    }
    const file = path.join(root, decodeURIComponent(url.pathname));
    if (!file.startsWith(root) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      return res.writeHead(404).end();
    }
    const exp = url.searchParams.get('exp');
    if (exp && Date.now() > Number(exp)) return res.writeHead(403).end('expired');
    const size = fs.statSync(file).size;
    const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? '');
    let start = 0;
    let end = size - 1;
    let status = 200;
    if (m) {
      status = 206;
      if (m[1] === '') start = Math.max(0, size - Number(m[2]));
      else {
        start = Number(m[1]);
        if (m[2] !== '') end = Math.min(size - 1, Number(m[2]));
      }
      if (start >= size) return res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end();
    }
    const stalled = stall != null && start <= stall.to && end >= stall.from;
    const entry = { path: url.pathname, start, end, t0: Date.now(), t1: 0, status, ...(stalled ? { stalled } : {}) };
    log.push(entry);
    await sleep(latencyMs);
    res.writeHead(status, {
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      'Content-Type': 'application/octet-stream',
      ...(status === 206 ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
    });
    if (req.method === 'HEAD') return res.end();
    req.on('close', () => (entry.t1 ||= Date.now()));
    await paced(
      res,
      fs.createReadStream(file, { start, end, highWaterMark: 256 * 1024 }),
      () => (entry.t1 ||= Date.now()),
      stalled ? stall.after : Infinity,
    );
  })
  .listen(port, '127.0.0.1', function () {
    // `--port 0` picks a free port; the line below names it (tests parse it).
    console.log(`throttled range server on :${this.address().port} (${opt('mbps', 20)} Mbps, ${latencyMs} ms) root=${root}`);
  });

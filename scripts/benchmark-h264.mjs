#!/usr/bin/env node
import { createReadStream } from 'node:fs';
import { stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { chromium } from '@playwright/test';

const DEFAULT_BASE_URL = 'http://127.0.0.1:4173';
const DEFAULT_DURATION_SECONDS = 15;
const SAMPLE_INTERVAL_MS = 200;

function usage() {
  return `Usage:
  npm run benchmark:h264 -- --file /absolute/path/recording.mcap [options]

Options:
  --file <path>       Absolute path to a local MCAP file (required)
  --base-url <url>    Running rosview URL (default: ${DEFAULT_BASE_URL})
  --duration <sec>    Benchmark duration in seconds (default: ${DEFAULT_DURATION_SECONDS})
  --speed <rate>      Playback speed used as load input (default: 1)
  --no-seeks          Disable random seek stress during sampling
  --output <path>     Also write the JSON result to this path
  --help              Show this help
`;
}

function parseArgs(argv) {
  const options = {
    baseUrl: DEFAULT_BASE_URL,
    durationSeconds: DEFAULT_DURATION_SECONDS,
    speed: 1,
    seeks: true,
    file: undefined,
    output: undefined,
    help: false,
  };
  const valueOptions = new Map([
    ['--file', 'file'],
    ['--base-url', 'baseUrl'],
    ['--duration', 'durationSeconds'],
    ['--speed', 'speed'],
    ['--output', 'output'],
  ]);

  for (let index = 2; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      options.help = true;
      continue;
    }
    if (argument === '--no-seeks') {
      options.seeks = false;
      continue;
    }
    const separator = argument.indexOf('=');
    const name = separator >= 0 ? argument.slice(0, separator) : argument;
    const key = valueOptions.get(name);
    if (!key) {
      throw new Error(`Unknown option: ${argument}`);
    }
    const value = separator >= 0 ? argument.slice(separator + 1) : argv[++index];
    if (!value || value.startsWith('--')) {
      throw new Error(`${name} requires a value`);
    }
    options[key] = key === 'durationSeconds' || key === 'speed' ? Number(value) : value;
  }
  return options;
}

async function validateOptions(options) {
  if (!options.file) {
    throw new Error('--file is required');
  }
  if (!path.isAbsolute(options.file)) {
    throw new Error('--file must be an absolute path');
  }
  const fileStat = await stat(options.file).catch(() => undefined);
  if (!fileStat?.isFile()) {
    throw new Error(`--file is not a readable regular file: ${options.file}`);
  }
  if (path.extname(options.file).toLowerCase() !== '.mcap') {
    throw new Error('--file must point to an .mcap file');
  }
  let baseUrl;
  try {
    baseUrl = new URL(options.baseUrl);
  } catch {
    throw new Error(`--base-url is not a valid URL: ${options.baseUrl}`);
  }
  if (!['http:', 'https:'].includes(baseUrl.protocol)) {
    throw new Error('--base-url must use http or https');
  }
  if (!Number.isFinite(options.durationSeconds) || options.durationSeconds < 2) {
    throw new Error('--duration must be a number of at least 2 seconds');
  }
  if (!Number.isFinite(options.speed) || options.speed < 0.1 || options.speed > 8) {
    throw new Error('--speed must be between 0.1 and 8');
  }
  if (options.output) {
    options.output = path.resolve(options.output);
  }
  return { ...options, baseUrl: baseUrl.toString(), fileSize: fileStat.size };
}

function parseRange(rangeHeader, size) {
  if (!rangeHeader) {
    return undefined;
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
  if (!match || (!match[1] && !match[2])) {
    return null;
  }
  let start;
  let end;
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isInteger(suffixLength) || suffixLength <= 0) {
      return null;
    }
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
  }
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    start >= size ||
    end < start
  ) {
    return null;
  }
  return { start, end: Math.min(end, size - 1) };
}

async function startFileServer(file, size) {
  const server = http.createServer((request, response) => {
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'Range');
    response.setHeader('Access-Control-Expose-Headers', 'Accept-Ranges, Content-Length, Content-Range');
    response.setHeader('Accept-Ranges', 'bytes');
    response.setHeader('Cache-Control', 'no-store');

    if (request.method === 'OPTIONS') {
      response.writeHead(204);
      response.end();
      return;
    }
    if (request.url !== '/recording.mcap' || !['GET', 'HEAD'].includes(request.method ?? '')) {
      response.writeHead(404);
      response.end();
      return;
    }

    const range = parseRange(request.headers.range, size);
    if (range === null) {
      response.setHeader('Content-Range', `bytes */${size}`);
      response.writeHead(416);
      response.end();
      return;
    }
    const start = range?.start ?? 0;
    const end = range?.end ?? size - 1;
    const contentLength = end - start + 1;
    response.setHeader('Content-Type', 'application/octet-stream');
    response.setHeader('Content-Length', contentLength);
    if (range) {
      response.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
      response.writeHead(206);
    } else {
      response.writeHead(200);
    }
    if (request.method === 'HEAD') {
      response.end();
      return;
    }
    const stream = createReadStream(file, { start, end });
    stream.on('error', (error) => response.destroy(error));
    stream.pipe(response);
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Could not determine benchmark file server address');
  }
  return {
    server,
    url: `http://127.0.0.1:${address.port}/recording.mcap`,
  };
}

async function closeServer(server) {
  if (!server) {
    return;
  }
  await new Promise((resolve) => server.close(resolve));
}

async function readHeap(page) {
  return page.evaluate(() => {
    const memory = performance.memory;
    return memory && Number.isFinite(memory.usedJSHeapSize) ? memory.usedJSHeapSize : null;
  });
}

async function readProgress(fill) {
  return fill.evaluate((element) => {
    const value = Number.parseFloat(element.style.width);
    return Number.isFinite(value) ? value : null;
  });
}

async function readImagePanels(page) {
  const panels = page.getByTestId('image-panel');
  return panels.evaluateAll((elements) => elements.map((element) => {
    const numberAttribute = (name) => {
      const value = element.getAttribute(name);
      if (value === null) return null;
      const number = Number(value);
      return Number.isFinite(number) ? number : null;
    };
    return {
      pressure: element.getAttribute('data-h264-pressure'),
      queueFrames: numberAttribute('data-h264-queue-frames'),
      droppedFrames: numberAttribute('data-h264-dropped-frames'),
      decodeQueueSize: numberAttribute('data-h264-decode-queue'),
      mediaLagMs: numberAttribute('data-h264-media-lag-ms'),
      resyncCount: numberAttribute('data-h264-resync-count'),
      renderedFrames: numberAttribute('data-h264-rendered-frames'),
    };
  }));
}

function summarizeProgress(samples) {
  const widths = samples.map(({ width }) => width).filter((value) => value !== null);
  let updateCount = 0;
  let forwardUpdateCount = 0;
  let longestStallSamples = 0;
  let currentStallSamples = 0;
  for (let index = 1; index < widths.length; index += 1) {
    const delta = widths[index] - widths[index - 1];
    if (Math.abs(delta) >= 0.05) {
      updateCount += 1;
      currentStallSamples = 0;
    } else {
      currentStallSamples += 1;
      longestStallSamples = Math.max(longestStallSamples, currentStallSamples);
    }
    if (delta >= 0.05) {
      forwardUpdateCount += 1;
    }
  }
  return {
    sampleCount: widths.length,
    updateCount,
    forwardUpdateCount,
    updateRatio: widths.length > 1 ? updateCount / (widths.length - 1) : 0,
    minPercent: widths.length > 0 ? Math.min(...widths) : null,
    maxPercent: widths.length > 0 ? Math.max(...widths) : null,
    longestStallMs: longestStallSamples * SAMPLE_INTERVAL_MS,
  };
}

async function runBenchmark(options, fixtureUrl) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const pageErrors = [];
    const consoleErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });

    const benchmarkUrl = new URL(options.baseUrl);
    benchmarkUrl.searchParams.set('url', fixtureUrl);
    const startedAt = Date.now();
    await page.goto(benchmarkUrl.toString(), { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page
      .locator('#rosview-root[data-player-presence="ready"]')
      .waitFor({ state: 'visible', timeout: 90_000 });
    const play = page.getByRole('button', { name: 'Play playback' });
    await play.waitFor({ state: 'visible', timeout: 30_000 });
    if (options.speed !== 1) {
      await page.getByTestId('playback-speed-trigger').click();
      await page.getByRole('menuitem', { name: `${options.speed}x`, exact: true }).click();
    }
    await play.click();

    const fill = page.getByTestId('playback-progress-fill');
    const track = page.getByTestId('playback-track');
    await fill.waitFor({ state: 'visible' });
    const samples = [];
    const imageSamples = [];
    const heapSamples = [];
    const seeks = [];
    const durationMs = options.durationSeconds * 1_000;
    const seekTimes = options.seeks
      ? [0.35, 0.6, 0.82].map((ratio) => durationMs * ratio)
      : [];
    let nextSeek = 0;
    const samplingStartedAt = Date.now();

    while (Date.now() - samplingStartedAt < durationMs) {
      const elapsedMs = Date.now() - samplingStartedAt;
      if (nextSeek < seekTimes.length && elapsedMs >= seekTimes[nextSeek]) {
        const targetRatio = 0.1 + Math.random() * 0.8;
        const box = await track.boundingBox();
        if (box && box.width > 10 && box.height > 0) {
          await track.click({
            position: {
              x: Math.max(1, Math.min(box.width - 1, box.width * targetRatio)),
              y: box.height / 2,
            },
          });
          seeks.push({ elapsedMs, targetRatio });
        }
        nextSeek += 1;
      }

      const resume = page.getByRole('button', { name: 'Play playback' });
      if (await resume.isVisible().catch(() => false)) {
        await resume.click();
      }
      samples.push({ elapsedMs, width: await readProgress(fill) });
      const panels = await readImagePanels(page);
      if (panels.length > 0) imageSamples.push({ elapsedMs, panels });
      const heapBytes = await readHeap(page);
      if (heapBytes !== null) heapSamples.push({ elapsedMs, bytes: heapBytes });
      await page.waitForTimeout(SAMPLE_INTERVAL_MS);
    }

    const decodeErrorTexts = await page
      .getByText(/decode failed|could not be decoded/i)
      .allTextContents()
      .catch(() => []);
    const statusTexts = await page.getByTestId('image-panel-status').allTextContents().catch(() => []);
    const heapValues = heapSamples.map(({ bytes }) => bytes);
    const latestImage = imageSamples.at(-1) ?? null;
    const latestPanels = latestImage?.panels ?? [];
    const metricsReasonable =
      latestPanels.every((panel) =>
        ['normal', 'degraded', 'recovery'].includes(panel.pressure) &&
        Number.isInteger(panel.queueFrames) &&
        panel.queueFrames >= 0 &&
        Number.isInteger(panel.droppedFrames) &&
        panel.droppedFrames >= 0 &&
        Number.isInteger(panel.decodeQueueSize) &&
        panel.decodeQueueSize >= 0 &&
        Number.isFinite(panel.mediaLagMs) &&
        panel.mediaLagMs >= 0 &&
        Number.isInteger(panel.resyncCount) &&
        panel.resyncCount >= 0 &&
        Number.isInteger(panel.renderedFrames) &&
        panel.renderedFrames >= 0
      );

    return {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      input: {
        file: options.file,
        fileBytes: options.fileSize,
        baseUrl: options.baseUrl,
        durationSeconds: options.durationSeconds,
        speed: options.speed,
      },
      environment: {
        platform: process.platform,
        arch: process.arch,
        node: process.version,
        browserVersion: browser.version(),
      },
      timing: {
        readyAndPlayMs: samplingStartedAt - startedAt,
        sampledMs: Date.now() - samplingStartedAt,
      },
      progress: {
        ...summarizeProgress(samples),
        samples,
      },
      seeks,
      image: {
        appeared: imageSamples.length > 0,
        statusTexts,
        metricsReasonable,
        latestMetrics: latestImage,
        samples: imageSamples,
        decodeErrors: decodeErrorTexts,
      },
      heap:
        heapValues.length > 0
          ? {
              available: true,
              initialBytes: heapValues[0],
              finalBytes: heapValues.at(-1),
              maxBytes: Math.max(...heapValues),
              deltaBytes: heapValues.at(-1) - heapValues[0],
              samples: heapSamples,
            }
          : { available: false },
      errors: {
        page: pageErrors,
        console: consoleErrors,
      },
    };
  } finally {
    await browser.close();
  }
}

async function main() {
  let fileServer;
  try {
    const parsed = parseArgs(process.argv);
    if (parsed.help) {
      process.stdout.write(usage());
      return;
    }
    const options = await validateOptions(parsed);
    const startedServer = await startFileServer(options.file, options.fileSize);
    fileServer = startedServer.server;
    const result = await runBenchmark(options, startedServer.url);
    const json = `${JSON.stringify(result, null, 2)}\n`;
    if (options.output) {
      await writeFile(options.output, json, 'utf8');
    }
    process.stdout.write(json);
  } finally {
    await closeServer(fileServer);
  }
}

main().catch((error) => {
  process.stderr.write(`benchmark:h264: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

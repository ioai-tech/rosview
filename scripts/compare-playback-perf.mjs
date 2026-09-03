#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const DEFAULT_THRESHOLD = 0.1;
/** Ignore sub-frame E2E noise on tiny absolute timings. */
const ABSOLUTE_SLACK_MS = 75;
const LOWER_IS_BETTER = new Set(['readyMs', 'playAdvanceMs', 'seekAdvanceMs', 'bufferingStuckMs']);
const HIGHER_IS_BETTER = new Set(['progressDelta1s']);

function parseArgs(argv) {
  const args = {
    baseline: 'tmp/playback-perf/baseline.json',
    current: 'tmp/playback-perf/latest.json',
    threshold: DEFAULT_THRESHOLD,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const cur = argv[i];
    if (cur === '--baseline' && i + 1 < argv.length) {
      args.baseline = argv[++i];
    } else if (cur === '--current' && i + 1 < argv.length) {
      args.current = argv[++i];
    } else if (cur === '--threshold' && i + 1 < argv.length) {
      args.threshold = Number(argv[++i]);
    }
  }
  if (!Number.isFinite(args.threshold) || args.threshold <= 0) {
    throw new Error('--threshold must be a positive number');
  }
  return args;
}

function readReport(filePath) {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`perf report not found: ${resolved}`);
  }
  return JSON.parse(fs.readFileSync(resolved, 'utf8'));
}

function indexById(report) {
  const map = new Map();
  for (const fixture of report.fixtures ?? []) {
    map.set(fixture.id, fixture);
  }
  return map;
}

function relativeDelta(baseline, current) {
  if (baseline === 0) {
    return current === 0 ? 0 : Number.POSITIVE_INFINITY;
  }
  return (current - baseline) / baseline;
}

function main() {
  const args = parseArgs(process.argv);
  const baseline = readReport(args.baseline);
  const current = readReport(args.current);
  const baselineById = indexById(baseline);
  const currentById = indexById(current);
  const regressions = [];

  console.log(`[perf:compare] baseline=${path.resolve(args.baseline)}`);
  console.log(`[perf:compare] current=${path.resolve(args.current)}`);
  console.log(`[perf:compare] threshold=${(args.threshold * 100).toFixed(1)}%`);

  for (const [id, before] of baselineById) {
    const after = currentById.get(id);
    if (!after) {
      regressions.push(`${id}: missing from current report`);
      continue;
    }
    for (const metric of [...LOWER_IS_BETTER, ...HIGHER_IS_BETTER]) {
      const baselineValue = Number(before[metric]);
      const currentValue = Number(after[metric]);
      if (!Number.isFinite(baselineValue) || !Number.isFinite(currentValue)) {
        continue;
      }
      if (metric === 'progressDelta1s' && (baselineValue < 1 || currentValue < 1)) {
        // Short/looping fixtures can wrap the playhead inside the 1s sample.
        continue;
      }
      const delta = relativeDelta(baselineValue, currentValue);
      const absolute = Math.abs(currentValue - baselineValue);
      const relativeWorse = LOWER_IS_BETTER.has(metric)
        ? delta > args.threshold
        : delta < -args.threshold;
      const worse = relativeWorse && (HIGHER_IS_BETTER.has(metric) || absolute > ABSOLUTE_SLACK_MS);
      const sign = delta >= 0 ? '+' : '';
      console.log(
        `- ${id}.${metric}: ${baselineValue.toFixed(1)} -> ${currentValue.toFixed(1)} (${sign}${(delta * 100).toFixed(1)}%)${worse ? ' REGRESSION' : ''}`,
      );
      if (worse) {
        regressions.push(
          `${id}.${metric}: ${baselineValue.toFixed(1)} -> ${currentValue.toFixed(1)} (${sign}${(delta * 100).toFixed(1)}%)`,
        );
      }
    }
  }

  if (regressions.length > 0) {
    console.error('\n[perf:compare] regressions over threshold:');
    for (const line of regressions) {
      console.error(`  - ${line}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log('\n[perf:compare] all compared metrics stayed within the threshold');
}

try {
  main();
} catch (error) {
  console.error(`[perf:compare] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

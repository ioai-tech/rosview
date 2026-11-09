/**
 * Generate all Playwright E2E fixtures into public/examples/.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @param {string} script */
function runNode(script) {
  const scriptPath = path.join(__dirname, script);
  const result = spawnSync(process.execPath, [scriptPath], { stdio: 'inherit' });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

/** @param {string} script */
function runPython(script) {
  const scriptPath = path.join(__dirname, script);
  const result = spawnSync('python3', [scriptPath], { stdio: 'inherit' });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

runNode('gen-test-mcap.mjs');
runNode('gen-test-mcap-pose.mjs');
runNode('gen-test-mcap-3cam.mjs');
runNode('gen-test-mcap-h264.mjs');
runNode('gen-test-mcap-compressed-depth.mjs');
runNode('gen-test-mcap-whole-body.mjs');
runPython('gen-test-hdf5.py');
runNode('gen-test-bvh.mjs');

// Multi-source merge fixtures.
runNode('gen-test-mcap-multi-base.mjs');
runNode('gen-test-mcap-multi-incremental.mjs');
// Uses the local-only `mcap` CLI; self-skips (exit 0, no output file) when
// it isn't on PATH, which is always the case in CI by design (see
// .github/workflows/ci.yml) — the Playwright spec that depends on this
// fixture skips itself in turn.
runNode('gen-test-mcap-filtered.mjs');
// Copies the committed test-fixtures/media/minimal-multi.bag; only needs
// the `rosbags` Python package to *regenerate* that committed source.
runPython('gen-test-bag.py');

console.log('[gen-e2e-fixtures] all fixtures ready');

/**
 * Dependency audit gate — the CI-facing wrapper around `npm audit`.
 *
 * Usage: node scripts/check-audit.mjs   (or: npm run check:audit)
 *
 * Fails on high/critical advisories. Advisories that have no non-breaking fix
 * are waived the way `SECURITY.md` prescribes: the advisory id (GHSA-…) is
 * documented in the "Dependency vulnerabilities" section there, and this gate
 * treats that section as the single source of truth. A vulnerability that is
 * only reachable through a waived one (the usual `via` chain) is covered by the
 * same waiver; anything else blocks.
 *
 * This replaces `npm audit --audit-level=high`, which cannot express "this one
 * has no fix yet" and therefore stays red forever once such an advisory lands,
 * hiding every later finding behind a permanently failing step.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SECURITY_POLICY = path.join(ROOT, 'SECURITY.md');
const WAIVER_SECTION = '## Dependency vulnerabilities';

/** Severities that fail the gate. */
const BLOCKING = new Set(['high', 'critical']);

/** GHSA ids documented in SECURITY.md. */
function readWaivers() {
  const md = fs.readFileSync(SECURITY_POLICY, 'utf8');
  const start = md.indexOf(WAIVER_SECTION);
  if (start === -1) {
    throw new Error(`"${WAIVER_SECTION}" section not found in SECURITY.md`);
  }
  const end = md.indexOf('\n## ', start + WAIVER_SECTION.length);
  const section = md.slice(start, end === -1 ? undefined : end);
  return new Set((section.match(/GHSA-[0-9a-z-]+/gi) ?? []).map((id) => id.toUpperCase()));
}

/** Advisory key of a `via` entry: the GHSA id, or null when there is none. */
function advisoryId(viaEntry) {
  const url = typeof viaEntry === 'object' ? viaEntry.url ?? '' : '';
  return url.match(/GHSA-[0-9a-z-]+/i)?.[0].toUpperCase() ?? null;
}

function runAudit() {
  try {
    return JSON.parse(execFileSync('npm', ['audit', '--json'], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    }));
  } catch (err) {
    // npm exits non-zero when it finds anything; the report is still on stdout.
    if (err.stdout) return JSON.parse(err.stdout);
    throw err;
  }
}

const waivers = readWaivers();
const audit = runAudit();
const vulnerabilities = audit.vulnerabilities ?? {};
const names = Object.keys(vulnerabilities);

// A node is waived when every advisory it carries is waived and every `via`
// chain it depends on is itself waived. Fixed point: resolve nodes whose fate
// is already known, repeat until nothing changes.
const waived = new Map(names.map((n) => [n, false]));
const blocked = new Set(names);
for (let pass = 0; pass <= names.length && blocked.size > 0; pass++) {
  for (const name of [...blocked]) {
    const via = vulnerabilities[name].via ?? [];
    const resolved = via.length > 0 && via.every((entry) => {
      if (typeof entry === 'string') return waived.get(entry) === true;
      const id = advisoryId(entry);
      return id !== null && waivers.has(id);
    });
    if (resolved) {
      waived.set(name, true);
      blocked.delete(name);
    }
  }
}

const reportable = names.filter((n) => BLOCKING.has(vulnerabilities[n].severity));
const failing = reportable.filter((n) => !waived.get(n));

console.log(`npm audit: ${names.length} advisories, ${reportable.length} at ${[...BLOCKING].join('/')} level`);
for (const name of reportable) {
  const node = vulnerabilities[name];
  const advisories = node.via
    .filter((v) => typeof v === 'object')
    .map((v) => `  ${advisoryId(v) ?? v.url}  ${v.title}`);
  console.log(`\n${waived.get(name) ? 'WAIVED' : 'BLOCKING'}  ${name}@${node.range} (${node.severity})`);
  for (const line of advisories) console.log(line);
  console.log(`  fix: ${JSON.stringify(node.fixAvailable)}`);
}

// Stale waivers are noise: they hide future findings under an id that no
// longer matches anything. Surface them, do not fail the build over them.
const used = new Set(
  names
    .flatMap((n) => vulnerabilities[n].via ?? [])
    .filter((v) => typeof v === 'object')
    .map(advisoryId)
    .filter(Boolean),
);
for (const id of waivers) {
  if (!used.has(id)) console.warn(`\nwarning: waiver ${id} in SECURITY.md matches no advisory — remove it`);
}

if (failing.length > 0) {
  console.error(
    `\n${failing.length} blocking advisories. Fix them (upgrade / narrow override), or waive in ` +
      `SECURITY.md "${WAIVER_SECTION}" when there is no non-breaking fix.`,
  );
  process.exit(1);
}
console.log('\nok: no blocking advisories.');

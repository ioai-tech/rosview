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
import { advisoryId, evaluateAudit, parseAuditReport, waivedInProduction } from './audit-waivers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SECURITY_POLICY = path.join(ROOT, 'SECURITY.md');
const WAIVER_SECTION = '## Dependency vulnerabilities';

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

/** `npm audit --json` (optionally production only). The report is on stdout even when npm exits 1. */
function runAudit(extraArgs = []) {
  let text;
  try {
    text = execFileSync('npm', ['audit', '--json', ...extraArgs], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    text = err.stdout ?? '';
  }
  return parseAuditReport(text);
}

function main() {
  const waivers = readWaivers();
  const audit = runAudit();
  const vulnerabilities = audit.vulnerabilities;
  const names = Object.keys(vulnerabilities);
  const verdict = evaluateAudit(vulnerabilities, waivers);
  const reportable = names.filter((n) => verdict.get(n).blocking);
  const failing = reportable.filter((n) => verdict.get(n).failing);

  // A waiver covers the toolchain only: none of its advisories may reach the production graph.
  const production = runAudit(['--omit=dev']);
  const leaked = waivedInProduction(production.vulnerabilities, waivers);

  console.log(`npm audit: ${names.length} advisories, ${reportable.length} blocking`);
  for (const name of reportable) {
    const node = vulnerabilities[name];
    const advisories = (node.via ?? [])
      .filter((v) => typeof v === 'object')
      .map((v) => `  ${advisoryId(v) ?? v.url}  ${v.title}`);
    console.log(`\n${verdict.get(name).waived ? 'WAIVED' : 'BLOCKING'}  ${name}@${node.range} (${node.severity})`);
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

  if (leaked.length > 0) {
    console.error(`\nwaived advisory ${leaked.join(', ')} reaches the production graph; a waiver must stay toolchain-only.`);
    process.exit(1);
  }
  if (failing.length > 0) {
    console.error(
      `\n${failing.length} blocking advisories. Fix them (upgrade / narrow override), or waive in ` +
        `SECURITY.md "${WAIVER_SECTION}" when there is no non-breaking fix.`,
    );
    process.exit(1);
  }
  console.log('\nok: no blocking advisories.');
}

try {
  main();
} catch (err) {
  console.error(`check-audit failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

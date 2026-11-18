/**
 * Waiver and severity logic for `check-audit.mjs`, kept pure so it can be unit tested.
 */

/** Severities that never block. Anything else (high, critical, unknown, missing) does. */
const NON_BLOCKING = new Set(['info', 'low', 'moderate']);

export function isBlockingSeverity(severity) {
  return !NON_BLOCKING.has(String(severity ?? '').toLowerCase());
}

/** Advisory key of a `via` entry: the GHSA id, or null when there is none. */
export function advisoryId(viaEntry) {
  const url = typeof viaEntry === 'object' ? viaEntry.url ?? '' : '';
  return url.match(/GHSA-[0-9a-z-]+/i)?.[0].toUpperCase() ?? null;
}

/**
 * Parses `npm audit --json` output. A failed audit (registry unreachable, `{"error": ...}`, no
 * output, not an audit report) throws: it must never read as "zero advisories".
 */
export function parseAuditReport(text) {
  let report;
  try {
    report = JSON.parse(text);
  } catch {
    throw new Error('npm audit did not produce JSON (registry unreachable or npm failed)');
  }
  if (report == null || typeof report !== 'object') throw new Error('npm audit output is not a report');
  if (report.error) {
    throw new Error(`npm audit failed: ${report.error.summary ?? report.error.code ?? JSON.stringify(report.error)}`);
  }
  if (typeof report.vulnerabilities !== 'object' || report.vulnerabilities === null || report.metadata == null) {
    throw new Error('npm audit output has no vulnerability data (not an audit report)');
  }
  return report;
}

/** Advisories reachable from a node through `via`, including through dependency cycles. */
function reachableAdvisories(vulnerabilities, start) {
  const seen = new Set();
  const advisories = [];
  const stack = [start];
  while (stack.length > 0) {
    const name = stack.pop();
    if (seen.has(name)) continue;
    seen.add(name);
    for (const entry of vulnerabilities[name]?.via ?? []) {
      if (typeof entry === 'string') stack.push(entry);
      else advisories.push({ id: advisoryId(entry), severity: entry.severity });
    }
  }
  return advisories;
}

/**
 * Decides every package. A package blocks when its own severity or any advisory under it is
 * blocking (high, critical, unknown, missing). It is waived only when it reaches at least one
 * waived blocking advisory and no unwaived advisory of any severity; a dependency cycle is
 * therefore waived only when every advisory reachable in it is.
 *
 * @param {Record<string, {severity?: string, via?: Array<string | {url?: string, severity?: string}>}>} vulnerabilities
 * @param {Set<string>} waivers upper-case GHSA ids
 * @returns {Map<string, {blocking: boolean, waived: boolean, failing: boolean}>}
 */
export function evaluateAudit(vulnerabilities, waivers) {
  const result = new Map();
  for (const name of Object.keys(vulnerabilities)) {
    const reach = reachableAdvisories(vulnerabilities, name);
    const isWaived = (a) => a.id !== null && waivers.has(a.id);
    const unwaived = reach.some((a) => !isWaived(a));
    const waivedBlocking = reach.some((a) => isWaived(a) && isBlockingSeverity(a.severity));
    const blocking = isBlockingSeverity(vulnerabilities[name].severity) || reach.some((a) => isBlockingSeverity(a.severity));
    const waived = !unwaived && waivedBlocking;
    result.set(name, { blocking, waived, failing: blocking && !waived });
  }
  return result;
}

/** Waived advisory ids that appear in the production dependency graph (`npm audit --omit=dev`). */
export function waivedInProduction(productionVulnerabilities, waivers) {
  const found = new Set();
  for (const node of Object.values(productionVulnerabilities)) {
    for (const entry of node.via ?? []) {
      const id = typeof entry === 'string' ? null : advisoryId(entry);
      if (id && waivers.has(id)) found.add(id);
    }
  }
  return [...found];
}

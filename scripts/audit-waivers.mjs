/**
 * Waiver resolution for `check-audit.mjs`, kept pure so it can be unit tested.
 */

/** Advisory key of a `via` entry: the GHSA id, or null when there is none. */
export function advisoryId(viaEntry) {
  const url = typeof viaEntry === 'object' ? viaEntry.url ?? '' : '';
  return url.match(/GHSA-[0-9a-z-]+/i)?.[0].toUpperCase() ?? null;
}

/**
 * A node is waived when every advisory it carries is waived and every `via` node it depends on
 * is itself waived. npm reports dependency cycles (vitest <-> @vitest/coverage-v8), so this is a
 * greatest fixed point: assume every node is waived, then un-waive any node with an unwaived
 * advisory or an unwaived `via` node until nothing changes. A cycle therefore counts as waived
 * only when every advisory reachable inside it is waived.
 *
 * @param {Record<string, {via?: Array<string | {url?: string}>}>} vulnerabilities `npm audit --json` `vulnerabilities`
 * @param {Set<string>} waivers upper-case GHSA ids
 * @returns {Map<string, boolean>}
 */
export function resolveWaived(vulnerabilities, waivers) {
  const names = Object.keys(vulnerabilities);
  const waived = new Map(names.map((n) => [n, true]));
  for (let changed = true; changed; ) {
    changed = false;
    for (const name of names) {
      if (!waived.get(name)) continue;
      const via = vulnerabilities[name].via ?? [];
      const ok =
        via.length > 0 &&
        via.every((entry) => {
          if (typeof entry === 'string') return waived.get(entry) === true;
          const id = advisoryId(entry);
          return id !== null && waivers.has(id);
        });
      if (!ok) {
        waived.set(name, false);
        changed = true;
      }
    }
  }
  return waived;
}

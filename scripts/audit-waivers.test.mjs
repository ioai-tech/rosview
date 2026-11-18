import { describe, expect, it } from 'vitest';
import { evaluateAudit, isBlockingSeverity, parseAuditReport, waivedInProduction } from './audit-waivers.mjs';

const adv = (id, severity = 'high') => ({ url: `https://github.com/advisories/${id}`, severity });
const waivers = new Set(['GHSA-AAAA-AAAA-AAAA']);
const verdict = (v) => Object.fromEntries([...evaluateAudit(v, waivers)].map(([k, x]) => [k, x.failing ? 'fail' : x.waived ? 'waived' : 'ok']));

describe('parseAuditReport', () => {
  it('rejects output that is not a real audit report', () => {
    expect(() => parseAuditReport('')).toThrow(/did not produce JSON/);
    expect(() => parseAuditReport('<html>')).toThrow(/did not produce JSON/);
    expect(() => parseAuditReport('{"error":{"code":"ENOTFOUND","summary":"request failed"}}')).toThrow(/audit failed/);
    expect(() => parseAuditReport('{}')).toThrow(/no vulnerability data/);
    expect(() => parseAuditReport('{"vulnerabilities":{}}')).toThrow(/no vulnerability data/); // no metadata
  });
  it('accepts a clean report with no vulnerabilities', () => {
    expect(parseAuditReport('{"vulnerabilities":{},"metadata":{"vulnerabilities":{"total":0}}}').vulnerabilities).toEqual({});
  });
});

describe('severity', () => {
  it('only info, low and moderate are non-blocking; unknown and missing block', () => {
    for (const s of ['info', 'low', 'moderate']) expect(isBlockingSeverity(s)).toBe(false);
    for (const s of ['high', 'critical', 'unknown', undefined, '']) expect(isBlockingSeverity(s)).toBe(true);
  });

  it('blocks a low package that carries a critical, unwaived advisory', () => {
    expect(verdict({ pkg: { severity: 'low', via: [adv('GHSA-CCCC-CCCC-CCCC', 'critical')] } })).toEqual({ pkg: 'fail' });
  });

  it('blocks an advisory with unknown or missing severity', () => {
    expect(verdict({ pkg: { severity: 'moderate', via: [adv('GHSA-DDDD-DDDD-DDDD', 'unknown')] } })).toEqual({ pkg: 'fail' });
    expect(verdict({ pkg: { severity: 'moderate', via: [{ url: 'https://github.com/advisories/GHSA-EEEE-EEEE-EEEE' }] } })).toEqual({ pkg: 'fail' });
  });

  it('lets a moderate-only package through', () => {
    expect(verdict({ pkg: { severity: 'moderate', via: [adv('GHSA-FFFF-FFFF-FFFF', 'moderate')] } })).toEqual({ pkg: 'ok' });
  });
});

describe('waivers', () => {
  it('waives a chain whose only advisory is a waived blocking one', () => {
    expect(
      verdict({ picomatch: { severity: 'high', via: [adv('GHSA-AAAA-AAAA-AAAA')] }, vite: { severity: 'high', via: ['picomatch'] } }),
    ).toEqual({ picomatch: 'waived', vite: 'waived' });
  });

  it('waives a dependency cycle only when every advisory in it is waived', () => {
    expect(
      verdict({
        picomatch: { severity: 'high', via: [adv('GHSA-AAAA-AAAA-AAAA')] },
        vitest: { severity: 'high', via: ['@vitest/coverage-v8', 'picomatch'] },
        '@vitest/coverage-v8': { severity: 'high', via: ['vitest'] },
      }),
    ).toEqual({ picomatch: 'waived', vitest: 'waived', '@vitest/coverage-v8': 'waived' });
  });

  it('an unwaived advisory still fails, including through a cycle and when it is only moderate', () => {
    const v = {
      picomatch: { severity: 'high', via: [adv('GHSA-AAAA-AAAA-AAAA')] },
      other: { severity: 'moderate', via: [adv('GHSA-BBBB-BBBB-BBBB', 'moderate')] },
      vitest: { severity: 'high', via: ['@vitest/coverage-v8', 'picomatch'] },
      '@vitest/coverage-v8': { severity: 'high', via: ['vitest', 'other'] },
    };
    expect(verdict(v)).toEqual({ picomatch: 'waived', other: 'ok', vitest: 'fail', '@vitest/coverage-v8': 'fail' });
  });

  it('a package that reaches no waived blocking advisory is not waived', () => {
    expect(verdict({ lonely: { severity: 'high', via: [] } })).toEqual({ lonely: 'fail' });
    // only a waived *moderate* advisory: nothing blocking is waived, but nothing blocks either
    const w = new Set(['GHSA-GGGG-GGGG-GGGG']);
    const r = evaluateAudit({ pkg: { severity: 'high', via: [adv('GHSA-GGGG-GGGG-GGGG', 'moderate')] } }, w).get('pkg');
    expect(r.waived).toBe(false);
    expect(r.failing).toBe(true); // package severity is high but no waived blocking advisory covers it
  });
});

describe('waivedInProduction', () => {
  it('reports a waived advisory that appears in the production graph', () => {
    expect(waivedInProduction({ picomatch: { via: [adv('GHSA-AAAA-AAAA-AAAA')] } }, waivers)).toEqual(['GHSA-AAAA-AAAA-AAAA']);
  });
  it('ignores unwaived advisories and an empty production graph', () => {
    expect(waivedInProduction({ x: { via: [adv('GHSA-BBBB-BBBB-BBBB')] } }, waivers)).toEqual([]);
    expect(waivedInProduction({}, waivers)).toEqual([]);
  });
});

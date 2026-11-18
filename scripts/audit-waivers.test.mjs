import { describe, expect, it } from 'vitest';
import { resolveWaived } from './audit-waivers.mjs';

const adv = (id) => ({ url: `https://github.com/advisories/${id}` });
const waivers = new Set(['GHSA-AAAA-AAAA-AAAA']);

describe('resolveWaived', () => {
  it('waives a chain whose only advisory is waived', () => {
    const v = {
      picomatch: { via: [adv('GHSA-AAAA-AAAA-AAAA')] },
      vite: { via: ['picomatch'] },
    };
    expect([...resolveWaived(v, waivers)]).toEqual([['picomatch', true], ['vite', true]]);
  });

  it('waives a dependency cycle only when every advisory in it is waived', () => {
    const v = {
      picomatch: { via: [adv('GHSA-AAAA-AAAA-AAAA')] },
      vitest: { via: ['@vitest/coverage-v8', 'picomatch'] },
      '@vitest/coverage-v8': { via: ['vitest'] },
    };
    const waived = resolveWaived(v, waivers);
    expect(waived.get('vitest')).toBe(true);
    expect(waived.get('@vitest/coverage-v8')).toBe(true);
  });

  it('an unwaived advisory still fails, including through a cycle', () => {
    const v = {
      picomatch: { via: [adv('GHSA-AAAA-AAAA-AAAA')] },
      other: { via: [adv('GHSA-BBBB-BBBB-BBBB')] },
      vitest: { via: ['@vitest/coverage-v8', 'picomatch'] },
      '@vitest/coverage-v8': { via: ['vitest', 'other'] },
    };
    const waived = resolveWaived(v, waivers);
    expect(waived.get('other')).toBe(false);
    expect(waived.get('@vitest/coverage-v8')).toBe(false);
    expect(waived.get('vitest')).toBe(false); // reaches the unwaived advisory through the cycle
    expect(waived.get('picomatch')).toBe(true);
  });

  it('a node without advisories or a via chain is not waived', () => {
    expect(resolveWaived({ lonely: { via: [] } }, waivers).get('lonely')).toBe(false);
  });
});

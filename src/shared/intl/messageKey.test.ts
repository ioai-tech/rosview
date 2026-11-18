import { describe, expect, it } from 'vitest';
import { getRosViewMessages, type RosViewMessageKey } from './loadRosViewMessages';

describe('RosViewMessageKey', () => {
  it('is a literal union (a typo is a type error) and overrides apply to known ids only', () => {
    // @ts-expect-error not a catalog id: `string` would have accepted it
    const typo: RosViewMessageKey = 'layout.viewerRegionn';
    expect(typo).toBeTruthy();
    const key: RosViewMessageKey = 'layout.viewerRegion';
    expect(getRosViewMessages('en', { [key]: 'Custom' })[key]).toBe('Custom');
    expect(getRosViewMessages('en', { 'no.such.id': 'x' } as never)['no.such.id']).toBeUndefined();
  });
});

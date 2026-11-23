import { describe, expect, it } from 'vitest';
import { getRosViewMessages } from './loadRosViewMessages';

/**
 * Panel toolbars are on screen whenever a panel is; a label left in English there is what a zh / ja
 * user sees first (walk finding m-7: the Plot field chips "Position / Velocity / Effort").
 */
describe('panel toolbar copy', () => {
  const en = getRosViewMessages('en');
  const toolbarIds = Object.keys(en).filter((id) => id.includes('.toolbar.'));

  it('covers the Plot joint-field chips', () => {
    expect(toolbarIds).toEqual(
      expect.arrayContaining([
        'panels.jointStatePlot.toolbar.field.position',
        'panels.jointStatePlot.toolbar.field.velocity',
        'panels.jointStatePlot.toolbar.field.effort',
      ]),
    );
  });

  it.each(['zh', 'ja'] as const)('is translated in %s', (locale) => {
    const messages = getRosViewMessages(locale);
    const untranslated = toolbarIds.filter((id) => /[A-Za-z]{3,}/.test(en[id]) && messages[id] === en[id]);
    expect(untranslated).toEqual([]);
  });
});

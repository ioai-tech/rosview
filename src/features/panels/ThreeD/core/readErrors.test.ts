import { describe, expect, it } from 'vitest';
import { createRosViewIntl } from '@/shared/intl/createRosViewIntl';
import { readErrorLines } from './readErrors';

describe('3D panel read errors', () => {
  it("lists the panel's topics that could not be read, once each, in the UI language", () => {
    const reason = 'No data arrived from the server for 20 s';
    const errors = { '/scene/map': reason, '/other/panel': 'x' };
    expect(readErrorLines(errors, ['/tf', '/scene/map', '/scene/map'], createRosViewIntl('en').formatMessage)).toEqual([
      `Could not read /scene/map: ${reason}`,
    ]);
    expect(readErrorLines(errors, ['/scene/map'], createRosViewIntl('zh').formatMessage)).toEqual([
      `无法读取 /scene/map：${reason}`,
    ]);
    expect(readErrorLines(undefined, ['/scene/map'], createRosViewIntl('en').formatMessage)).toEqual([]);
  });
});

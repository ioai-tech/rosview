import { describe, expect, it } from 'vitest';
import { resolveEmbedChrome } from './embedChrome';

describe('resolveEmbedChrome', () => {
  it('defaults viewer mode to full chrome', () => {
    expect(resolveEmbedChrome({ mode: 'viewer' })).toEqual({
      showNavbar: true,
      showSidebar: true,
      showPlaybackBar: true,
    });
  });

  it('defaults tool mode to panels-only', () => {
    expect(resolveEmbedChrome({ mode: 'tool' })).toEqual({
      showNavbar: false,
      showSidebar: false,
      showPlaybackBar: false,
    });
  });

  it('allows explicit overrides', () => {
    expect(
      resolveEmbedChrome({
        mode: 'tool',
        showPlaybackBar: true,
      }),
    ).toEqual({
      showNavbar: false,
      showSidebar: false,
      showPlaybackBar: true,
    });
  });
});

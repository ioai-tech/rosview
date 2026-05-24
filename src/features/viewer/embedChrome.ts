export type RosViewerChrome = 'full' | 'minimal' | 'panels-only';

export type RosViewerMode = 'viewer' | 'tool';

export interface ResolvedEmbedChrome {
  showNavbar: boolean;
  showSidebar: boolean;
  showPlaybackBar: boolean;
}

export interface EmbedChromeInput {
  mode?: RosViewerMode;
  chrome?: RosViewerChrome;
  showNavbar?: boolean;
  showSidebar?: boolean;
  showPlaybackBar?: boolean;
}

function presetDefaults(chrome: RosViewerChrome): ResolvedEmbedChrome {
  switch (chrome) {
    case 'minimal':
      return { showNavbar: false, showSidebar: true, showPlaybackBar: false };
    case 'panels-only':
      return { showNavbar: false, showSidebar: false, showPlaybackBar: false };
    default:
      return { showNavbar: true, showSidebar: true, showPlaybackBar: true };
  }
}

export function resolveEmbedChrome(input: EmbedChromeInput): ResolvedEmbedChrome {
  const preset = input.chrome ?? (input.mode === 'tool' ? 'panels-only' : 'full');
  const defaults = presetDefaults(preset);
  return {
    showNavbar: input.showNavbar ?? defaults.showNavbar,
    showSidebar: input.showSidebar ?? defaults.showSidebar,
    showPlaybackBar: input.showPlaybackBar ?? defaults.showPlaybackBar,
  };
}

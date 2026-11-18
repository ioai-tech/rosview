import type React from 'react';
import type { Player } from '@/core/types/player';
import type { PreferencePersistence } from '@/core/preferences/types';
import type { FoxgloveLayoutData } from '@/core/preferences/foxgloveLayout';
import type { OpenPanelInput } from '@/features/layout/dockviewController';
import type { RosViewExtension } from '@/core/extensions/types';
import type { FileListItem } from '@/shared/utils/datasetSources';
import type { RosViewerChrome, RosViewerMode } from './embedChrome';
import type { RosViewMessageOverrides } from '@/shared/intl/loadRosViewMessages';

export interface RosViewerProps {
  url?: string;
  file?: File;
  urls?: string[];
  files?: File[];
  /**
   * When `true`, every dataset produced from `file`/`files`/`url`/`urls`/
   * `fileManifest` is merged into a single multi-source session (topics and
   * time range unioned) instead of the default "list + switch" behavior.
   * @default false
   */
  mergeSources?: boolean;
  theme?: 'light' | 'dark' | 'system';
  language?: 'en' | 'zh' | 'ja';
  /**
   * Replaces viewer copy by message id (ICU message strings, so plurals work), applied on top of
   * the built-in en / zh / ja catalogs. Unknown ids are ignored.
   */
  messages?: RosViewMessageOverrides;
  /** CSS class applied to the outermost container element. */
  className?: string;
  /** Inline styles applied to the outermost container element. */
  style?: React.CSSProperties;
  onFatalError?: (error: Error) => void;
  /**
   * `'localStorage'`: read/write `ioai.rosview.prefs`. `'off'`: no storage (host owns prefs).
   * @default 'localStorage'
   */
  preferencePersistence?: PreferencePersistence;
  /** Fired when the user changes theme in the navbar (orthogonal to persistence). */
  onThemeChange?: (theme: 'light' | 'dark' | 'system') => void;
  /** Fired when the user changes language in the navbar. */
  onLanguageChange?: (language: 'en' | 'zh' | 'ja') => void;
  /** Fired after this component rewrites SPA query state and the host should re-read `window.location.search`. */
  onSpaUrlQuerySync?: () => void;
  /**
   * Remote dataset manifest: JSON URL or parsed rows.
   * Merged/deduped with `url` / `urls`; fetch errors are logged only and do not block other sources.
   */
  fileManifest?: string | FileListItem[];
  /** Optional third-party extension contributions for sidebar and playback overlays. */
  extensions?: RosViewExtension[];
  /** Optional center label override shown in navbar source area. */
  navbarSourceName?: string;
  /** Whether to show the left navbar brand button. @default true */
  showNavbarBrand?: boolean;
  /** Custom label for the left navbar brand button (defaults to product name). */
  navbarBrandLabel?: string;
  /** Whether to show navbar language switcher. @default true */
  showLanguageSwitcher?: boolean;
  /** Whether to show navbar theme switcher. @default true */
  showThemeSwitcher?: boolean;
  /** Prefer auto layout bootstrap over welcome placeholder in embedded mode. @default false */
  preferAutoLayout?: boolean;
  /**
   * `spa`: sync `?url=` with the active source; restore `file://` / `folder://` from IndexedDB on load, and `sample://` from the sample manifest.
   * `off`: library / embed — never writes the URL; custom locators in `url` do not auto-restore.
   * @default 'off'
   */
  urlState?: 'spa' | 'off';
  /**
   * Opaque host payload forwarded to every `RosViewExtension` as `context.hostContext`.
   * RosView does not read or validate this object.
   */
  hostContext?: unknown;
  /**
   * Embed preset. `tool` opens panels without a recording source (MinimalPlayer) and defaults to panels-only chrome.
   * @default 'viewer'
   */
  mode?: RosViewerMode;
  /** When false, mount MinimalPlayer and workspace without url/file. @default true (false when mode='tool'). */
  requireSource?: boolean;
  /** Chrome preset; overridden by explicit showNavbar/showSidebar/showPlaybackBar. */
  chrome?: RosViewerChrome;
  showNavbar?: boolean;
  showSidebar?: boolean;
  showPlaybackBar?: boolean;
  /** Hide navbar file menus and disable recording drag-and-drop in the workspace. */
  hideOpenFileMenus?: boolean;
  /**
   * `'inherit'`: follow `preferencePersistence`. `'off'`: never read/write layout localStorage.
   * @default 'inherit'
   */
  layoutPersistence?: PreferencePersistence | 'inherit';
  layoutStorageKey?: string;
  /** Applied on mount before saved layout. */
  initialLayout?: FoxgloveLayoutData;
  /** Shorthand single-panel layout when `initialLayout` is omitted. */
  defaultPanel?: OpenPanelInput;
  /** When true (default for mode='tool'), skip Dockview Welcome placeholder. */
  suppressWelcomePanel?: boolean;
  onLayoutReady?: (info: { panelCount: number }) => void;
  /**
   * Fired once the player is ready. `resetLayout()` forgets the saved layout under
   * `layoutStorageKey` and restores the `initialLayout` / `defaultPanel`, or the auto layout; it
   * returns false while no layout exists yet.
   */
  onPlayerReady?: (ctx: { player: Player; hasSource: boolean; resetLayout: () => boolean }) => void;
  onSourceLoadingChange?: (loading: boolean) => void;
  /**
   * Host-stable identity of the recording being shown (for example the recording id), used to
   * reuse already-downloaded bytes when the same recording is opened again in this tab and to
   * keep that cache across a URL refresh. Never put a signed URL here. Honoured only while the
   * viewer has exactly one remote source. Recording bytes are held in memory for the lifetime of
   * the page only (never IndexedDB / Cache Storage / OPFS); call `clearCache()` on logout.
   */
  sourceKey?: string;
  /**
   * Presigned-URL renewal. Called at most once per batch, with the current URL of every open
   * remote source, when a request fails with 401 / 403 or starts within 60 s of `urlExpiresAt`.
   * Resolve to the new URLs in the same order. Position, layout and panels are kept and the
   * failed request is retried once; if it fails again the ordinary source error is shown.
   */
  refreshUrls?: (expired: string[]) => Promise<string[]>;
  /** ISO 8601 time at which the current presigned URLs expire; enables renewal 60 s before. */
  urlExpiresAt?: string;
  /** Sidebar tab id to select on first mount (e.g. extension `sidebarTabs[].id`). */
  initialSidebarTab?: string;
}

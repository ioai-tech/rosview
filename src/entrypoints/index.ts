// ============================================================================
// @ioai/rosview — Public API (v1.2.0)
// ============================================================================
// Only symbols exported here are part of the stable public contract and
// subject to semver guarantees. Internal modules may change without notice.
// ============================================================================

// Import global styles for library consumers (Tailwind + scoped tokens).
import '../index.css';

// ---------------------------------------------------------------------------
// Main viewer component
// ---------------------------------------------------------------------------
export { RosViewer } from '../features/viewer/RosViewer';
export type { RosViewerProps } from '../features/viewer/RosViewer';

// ---------------------------------------------------------------------------
// Provider + theme hook
// (wrap your own UI within the ROSView theme/intl context)
// ---------------------------------------------------------------------------
export { RosViewProvider, useRosViewTheme } from '../features/viewer/RosViewProvider';
export type { RosViewProviderProps } from '../features/viewer/RosViewProvider';

// ---------------------------------------------------------------------------
// Embed helpers
// ---------------------------------------------------------------------------
export { resolveEmbedChrome } from '../features/viewer/embedChrome';
export type { RosViewerChrome, RosViewerMode, ResolvedEmbedChrome } from '../features/viewer/embedChrome';
export { MinimalPlayer } from '../core/players/MinimalPlayer';
export { createSinglePanelLayout } from '../core/preferences/createSinglePanelLayout';

// ---------------------------------------------------------------------------
// Preference types and read/write utilities
// (for host apps that manage persistence externally)
// ---------------------------------------------------------------------------
export type {
  PreferencePersistence,
  RosViewLanguageCode,
  RosViewPersistedTheme,
  RosViewUiTheme,
} from '../core/preferences/types';
export { readPreferences, writePreferences } from '../core/preferences/readWritePreferences';
export {
  ROS_VIEW_LAYOUT_STORAGE_KEY,
  ROS_VIEW_PREFERENCES_STORAGE_KEY,
} from '../core/preferences/storageKeys';

// ---------------------------------------------------------------------------
// Dataset / source utilities
// (build custom dataset pickers or remote list manifests)
// ---------------------------------------------------------------------------
export type { DatasetItem, FileListItem } from '../shared/utils/datasetSources';
export {
  parseRemoteDatasetListJson,
  datasetItemsFromListItems,
} from '../shared/utils/datasetSources';

// ---------------------------------------------------------------------------
// Layout persistence utilities
// (save/restore the panel layout to localStorage or custom storage)
// ---------------------------------------------------------------------------
export {
  clearSavedDockviewLayout,
  readSavedDockviewLayout,
  saveDockviewLayoutToStorage,
} from '../core/preferences/layoutStorage';

// ---------------------------------------------------------------------------
// Foxglove layout interop
// (import/export Foxglove Studio-compatible layouts for cross-tool compatibility)
// ---------------------------------------------------------------------------
export {
  importFoxgloveLayout,
  buildFoxgloveLayout,
  parseFoxgloveLayout,
} from '../core/preferences/foxgloveLayout';
export type {
  FoxgloveLayoutData,
  ImportFoxgloveLayoutResult,
} from '../core/preferences/foxgloveLayout';
export {
  exportDockviewLayout,
  importDockviewLayout,
  openDockviewPanel,
} from '../features/layout/dockviewController';
export type { OpenPanelInput } from '../features/layout/dockviewController';

// ---------------------------------------------------------------------------
// Extension API
// (third-party sidebar / playback overlay contributions)
// ---------------------------------------------------------------------------
export type {
  MessageAccessApi,
  PlaybackControlsApi,
  PlaybackOverlayContribution,
  PlaybackSnapshot,
  RosViewExtension,
  RosViewExtensionContext,
  SidebarTabContribution,
  TimelineApi,
  TimelineOverlayContribution,
} from '../core/extensions/types';
export type { GetMessagesInTimeRangeArgs } from '../core/types/player';

// ---------------------------------------------------------------------------
// Core ROS / player types
// (for typed message consumers via useMessagePipeline)
// ---------------------------------------------------------------------------
export type {
  Time,
  TimeRange,
  MessageEvent,
  TopicInfo,
  TopicStats,
  PlayerProblem,
} from '../core/types/ros';
export type {
  Player,
  PlayerPresence,
  PlayerState,
  Subscription,
} from '../core/types/player';

// ---------------------------------------------------------------------------
// Advanced: MessagePipeline hook
// (subscribe to playback state and decoded messages from within custom panels)
// ---------------------------------------------------------------------------
export { useMessagePipeline } from '../core/pipeline/useMessagePipeline';

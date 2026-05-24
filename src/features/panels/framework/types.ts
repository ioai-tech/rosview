import type React from 'react';
import type { Player } from '@/core/types/player';
import type { TopicInfo } from '@/core/types/ros';

/**
 * Panel type identifiers. Aligned with Foxglove Studio panel types so that
 * a panel id of the form `${PanelType}!${hash}` round-trips with Foxglove
 * layout JSON (see `util/layout.ts#getPanelTypeFromId`).
 */
export type PanelType =
  | 'RawMessages'
  | 'Image'
  | '3D'
  | 'Pose'
  | 'JointStatePlot'
  | 'Timeline'
  | 'TopicGraph'
  | 'Align'
  | 'Audio'
  | 'UrdfDebug'
  | 'Unavailable';

/**
 * Schema gatekeeper for a panel's persisted config. `parse` must be tolerant:
 * given arbitrary JSON (including partial/malformed input from old layouts or
 * Foxglove JSON), produce a usable config by filling in defaults.
 */
export interface PanelConfigSchema<TConfig> {
  version: number;
  parse(input: unknown): TConfig;
}

export interface PanelSchemaSupport {
  /**
   * Canonical ROS schema names this panel can consume in auto-layout detection.
   * Examples: `sensor_msgs/msg/Image`, `geometry_msgs/msg/PoseStamped`.
   */
  supportedSchemas: readonly string[];
}

export interface PanelAutoLayoutHints {
  /** When true, auto-layout always creates this panel even without matching topics. */
  alwaysInclude?: boolean;
}

/**
 * Props passed to a panel's `render` function. `config` is a live view into
 * the panel's persisted state — the panel should treat it as read-only within
 * its own render tree and use `setConfig` or the settings UI to mutate.
 */
export interface PanelRenderProps<TConfig> {
  player: Player;
  panelId: string;
  panelTitle: string;
  config: TConfig;
  setConfig: (next: TConfig | ((prev: TConfig) => TConfig)) => void;
  resetPanel: () => void;
}

/**
 * Context given to a panel's settings editor. Panels are free to author any
 * React UI as long as they read `config` and call `setConfig` to persist
 * changes. The context also exposes the live player and topic list so the
 * settings UI can offer autocompletion, topic previews, etc.
 *
 * `extras` is a *read-only* snapshot of Foxglove config fields that we did
 * not map into our typed config (for example `3D.cameraState`). Panels MAY
 * use it to display deep-interop information but SHOULD NOT attempt to
 * mutate it — round-trip preservation is handled by the framework.
 */
export interface PanelSettingsContext<TConfig> {
  panelId: string;
  panelTitle: string;
  config: TConfig;
  setConfig: (next: TConfig | ((prev: TConfig) => TConfig)) => void;
  player: Player;
  topics: ReadonlyArray<TopicInfo>;
  resetPanel: () => void;
  duplicatePanel: () => void;
  closePanel: () => void;
  copyPanelId: () => void;
  extras?: Readonly<Record<string, unknown>>;
}

/**
 * A panel definition is the single source of truth for one panel kind.
 * Each concrete panel contributes a `PanelDefinition` that wires together
 * the default config, schema parser, renderer and (optional) settings UI.
 */
export interface PanelDefinition<TConfig = unknown> {
  type: PanelType;
  defaultTitle: string;
  /** Produce a fresh default config (used on first open / reset). */
  createDefaultConfig: () => TConfig;
  /** Versioned schema used for persist/restore. */
  configSchema: PanelConfigSchema<TConfig>;
  /** Render the panel body. */
  render: (props: PanelRenderProps<TConfig>) => React.ReactNode;
  /** Optional schema metadata for schema-driven auto-layout and capability discovery. */
  schemaSupport?: PanelSchemaSupport;
  /** Optional hints used by auto-layout planners. */
  autoLayoutHints?: PanelAutoLayoutHints;
  /**
   * Optional settings editor. When present, the tab header shows a gear icon
   * that opens the Sidebar "Settings" tab for this panel. Panels may return
   * any React node; it is mounted inside a scrollable sidebar container.
   */
  renderSettings?: (ctx: PanelSettingsContext<TConfig>) => React.ReactNode;
}

export interface PanelInstanceSnapshot {
  id: string;
  type: PanelType;
  title: string;
  config: unknown;
  configVersion: number;
  /**
   * Foxglove-compatible panel type string (e.g. `'Canvas'` when our internal
   * `type` is `'Image'`). Undefined means the id prefix already matches our
   * internal `type`. Preserved so exports can emit the original Foxglove type.
   */
  foxgloveType?: string;
  /**
   * Unknown fields from a Foxglove panel config that we could not map into
   * our own typed `config`. Preserved so re-exports are lossless.
   */
  extras?: Record<string, unknown>;
}

export { isRecord } from '@/shared/utils/guards';

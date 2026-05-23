# API Reference — @ioai/rosview

> Simplified Chinese: [API.zh.md](API.zh.md)

This document covers the complete public API of `@ioai/rosview` v1.0.1.

Before using this package, install peer dependencies in your host app: `react`, `react-dom`, `three`, `@react-three/fiber`, and `@react-three/drei`.

---

## Table of Contents

1. [RosViewer](#rosviewer)
2. [RosViewProvider](#rosviewprovider)
3. [TypeScript Types](#typescript-types)
4. [Preference Utilities](#preference-utilities)
5. [Dataset Utilities](#dataset-utilities)
6. [Layout Utilities](#layout-utilities)
7. [Extension API](#extension-api)
8. [MessagePipeline Hook](#messagepipeline-hook)
9. [URL Parameters (SPA)](#url-parameters-spa)

---

## RosViewer

The main embeddable component. Renders the full viewer UI including navbar, panels, and playback controls.

```tsx
import { RosViewer } from '@ioai/rosview';
import '@ioai/rosview/style.css';
```

### Props

#### Data sources

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `url` | `string` | — | Single remote file URL (HTTP/HTTPS). Supports HTTP Range requests for large files. |
| `urls` | `string[]` | — | Multiple remote file URLs. Each becomes a selectable dataset in the sidebar. |
| `file` | `File` | — | Single local `File` object (e.g. from `<input type="file">`). |
| `files` | `File[]` | — | Multiple local `File` objects. |
| `fileManifest` | `string \| FileListItem[]` | — | Remote dataset manifest JSON URL **or** an array of `FileListItem` rows. Merged with `url`/`urls`. Fetch errors are logged and do not block other sources. Use this prop when embedding; the standalone SPA does not read manifest URLs from query parameters. |

All source props may be combined. Duplicates are deduplicated automatically. Files take priority over URLs in display order.

#### Appearance

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `theme` | `'light' \| 'dark' \| 'system'` | `'system'` | Color theme. `'system'` follows the OS preference. |
| `language` | `'en' \| 'zh' \| 'ja'` | `'en'` | UI language (English, Simplified Chinese, Japanese). |
| `className` | `string` | — | CSS class applied to the outermost container element. |
| `style` | `React.CSSProperties` | — | Inline styles applied to the outermost container element. |

#### Persistence

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `preferencePersistence` | `'localStorage' \| 'off'` | `'localStorage'` | Controls where user preferences (theme, language, layout) are saved. Use `'off'` to disable all automatic storage and manage state externally. |
| `urlState` | `'spa' \| 'off'` | `'off'` | `'spa'`: sync browser `?url=` with the active dataset and restore `file://` / `folder://` / `sample://` from IndexedDB **Recent** or the sample manifest (standalone SPA). `'off'`: default for npm embedding — no `history.pushState`, and custom locators in `url` do not auto-restore. |

#### Event callbacks

| Prop | Type | Description |
|------|------|-------------|
| `onFatalError` | `(error: Error) => void` | Called when a file fails to load and no fallback succeeds. |
| `onThemeChange` | `(theme: 'light' \| 'dark' \| 'system') => void` | Called when the user changes the theme via the navbar. |
| `onLanguageChange` | `(language: 'en' \| 'zh' \| 'ja') => void` | Called when the user changes the language via the navbar. |
| `extensions` | `RosViewExtension[]` | Optional host contributions: sidebar tabs plus timeline/playback overlays. |
| `hostContext` | `unknown` | Opaque value forwarded to every extension as `context.hostContext`. RosView does not interpret it (pass dataset ids, feature flags, etc.). |

### Minimal example

```tsx
<RosViewer url="https://cdn.example.com/recording.mcap" />
```

### Controlled theme + language

```tsx
const [theme, setTheme] = React.useState<'light' | 'dark' | 'system'>('dark');
const [lang, setLang] = React.useState<'en' | 'zh' | 'ja'>('en');

<RosViewer
  url="https://cdn.example.com/recording.mcap"
  theme={theme}
  language={lang}
  preferencePersistence="off"
  onThemeChange={setTheme}
  onLanguageChange={setLang}
/>
```

---

## RosViewProvider

Provides the theme context and i18n `IntlProvider` for applications that need to render custom UI within the ROSView theme.

```tsx
import { RosViewProvider, useRosViewTheme } from '@ioai/rosview';
```

### RosViewProviderProps

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `theme` | `'light' \| 'dark' \| 'system'` | `'system'` | Theme for child components. |
| `language` | `'en' \| 'zh' \| 'ja'` | `'en'` | Language for react-intl messages. |
| `children` | `React.ReactNode` | (required) | Child components. |

### useRosViewTheme

```tsx
const { theme, resolvedTheme } = useRosViewTheme();
// theme: 'light' | 'dark' | 'system'
// resolvedTheme: 'light' | 'dark'  (system resolved to actual value)
```

---

## TypeScript Types

### RosViewLanguageCode

```ts
type RosViewLanguageCode = 'en' | 'zh' | 'ja';
```

### RosViewUiTheme

```ts
type RosViewUiTheme = 'light' | 'dark' | 'system';
```

### RosViewPersistedTheme

```ts
type RosViewPersistedTheme = 'light' | 'dark';  // 'system' is not persisted
```

### PreferencePersistence

```ts
type PreferencePersistence = 'localStorage' | 'off';
```

### DatasetItem

Represents a single data source (file or URL) that has been normalized for use with the player.

```ts
interface DatasetItem {
  id: string;
  kind: 'file' | 'url';
  name: string;
  file?: File;
  url?: string;
  sizeBytes?: number;
  durationSec?: number;
  topicCount?: number;
}
```

### FileListItem

One row from a remote dataset manifest JSON.

```ts
interface FileListItem {
  url: string;
  name?: string;
  sizeBytes?: number;
  durationSec?: number;
  topicCount?: number;
}
```

### Time

ROS-compatible timestamp (nanosecond precision).

```ts
interface Time {
  sec: number;
  nsec: number;
}
```

### MessageEvent

A decoded message from the player.

```ts
interface MessageEvent<T = unknown> {
  topic: string;
  receiveTime: Time;
  message: T;
  sizeInBytes: number;
  schemaName?: string;
}
```

### PlayerPresence

```ts
type PlayerPresence = 'preinit' | 'initializing' | 'ready' | 'closed';
```

---

## Preference Utilities

For host applications that manage preferences externally (`preferencePersistence="off"`).

```ts
import { readPreferences, writePreferences } from '@ioai/rosview';
import { ROS_VIEW_PREFERENCES_STORAGE_KEY, ROS_VIEW_LAYOUT_STORAGE_KEY } from '@ioai/rosview';
```

### readPreferences()

Returns the stored preferences object or `null` if none saved.

```ts
const prefs = readPreferences();
// { theme: 'dark', language: 'zh', ... } | null
```

### writePreferences(patch)

Merges a partial preferences object into the stored value.

```ts
writePreferences({ theme: 'dark', language: 'en' });
```

### Storage keys

| Constant | Value | Content |
|----------|-------|---------|
| `ROS_VIEW_PREFERENCES_STORAGE_KEY` | `'ioai.rosview.prefs'` | UI preferences JSON |
| `ROS_VIEW_LAYOUT_STORAGE_KEY` | `'ioai.rosview.layout'` | Panel layout JSON |

---

## Dataset Utilities

```ts
import { parseRemoteDatasetListJson, datasetItemsFromListItems } from '@ioai/rosview';
```

### parseRemoteDatasetListJson(json)

Parse a raw JSON value (from `fetch`) into a `FileListItem[]`. Invalid rows are skipped.

```ts
const res = await fetch('/manifest.json');
const items: FileListItem[] = parseRemoteDatasetListJson(await res.json());
```

### datasetItemsFromListItems(items)

Convert `FileListItem[]` to `DatasetItem[]` (the format used by `RosViewer`).

```ts
const datasets = datasetItemsFromListItems(items);
<RosViewer files={[]} fileManifest={items} />
```

---

## Layout Utilities

### Layout persistence

```ts
import {
  readSavedDockviewLayout,
  saveDockviewLayoutToStorage,
  clearSavedDockviewLayout,
} from '@ioai/rosview';
```

| Function | Description |
|----------|-------------|
| `readSavedDockviewLayout()` | Read the saved panel layout from localStorage. Returns `FoxgloveLayoutData \| null`. |
| `saveDockviewLayoutToStorage(layout)` | Write a panel layout to localStorage. |
| `clearSavedDockviewLayout()` | Remove the saved panel layout from localStorage. |

### Foxglove layout interop

```ts
import { importFoxgloveLayout, buildFoxgloveLayout, parseFoxgloveLayout } from '@ioai/rosview';
import { exportDockviewLayout, importDockviewLayout, openDockviewPanel } from '@ioai/rosview';
```

| Function | Description |
|----------|-------------|
| `parseFoxgloveLayout(raw)` | Parse a raw Foxglove layout JSON object into `FoxgloveLayoutData`. |
| `importFoxgloveLayout(data, options?)` | Convert a `FoxgloveLayoutData` into a DockView-compatible layout and apply it. Returns `ImportFoxgloveLayoutResult`. |
| `buildFoxgloveLayout(input)` | Build a `FoxgloveLayoutData` from a panel configuration object. |
| `exportDockviewLayout()` | Export the current panel layout as `FoxgloveLayoutData`. Returns `null` if no layout is active. |
| `importDockviewLayout(layout)` | Apply a previously exported layout to the current DockView instance. |
| `openDockviewPanel(input)` | Programmatically open a panel by type. Returns the new panel ID or `null`. |

---

## Extension API

`@ioai/rosview` can be extended by passing `extensions` to `RosViewer`.

```ts
import type {
  RosViewExtension,
  RosViewExtensionContext,
  SidebarTabContribution,
  PlaybackOverlayContribution,
  TimelineOverlayContribution,
  PlaybackControlsApi,
  PlaybackSnapshot,
  TimelineApi,
  MessageAccessApi,
} from '@ioai/rosview';
```

### Core types

| Type | Description |
|------|-------------|
| `RosViewExtension` | One extension bundle. Contains optional `sidebarTabs`, `playbackOverlays`, and `timelineOverlays` (merged after `playbackOverlays`, same contribution shape). |
| `SidebarTabContribution` | Registers a sidebar tab (`id`, `title`, optional `icon`, optional `order`, `render(context)`). |
| `PlaybackOverlayContribution` | Registers a region above playback track (`id`, optional `order`, optional `height`, `render(context)`). |
| `TimelineOverlayContribution` | Alias of `PlaybackOverlayContribution` for naming clarity. |
| `RosViewExtensionContext` | Stable context object passed into extension renderers. |
| `PlaybackControlsApi` | Playback controls: `seek`, `play`, `pause`, `setSpeed`, `setLooping`, `stepBy`, `stepMessage`, `playUntil`, `subscribeCurrentTime`, `getSnapshot`. |
| `PlaybackSnapshot` | Playback state including `currentTime`, `startTime`, `endTime`, `isPlaying`, `speed`, optional `progressPercent`, `buffering`, `problems`. |
| `TimelineApi` | Helpers aligned with the scrubber: `getTimeBounds`, `timeToPercent`, `percentToTime`. |
| `MessageAccessApi` | Read-only `getMessagesInTimeRange` when the underlying player supports it. |

### Example

```tsx
import { RosViewer } from '@ioai/rosview';
import type { RosViewExtension } from '@ioai/rosview';

const annotationExtension: RosViewExtension = {
  id: 'my-annotation-tool',
  sidebarTabs: [
    {
      id: 'annotations',
      title: 'Annotations',
      order: 20,
      render: ({ playback }) => (
        <MyAnnotationSidebar
          getPlaybackSnapshot={playback.getSnapshot}
          onSeek={playback.seek}
        />
      ),
    },
  ],
  playbackOverlays: [
    {
      id: 'annotation-ranges',
      order: 10,
      render: ({ playback, timeline }) => (
        <MyAnnotationTimeline
          getBounds={timeline.getTimeBounds}
          timeToPercent={timeline.timeToPercent}
          getPlaybackSnapshot={playback.getSnapshot}
          subscribeCurrentTime={playback.subscribeCurrentTime}
          onSeek={playback.seek}
        />
      ),
    },
  ],
  timelineOverlays: [
    {
      id: 'lane-markers',
      order: 5,
      height: 14,
      render: ({ timeline }) => <MyThinLane timeline={timeline} />,
    },
  ],
};

<RosViewer url="/demo.mcap" extensions={[annotationExtension]} hostContext={{ datasetId: 42 }} />;
```

### Best practices

- Prefer `playback.subscribeCurrentTime()` for high-frequency visuals (canvas/ref updates) instead of React setState on every frame.
- Use `playback.getSnapshot()` for low-frequency state checks like `isPlaying`, `startTime`, and `endTime`.
- Keep extension renderers resilient; runtime errors are isolated from core playback controls.

---

## MessagePipeline Hook

For advanced use cases — subscribing to playback state and decoded messages from within custom React components rendered inside the viewer.

```ts
import { useMessagePipeline } from '@ioai/rosview';
```

```tsx
function MyCustomPanel() {
  const presence = useMessagePipeline(s => s.playerState.presence);
  const topics = useMessagePipeline(s => s.sortedTopics);

  if (presence !== 'ready') return <div>Loading…</div>;

  return (
    <ul>
      {topics.map(t => <li key={t.name}>{t.name} ({t.schemaName})</li>)}
    </ul>
  );
}
```

The selector function receives `MessagePipelineState` and should return a stable (memoized) value to avoid unnecessary re-renders.

---

## URL Parameters (SPA)

When using the standalone SPA at [rosview.com](https://rosview.com) or a self-hosted deployment, the address bar uses a single datasource parameter `url` (plus optional UI params). Opening or switching a source updates the URL with `history.pushState` so refresh restores the same item.

| Parameter | Example value | Description |
|-----------|---------------|-------------|
| `url` | `https://cdn.example.com/recording.mcap` | Remote recording (HTTP(S) or same-origin path such as `/examples/run.mcap`). |
| `url` | `file://test.mcap` | Local file: replay uses the most recent matching **Recent** entry with stored `FileSystemFileHandle` (same display name; ambiguous if duplicated). |
| `url` | `folder://dataset` | Local folder: replay uses the most recent **Recent** directory entry whose folder name matches. |
| `url` | `sample://franka_stack` | Built-in sample: resolve `id` against the JSON catalog from `VITE_SAMPLE_DATASETS_MANIFEST_URL` or `VITE_SAMPLES_BASE_URL` (see sample manifest in the repo `src/services/sampleDatasets.ts`). |
| `theme` | `dark` | Initial theme (`light` / `dark` / `system`). |
| `language` | `zh` | Initial language (`en` / `zh` / `ja`). |

`file://`, `folder://`, and `sample://` are **app-specific** locators, not the browser’s native `file:` URL scheme.

For multiple remote files or a remote JSON manifest, use the React `urls` / `fileManifest` props when embedding `@ioai/rosview`; the standalone SPA intentionally tracks a single `url` in the query string.

Example deep-link:
```
https://rosview.com?url=https://cdn.example.com/run1.mcap&theme=dark&language=en
```

# API 参考 — @ioai/rosview

> English: [API.md](API.md)

本文档描述 `@ioai/rosview` v1.0.1 的完整公开 API。

在使用该包前，请先在宿主应用安装 peer 依赖：`react`、`react-dom`、`three`、`@react-three/fiber`、`@react-three/drei`。

---

## 目录

1. [RosViewer](#rosviewer)
2. [RosViewProvider](#rosviewprovider)
3. [TypeScript 类型](#typescript-类型)
4. [偏好设置工具](#偏好设置工具)
5. [数据集工具](#数据集工具)
6. [布局工具](#布局工具)
7. [扩展 API](#扩展-api)
8. [MessagePipeline Hook](#messagepipeline-hook)
9. [URL 参数（SPA）](#url-参数spa)

---

## RosViewer

主嵌入组件，渲染完整查看器 UI（导航栏、面板、播放控制）。

```tsx
import { RosViewer } from '@ioai/rosview';
import '@ioai/rosview/style.css';
```

### Props

#### 数据源

| Prop | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `url` | `string` | — | 单个远程文件 URL（HTTP/HTTPS）。大文件支持 HTTP Range。 |
| `urls` | `string[]` | — | 多个远程文件 URL；每个在侧边栏中作为可选数据集。 |
| `file` | `File` | — | 单个本地 `File`（例如来自 `<input type="file">`）。 |
| `files` | `File[]` | — | 多个本地 `File`。 |
| `fileManifest` | `string \| FileListItem[]` | — | 远程 manifest 的 JSON URL **或** `FileListItem[]` 行数组。与 `url`/`urls` 合并；拉取错误会记录日志且不阻塞其他源。独立 SPA 不会从查询串读取 manifest，请在嵌入时使用此 prop。 |

所有数据源类 prop 可组合使用；重复项会自动去重。展示顺序上文件优先于 URL。

#### 外观

| Prop | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `theme` | `'light' \| 'dark' \| 'system'` | `'system'` | 配色主题；`'system'` 跟随系统。 |
| `language` | `'en' \| 'zh' \| 'ja'` | `'en'` | UI 语言。 |
| `className` | `string` | — | 应用到最外层容器的 CSS class。 |
| `style` | `React.CSSProperties` | — | 应用到最外层容器的内联样式。 |

#### 持久化

| Prop | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `preferencePersistence` | `'localStorage' \| 'off'` | `'localStorage'` | 控制主题、语言、布局等偏好的保存位置；`'off'` 表示不自动写入，由宿主自行管理。 |
| `urlState` | `'spa' \| 'off'` | `'off'` | `'spa'`：与独立 SPA 一致，用 `history.pushState` 同步地址栏 `?url=`；加载时从 IndexedDB **最近打开** 恢复 `file://` / `folder://`，或通过示例清单解析 `sample://`。`'off'`：npm 嵌入默认 — 不写地址栏，上述自定义定位符不会自动恢复。 |

#### 事件回调

| Prop | 类型 | 说明 |
|------|------|------|
| `onFatalError` | `(error: Error) => void` | 文件加载失败且无可用回退时调用。 |
| `onThemeChange` | `(theme: 'light' \| 'dark' \| 'system') => void` | 用户通过导航栏切换主题时调用。 |
| `onLanguageChange` | `(language: 'en' \| 'zh' \| 'ja') => void` | 用户通过导航栏切换语言时调用。 |
| `extensions` | `RosViewExtension[]` | 可选宿主扩展：侧边栏 Tab、播放条/时间轴叠加层等。 |
| `hostContext` | `unknown` | 不透明上下文，原样出现在 `context.hostContext`（如数据集 id、权限标记）。 |

### 最小示例

```tsx
<RosViewer url="https://cdn.example.com/recording.mcap" />
```

### 受控主题 + 语言

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

为主题上下文与 i18n 的 `IntlProvider` 提供封装，便于在 ROSView 主题下渲染自定义 UI。

```tsx
import { RosViewProvider, useRosViewTheme } from '@ioai/rosview';
```

### RosViewProviderProps

| Prop | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `theme` | `'light' \| 'dark' \| 'system'` | `'system'` | 子组件主题。 |
| `language` | `'en' \| 'zh' \| 'ja'` | `'en'` | react-intl 消息语言。 |
| `children` | `React.ReactNode` | （必填） | 子节点。 |

### useRosViewTheme

```tsx
const { theme, resolvedTheme } = useRosViewTheme();
// theme: 'light' | 'dark' | 'system'
// resolvedTheme: 'light' | 'dark'  （system 已解析为实际值）
```

---

## TypeScript 类型

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
type RosViewPersistedTheme = 'light' | 'dark';  // 'system' 不会持久化
```

### PreferencePersistence

```ts
type PreferencePersistence = 'localStorage' | 'off';
```

### DatasetItem

表示已规范化、供播放器使用的单个数据源（文件或 URL）。

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

远程 manifest JSON 中的一行。

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

ROS 兼容时间戳（纳秒精度）。

```ts
interface Time {
  sec: number;
  nsec: number;
}
```

### MessageEvent

播放器解码后的一条消息。

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

## 偏好设置工具

用于在宿主侧管理偏好（`preferencePersistence="off"` 时）。

```ts
import { readPreferences, writePreferences } from '@ioai/rosview';
import { ROS_VIEW_PREFERENCES_STORAGE_KEY, ROS_VIEW_LAYOUT_STORAGE_KEY } from '@ioai/rosview';
```

### readPreferences()

返回已保存的偏好对象；若无则 `null`。

```ts
const prefs = readPreferences();
// { theme: 'dark', language: 'zh', ... } | null
```

### writePreferences(patch)

将部分字段合并写入已存储的偏好。

```ts
writePreferences({ theme: 'dark', language: 'en' });
```

### 存储键

| 常量 | 值 | 内容 |
|------|-----|------|
| `ROS_VIEW_PREFERENCES_STORAGE_KEY` | `'ioai.rosview.prefs'` | UI 偏好 JSON |
| `ROS_VIEW_LAYOUT_STORAGE_KEY` | `'ioai.rosview.layout'` | 面板布局 JSON |

---

## 数据集工具

```ts
import { parseRemoteDatasetListJson, datasetItemsFromListItems } from '@ioai/rosview';
```

### parseRemoteDatasetListJson(json)

将 `fetch` 得到的原始 JSON 解析为 `FileListItem[]`；无效行会被跳过。

```ts
const res = await fetch('/manifest.json');
const items: FileListItem[] = parseRemoteDatasetListJson(await res.json());
```

### datasetItemsFromListItems(items)

将 `FileListItem[]` 转为 `DatasetItem[]`（`RosViewer` 内部使用的格式）。

```ts
const datasets = datasetItemsFromListItems(items);
<RosViewer files={[]} fileManifest={items} />
```

---

## 布局工具

### 布局持久化

```ts
import {
  readSavedDockviewLayout,
  saveDockviewLayoutToStorage,
  clearSavedDockviewLayout,
} from '@ioai/rosview';
```

| 函数 | 说明 |
|------|------|
| `readSavedDockviewLayout()` | 从 localStorage 读取已保存布局；返回 `FoxgloveLayoutData \| null`。 |
| `saveDockviewLayoutToStorage(layout)` | 将面板布局写入 localStorage。 |
| `clearSavedDockviewLayout()` | 清除已保存的面板布局。 |

### Foxglove 布局互操作

```ts
import { importFoxgloveLayout, buildFoxgloveLayout, parseFoxgloveLayout } from '@ioai/rosview';
import { exportDockviewLayout, importDockviewLayout, openDockviewPanel } from '@ioai/rosview';
```

| 函数 | 说明 |
|------|------|
| `parseFoxgloveLayout(raw)` | 将原始 Foxglove 布局 JSON 解析为 `FoxgloveLayoutData`。 |
| `importFoxgloveLayout(data, options?)` | 将 `FoxgloveLayoutData` 转为 DockView 兼容布局并应用；返回 `ImportFoxgloveLayoutResult`。 |
| `buildFoxgloveLayout(input)` | 由面板配置对象构建 `FoxgloveLayoutData`。 |
| `exportDockviewLayout()` | 导出当前面板布局为 `FoxgloveLayoutData`；无活动布局时返回 `null`。 |
| `importDockviewLayout(layout)` | 将先前导出的布局应用到当前 DockView。 |
| `openDockviewPanel(input)` | 按类型程序化打开面板；返回新面板 ID 或 `null`。 |

---

## 扩展 API

通过向 `RosViewer` 传入 `extensions` 扩展 `@ioai/rosview`。

```ts
import type {
  RosViewExtension,
  RosViewExtensionContext,
  SidebarTabContribution,
  PlaybackOverlayContribution,
  PlaybackControlsApi,
  PlaybackSnapshot,
} from '@ioai/rosview';
```

### 核心类型

| 类型 | 说明 |
|------|------|
| `RosViewExtension` | 一个扩展包；可含 `sidebarTabs`、`playbackOverlays`、`timelineOverlays`（与前者同形，排在 `playbackOverlays` 之后合并）。 |
| `SidebarTabContribution` | 注册侧边栏 Tab（`id`、`title`、可选 `icon`、`order`、`render(context)`）。 |
| `PlaybackOverlayContribution` | 在播放条上方注册一块区域（`id`、可选 `order`、`height`、`render(context)`）。 |
| `RosViewExtensionContext` | 传给扩展渲染器的稳定上下文（含 `playback`、`timeline`、`messages`、`hostContext`）。 |
| `PlaybackControlsApi` | 播放控制：`seek`、`play`、`pause`、`setSpeed`、`setLooping`、`stepBy`、`stepMessage`、`playUntil`、`subscribeCurrentTime`、`getSnapshot`。 |
| `PlaybackSnapshot` | 播放状态快照；可含 `progressPercent`、`buffering`、`problems` 等。 |
| `TimelineApi` | 与主 scrubber 对齐：`getTimeBounds`、`timeToPercent`、`percentToTime`。 |
| `MessageAccessApi` | 只读 `getMessagesInTimeRange`（播放器支持时）。 |

### 示例

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
      render: ({ playback }) => (
        <MyAnnotationTimeline
          getPlaybackSnapshot={playback.getSnapshot}
          subscribeCurrentTime={playback.subscribeCurrentTime}
          onSeek={playback.seek}
        />
      ),
    },
  ],
};

<RosViewer url="/demo.mcap" extensions={[annotationExtension]} />;
```

### 最佳实践

- 高频视觉更新优先用 `playback.subscribeCurrentTime()`，避免每帧 `setState`。
- 低频状态检查（如 `isPlaying`、`startTime`、`endTime`）用 `playback.getSnapshot()`。
- 扩展渲染器应容错；运行时错误与核心播放控制隔离。

---

## MessagePipeline Hook

高级用法：在查看器内嵌的自定义 React 组件中订阅播放状态与解码消息。

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

选择器接收 `MessagePipelineState`，应返回稳定（可记忆化）的值，以减少不必要重渲染。

---

## URL 参数（SPA）

在 [rosview.com](https://rosview.com) 或自托管 SPA 中，地址栏使用单一数据源参数 `url`（以及可选的 UI 参数）。打开或切换数据源会通过 `history.pushState` 更新 `?url=`，刷新后按该参数恢复。

| 参数 | 示例值 | 说明 |
|------|--------|------|
| `url` | `https://cdn.example.com/recording.mcap` | 远程录制（HTTP(S) 或同源路径，如 `/examples/run.mcap`）。 |
| `url` | `file://test.mcap` | 本地文件：按显示名匹配 **最近打开** 中最近一条可重放的 `FileSystemFileHandle` 记录（重名时取最近）。 |
| `url` | `folder://dataset` | 本地文件夹：按文件夹名匹配 **最近打开** 中最近一条可重放的目录句柄。 |
| `url` | `sample://franka_stack` | 内置示例：用 id 在构建时配置的 JSON 清单中解析（`VITE_SAMPLE_DATASETS_MANIFEST_URL` 或 `VITE_SAMPLES_BASE_URL`，见 `src/services/sampleDatasets.ts`）。 |
| `theme` | `dark` | 初始主题（`light` / `dark` / `system`）。 |
| `language` | `zh` | 初始语言（`en` / `zh` / `ja`）。 |

此处的 `file://` / `folder://` / `sample://` 为应用自定义定位符，**不是**浏览器原生的 `file:` URL。

多远程文件或远程 JSON manifest 请在集成 `@ioai/rosview` 时使用 React 的 `urls` / `fileManifest` props；独立 SPA 的查询串只跟踪单个 `url`。

示例深链：

```
https://rosview.com?url=https://cdn.example.com/run1.mcap&theme=dark&language=en
```

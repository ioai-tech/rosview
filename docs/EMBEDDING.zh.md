# 嵌入指南 — @ioai/rosview

> English: [EMBEDDING.md](EMBEDDING.md)

本指南说明如何将 ROSView 作为可嵌入的 React 组件集成到你自己的应用中。

---

## 前置条件

- React ≥ 19.2（含 19.3）与 react-dom ≥ 19.2
- `three` ≥ 0.173（peer；ROSView 不打包它）
- 支持 ES 模块与 Web Workers 的打包工具（推荐 Vite；Webpack 5+ 需适当配置）

安装已发布的 npm 包不要求特定 Node.js 版本（使用较新的 npm 即可）。**开发本仓库**使用 Node 24（见 `CONTRIBUTING.md` / `.nvmrc`）。`package.json` 的 `engines.node` 为 `>=18`，避免宿主被我们的 CI Node 版本拦住。

---

## 安装

```bash
npm install @ioai/rosview
```

`@react-three/fiber` 与 `@react-three/drei` **不是** peer。若当初仅为 ROSView 安装它们，请卸载。若宿主自己的画布仍使用 React Three Fiber，请把 fiber/drei 留在**宿主**依赖中。`three` 仍然必需。

宿主应用中需已有上述 peer 包（npm 7+ 会自动安装缺失的 peer）。ROSView 运行时用到的其它库（Dockview、MCAP、Foxglove 编解码、Radix 等）**已经打进** `@ioai/rosview` 包内。不要为了「让 rosview 能跑」再在宿主里额外安装它们——那会重复拷贝并可能破坏下游 lockfile。

---

## 步骤 1 — 引入样式表

组件依赖其打包后的 CSS。在应用根入口（如 `main.tsx` / `App.tsx`）中全局引入一次：

```tsx
// main.tsx 或 App.tsx（顶层入口）
import '@ioai/rosview/style.css';
```

样式在构建产物中限定在 `#rosview-root` 内，Tailwind preflight 不会重置宿主应用的全局元素（导航栏、按钮等）。

---

## 步骤 2 — 基本用法

```tsx
import { RosViewer } from '@ioai/rosview';

export default function App() {
  return (
    <div style={{ width: '100%', height: '100vh' }}>
      <RosViewer
        url="https://cdn.example.com/recording.mcap"
        theme="dark"
        language="en"
      />
    </div>
  );
}
```

组件默认高度为 `100vh`。嵌入到更大页面中时，请用 `className` 或 `style` 限制容器尺寸。

默认 `urlState` 为 `'off'`：组件**不会**调用 `history.pushState`，也不会把 `url` prop 中的 `file://` / `folder://` 当作可从 IndexedDB 恢复的定位符。仅当你构建与独立站点类似、独占地址栏的全页应用时，才使用 `urlState="spa"`。

### 窄容器与键盘快捷键

查看器自身内容区宽度（按容器，而非窗口）小于 640px 时，侧栏移到播放器下方，分栏改为上下排列。面板只调整顺序、不重新挂载，Dockview 布局与侧栏状态都会保留。侧栏本身窄于 320px 时，标签只显示图标，并保留无障碍名称。

焦点位于文本框、下拉框，或自身使用这些按键的控件（标签页、滑块、单选、复选框、菜单、列表框、对话框）时，全局播放快捷键（空格、方向键）不生效。焦点在按钮或链接上时，空格也交给该控件处理。不带 Alt 的 Ctrl/Cmd 组合键交给浏览器和宿主处理；Alt+Ctrl/Cmd+方向键仍按 100 ms 步进。

---

## 步骤 3 — 本地文件选择

```tsx
import React from 'react';
import { RosViewer } from '@ioai/rosview';

export function FileViewer() {
  const [file, setFile] = React.useState<File>();

  return (
    <div style={{ height: '100vh' }}>
      {!file && (
        <input
          type="file"
          accept=".mcap,.bag,.db3,.h5,.hdf5,.bvh"
          onChange={e => setFile(e.target.files?.[0])}
        />
      )}
      {file && (
        <RosViewer
          file={file}
          theme="system"
          onFatalError={err => alert(`Failed to load: ${err.message}`)}
        />
      )}
    </div>
  );
}
```

---

## 步骤 4 — 远程数据集清单

在数据门户或回放看板中，可提供 JSON manifest：

```json
[
  {
    "url": "https://cdn.example.com/session_001.mcap",
    "name": "Session 001 — Parking lot",
    "sizeBytes": 2147483648,
    "durationSec": 180,
    "topicCount": 24
  },
  {
    "url": "https://cdn.example.com/session_002.mcap",
    "name": "Session 002 — Highway",
    "sizeBytes": 1073741824,
    "durationSec": 90
  }
]
```

将 manifest 的 URL 传给 `fileManifest`：

```tsx
<RosViewer
  fileManifest="https://cdn.example.com/manifest.json"
  theme="dark"
/>
```

若你已在应用侧拉取并过滤好数据，可直接传入解析后的行数组：

```tsx
import { parseRemoteDatasetListJson } from '@ioai/rosview';

const res = await fetch('/api/datasets');
const rows = parseRemoteDatasetListJson(await res.json());

<RosViewer fileManifest={rows} />
```

---

## 进阶：预签名 URL、流式读取与页内缓存

RosView 用小粒度 HTTP Range 请求读取远程录制（512 KiB 块，单次请求最多数 MiB）：对带索引的 MCAP，先读摘要与 chunk 索引，再只读播放头附近的 chunk，因此首帧只需几百 KB，而不是整文件。暂停时（打开后和暂停中拖动进度后）只读取播放头所在帧需要的数据：该时刻的 chunk，以及借助 chunk 索引与消息索引找到的各面板话题的最新一条消息——即使它位于文件末尾写入的 chunk 中（例如以首帧为时间戳的地图或 `/tf_static`）；每个面板的画面在自己的字节到达后立即显示，随后停止读取。时间序列面板（Plot、Align、Timeline）在暂停时也会读取各自的时间窗口——Plot 读取播放头前后 ±30 秒，机器人录制的自动布局会加入 JointState 与 Imu 曲线——每个窗口只读一次，之后从缓存提供。预读（接下来几秒的录制，绝不读取相距很远的 chunk 之间的字节）只在播放时进行。已下载的块**仅在内存中、仅在页面生命周期内**保留（默认预算 512 MiB，最近最少使用淘汰）。不会写入 IndexedDB、Cache Storage 或 OPFS，录制字节不会在登出或删除后残留。在同一标签页中以相同 `sourceKey` 重新打开录制时，仍在缓存中的数据不会再次读取：只发一个 1 字节请求核对文件大小与版本（`ETag`；其他版本绝不会从缓存提供），传入 `knownTotalBytes` 时则一个请求也不发。设置 `preferencePersistence="off"` 还会关闭最近文件历史。

```tsx
import { RosViewer, clearCache } from '@ioai/rosview';

<RosViewer
  url={presignedUrl}
  sourceKey={recording.id}            // 宿主稳定 id，不要用带签名的 URL
  urlExpiresAt={expiresAtIso}         // 可选：到期前 60 秒续期
  refreshUrls={async (expired) => fetchFreshUrls(expired)} // 顺序与数量一一对应
  preferencePersistence="off"
/>

// 登出、移除成员或删除数据时：
clearCache();
```

- `sourceKey` 让同一录制在同一标签页内（如 数据、原始、数据）从内存重开，并在 URL 刷新后保留缓存。内容变化时它必须变化（带上版本或 ETag）；服务端 `ETag` 不同也会清除该项。仅当查看器恰有一个远程源时生效。
- `refreshUrls(expired)`：请求收到 401/403，或在 `urlExpiresAt` 前 60 秒内发起请求时，每批最多调用一次，参数为所有打开的远程源的当前 URL，按相同顺序返回新 URL。失败的请求重试一次；位置、布局与面板保持不变。新 URL 仍失败则显示原有的数据源错误，并在 30 秒内不再续期。若宿主改用更换 `url` 属性，查看器会重启，请使用 `refreshUrls`。
- 桶 / 服务器的 CORS 规则必须同样作用于**错误响应**（包括 403），并暴露 `Content-Range`、`Content-Length`、`ETag`、`Accept-Ranges`。403 没有 CORS 头时浏览器只报网络错误，RosView 无法区分 URL 过期与网络故障，此时仅在 `urlExpiresAt` 已过（或 60 秒内）时续期。
- `refreshUrls` 收到的 URL 字符串与你传给 `url` / `urls` 的完全一致（不会被补全为绝对地址）。
- 网络中断时等待恢复，而不是报错：服务器应答过之后，若某个 Range 请求完全得不到响应（浏览器的 “Failed to fetch”：网络断开或主机不可达），RosView 保留已到达的字节，在查看器上显示“网络连接已断开，正在重新连接…”（`playerState.progress.reconnecting`），并在 0.5、1、2 秒后、此后每 3 秒重试；浏览器触发 `online`，或该查看器的任一其他请求得到响应时立即重试。网络恢复后，播放、画面和 Plot 窗口自动继续，无需点“重试”或跳转；重新连接期间读取超时不会触发。预读不等待（之后会重新请求）。从未应答过的服务器（主机错误、桶未配置 CORS）约 2 秒后以 `RangeNetworkError` 失败；网络恢复后的拒绝（例如续期也无法解决的 403）按普通错误显示。中断期间失败的 `refreshUrls` 调用不算拒绝：网络恢复时解除 30 秒暂停，期间过期的 URL 会立即续期。
- Range 请求若 20 秒内没有收到任何字节（等待响应时为 60 秒）即视为停滞：RosView 中止该请求，并对仍缺少的字节再请求一次。第一个请求（读取文件大小的探测，或重新打开时的 1 字节核对）也是如此。若再次停滞，读取以 `RangeStallError`（“No data arrived from the server for 20 s …”）失败。查看器会在缺数据的地方说明原因，而不是一直等待：
  - 凡是读取了“当前帧无法读取”的话题的面板，都会写明该话题和原因，不再显示“等待中”；面板的其他话题照常显示。该话题重新读取后（跳转，或播放中收到它的消息），或已没有面板读取它时，错误消失；
  - Plot、Align 和 Timeline 在其时间窗口上显示原因；
  - 播放随之停止（读取先超时时显示 “Reading the recording timed out …”，真实原因到达后替换）；
  - CSV 导出在按钮下方显示原因；
  - 已知类型的失败以查看器的语言说明（“无法连接到服务器，请检查网络连接。”“服务器停止发送数据。”“服务器返回了错误。”），原始信息放在悬停提示中。`playerState.progress.playbackErrorKind` 与每条 `panelReadErrors` 的 `kind`（`network`、`stalled`、`refused`）供宿主识别；
  - “重试”（`Player.retry()`）重新读取失败的内容：播放、每个读取失败话题的当前帧（暂停时也会），以及每个读取失败的 Plot、Align、Timeline 窗口（`playerState.progress.retryCount`），无需跳转。Plot 保留失败前已读取的点。
- `clearCache()` 清空页面上所有查看器的缓存字节并中止进行中的 Range 请求。
- 无索引 MCAP 通过同一缓存扫描一次（嵌入时扫描结果仅保存在内存）。ROS 1 `.bag` 同样按 Range 读取；ROS 2 `.db3`（SQLite）仍需整体下载，遇到 401/403 会续期一次。

## 进阶：自动布局、文案与重置布局

`preferAutoLayout` 根据话题生成默认面板：

- 图像话题最多六个，按 `head`、`front`、`wrist`、`left`、`right`、`rgb`/`color`、其他、最后 `depth` 与 `ir` 排序；`left`/`right` 立体对并排。一到三个相机为一行，四个为 2x2，五或六个为 3x2。
- 每个 `sensor_msgs/JointState` 话题一个 `position[:]` 曲线图（实测流优先于指令流，最多四个），每个 `sensor_msgs/Imu` 话题一个曲线图（角速度与线加速度）。
- 仅当存在 TF 或位姿话题（或 BVH 骨架）**且**浏览器支持 WebGL 时才有 3D 面板；位姿话题生成 Pose 面板。
- 原始消息作为底部窄条（无其他面板时为唯一面板）。

曲线图随消息到达逐步绘制。对远程 Range 读取的录制，曲线图只读取播放头前后各 30 秒的窗口，并随播放头移动重新居中（横轴跟随窗口），不会预加载整个文件。窗口按 MCAP chunk 由粗到细读取：先读播放头所在的 chunk，再读均匀分布在整个窗口上的 chunk，然后补齐其间的空隙，因此只需窗口的一小部分字节就能看到整条曲线的走势，随后逐渐变得精细（相机与关节数据共用 chunk 时，高码率机器人录制的一个窗口几乎就是整个文件）；图表上方有提示说明。本地文件仍读取完整范围；合并集合中只要有远程源，所有曲线图都使用该窗口。嵌入根节点是带标签的 `region`，不再渲染 `<main>` 地标。

`messages` 按消息 id 替换文案（ICU 字符串，叠加在 en / zh / ja 之上；`RosViewMessageKey` 列出所有 id）：

```tsx
<RosViewer messages={{ 'layout.viewerRegion': '录制查看器' }} />
```

`topicLabels` 用宿主应用已有的名称命名话题，键为完整的话题名。有名称的话题先显示名称，话题作为次要文字：面板话题栏（图像及其他面板；悬停也显示话题）、话题选择器（也可按名称搜索）、只显示该话题的面板的标签页标题，以及侧栏话题列表及其过滤。组合多个话题的面板（曲线图、3D、位姿）保留原标题。布局、面板配置与导出仍使用话题名；没有名称的话题显示与不传该属性时完全相同。

```tsx
<RosViewer
  url={url}
  topicLabels={{
    '/sensor/EgoCentric_Camera_0/image/compressed': '头部左相机',
    '/sensor/Left_Wrist_Camera_0/image/compressed': '左手腕相机',
  }}
/>
```

`layoutStorageKey` 按宿主隔离已保存的布局（请带上应用名）。`resetLayout()` 通过 `onPlayerReady({ player, hasSource, resetLayout })` 传入；它清除该 key 下已保存的布局，并恢复 `initialLayout` / `defaultPanel` 或自动布局。导航栏「布局」菜单有同样的“重置布局”。

## 进阶：Navbar 品牌文案

Navbar 左侧默认显示 **ROS View**。嵌入到更大页面时，可以隐藏或替换为你的产品名：

```tsx
// 隐藏品牌按钮（File / Layout 菜单仍保留）
<RosViewer url="..." showNavbarBrand={false} />

// 替换为宿主品牌
<RosViewer url="..." navbarBrandLabel="Acme 数据平台" />
```

相关 props：

| Prop | 说明 |
|------|------|
| `showNavbarBrand` | 左侧品牌按钮是否显示（默认 `true`）。 |
| `navbarBrandLabel` | 自定义品牌文案；未设置时使用本地化产品名。 |
| `navbarSourceName` | 中间区域的数据源名称（与品牌文案无关）。 |
| `showNavbar` | 设为 `false` 时隐藏整条 Navbar（通过 `chrome` 或显式 prop）。 |

---

## 进阶：受控主题与语言

关闭组件内部的 localStorage 持久化，由宿主应用完全控制状态：

```tsx
import { RosViewer } from '@ioai/rosview';
import { readPreferences, writePreferences } from '@ioai/rosview';

function ControlledViewer() {
  const saved = readPreferences();
  const [theme, setTheme] = React.useState(saved?.theme ?? 'system');
  const [lang, setLang]   = React.useState(saved?.language ?? 'en');

  const handleThemeChange = (t: typeof theme) => {
    setTheme(t);
    writePreferences({ theme: t !== 'system' ? t : undefined });
  };

  return (
    <RosViewer
      url="https://cdn.example.com/recording.mcap"
      theme={theme}
      language={lang}
      preferencePersistence="off"
      onThemeChange={handleThemeChange}
      onLanguageChange={setLang}
    />
  );
}
```

---

## 进阶：Foxglove 布局迁移

若团队使用 Foxglove Studio 布局，可直接导入：

```tsx
import { importFoxgloveLayout } from '@ioai/rosview';

// layout 为 Foxglove 布局 .json 文件解析得到的对象
const result = importFoxgloveLayout(layout);
if (result.success) {
  console.log('Imported panels:', result.panelCount);
} else {
  console.warn('Import failed:', result.error);
}
```

---

## 进阶：自定义标注流程

```tsx
import { RosViewer, useAnnotationController } from '@ioai/rosview';

function AnnotationApp() {
  const controller = useAnnotationController({
    dictionary: {
      skills: [
        { id: 'pick', label: 'Pick object' },
        { id: 'place', label: 'Place object' },
      ],
    },
    onAnnotationsChange: ({ annotations }) => {
      console.log('Updated annotations:', annotations.length);
    },
    onExport: async (payload) => {
      await fetch('/api/annotations', {
        method: 'POST',
        body: JSON.stringify(payload),
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });

  return (
    <RosViewer
      url="https://cdn.example.com/recording.mcap"
      theme="dark"
    />
  );
}
```

---

## 打包工具配置

### Vite（推荐）

通常无需额外配置。Worker 导入（`?worker`）由 Vite 自动处理。

```ts
// vite.config.ts — 无需 ROSView 专用配置
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
});
```

### Webpack 5

启用 WebAssembly 与 Worker 支持：

```js
// webpack.config.js
module.exports = {
  experiments: {
    asyncWebAssembly: true,
  },
};
```

### Next.js（App Router / Turbopack）

ROSView 是纯浏览器端组件（依赖 Web Worker、WASM、`window` 等），**不能在服务端渲染**。在 Next.js 中集成时遵循以下三点即可：

**1. 在 `next.config.js` 中转译本包**

```js
// next.config.js
const nextConfig = {
  transpilePackages: ['@ioai/rosview'],
};

module.exports = nextConfig;
```

**2. 用客户端组件包裹，并以 `ssr: false` 动态加载**

`ssr: false` 只能在**客户端组件**里使用，不能直接在服务端组件（如 `page.tsx`）里对 `next/dynamic` 使用。因此请新建一个 `'use client'` 包裹组件：

```tsx
// components/RosViewerClient.tsx
'use client';

import '@ioai/rosview/style.css';
import dynamic from 'next/dynamic';

// 仅在客户端加载，避免 SSR 阶段触碰浏览器 API
const RosViewer = dynamic(
  () => import('@ioai/rosview').then((m) => ({ default: m.RosViewer })),
  { ssr: false },
);

export function RosViewerClient({ url }: { url: string }) {
  return (
    <div style={{ width: '100%', height: '100vh' }}>
      <RosViewer url={url} theme="dark" />
    </div>
  );
}
```

```tsx
// app/visualize/page.tsx —— 服务端组件直接渲染上面的客户端组件
import { RosViewerClient } from '@/components/RosViewerClient';

export default async function VisualizePage({
  searchParams,
}: {
  searchParams: Promise<{ url?: string }>;
}) {
  const { url } = await searchParams;
  return <RosViewerClient url={url ?? ''} />;
}
```

**3.（可选）提供支持 HTTP Range 的文件接口**

要流式可视化本地/私有的 mcap/bag，可在 Next.js 中提供一个支持 `Accept-Ranges` 的 GET 路由，把 `url` 指向它即可：

```ts
// app/api/recording/route.ts
import fs from 'node:fs';
import { NextRequest, NextResponse } from 'next/server';

export async function GET(req: NextRequest) {
  const filePath = '/data/recording.mcap'; // 经过校验的安全路径
  const { size } = await fs.promises.stat(filePath);
  const range = req.headers.get('range');

  // 无 Range：返回整文件，但仍声明支持 Range
  if (!range) {
    const stream = fs.createReadStream(filePath);
    return new NextResponse(stream as unknown as ReadableStream, {
      status: 200,
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(size),
        'Accept-Ranges': 'bytes',
      },
    });
  }

  const [startStr, endStr] = range.replace('bytes=', '').split('-');
  const start = Number(startStr);
  const end = endStr ? Number(endStr) : size - 1;
  const stream = fs.createReadStream(filePath, { start, end });

  return new NextResponse(stream as unknown as ReadableStream, {
    status: 206,
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Content-Length': String(end - start + 1),
      'Accept-Ranges': 'bytes',
    },
  });
}
```

> **关于 `db3`**：db3 与其他格式一样，**本地 `File`** 与**远程 URL** 两种方式都支持，直接把上面 Range 接口的地址传给 `url` 即可。但由于 SQLite 需要随机访问整库，db3 **无法像 mcap / bag 那样按 Range 流式加载**——传入 db3 的 URL 时，ROSView 会在 Worker 内**自动整文件下载**后再打开（带下载进度）。因此对超大 db3，建议优先转换为 MCAP 以获得真正的流式体验。你无需再在宿主侧手动下载为 `File`。

> **版本要求**：请使用 **`@ioai/rosview` ≥ 1.3.5**（依赖 `@ioai/wasm-zstd` ≥ 1.1.2）。1.3.5 新增了 db3 的远程 URL 加载，并修复了 1.3.4 在 Turbopack 下因 inline worker 以 `blob:` URL 运行、无法解析 zstd glue 相对动态 import 而抛出的 `Failed to resolve module specifier './wasm-zstd-*.js'`；`@ioai/wasm-zstd` 1.1.2 将 glue 静态内联进 worker，彻底解决该问题。

---

## 故障排查

### "SharedArrayBuffer is not defined"

部分 WASM 解码器（bz2、lz4）在可用时会利用 `SharedArrayBuffer`。服务器需返回以下响应头：

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

即使没有这些头，组件仍可工作；相关解码器会退回到非共享内存模式。

### 远程文件出现 "Failed to load: ..."

远程文件必须通过 CORS 允许你的应用来源，例如：

```
Access-Control-Allow-Origin: https://your-app.example.com
```

### 大文件加载慢

- 确认服务器支持 **HTTP Range**（`Accept-Ranges: bytes`）。
- 不支持 Range 时，往往需要整文件下载完成后才能开始回放。

### Firefox 中的 Worker 错误

Firefox 对 Worker 的 CSP 更严格。若使用 `Content-Security-Policy` 响应头，请添加 `worker-src 'self' blob:`。

### "Failed to resolve module specifier './wasm-zstd-*.js'"

该错误出现在 `@ioai/rosview` 1.3.4（搭配 `@ioai/wasm-zstd` 1.1.1）在以 `blob:` URL 运行 inline worker 的打包器（如 Next.js Turbopack）下。升级到 **`@ioai/rosview` ≥ 1.3.5**（`@ioai/wasm-zstd` ≥ 1.1.2）即可修复——新版本会将 zstd glue 静态内联进 worker，不再有运行时相对动态 import。

---

## TypeScript 支持

包内提供完整类型声明，可直接导入类型：

```ts
import type {
  RosViewerProps,
  FileListItem,
  PreferencePersistence,
} from '@ioai/rosview';
```

---

## 宿主扩展与业务逻辑

RosView **不包含**具体业务的标注、质检规则或持久化。宿主应用应：

1. 在 `RosViewer` 上传入不透明 `hostContext`（例如 `{ datasetId, canAnnotate }`），在扩展里通过 `context.hostContext` 读取。
2. 使用 `extensions` 实现侧边栏与 `playbackOverlays` / `timelineOverlays`，并结合 `context.playback`、`context.timeline`、`context.messages`。
3. 将所有 REST、权限与领域模型保留在宿主应用内。


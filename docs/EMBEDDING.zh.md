# 嵌入指南 — @ioai/rosview

> English: [EMBEDDING.md](EMBEDDING.md)

本指南说明如何将 ROSView 作为可嵌入的 React 组件集成到你自己的应用中。

---

## 前置条件

- React ≥ 19 与 react-dom ≥ 19
- 支持 ES 模块与 Web Workers 的打包工具（推荐 Vite；Webpack 5+ 需适当配置）
- Node.js ≥ 22（与 `package.json` 中 `engines` 一致；CI 使用 Node 24）

---

## 安装

```bash
npm install @ioai/rosview
```

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


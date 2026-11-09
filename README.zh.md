# ROSView &nbsp;·&nbsp; [在线演示 →](https://rosview.com) &nbsp;·&nbsp; [npm: @ioai/rosview](https://www.npmjs.com/package/@ioai/rosview) &nbsp;·&nbsp; [English](README.md)

[![CI](https://github.com/ioai-tech/rosview/actions/workflows/ci.yml/badge.svg)](https://github.com/ioai-tech/rosview/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@ioai/rosview)](https://www.npmjs.com/package/@ioai/rosview)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

> 高性能、浏览器原生的机器人数据可视化。从零构建的 Foxglove Studio 现代替代方案 —— 基于 React 19、Vite 8 与 Web Workers。

支持 **MCAP**、**ROS 1 bag**、**ROS 2 db3**、**HDF5** 与 **BVH** 文件。可作为独立 SPA（零安装，访问 [rosview.com](https://rosview.com)）或作为可嵌入的 npm 包使用。

<p align="center">
  <a href="https://rosview.com">
    <img src="docs/assets/rosview-demo.webp" alt="ROSView 演示 — Realman pick and place" width="920">
  </a>
</p>

---

## 文档

| 文档 | 说明 |
|------|------|
| [嵌入指南（中文）](docs/EMBEDDING.zh.md) | 将 `@ioai/rosview` 集成到 React 应用（打包器、清单、排错）。 |
| [API 参考（中文）](docs/API.zh.md) | 公开导出：`RosViewer` props、类型、偏好、布局工具、扩展。 |
| [架构（英文）](docs/ARCHITECTURE.md) | 需求、设计与技术说明（SPA + npm）；[中文版](docs/ARCHITECTURE.zh.md)。 |
| [开发（英文）](docs/DEVELOPMENT.md) | 本地环境、测试、Playwright、fixture。 |
| [发版（英文）](docs/RELEASE.md) | 维护者流程：版本号、tag、npm 与 GitHub Release。 |
| [贡献指南](CONTRIBUTING.md) | 分支流程、提交规范、PR 自检。 |
| [安全策略](SECURITY.md) | 支持版本与负责任披露。 |
| [文档索引（英文）](docs/README.md) | 全部文档路径一览。 |

**English:** [README](README.md) · [Embedding](docs/EMBEDDING.md) · [API](docs/API.md) · [Architecture](docs/ARCHITECTURE.md)

---

## 功能特性

- **多格式** — MCAP · ROS 1 `.bag` · ROS 2 `.db3` · HDF5 `.h5/.hdf5` · BVH 骨骼动画
  - 无索引 MCAP（无 summary，如流式写入或被截断的录制）会在加载时自动建立索引
  - 全身遥操作 MCAP（`whole_body.frame`，如 Unitree G1 + Dex3）会被拆分为相机、关节状态和基座位姿话题
  - 无索引 MCAP 的索引会缓存在 IndexedDB 中，再次打开（包括 HTTP 远程文件）无需重新扫描
- **内置机器人模型** — 录制中有匹配的关节状态但没有 `robot_description` 时，3D 面板会自动加载内置的 Unitree G1 URDF
- **Worker 解析** — 专用 Web Worker + Comlink；主线程尽量不被阻塞
- **HTTP Range 流式加载** — 无需整文件下载即可开始回放
- **多面板布局** — 基于 DockView 的可拖拽、可停靠面板
- **可视化面板** — 图像（H.264）、3D（点云、URDF、TF）、Plot（uPlot）、关节、地图、音频、RawMessages、TopicGraph、位姿
- **Foxglove 布局兼容** — 导入 / 导出 Foxglove Studio 布局
- **国际化** — English · 简体中文 · 日本語
- **明 / 暗 / 跟随系统** 主题
- **扩展 API** — 注册第三方侧边栏 Tab 与播放条上方叠加区域

---

## 快速开始（SPA）

在 Chrome 或 Edge 中打开 **[rosview.com](https://rosview.com)**，无需安装。

可通过 URL 参数直达文件：

```
https://rosview.com?url=https://your-server.com/recording.mcap
https://rosview.com?url=/examples/run.mcap
https://rosview.com?url=file://run.mcap
https://rosview.com?url=folder://MyDataset
https://rosview.com?url=sample://franka_stack
https://rosview.com?url=https://your-server.com/recording.mcap&theme=dark&language=zh
```

远程 manifest 与多 URL 请在 npm 集成时使用 `fileManifest` / `urls` props。

### 自托管

```bash
git clone https://github.com/ioai-tech/rosview.git
cd rosview
npm install
npm run dev          # 开发服务器 http://localhost:5173
npm run build        # 生产 SPA → dist/
```

---

## 嵌入（npm 包）

### 安装

```bash
npm install @ioai/rosview
```

> **Peer dependencies**：项目中需已安装 React **≥ 19.2**（含 19.3）、react-dom ≥ 19.2 以及 `three`（≥ 0.173）。`@react-three/fiber` 与 `@react-three/drei` 不再是 peer。若当初仅为 ROSView 安装它们，请卸载。若宿主自己的画布仍使用 React Three Fiber，请把 fiber/drei 留在**宿主**依赖中。其它运行时库已打进 `@ioai/rosview`，不要在宿主里再装一份。详见 [嵌入指南](docs/EMBEDDING.zh.md)。

### 引入样式表

```tsx
import '@ioai/rosview/style.css';
```

### 基本用法

```tsx
import { RosViewer } from '@ioai/rosview';

export function MyApp() {
  return (
    <RosViewer
      url="https://your-server.com/recording.mcap"
      theme="dark"
      language="en"
    />
  );
}
```

### 加载本地文件

```tsx
import { RosViewer } from '@ioai/rosview';

export function FileLoader() {
  const [file, setFile] = React.useState<File>();

  return (
    <>
      <input type="file" accept=".mcap,.bag,.db3,.h5,.hdf5,.bvh"
        onChange={e => setFile(e.target.files?.[0])} />
      {file && <RosViewer file={file} theme="system" />}
    </>
  );
}
```

### 多数据源 + 远程清单

```tsx
<RosViewer
  urls={['https://cdn.example.com/run1.mcap', 'https://cdn.example.com/run2.mcap']}
  fileManifest="https://cdn.example.com/manifest.json"
  theme="dark"
  language="zh"
  onFatalError={(err) => console.error('Fatal:', err)}
/>
```

**`manifest.json`** 格式：

```json
[
  { "url": "https://cdn.example.com/run1.mcap", "name": "Run 1", "sizeBytes": 1073741824 },
  { "url": "https://cdn.example.com/run2.mcap", "name": "Run 2", "durationSec": 120 }
]
```

---

## 支持的文件格式

| 格式 | 扩展名 | 说明 |
|------|--------|------|
| MCAP | `.mcap` | ROS 2 / 机器人常用；zstd、lz4 压缩 |
| ROS 1 bag | `.bag` | ROS 1 录制格式 |
| ROS 2 SQLite | `.db3` | ROS 2 默认录制（`sql.js` WASM） |
| HDF5 | `.h5`, `.hdf5` | 科学数据；`@ioai/hdf5` WASM 读取 |
| BVH | `.bvh` | 动作捕捉骨骼动画 |

所有格式均在浏览器内通过 Web Worker 解析，无需服务端转码。

---

## 键盘快捷键

| 按键 | 作用 |
|------|------|
| `Space` | 播放 / 暂停 |
| `←` / `→` | 上一帧 / 下一帧 |
| `[` / `]` | 减速 / 加速 |
| `Home` | 跳到开头 |
| `End` | 跳到结尾 |

---

## URL 参数（SPA）

| 参数 | 示例 | 说明 |
|------|------|------|
| `url` | `?url=https://…/file.mcap` 或 `?url=/examples/run.mcap` | 单个远程文件；加载/切换时用 `pushState` 更新 |
| `url` | `?url=file://name.mcap` | 本地文件定位符（从「最近打开」/IndexedDB 句柄恢复） |
| `url` | `?url=folder://MyDataset` | 本地文件夹定位符 |
| `url` | `?url=sample://franka_stack` | 示例 id（依赖构建时 manifest：`VITE_SAMPLE_DATASETS_MANIFEST_URL` / `VITE_SAMPLES_BASE_URL`） |
| `theme` | `?theme=dark` | `light` · `dark` · `system` |
| `language` | `?language=zh` | `en` · `zh` · `ja` |

多远程 URL 或远程 manifest 请使用 npm 嵌入时的 `urls` / `fileManifest` props，独立 SPA 查询串只维护单个 `url`。

---

## API 参考

完整组件 props、TypeScript 类型、工具函数与高级嵌入模式见 [docs/API.zh.md](docs/API.zh.md)（或英文 [docs/API.md](docs/API.md)）。

---

## 参与贡献

欢迎 Issue 与 Pull Request。提交前请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。

- **缺陷报告** — 使用 [Bug Report](.github/ISSUE_TEMPLATE/bug_report.yml) 模板  
- **功能建议** — 使用 [Feature Request](.github/ISSUE_TEMPLATE/feature_request.yml) 模板  
- **安全漏洞** — 见 [SECURITY.md](SECURITY.md)

---

## 许可

[MIT](LICENSE) © 2026 [IO-AI Tech](https://rosview.com)

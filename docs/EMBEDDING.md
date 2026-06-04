# Embedding Guide — @ioai/rosview

> Simplified Chinese: [EMBEDDING.zh.md](EMBEDDING.zh.md)

This guide walks through integrating ROSView as an embeddable React component into your own application.

---

## Prerequisites

- React ≥ 19 and react-dom ≥ 19
- A bundler that supports ES modules and Web Workers (Vite recommended; Webpack 5+ works with configuration)
- Node.js ≥ 22 (matches `engines` in `package.json`; CI uses Node 24)

---

## Installation

```bash
npm install @ioai/rosview
```

---

## Step 1 — Import the stylesheet

The component requires its bundled CSS. Import it once at your application root:

```tsx
// main.tsx or App.tsx (top-level entry point)
import '@ioai/rosview/style.css';
```

Styles are scoped to `#rosview-root` inside the bundle, so Tailwind preflight does not reset global elements (navbar, buttons, etc.) in your host application.

---

## Step 2 — Basic usage

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

The component defaults to `height: 100vh`. Use the `className` or `style` props to constrain its dimensions when embedding within a larger page.

By default `urlState` is `'off'`: the viewer does **not** call `history.pushState` or interpret `file://` / `folder://` in the `url` prop as restorable locators. Use `urlState="spa"` only if you are building a full-page app that owns the address bar (same behavior as the standalone site).

---

## Step 3 — Local file picker

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

## Step 4 — Remote dataset manifest

For data portals or review dashboards with many recordings, serve a JSON manifest:

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

Then pass the manifest URL:

```tsx
<RosViewer
  fileManifest="https://cdn.example.com/manifest.json"
  theme="dark"
/>
```

Or pass the parsed rows directly (if you already fetched and filtered them):

```tsx
import { parseRemoteDatasetListJson } from '@ioai/rosview';

const res = await fetch('/api/datasets');
const rows = parseRemoteDatasetListJson(await res.json());

<RosViewer fileManifest={rows} />
```

---

## Advanced: Navbar branding

The navbar shows **ROS View** on the left by default. When embedding inside a larger app, you can hide it or replace it with your product name:

```tsx
// Hide the brand button (File / Layout menus remain)
<RosViewer url="..." showNavbarBrand={false} />

// Replace with host branding
<RosViewer url="..." navbarBrandLabel="Acme Data Portal" />
```

Related props:

| Prop | Description |
|------|-------------|
| `showNavbarBrand` | Left brand button visibility (`true` by default). |
| `navbarBrandLabel` | Custom brand text; defaults to the localized product name. |
| `navbarSourceName` | Center label for the active dataset (separate from brand). |
| `showNavbar` | Hides the entire navbar when `false` (via `chrome` or explicit prop). |

---

## Advanced: Controlled theme & language

Disable internal localStorage persistence and fully control state from your application:

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

## Advanced: Foxglove layout migration

If your team uses Foxglove Studio layouts, you can import them directly:

```tsx
import { importFoxgloveLayout } from '@ioai/rosview';

// layout is the JSON object from a .json Foxglove layout file
const result = importFoxgloveLayout(layout);
if (result.success) {
  console.log('Imported panels:', result.panelCount);
} else {
  console.warn('Import failed:', result.error);
}
```

---

## Advanced: Custom annotation workflow

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

## Bundler configuration

### Vite (recommended)

No special configuration needed. Worker imports (`?worker`) are handled by Vite automatically.

```ts
// vite.config.ts — no ROSView-specific config required
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
});
```

### Webpack 5

Enable WebAssembly and Worker support:

```js
// webpack.config.js
module.exports = {
  experiments: {
    asyncWebAssembly: true,
  },
};
```

### Next.js (App Router / Turbopack)

ROSView is a browser-only component (it relies on Web Workers, WASM, `window`, etc.) and **cannot be server-rendered**. Integrating it into Next.js takes three steps:

**1. Transpile the package in `next.config.js`**

```js
// next.config.js
const nextConfig = {
  transpilePackages: ['@ioai/rosview'],
};

module.exports = nextConfig;
```

**2. Wrap it in a Client Component loaded with `ssr: false`**

`ssr: false` is only allowed inside a **Client Component** — you cannot use it with `next/dynamic` directly in a Server Component (e.g. `page.tsx`). So create a `'use client'` wrapper:

```tsx
// components/RosViewerClient.tsx
'use client';

import '@ioai/rosview/style.css';
import dynamic from 'next/dynamic';

// Client-only load to avoid touching browser APIs during SSR
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
// app/visualize/page.tsx — a Server Component rendering the client wrapper
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

**3. (Optional) Serve files through a Range-capable route**

To stream local/private mcap/bag recordings, expose a GET route that supports `Accept-Ranges` and point `url` at it:

```ts
// app/api/recording/route.ts
import fs from 'node:fs';
import { NextRequest, NextResponse } from 'next/server';

export async function GET(req: NextRequest) {
  const filePath = '/data/recording.mcap'; // validated, safe path
  const { size } = await fs.promises.stat(filePath);
  const range = req.headers.get('range');

  // No Range: return the whole file but still advertise Range support
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

> **About `db3`:** Like the other formats, db3 supports both a **local `File`** and a **remote URL** — just point `url` at the Range route above. However, because SQLite needs random access to the whole database, db3 **cannot be Range-streamed** the way mcap / bag are: when given a db3 URL, ROSView **downloads the file in full inside the Worker** (with download progress) before opening it. For very large db3 files, prefer converting to MCAP for true streaming. You no longer need to download the db3 as a `File` yourself on the host side.

> **Version requirement:** Use **`@ioai/rosview` ≥ 1.3.5** (which depends on `@ioai/wasm-zstd` ≥ 1.1.2). 1.3.5 adds remote-URL loading for db3 and fixes the Turbopack inline-worker regression from 1.3.4 (`Failed to resolve module specifier './wasm-zstd-*.js'`, caused by the inline worker running from a `blob:` URL and unable to resolve the zstd glue's relative dynamic import). `@ioai/wasm-zstd` 1.1.2 statically inlines the glue into the worker, fixing this for good.

---

## Troubleshooting

### "SharedArrayBuffer is not defined"

Some WASM decoders (bz2, lz4) benefit from `SharedArrayBuffer`. Your server must send the following headers:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

The component works without these headers; affected decoders fall back to non-shared memory.

### "Failed to load: ..." with remote files

Remote files must be served with CORS headers that allow your application's origin:

```
Access-Control-Allow-Origin: https://your-app.example.com
```

### Large files load slowly

- Ensure the server supports **HTTP Range requests** (`Accept-Ranges: bytes`).
- Files without Range support are downloaded in full before playback can start.

### Worker errors in Firefox

Firefox has stricter CSP enforcement for workers. If you use a `Content-Security-Policy` header, add `worker-src 'self' blob:`.

### "Failed to resolve module specifier './wasm-zstd-*.js'"

This occurs with `@ioai/rosview` 1.3.4 (paired with `@ioai/wasm-zstd` 1.1.1) under bundlers that run inline workers from `blob:` URLs, such as Next.js Turbopack. Upgrade to **`@ioai/rosview` ≥ 1.3.5** (`@ioai/wasm-zstd` ≥ 1.1.2) — newer versions statically inline the zstd glue into the worker, removing the runtime relative dynamic import.

---

## TypeScript support

The package ships full TypeScript declarations. Import types directly:

```ts
import type {
  RosViewerProps,
  FileListItem,
  PreferencePersistence,
} from '@ioai/rosview';
```

---

## Host extensions and business logic

RosView ships **no** product-specific annotation, QC rules, or persistence. Host applications should:

1. Pass opaque `hostContext` on `RosViewer` (for example `{ datasetId, canAnnotate }`) and read `context.hostContext` inside `extensions`.
2. Implement sidebar tabs and `playbackOverlays` / `timelineOverlays` using `context.playback`, `context.timeline`, and optionally `context.messages.getMessagesInTimeRange`.
3. Keep all REST calls, permissions, and domain models in the host app.


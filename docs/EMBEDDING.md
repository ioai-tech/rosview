# Embedding Guide — @ioai/rosview

> Simplified Chinese: [EMBEDDING.zh.md](EMBEDDING.zh.md)

This guide walks through integrating ROSView as an embeddable React component into your own application.

---

## Prerequisites

- React ≥ 19.2 (including 19.3) and react-dom ≥ 19.2
- `three` ≥ 0.173 (peer; ROSView does not bundle it)
- A bundler that supports ES modules and Web Workers (Vite recommended; Webpack 5+ works with configuration)

Installing the published package does not require a particular Node.js version beyond a current npm client. **Developing this repository** uses Node 24 (see `CONTRIBUTING.md` / `.nvmrc`). `package.json` `engines.node` is `>=18` so host apps are not blocked by our CI Node version.

---

## Installation

```bash
npm install @ioai/rosview
```

`@react-three/fiber` and `@react-three/drei` are **not** peers. Hosts that installed them **only** for ROSView should uninstall them. Hosts that still use React Three Fiber for their own canvases keep fiber/drei as **host** dependencies. `three` remains required.

Peer packages must already be in the host app (npm 7+ will install missing peers automatically). Other libraries ROSView uses at runtime (Dockview, MCAP, Foxglove codecs, Radix, and so on) are **already bundled** into `@ioai/rosview`. Do not add them as extra dependencies of your app “so rosview works” — that duplicates copies and can break the host lockfile.

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

### Narrow containers and keyboard shortcuts

When the viewer's own content area is narrower than 640px (the container, not the window), the sidebar moves below the player and the split becomes vertical. The panels are reordered, not remounted, so the Dockview layout and sidebar state survive the change. Sidebar tabs show icons with accessible names when the sidebar itself is narrower than 320px.

Global playback shortcuts (Space, arrow keys) are ignored while focus is in a text field, a select, or an interactive control that owns those keys: tabs, sliders, radios, checkboxes, menus, listboxes and dialogs. Space is also left to a focused button or link. Ctrl/Cmd chords without Alt are left to the browser and the host; Alt+Ctrl/Cmd+Arrow still steps by 100 ms.

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

## Advanced: Presigned URLs, streaming and the in-tab cache

RosView reads remote recordings with small HTTP Range requests (512 KiB blocks, at most a few MiB per request): for an indexed MCAP it fetches the summary and chunk index, then only the chunks around the playhead, so the first image appears after a few hundred kilobytes rather than after the whole file. While paused (on open and after a seek) it reads only what the frame at the playhead needs — the chunks at that time plus, through the chunk and message indexes, the latest message of each panel's topic even when it sits in a chunk written at the end of the file (a map or `/tf_static` stamped at the first frame) — shows each panel's frame as soon as its own bytes arrive, and then stops reading. Time-series panels (Plot, Align, Timeline) also read their time window while paused — a Plot reads ±30 s around the playhead, and the auto layout of a robot recording adds JointState and Imu plots — once per window, after which the bytes are cached. Read-ahead (the next few seconds of recording, never the space between distant chunks) runs only while playing. Downloaded blocks are kept **in memory for the lifetime of the page only** (default budget 512 MiB, least-recently-used). Nothing is written to IndexedDB, Cache Storage or OPFS, so recording bytes cannot outlive a logout or an erasure. Reopening a recording with the same `sourceKey` in the same tab re-reads nothing that is still cached: one 1-byte request checks its size and version (`ETag`; another version is never served from the cache), or none when you pass `knownTotalBytes`. Set `preferencePersistence="off"` to also disable the recent-files history.

```tsx
import { RosViewer, clearCache } from '@ioai/rosview';

<RosViewer
  url={presignedUrl}
  sourceKey={recording.id}            // host-stable id, never the signed URL
  urlExpiresAt={expiresAtIso}         // optional: renew 60 s before expiry
  refreshUrls={async (expired) => fetchFreshUrls(expired)} // same order, same length
  preferencePersistence="off"
/>

// On logout, membership removal or erasure:
clearCache();
```

- `sourceKey` lets the same recording reopen in the same tab (for example Data, then Raw, then Data) from memory, and keeps the cache across a URL refresh. It must change when the content changes (include a version or ETag); a differing server `ETag` also purges the entry. It is honoured only while the viewer has exactly one remote source.
- `refreshUrls(expired)` is called at most once per batch, with the current URL of every open remote source, when a request gets 401 or 403 or starts within 60 s of `urlExpiresAt`. Resolve to the new URLs in the same order. The failed request is retried once; position, layout and panels are kept. If the new URL fails as well, the ordinary source error is shown and RosView stops asking for 30 s. A host that changes the `url` prop instead restarts the viewer; use `refreshUrls` to avoid that.
- The bucket / server CORS rules must apply to **error responses too** (403 included) and expose `Content-Range`, `Content-Length`, `ETag` and `Accept-Ranges`. Without CORS headers on a 403 the browser reports a network error and RosView cannot tell an expired URL from an outage; it then renews only when `urlExpiresAt` has passed (or is within 60 s).
- `refreshUrls` receives the URL strings exactly as you passed them to `url` / `urls` (never made absolute).
- A range request that receives no bytes for 20 s (60 s while waiting for the response) is stalled: RosView aborts it and asks once more for the bytes still missing. If that stalls too, the read fails with `RangeStallError` ("No data arrived from the server for 20 s …"); a Plot shows that message instead of loading forever, and playback reports a source error.
- `clearCache()` drops every cached byte of every viewer on the page and aborts in-flight range requests.
- Unindexed MCAP is scanned once through the same cache (the scan result stays in memory only when embedded). ROS 1 `.bag` reads through ranges too; ROS 2 `.db3` (SQLite) must still be downloaded whole, and renews its URL once if it gets 401/403.

## Advanced: Auto layout, copy and layout reset

`preferAutoLayout` builds the default panels from the topics:

- Image topics, at most six, ranked `head`, `front`, `wrist`, `left`, `right`, `rgb`/`color`, others, then `depth` and `ir`; a `left`/`right` pair stays side by side. One to three cameras are one row, four are 2x2, five or six are 3x2.
- One Plot of `position[:]` per `sensor_msgs/JointState` topic (measured streams before command streams, at most four) and one per `sensor_msgs/Imu` topic (angular velocity and linear acceleration).
- A 3D panel only when there are TF or pose topics (or a BVH skeleton) **and** the browser has WebGL; a Pose panel for pose topics.
- Raw Messages as a thin strip at the bottom (the only panel when nothing else applies).

Plots draw while messages arrive. For remote range-backed recordings a Plot reads only a window of +/- 30 s around the playhead and recentres it as the playhead moves (its x axis follows the window); it never preloads the whole file. A hint above the chart says so. Local files keep reading the full range; in a merged set that contains any remote source, every Plot uses the window. The embedded root renders a labelled `region`, not a `<main>` landmark.

`messages` replaces viewer copy by message id (ICU strings, applied over en / zh / ja; `RosViewMessageKey` lists the ids):

```tsx
<RosViewer messages={{ 'layout.viewerRegion': 'Recording viewer' }} />
```

`layoutStorageKey` isolates the saved layout per host (use a key that includes your app name). `resetLayout()` is passed to `onPlayerReady({ player, hasSource, resetLayout })`; it forgets the saved layout under that key and restores `initialLayout` / `defaultPanel`, or the auto layout. The navbar Layout menu has the same "Reset layout" entry.

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


# Development, fixtures, and release checks

## Commands

| Command | Purpose |
|---------|---------|
| `npm run dev` | Vite dev server (default `http://localhost:5173`). |
| `npm run lint` | ESLint on `src/**/*.ts(x)` and `tests/**/*.ts`. |
| `npm run test` | Vitest unit tests. |
| `npm run build` | `tsc` + Vite **SPA** build only (`vite.config.ts` → `dist/`). |
| `npm run build:lib` | `tsc` + Vite lib build (`vite.lib.config.ts` → JS/CSS/WASM) + `build:lib:types` (tsc → `.tmp-dts`, api-extractor → `dist-lib/*.d.ts`); used by `prepublishOnly` and embedders. |
| `npm run test:e2e` | Playwright (requires fixture MCAP; see below). |

## Fixtures

Committed sources live under **`test-fixtures/`** (layouts, minimal HDF5/BVH, H264/JPEG bytes). Playwright copies or generates runtime files into **`public/examples/`** (gitignored) via:

```bash
npm run gen:e2e:fixtures
```

This runs automatically as `pretest:e2e` before `npm run test:e2e`.

| Generated file (`public/examples/`) | Purpose |
|-------------------------------------|---------|
| `test_5s.mcap` | Basic MCAP playback, dockview, transport |
| `test_pose.mcap` | PoseStamped sidebar topics |
| `test_3cam.mcap` | Three-camera image grid layout |
| `test_h264.mcap` | H.264 CompressedImage decode |
| `test_minimal.hdf5` | ALOHA-schema HDF5 (~7 KB) |
| `test_minimal.bvh` | Minimal BVH skeleton |
| `test_multi_base.mcap` | Multi-source merge: "base recording" (camera + `/joint_states`, 0-5s) |
| `test_multi_incremental.mcap` | Multi-source merge: separately-authored file adding one topic, 3-7s |
| `test_multi_filtered.mcap` | Multi-source merge: derived from `test_multi_base.mcap` via the real `mcap filter` CLI — **optional**, see below |
| `test_multi.bag` | Multi-source merge: ROS1 bag for mcap+bag mixed-format tests (copied from the committed `test-fixtures/media/minimal-multi.bag`) |

Vitest layout round-trip tests import JSON directly from `test-fixtures/layouts/`.

### Optional external tools

Two fixtures depend on a tool that isn't an npm package. Their generator scripts detect absence and skip (exit 0, no output file) rather than failing the whole `gen:e2e:fixtures` run; Playwright specs that need one of these files check for it and `test.skip()` themselves when it's missing.

- **`mcap` CLI** (Rust rewrite, `mcap --version` ≥ 0.1) — a local-only debugging tool, needed only to (re)generate `test_multi_filtered.mcap` via `mcap filter`. Install with `brew install mcap` or download a binary from <https://github.com/foxglove/mcap/releases?q=mcap-cli>. **CI does not install it**: `test_multi_filtered.mcap` and the one Playwright spec that depends on it simply skip there; everything else runs normally.
- **`rosbags`** Python package — needed only to *regenerate* the committed `test-fixtures/media/minimal-multi.bag` source (e.g. after changing its schema in `scripts/gen-test-bag.py`); `npm run gen:e2e:fixtures` just copies that committed file into `public/examples/test_multi.bag`, so CI and most contributors never need to install it. If you do: `pip install rosbags`.

For sample deep links (`?url=sample://…`), set `VITE_SAMPLE_DATASETS_MANIFEST_URL` in `.env` to a reachable JSON manifest (see `src/services/sampleDatasets.ts`).

For remote lists in the browser during dev, prefer **same-origin** URLs, e.g.  
`http://localhost:5173/?url=/examples/test_5s.mcap`  
so Vite serves static files and Range requests correctly.

## Performance gates

### Manual baseline (recommended for PR notes)

| Scenario | Action | Goal (suggested) |
|----------|--------|------------------|
| ~1GB MCAP | Open via `?url=` until first frame is usable | Note seconds; watch main-thread long tasks |
| Multi-panel playback | 3+ panels, 2× speed for 60s | No severe jank; memory stable |
| Remote Range | Large file over HTTP Range | Time to first useful frame / draggable scrubber |

### Automated checks

- `npm run lint`, `npm run test`, `npm run build` (SPA), `npm run build:lib` (when validating the npm bundle), `npm run test:e2e` (with fixtures).
- CI: see `.github/workflows/ci.yml` (Node version should match `package.json` `engines`).

### WASM re-evaluation

Prefer main-thread rendering and subscription tuning before MCAP-parse WASM. Consider a WASM PoC only if worker traces show deserialize dominating, main-thread R3F cost is already low, and message latency still needs improvement.

## Acceptance (multi-source MCAP)

**Prerequisites**

1. `npm install` and (first time) `npx playwright install`.
2. `npm run gen:e2e:fixtures` (also runs automatically before `test:e2e`).
3. `npm run dev` → `http://localhost:5173`.

**Playwright**

```bash
npm run test:e2e
```

**Manual checks (e.g. Chrome DevTools MCP)**

1. Open  
   `http://localhost:5173/?url=/examples/test_5s.mcap`  
   Confirm Dockview loads; no fatal console errors.
2. Sidebar shows Topics / Data / Tags (or localized equivalents).
3. Switch to **Data** if multiple sources are present; the successfully loaded row is highlighted.
4. Open `/`, upload or drag a local `.mcap`; confirm load succeeds.

Full E2E coverage requires `npm run gen:e2e:fixtures` so `public/examples/` is populated; no files outside the repo are needed.

## Acceptance (multi-source merge)

Loading multiple recording files together (any mix of `.mcap`/`.bag`/`.db3`/`.hdf5`/`.bvh`) merges them into one session: topics from every file are concatenated in file order, and the playback range becomes the union of each file's time range. See `tests/multi-sources.spec.ts` for the automated coverage (multi-mcap merge, mcap+bag mixed formats, merging into an already-active session, Data tab grouping).

**Manual checks**

1. `npm run gen:e2e:fixtures`, then `npm run dev`.
2. Drag `public/examples/test_multi_base.mcap` onto the welcome screen; confirm it loads with 2 topics (`/camera/front/image_raw/compressed`, `/joint_states`) and a 0-5s range.
3. Drag `public/examples/test_multi_incremental.mcap` in on top of the already-loaded session; confirm the topic list grows to 3 topics and the playback range extends to 0-7s (the union), **without** switching away to a separate "Data" entry.
4. Open the new topic's "more" menu (`⋯` in the sidebar Topics tab); confirm it shows a "Source: …" line naming both files once a topic name happens to be shared, or the single owning file otherwise.
5. Optional, with the real `mcap` CLI installed and a large real-world recording on hand: split it into two files by topic/time range with `mcap filter in.mcap -o a.mcap -y /some/topic` (and a complementary `-n` regex for the rest), then load both together and confirm the merged topic count/time range match `mcap info` on the original file.

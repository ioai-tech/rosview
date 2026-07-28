/**
 * Library build for `@ioai/rosview`.
 *
 * Vite 8 production builds are Rolldown-backed; use `build.rolldownOptions` /
 * `worker.rolldownOptions` (see the [Vite 8 migration guide](https://vite.dev/guide/migration.html)).
 *
 * JS/CSS/WASM/workers are emitted here via `build.lib`. Type declarations are produced separately
 * (`tsc -p tsconfig.lib.json` → `.tmp-dts`, then `@microsoft/api-extractor` → `dist-lib/*.d.ts`).
 * The public entry `src/entrypoints/index.ts` re-exports via relative paths so rolled-up types stay
 * free of fragile `@/` paths for Next.js / pnpm consumers.
 *
 * WASM assets are loaded via Vite native `*.wasm?url` + `assetsInclude` (no vite-plugin-wasm).
 */
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { fileURLToPath } from 'node:url';

/** Directory containing this config file (avoids `process.cwd()` so entry paths stay stable). */
const packageDir = path.dirname(fileURLToPath(import.meta.url));

/** Keep React Three Fiber + three outside the library ESM chunk so Next.js (Turbopack) can transpile them. */
function libExternal(id: string): boolean {
  if (id === 'react' || id === 'react-dom' || id === 'react/jsx-runtime') return true;
  if (id === 'three' || id.startsWith('three/')) return true;
  if (id.startsWith('@react-three/')) return true;
  return false;
}

export default defineConfig({
  root: packageDir,
  define: {
    'import.meta.env.VITE_SAMPLE_DATASETS_MANIFEST_URL': JSON.stringify('off'),
  },
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.join(packageDir, 'src'),
    },
  },
  assetsInclude: ['**/*.wasm'],
  optimizeDeps: {},
  worker: {
    format: 'es',
    rolldownOptions: {
      output: {
        sourcemap: false,
      },
    },
  },
  build: {
    target: 'esnext',
    outDir: 'dist-lib',
    /** Flat dist-lib: WASM/HDF5 assets alongside chunks (no dist-lib/assets/). */
    assetsDir: '.',
    /** Library + worker chunks: no .map in dist-lib (smaller publish / vendored copy). */
    sourcemap: false,
    copyPublicDir: false,
    lib: {
      entry: {
        rosview: path.join(packageDir, 'src/entrypoints/index.ts'),
        'urdf-preview': path.join(packageDir, 'src/entrypoints/urdf-preview.ts'),
      },
      formats: ['es'],
      fileName: (_format, entryName) => `${entryName}.es.js`,
    },
    rolldownOptions: {
      onLog(level, log, defaultHandler) {
        if (level === 'warn' && typeof log !== 'string') {
          const paths = [log.id, log.loc?.file, ...(log.ids ?? [])].filter(Boolean) as string[];
          const inNodeModules = paths.some((p) => p.includes('/node_modules/'));
          const isViteResolveWarn =
            log.plugin === 'rolldown:vite-resolve' && log.message.includes('node_modules');
          if (inNodeModules || isViteResolveWarn) return;
        }
        defaultHandler(level, log);
      },
      external: libExternal,
      output: {
        assetFileNames: (assetInfo) => {
          if (assetInfo.name?.endsWith('.css')) return 'rosview.css';
          return '[name]-[hash][extname]';
        },
      },
    },
    cssCodeSplit: false,
  },
});

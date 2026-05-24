/**
 * Library build for `@ioai/rosview`.
 *
 * Vite 8 production builds are Rolldown-backed; `build.rollupOptions` remains the supported config
 * surface (compat layer). See the [Vite config reference](https://vite.dev/config/).
 *
 * Declarations are emitted by `vite-plugin-dts` during `vite build`; `rollupTypes: true` uses API
 * Extractor to merge into a single `rosview.d.ts` (see package.json `types`).
 * Set the plugin `compilerOptions.rootDir` to `<package>/src` and use an absolute `build.lib.entry`;
 * otherwise, when cwd is outside the package in a monorepo, `insertTypesEntry` can emit an empty
 * `export {}` and rollup output may be empty.
 * The public entry `src/entrypoints/index.ts` re-exports via relative paths so `@/` is not turned
 * into fragile `../../…` paths for Next.js / pnpm consumers.
 */
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import dts from 'vite-plugin-dts';
import wasm from 'vite-plugin-wasm';
import path from 'path';
import { fileURLToPath } from 'node:url';

/** Directory containing this config file (avoids `process.cwd()` so dts `entryRoot` matches outputs). */
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
  plugins: [
    react(),
    wasm(),
    dts({
      /** Align with TS `rootDir: src` so declarations are not mirrored under `dist-lib/src/...` (insertTypesEntry vs emittedFiles). */
      compilerOptions: {
        rootDir: path.join(packageDir, 'src'),
      },
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      outDir: 'dist-lib',
      entryRoot: path.join(packageDir, 'src'),
      exclude: [
        '**/*.worker.ts',
        '**/*.test.ts',
        'src/entrypoints/main.tsx',
        'src/entrypoints/App.tsx',
      ],
      tsconfigPath: './tsconfig.app.json',
      pathsToAliases: false,
      rollupTypes: true,
      insertTypesEntry: true,
      copyDtsFiles: false,
    }),
  ],
  resolve: {
    alias: {
      '@': path.join(packageDir, 'src'),
    },
  },
  optimizeDeps: {},
  worker: {
    format: 'es',
    plugins: () => [wasm()],
    rollupOptions: {
      output: {
        sourcemap: false,
      },
    },
  },
  build: {
    target: 'esnext',
    outDir: 'dist-lib',
    /** Library + worker chunks: no .map in dist-lib (smaller publish / vendored copy). */
    sourcemap: false,
    copyPublicDir: false,
    lib: {
      entry: path.join(packageDir, 'src/entrypoints/index.ts'),
      formats: ['es'],
      fileName: 'rosview.es',
    },
    rollupOptions: {
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
          return assetInfo.name || '[name][extname]';
        },
      },
    },
    cssCodeSplit: false,
  },
});

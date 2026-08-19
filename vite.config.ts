/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  // Relative base so the SPA works both at domain root (rosview.com) and under a path prefix (io-ai.tech/rosview/).
  base: './',
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/**/*.test.{ts,tsx}',
        'src/**/*.worker.ts',
        'src/entrypoints/main.tsx',
        'src/entrypoints/App.tsx',
      ],
      reporter: ['text', 'lcov'],
      thresholds: {
        lines: 50,
        functions: 50,
      },
    },
  },
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
      // protobufjs probes require('fs') at load; silent null avoids Vite's noisy external stub.
      // Keep `node:fs` unaliased so Vitest/Node fixtures can still use the real module.
      fs: path.resolve(import.meta.dirname, './src/shims/empty-fs.js'),
    },
  },
  // Native Vite asset URLs (`*.wasm?url`); no vite-plugin-wasm (ESM wasm import path unused).
  assetsInclude: ['**/*.wasm'],
  server: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "credentialless",
    },
  },
  preview: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "credentialless",
    },
  },
  optimizeDeps: {
    // Playback workers are imported only after a dataset is opened. Pre-bundle their
    // transitive parser/decompression deps up front so first-open in dev does not
    // trigger Vite's "new dependencies optimized" reload and bounce back to home.
    include: [
      '@foxglove/omgidl-parser',
      '@foxglove/omgidl-serialization',
      '@foxglove/ros2idl-parser',
      '@foxglove/rosmsg',
      '@foxglove/rosmsg-serialization',
      '@foxglove/rosmsg2-serialization',
      '@ioai/wasm-zstd',
      '@mcap/browser',
      '@mcap/core',
      'eventemitter3',
      'flatbuffers/js/flexbuffers.js',
      'intervals-fn',
      'lz4js',
      'protobufjs',
      'protobufjs/ext/descriptor',
      '@ioai/hdf5',
    ],
  },
  worker: {
    format: 'es',
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
      output: {
        format: 'es',
        // @ioai/hdf5 dynamic import must stay in the worker bundle — splitting it
        // emits a sibling chunk (dist-*.js) that workers resolve with a broken
        // relative URL under preview/assets/.
        codeSplitting: false,
      },
    },
  },
  build: {
    target: 'esnext',
    // Modern browsers only (esnext); skip ~1KB modulepreload polyfill.
    modulePreload: { polyfill: false },
    // Large wasm/worker chunks make gzip size reporting slow (Vite build options).
    reportCompressedSize: false,
    chunkSizeWarningLimit: 1200,
    rolldownOptions: {
      checks: {
        // The worker-heavy build legitimately spends time in Vite worker/CSS plugins;
        // keep chunk-size warnings meaningful without failing on plugin timing noise.
        pluginTimings: false,
      },
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
      output: {
        // Prefer Rolldown codeSplitting.groups over deprecated manualChunks (Vite 8).
        codeSplitting: {
          groups: [
            { name: 'vendor-dockview', test: /dockview/, priority: 30 },
            { name: 'vendor-three', test: /(?:^|[\\/])three(?:[\\/]|$)/, priority: 30 },
            { name: 'vendor-uplot', test: /(?:^|[\\/])uplot(?:[\\/]|$)/, priority: 30 },
            { name: 'vendor-mcap', test: /@mcap[\\/]core/, priority: 30 },
            { name: 'vendor-rosbag', test: /@foxglove[\\/]rosbag/, priority: 30 },
            { name: 'vendor-ioai-hdf5', test: /@ioai[\\/]hdf5/, priority: 30 },
          ],
        },
      },
    },
  },
});
/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import wasm from 'vite-plugin-wasm';
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
      '@': path.resolve(__dirname, './src'),
    },
  },
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
    // Only exclude direct WASM packages — Vite cannot pre-bundle their binary assets.
    exclude: [
      '@ioai/hdf5',
    ],
  },
  worker: {
    format: 'es',
    plugins: () => [wasm()],
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
        codeSplitting: true,
      },
    },
  },
  build: {
    target: 'esnext',
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
        codeSplitting: true,
        manualChunks(id) {
          if (id.includes('dockview')) return 'vendor-dockview';
          if (id.includes('three')) return 'vendor-three';
          if (id.includes('uplot')) return 'vendor-uplot';
          if (id.includes('@mcap/core')) return 'vendor-mcap';
          if (id.includes('@foxglove/rosbag')) return 'vendor-rosbag';
          if (id.includes('@ioai/hdf5')) return 'vendor-ioai-hdf5';
        },
      },
    },
  },
});
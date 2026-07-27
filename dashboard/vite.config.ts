/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

/** Replace __RC_BUILD_HASH__ in public/theme-init.js with a real hash after build. */
export function createCacheBustPlugin(
  outputFile = resolve(__dirname, 'dist/theme-init.js'),
): Plugin {
  let buildFailed = false;
  return {
    name: 'rc-cache-bust',
    apply: 'build',
    buildStart() {
      buildFailed = false;
    },
    buildEnd(error) {
      buildFailed = error != null;
    },
    closeBundle() {
      // Rollup also calls closeBundle after a failed build. Do not replace the
      // primary compiler error with an ENOENT from an output that was never made.
      if (buildFailed) return;
      const src = readFileSync(outputFile, 'utf8');
      if (!src.includes('__RC_BUILD_HASH__')) return;
      const hash = createHash('sha256').update(Date.now().toString()).digest('hex').slice(0, 12);
      writeFileSync(outputFile, src.replace(/__RC_BUILD_HASH__/g, hash));
    },
  };
}

export default defineConfig({
  plugins: [react(), createCacheBustPlugin()],
  base: './',
  css: {
    preprocessorOptions: {
      scss: {
        silenceDeprecations: ['global-builtin', 'color-functions'],
      },
    },
  },
  test: {
    environment: 'happy-dom',
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    chunkSizeWarningLimit: 600,
    // Disable module-preload polyfill to avoid inline scripts that violate
    // OpenClaw's "script-src 'self'" CSP header.
    modulePreload: { polyfill: false },
    rollupOptions: {
      output: {
        manualChunks: {
          antd: ['antd', '@ant-design/icons'],
          markdown: ['react-markdown', 'remark-gfm'],
          shiki: ['shiki'],
        },
      },
    },
  },
  server: {
    port: 5175,
    proxy: {
      '/ws': {
        target: 'ws://127.0.0.1:28789',
        ws: true,
      },
      '/socket.io': {
        target: 'http://127.0.0.1:28789',
      },
      '/rc': {
        target: 'http://127.0.0.1:28789',
      },
    },
  },
});

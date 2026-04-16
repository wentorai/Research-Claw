/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const rcRootPkg = JSON.parse(readFileSync(resolve(__dirname, '../package.json'), 'utf8')) as { version?: string };
const rcAppVersion = typeof rcRootPkg.version === 'string' ? rcRootPkg.version : '0.0.0';

/** Replace __RC_BUILD_HASH__ in public/theme-init.js with a real hash after build. */
function cacheBust(): Plugin {
  return {
    name: 'rc-cache-bust',
    apply: 'build',
    closeBundle() {
      const file = resolve(__dirname, 'dist/theme-init.js');
      const src = readFileSync(file, 'utf8');
      if (!src.includes('__RC_BUILD_HASH__')) return;
      const hash = createHash('sha256').update(Date.now().toString()).digest('hex').slice(0, 12);
      writeFileSync(file, src.replace(/__RC_BUILD_HASH__/g, hash));
    },
  };
}

export default defineConfig({
  plugins: [react(), cacheBust()],
  define: {
    'import.meta.env.VITE_RC_APP_VERSION': JSON.stringify(rcAppVersion),
  },
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

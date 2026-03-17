/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [react()],
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

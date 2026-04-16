import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';

const rcRootPkg = JSON.parse(readFileSync(resolve(__dirname, '../package.json'), 'utf8')) as { version?: string };
const rcAppVersion = typeof rcRootPkg.version === 'string' ? rcRootPkg.version : '0.0.0';

export default defineConfig({
  plugins: [react()],
  define: {
    'import.meta.env.VITE_RC_APP_VERSION': JSON.stringify(rcAppVersion),
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  test: {
    environment: 'happy-dom',
    globals: true,
    setupFiles: ['./src/__tests__/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
});

import { defineConfig, configDefaults } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [react()],
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
    // `*.live.test.ts` 打的是一个真在跑的 gateway,没有 mock。默认全量套件必须
    // 在无 gateway 的机器上也能全绿,所以在这里排除;它们由 vitest.live.config.ts
    // + scripts/f7-live.sh 单独拉起。
    exclude: [...configDefaults.exclude, 'src/**/*.live.test.ts'],
    // Panel tests render the full antd tree and legitimately take 2-4s here;
    // under CPU contention they cross Vitest's 5s default and are reported as
    // timeouts rather than as real defects. CI runners have far fewer cores
    // than a dev box, so the default would make this suite flaky there.
    // 30s matches extensions/research-claw-core/vitest.config.ts.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});

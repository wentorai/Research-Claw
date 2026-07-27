/**
 * 真机(live)测试专用配置 —— 与默认套件严格分离。
 *
 * 默认套件(vitest.config.ts)必须在任何机器上离线全绿,所以它 exclude 掉了
 * `*.live.test.ts`。这里只跑 live 用例。
 *
 * 环境仍是 happy-dom:live 用例 import 的是 dashboard 生产 store,而 store 链上
 * 的 i18n 初始化要读 localStorage(src/i18n/index.ts:11),纯 node 环境会直接
 * ReferenceError。happy-dom 只是补齐浏览器全局,node 内置模块(ws/net/crypto)
 * 依然可用,所以 OpenClaw 的 gateway runtime 能正常跑。
 *
 * 不要直接 `vitest run -c vitest.live.config.ts`:用 `scripts/f7-live.sh`,
 * 它会做前置条件检查和日志硬校验(退出码 0 ≠ 用例真的执行过)。
 */
import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  test: {
    environment: 'happy-dom',
    globals: true,
    include: ['src/**/*.live.test.ts'],
    // 每条用例都要开真 WebSocket 连接 + 等 gateway 落盘,串行跑,避免并发
    // 打同一个 cron 表互相踩踏
    fileParallelism: false,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
});

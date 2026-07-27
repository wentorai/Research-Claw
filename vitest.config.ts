import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The dashboard needs its own jsdom/Vite setup, so it runs from its own
    // config. `pnpm test` chains both runs; this only splits them.
    exclude: [...configDefaults.exclude, 'dashboard/**'],
    // Several suites here spawn real node subprocesses (diagnostic redaction,
    // script harnesses), which the 5s default cannot absorb on a loaded CI
    // runner. 30s matches extensions/research-claw-core/vitest.config.ts.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});

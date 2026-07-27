import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sentinel = path.join(pluginRoot, 'dist', 'withdrawn-memory-guard.sentinel');

describe('plugin distribution build', () => {
  it(
    'removes stale output before compiling the current source tree',
    () => {
      fs.mkdirSync(path.dirname(sentinel), { recursive: true });
      fs.writeFileSync(sentinel, 'stale withdrawn feature output\n', 'utf8');

      try {
        execFileSync('pnpm', ['build'], {
          cwd: pluginRoot,
          encoding: 'utf8',
          stdio: 'pipe',
        });
        expect(fs.existsSync(sentinel)).toBe(false);
      } finally {
        fs.rmSync(sentinel, { force: true });
      }
    },
    30_000,
  );
});

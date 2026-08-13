import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');

describe('health listener ownership check', () => {
  it('intersects lsof PID and cwd selectors instead of reading another process', () => {
    const health = fs.readFileSync(path.join(ROOT, 'scripts', 'health.sh'), 'utf8');
    expect(health).toContain('lsof -a -p "$PID" -d cwd -Fn');
    expect(health).not.toContain('lsof -p "$PID" -d cwd -Fn');
    expect(health).toContain('grep -Fxq "n$CONFIG_PATH"');
  });
});

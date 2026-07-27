import fs from 'node:fs';

import { describe, expect, it } from 'vitest';
import { loadPluginFresh } from './harness/plugin-harness.js';

const CONFIG = {
  enabled: false,
  reviewMode: 'off',
};

describe.sequential('plugin harness database lifecycle', () => {
  let generatedDbPath = '';

  it('opens an isolated temporary database while the harness is active', async () => {
    const harness = await loadPluginFresh(CONFIG);
    generatedDbPath = harness.databasePath;

    expect(harness.ownsDatabasePath).toBe(true);
    expect(generatedDbPath).toMatch(/rc-supervisor-test-.*\.db$/);
    expect(fs.existsSync(generatedDbPath)).toBe(true);
  });

  it('removes the prior harness database and sidecars after the test boundary', () => {
    expect(generatedDbPath).not.toBe('');
    for (const suffix of ['', '-wal', '-shm']) {
      expect(fs.existsSync(`${generatedDbPath}${suffix}`)).toBe(false);
    }
  });
});

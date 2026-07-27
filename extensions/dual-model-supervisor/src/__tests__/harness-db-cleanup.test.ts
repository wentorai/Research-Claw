import fs from 'node:fs';
import os from 'node:os';

import { describe, expect, it } from 'vitest';
import { loadPluginFresh } from './harness/plugin-harness.js';

const CONFIG = {
  enabled: false,
  reviewMode: 'off',
};

function generatedHarnessDbFileCount(): number {
  return fs
    .readdirSync(os.tmpdir())
    .filter((name) => /^rc-supervisor-test-.*\.db(?:-wal|-shm)?$/.test(name))
    .length;
}

describe.sequential('plugin harness database lifecycle', () => {
  let filesBeforeHarness = 0;

  it('opens an isolated temporary database while the harness is active', async () => {
    filesBeforeHarness = generatedHarnessDbFileCount();
    await loadPluginFresh(CONFIG);

    expect(generatedHarnessDbFileCount()).toBeGreaterThan(filesBeforeHarness);
  });

  it('removes the prior harness database and sidecars after the test boundary', () => {
    expect(generatedHarnessDbFileCount()).toBe(filesBeforeHarness);
  });
});

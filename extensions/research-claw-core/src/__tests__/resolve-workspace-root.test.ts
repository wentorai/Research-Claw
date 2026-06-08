import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { resolveWorkspaceRoot } from '../workspace/resolve-root.js';

describe('resolveWorkspaceRoot', () => {
  let tmpDir = '';

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-ws-root-'));
    fs.mkdirSync(path.join(tmpDir, 'config'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'workspace'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'config', 'openclaw.json'),
      JSON.stringify({
        agents: { defaults: { workspace: path.join(tmpDir, 'workspace') } },
      }),
    );
  });

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('prefers explicit plugin workspace.root override', () => {
    const custom = path.join(tmpDir, 'custom-workspace');
    const api = { resolvePath: () => path.join(tmpDir, 'extensions', 'research-claw-core') };
    expect(resolveWorkspaceRoot(api, custom)).toBe(path.resolve(custom));
  });

  it('falls back to agents.defaults.workspace from openclaw.json', () => {
    const prev = process.env.OPENCLAW_CONFIG_PATH;
    process.env.OPENCLAW_CONFIG_PATH = path.join(tmpDir, 'config', 'openclaw.json');
    const api = { resolvePath: () => path.join(tmpDir, 'extensions', 'research-claw-core') };
    try {
      expect(resolveWorkspaceRoot(api)).toBe(path.resolve(tmpDir, 'workspace'));
    } finally {
      if (prev === undefined) delete process.env.OPENCLAW_CONFIG_PATH;
      else process.env.OPENCLAW_CONFIG_PATH = prev;
    }
  });
});

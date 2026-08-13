import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const ENSURE_CONFIG = path.join(ROOT, 'scripts', 'ensure-config.cjs');
const EXAMPLE_CONFIG = path.join(ROOT, 'config', 'openclaw.example.json');

describe('ensure-config bootstrap per-file limit', () => {
  let tempRoot: string;
  let configPath: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-bootstrap-limit-'));
    configPath = path.join(tempRoot, 'config', 'openclaw.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  function migrate(bootstrapMaxChars?: number): number | undefined {
    const defaults = bootstrapMaxChars === undefined ? {} : { bootstrapMaxChars };
    fs.writeFileSync(configPath, JSON.stringify({ agents: { defaults } }));
    execFileSync(process.execPath, [ENSURE_CONFIG, configPath], {
      env: { ...process.env, HOME: path.join(tempRoot, 'home') },
    });
    return JSON.parse(fs.readFileSync(configPath, 'utf8'))
      .agents?.defaults?.bootstrapMaxChars;
  }

  it('ships 30000 in the fresh-install template', () => {
    const config = JSON.parse(fs.readFileSync(EXAMPLE_CONFIG, 'utf8'));
    expect(config.agents.defaults.bootstrapMaxChars).toBe(30_000);
  });

  it('adds 30000 when the OpenClaw limit is implicit', () => {
    expect(migrate()).toBe(30_000);
  });

  it('migrates the exact legacy OpenClaw default from 20000 to 30000', () => {
    expect(migrate(20_000)).toBe(30_000);
  });

  it.each([12_000, 45_000])('preserves an explicit operator limit of %s', (limit) => {
    expect(migrate(limit)).toBe(limit);
  });
});

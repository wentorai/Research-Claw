import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { buildSaveConfig, type ConfigPatchInput } from './config-patch';

const ROOT = path.resolve(__dirname, '../../..');
const OPENCLAW = path.join(ROOT, 'node_modules', '.bin', 'openclaw');
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function input(): ConfigPatchInput {
  return {
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-test',
    textModel: 'gpt-4o',
  };
}

/**
 * Write a Dashboard-built config and run the installed OpenClaw CLI against it.
 * RC paths are resolved the way run.sh resolves them before gateway startup.
 */
function validateBuiltConfig(config: Record<string, unknown>) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-config-patch-schema-'));
  tempDirs.push(tempRoot);
  const configPath = path.join(tempRoot, 'config', 'openclaw.json');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });

  const prepared = structuredClone(config);
  const plugins = prepared.plugins as { load?: { paths?: string[] } } | undefined;
  if (plugins?.load?.paths) {
    plugins.load.paths = plugins.load.paths.map((entry) => path.resolve(ROOT, entry));
  }
  fs.writeFileSync(configPath, JSON.stringify(prepared, null, 2));

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: path.join(tempRoot, 'home'),
    XDG_CACHE_HOME: path.join(tempRoot, 'xdg-cache'),
    XDG_CONFIG_HOME: path.join(tempRoot, 'xdg-config'),
    XDG_DATA_HOME: path.join(tempRoot, 'xdg-data'),
    XDG_STATE_HOME: path.join(tempRoot, 'xdg-state'),
    OPENCLAW_STATE_DIR: path.join(tempRoot, 'state'),
    OPENCLAW_CONFIG_PATH: configPath,
    NODE_ENV: 'production',
  };
  delete env.VITEST;
  delete env.VITEST_POOL_ID;
  delete env.VITEST_WORKER_ID;

  const child = spawnSync(OPENCLAW, ['config', 'validate', '--json'], {
    encoding: 'utf8',
    env,
  });
  const raw = `${child.stdout ?? ''}${child.stderr ?? ''}`.trim();
  return { result: JSON.parse(raw) as { valid: boolean; issues?: unknown[] }, raw };
}

describe('Dashboard config patches validate against OpenClaw 2026.9.2', () => {
  it('emits no retired 2026.9.2 keys from RC defaults', () => {
    const config = buildSaveConfig(null, input());
    const agents = config.agents as {
      defaults?: Record<string, unknown>;
      entries?: Record<string, unknown>;
    };
    const defaults = agents.defaults ?? {};
    const compaction = defaults.compaction as Record<string, unknown>;
    const logging = (config.logging ?? {}) as Record<string, unknown>;
    const browser = (config.browser ?? {}) as {
      profiles?: Record<string, Record<string, unknown>>;
    };
    const commands = (config.commands ?? {}) as Record<string, unknown>;
    const workshop = (config.skills as {
      workshop?: { autonomous?: Record<string, unknown> };
    }).workshop;

    expect(config).not.toHaveProperty('ui');
    expect(logging).not.toHaveProperty('redactSensitive');
    expect(defaults).not.toHaveProperty('memorySearch');
    expect(compaction).not.toHaveProperty('customInstructions');
    expect(browser.profiles?.['research-claw']).not.toHaveProperty('color');
    expect(commands).not.toHaveProperty('ownerDisplay');
    expect(workshop?.autonomous ?? {}).not.toHaveProperty('enabled');
  });

  it('produces a config the installed OpenClaw 2026.9.2 schema accepts', () => {
    const { result, raw } = validateBuiltConfig(buildSaveConfig(null, input()));

    expect(result.valid, raw).toBe(true);
    expect(result.issues ?? []).toEqual([]);
  }, 30_000);
});

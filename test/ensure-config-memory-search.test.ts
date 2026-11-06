import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const ENSURE_CONFIG = path.join(ROOT, 'scripts', 'ensure-config.cjs');
const EXAMPLE_CONFIG = path.join(ROOT, 'config', 'openclaw.example.json');
const tempRoots: string[] = [];

function migrate(config: Record<string, unknown>) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-memory-search-config-'));
  tempRoots.push(tempRoot);
  const configPath = path.join(tempRoot, 'project', 'config', 'openclaw.json');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

  execFileSync(process.execPath, [ENSURE_CONFIG, configPath]);
  const firstBytes = fs.readFileSync(configPath, 'utf8');
  execFileSync(process.execPath, [ENSURE_CONFIG, configPath]);
  const secondBytes = fs.readFileSync(configPath, 'utf8');

  return {
    config: JSON.parse(secondBytes) as {
      agents?: { defaults?: { memorySearch?: unknown } };
      memory?: { search?: { enabled?: boolean; [key: string]: unknown } };
    },
    firstBytes,
    secondBytes,
  };
}

function migrateGlobal(config: Record<string, unknown>) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-global-memory-search-config-'));
  tempRoots.push(tempRoot);
  const isolatedHome = path.join(tempRoot, 'home');
  const configPath = path.join(isolatedHome, '.openclaw', 'openclaw.json');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

  execFileSync(process.execPath, [ENSURE_CONFIG, configPath], {
    env: { ...process.env, HOME: isolatedHome },
  });
  return JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
    agents?: { defaults?: { memorySearch?: unknown } };
    memory?: unknown;
  };
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('shared memory.search migration (OpenClaw 2026.9.2)', () => {
  it('fresh-install template disables semantic memory until an embeddings provider is configured', () => {
    const example = JSON.parse(fs.readFileSync(EXAMPLE_CONFIG, 'utf8'));
    expect(example.memory?.search).toEqual({ enabled: false });
    expect(example.agents?.defaults).not.toHaveProperty('memorySearch');
  });

  it('adds the safe default to an upgraded project that never chose a memory search policy', () => {
    const { config, firstBytes, secondBytes } = migrate({
      agents: {
        defaults: {
          model: { primary: 'deepseek/deepseek-v4-pro' },
        },
      },
    });

    expect(config.memory?.search).toEqual({ enabled: false });
    expect(secondBytes).toBe(firstBytes);
  });

  it.each([true, false])('migrates a legacy agents.defaults.memorySearch choice into memory.search enabled=%s', (enabled) => {
    const { config, firstBytes, secondBytes } = migrate({
      agents: {
        defaults: {
          memorySearch: {
            enabled,
            provider: 'operator-owned-provider',
          },
        },
      },
    });

    expect(config.memory?.search).toEqual({
      enabled,
      provider: 'operator-owned-provider',
    });
    expect(config.agents?.defaults).not.toHaveProperty('memorySearch');
    expect(secondBytes).toBe(firstBytes);
  });

  it('lets canonical memory.search win over a conflicting legacy memorySearch', () => {
    const { config, firstBytes, secondBytes } = migrate({
      agents: {
        defaults: {
          memorySearch: {
            enabled: true,
            provider: 'legacy-provider',
            maxResults: 5,
          },
        },
      },
      memory: {
        search: {
          enabled: false,
          provider: 'canonical-provider',
        },
      },
    });

    expect(config.memory?.search).toEqual({
      enabled: false,
      provider: 'canonical-provider',
      maxResults: 5,
    });
    expect(config.agents?.defaults).not.toHaveProperty('memorySearch');
    expect(secondBytes).toBe(firstBytes);
  });

  it('does not inject Research-Claw memory policy into global vanilla OpenClaw config', () => {
    const config = migrateGlobal({
      agents: {
        defaults: {
          model: { primary: 'operator/model' },
        },
      },
    });

    expect(config.agents?.defaults).not.toHaveProperty('memorySearch');
    expect(config).not.toHaveProperty('memory');
  });
});

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const MANIFEST = path.join(ROOT, 'extensions', 'research-claw-core', 'openclaw.plugin.json');
const EXAMPLE = path.join(ROOT, 'config', 'openclaw.example.json');
const ENSURE = path.join(ROOT, 'scripts', 'ensure-config.cjs');
const OPENCLAW = path.join(ROOT, 'node_modules', 'openclaw', 'dist', 'entry.js');
const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-product-policy-'));
  tempRoots.push(root);
  return root;
}

function policy(capabilities: Record<string, string> = {}) {
  return {
    capabilities: {
      settings: 'enabled',
      extensions: 'enabled',
      supervisor: 'enabled',
      peripherals: 'enabled',
      ...capabilities,
    },
  };
}

function isolatedEnv(root: string, configPath: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: path.join(root, 'home'),
    USERPROFILE: path.join(root, 'home'),
    XDG_CACHE_HOME: path.join(root, 'xdg-cache'),
    XDG_CONFIG_HOME: path.join(root, 'xdg-config'),
    XDG_DATA_HOME: path.join(root, 'xdg-data'),
    XDG_STATE_HOME: path.join(root, 'xdg-state'),
    OPENCLAW_STATE_DIR: path.join(root, 'state'),
    OPENCLAW_CONFIG_PATH: configPath,
  };
}

function writeValidationConfig(root: string, value: unknown): string {
  const configPath = path.join(root, 'openclaw.json');
  fs.mkdirSync(path.join(root, 'workspace'), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify({
    agents: { defaults: { workspace: path.join(root, 'workspace') } },
    plugins: {
      enabled: true,
      allow: ['research-claw-core'],
      load: { paths: [path.join(ROOT, 'extensions', 'research-claw-core')] },
      entries: {
        'research-claw-core': {
          enabled: true,
          config: {
            dbPath: path.join(root, 'library.db'),
            productPolicy: value,
          },
        },
      },
    },
  }, null, 2)}\n`);
  return configPath;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('productPolicy manifest and migration contract', () => {
  it('declares a strict nested schema with capability-specific enums', () => {
    const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
    const schema = manifest.configSchema.properties.productPolicy;
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(['capabilities']);
    expect(schema.properties.capabilities.additionalProperties).toBe(false);
    expect(schema.properties.capabilities.required.sort()).toEqual([
      'extensions', 'peripherals', 'settings', 'supervisor',
    ]);
    expect(schema.properties.capabilities.properties).toEqual({
      settings: { type: 'string', enum: ['enabled', 'enabled-hidden'] },
      extensions: { type: 'string', enum: ['enabled', 'enabled-hidden'] },
      supervisor: { type: 'string', enum: ['enabled', 'enabled-hidden'] },
      peripherals: { type: 'string', enum: ['enabled', 'enabled-hidden', 'disabled'] },
    });
  });

  it('keeps the ordinary example explicitly all-enabled', () => {
    const example = JSON.parse(fs.readFileSync(EXAMPLE, 'utf8'));
    expect(example.plugins.entries['research-claw-core'].config.productPolicy).toEqual(policy());
  });

  it('preserves an injected Profile policy byte-stably across repeated ensure runs', () => {
    const root = makeTempRoot();
    const configDir = path.join(root, 'config');
    const configPath = path.join(configDir, 'openclaw.json');
    fs.mkdirSync(configDir, { recursive: true });
    const injected = policy({
      settings: 'enabled-hidden',
      extensions: 'enabled-hidden',
      supervisor: 'enabled-hidden',
      peripherals: 'disabled',
    });
    fs.writeFileSync(configPath, `${JSON.stringify({
      plugins: {
        enabled: true,
        entries: {
          'research-claw-core': {
            enabled: true,
            config: { dbPath: '~/.research-claw/library.db', productPolicy: injected },
          },
        },
      },
    }, null, 2)}\n`);
    const env = isolatedEnv(root, configPath);

    execFileSync(process.execPath, [ENSURE, configPath], { cwd: ROOT, env });
    const afterFirst = fs.readFileSync(configPath, 'utf8');
    expect(JSON.parse(afterFirst).plugins.entries['research-claw-core'].config.productPolicy).toEqual(injected);
    execFileSync(process.execPath, [ENSURE, configPath], { cwd: ROOT, env });
    const afterSecond = fs.readFileSync(configPath, 'utf8');
    expect(afterSecond).toBe(afterFirst);
  });

  it('is accepted by the real OpenClaw 2026.6.1 config validator', () => {
    const root = makeTempRoot();
    const configPath = writeValidationConfig(root, policy({ peripherals: 'disabled' }));
    const result = spawnSync(process.execPath, [OPENCLAW, 'config', 'validate', '--json'], {
      cwd: root,
      env: isolatedEnv(root, configPath),
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ valid: true });
  });

  it('is rejected by the real validator when an unsupported state is present', () => {
    const root = makeTempRoot();
    const configPath = writeValidationConfig(root, policy({ settings: 'disabled' }));
    const result = spawnSync(process.execPath, [OPENCLAW, 'config', 'validate', '--json'], {
      cwd: root,
      env: isolatedEnv(root, configPath),
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain('productPolicy');
  });
});

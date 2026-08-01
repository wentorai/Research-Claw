/**
 * ensure-config.cjs agent-run timeout migration contract.
 *
 * `agents.defaults.timeoutSeconds` is OpenClaw's wall-clock ceiling for the
 * entire agent turn. It is not an inactivity watchdog: an actively streaming,
 * tool-heavy research turn is still aborted when this deadline expires.
 *
 * RC raised the product default from the legacy 300 seconds to 3600 seconds in
 * commit 83a02c6. Keep the real startup migration and the fresh-install
 * template aligned so an upgrade cannot silently restore the old five-minute
 * ceiling. These tests execute the real migration script instead of mocking it.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const ENSURE_CONFIG = path.join(ROOT, 'scripts', 'ensure-config.cjs');
const EXAMPLE_CONFIG = path.join(ROOT, 'config', 'openclaw.example.json');
const EXPECTED_AGENT_TIMEOUT_SECONDS = 3600;
const LEGACY_AGENT_TIMEOUT_SECONDS = 300;
const tempRoots: string[] = [];

function createProjectConfig(config: Record<string, unknown>): string {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-agent-timeout-'));
  tempRoots.push(tempRoot);
  const configPath = path.join(tempRoot, 'project', 'config', 'openclaw.json');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return configPath;
}

function createGlobalConfig(config: Record<string, unknown>): { configPath: string; home: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-agent-timeout-home-'));
  tempRoots.push(home);
  const configPath = path.join(home, '.openclaw', 'openclaw.json');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return { configPath, home };
}

function migrate(
  configPath: string,
  env: NodeJS.ProcessEnv = process.env,
): { timeoutSeconds?: number; bytes: string } {
  execFileSync(process.execPath, [ENSURE_CONFIG, configPath], { env });
  const bytes = fs.readFileSync(configPath, 'utf8');
  const config = JSON.parse(bytes) as {
    agents?: { defaults?: { timeoutSeconds?: number } };
  };
  return {
    timeoutSeconds: config.agents?.defaults?.timeoutSeconds,
    bytes,
  };
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('ensure-config.cjs — agent run timeout migration', () => {
  it('keeps the fresh-install template at the one-hour research-turn ceiling', () => {
    const example = JSON.parse(fs.readFileSync(EXAMPLE_CONFIG, 'utf8')) as {
      agents?: { defaults?: { timeoutSeconds?: number } };
    };
    expect(example.agents?.defaults?.timeoutSeconds).toBe(EXPECTED_AGENT_TIMEOUT_SECONDS);

    const configPath = createProjectConfig(example);
    expect(migrate(configPath).timeoutSeconds).toBe(EXPECTED_AGENT_TIMEOUT_SECONDS);
  });

  it('upgrades the legacy five-minute value instead of preserving the stale cap', () => {
    const configPath = createProjectConfig({
      agents: { defaults: { timeoutSeconds: LEGACY_AGENT_TIMEOUT_SECONDS } },
    });

    expect(migrate(configPath).timeoutSeconds).toBe(EXPECTED_AGENT_TIMEOUT_SECONDS);
  });

  it('uses the immutable Docker template when the config volume hides the repository template', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-agent-timeout-template-'));
    tempRoots.push(tempRoot);
    const dockerTemplate = path.join(tempRoot, 'openclaw.example.json');
    fs.copyFileSync(EXAMPLE_CONFIG, dockerTemplate);
    const configPath = createProjectConfig({
      agents: { defaults: { timeoutSeconds: LEGACY_AGENT_TIMEOUT_SECONDS } },
    });

    expect(migrate(configPath, {
      ...process.env,
      RC_CONFIG_TEMPLATE_PATH: dockerTemplate,
    }).timeoutSeconds).toBe(EXPECTED_AGENT_TIMEOUT_SECONDS);
  });

  it('keeps the global OpenClaw compatibility config aligned in an isolated HOME', () => {
    const { configPath, home } = createGlobalConfig({
      agents: { defaults: { timeoutSeconds: LEGACY_AGENT_TIMEOUT_SECONDS } },
    });

    expect(migrate(configPath, { ...process.env, HOME: home }).timeoutSeconds)
      .toBe(EXPECTED_AGENT_TIMEOUT_SECONDS);
  });

  it('adds the current default when timeoutSeconds is absent', () => {
    const configPath = createProjectConfig({ agents: { defaults: {} } });
    expect(migrate(configPath).timeoutSeconds).toBe(EXPECTED_AGENT_TIMEOUT_SECONDS);
  });

  it.each([120, 600, 3599])(
    'preserves an intentional shorter operator value (%i seconds)',
    (timeoutSeconds) => {
      const configPath = createProjectConfig({ agents: { defaults: { timeoutSeconds } } });
      expect(migrate(configPath).timeoutSeconds).toBe(timeoutSeconds);
    },
  );

  it.each([3601, 7200])(
    'caps an over-limit value (%i seconds) at the template ceiling',
    (timeoutSeconds) => {
      const configPath = createProjectConfig({ agents: { defaults: { timeoutSeconds } } });
      expect(migrate(configPath).timeoutSeconds).toBe(EXPECTED_AGENT_TIMEOUT_SECONDS);
    },
  );

  it.each([0, -1, '3600', null])(
    'repairs an invalid timeout value (%j) with the template default',
    (timeoutSeconds) => {
      const configPath = createProjectConfig({ agents: { defaults: { timeoutSeconds } } });
      expect(migrate(configPath).timeoutSeconds).toBe(EXPECTED_AGENT_TIMEOUT_SECONDS);
    },
  );

  it('is byte-stable after the first startup migration', () => {
    const configPath = createProjectConfig({
      agents: { defaults: { timeoutSeconds: LEGACY_AGENT_TIMEOUT_SECONDS } },
    });

    const first = migrate(configPath);
    const second = migrate(configPath);

    expect(first.timeoutSeconds).toBe(EXPECTED_AGENT_TIMEOUT_SECONDS);
    expect(second.timeoutSeconds).toBe(EXPECTED_AGENT_TIMEOUT_SECONDS);
    expect(second.bytes).toBe(first.bytes);
  });
});

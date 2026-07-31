import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const ENSURE_CONFIG = path.resolve(__dirname, '../scripts/ensure-config.cjs');
const RC_REDACT_PATTERNS = [
  String.raw`\b(?:Cookie|Set-Cookie)\s*:\s*([^\r\n]+)`,
  String.raw`https?://hooks\.[^/\s]+/(?:services/)?([^\s"'<>]+)`,
  String.raw`https?://[^\s"'<>]+/(?:api/)?webhooks?/([^\s"'<>]+)`,
  String.raw`https?://open\.feishu\.cn/open-apis/bot/v2/hook/([^\s"'<>]+)`,
  String.raw`[a-z][a-z0-9+.-]*://[^@\s/:]+:([^@\s]+)@`,
];
const DEFAULTS = {
  level: 'info',
  consoleLevel: 'error',
  file: '~/.research-claw/logs/openclaw.log',
  redactSensitive: 'tools',
  redactPatterns: RC_REDACT_PATTERNS,
};

describe('ensure-config.cjs — logging three-state migration', () => {
  let tempRoot: string;
  let configPath: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-logging-config-'));
    configPath = path.join(tempRoot, 'project', 'config', 'openclaw.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  function migrate(config: Record<string, unknown>, target = configPath, env?: NodeJS.ProcessEnv) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(config, null, 2));
    execFileSync(process.execPath, [ENSURE_CONFIG, target], {
      env: { ...process.env, ...env },
    });
    return JSON.parse(fs.readFileSync(target, 'utf8'));
  }

  it('injects all defaults when logging is absent', () => {
    expect(migrate({}).logging).toEqual(DEFAULTS);
  });

  it('fills only missing keys and never overwrites user values', () => {
    const migrated = migrate({
      logging: {
        level: 'debug',
        file: '/custom/openclaw.jsonl',
        redactSensitive: 'off',
        redactPatterns: ['operator-pattern'],
      },
    });
    expect(migrated.logging).toEqual({
        level: 'debug',
        consoleLevel: 'error',
        file: '/custom/openclaw.jsonl',
        redactSensitive: 'tools',
        redactPatterns: ['operator-pattern', ...RC_REDACT_PATTERNS],
      });
  });

  it.each([[], 'invalid'])('replaces a non-object logging value (%j)', (logging) => {
    expect(migrate({ logging }).logging).toEqual(DEFAULTS);
  });

  it('does not inject RC logging defaults into the global OpenClaw config', () => {
    const isolatedHome = path.join(tempRoot, 'home');
    const globalConfig = path.join(isolatedHome, '.openclaw', 'openclaw.json');
    const migrated = migrate(
      { logging: { level: 'trace' } },
      globalConfig,
      { HOME: isolatedHome },
    );
    expect(migrated.logging).toEqual({ level: 'trace' });
  });

  it('repairs disabled redaction without changing explicit log levels or paths', () => {
    const migrated = migrate({
      logging: {
        level: 'trace',
        consoleLevel: 'debug',
        file: '/operator/log.jsonl',
        redactSensitive: 'off',
      },
    });
    expect(migrated.logging).toMatchObject({
      level: 'trace',
      consoleLevel: 'debug',
      file: '/operator/log.jsonl',
      redactSensitive: 'tools',
    });
    expect(migrated.logging.redactPatterns).toEqual(RC_REDACT_PATTERNS);
  });
});

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const ENSURE_CONFIG = path.join(ROOT, 'scripts', 'ensure-config.cjs');
const tempRoots: string[] = [];

function migrate(config: Record<string, unknown>) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-channel-cleanup-'));
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
      channels?: Record<string, unknown>;
      plugins?: {
        allow?: string[];
        entries?: Record<string, unknown>;
        installs?: Record<string, unknown>;
      };
    },
    firstBytes,
    secondBytes,
  };
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('legacy external-channel cleanup', () => {
  it('removes an allow-only Discord orphan left after the channel/plugin was removed', () => {
    const { config, firstBytes, secondBytes } = migrate({
      plugins: {
        allow: ['discord'],
      },
    });

    expect(config.plugins?.allow).not.toContain('discord');
    expect(secondBytes).toBe(firstBytes);
  });

  it('removes the historical template placeholder instead of preserving a dead channel', () => {
    const { config } = migrate({
      channels: {
        discord: {
          botToken: '<YOUR_DISCORD_BOT_TOKEN>',
        },
      },
      plugins: {
        allow: ['discord'],
      },
    });

    expect(config.channels?.discord).toBeUndefined();
    expect(config.plugins?.allow).not.toContain('discord');
  });

  it('removes the historical Telegram placeholder without touching real channels', () => {
    const { config } = migrate({
      channels: {
        telegram: {
          botToken: '<YOUR_TELEGRAM_BOT_TOKEN>',
          commands: { native: false },
        },
      },
    });

    expect(config.channels?.telegram).toBeUndefined();
  });

  it('preserves an operator-configured Discord channel even without install provenance', () => {
    const { config } = migrate({
      channels: {
        discord: {
          token: 'operator-secret',
        },
      },
      plugins: {
        allow: ['discord'],
      },
    });

    expect(config.channels?.discord).toEqual({ token: 'operator-secret' });
    expect(config.plugins?.allow).toContain('discord');
  });

  it('preserves an operator-configured Telegram channel', () => {
    const { config } = migrate({
      channels: {
        telegram: {
          enabled: true,
          botToken: '123456:operator-secret',
          dmPolicy: 'pairing',
        },
      },
      plugins: {
        allow: ['telegram'],
      },
    });

    expect(config.channels?.telegram).toEqual({
      enabled: true,
      botToken: '123456:operator-secret',
      dmPolicy: 'pairing',
    });
    expect(config.plugins?.allow).toContain('telegram');
  });

  it.each([
    { entries: { discord: { enabled: true } } },
    { installs: { discord: { source: 'npm', spec: '@openclaw/discord' } } },
  ])('preserves an allow-listed Discord plugin with explicit provenance %#', (plugins) => {
    const { config } = migrate({
      plugins: {
        allow: ['discord'],
        ...plugins,
      },
    });

    expect(config.plugins?.allow).toContain('discord');
  });
});

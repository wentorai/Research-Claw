/**
 * ensure-config.cjs plugin wiring (browser + research-superpower)
 *
 * Reproduces the upgrade regression behind "browser shows 已启用 in settings but
 * the session reports browser disabled" and "CNKI skills don't work":
 *
 *   The 330acb5 integration added `browser` and `research-superpower` to the
 *   example/dev config's plugins.allow, but ensure-config.cjs (the ONLY migration
 *   path for users who already have a project config) never appended them. So an
 *   upgrading user keeps an allow list without `browser` → the gateway auto-enables
 *   browser in-memory (settings read config and show 已启用) while the browser
 *   control service re-reads the on-disk config, finds `browser` not in the trust
 *   list, and refuses to start → "browser control disabled" → all browser-driven
 *   CNKI skills fail. research-superpower (a path extension) is likewise never
 *   wired into allow / load.paths, so its rp_* tools never load.
 *
 * These tests drive the REAL script (no mock) against a project config that
 * predates the integration and assert the wiring is repaired idempotently.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

const ENSURE_CONFIG = path.resolve(__dirname, '../scripts/ensure-config.cjs');

/** A project config as an upgrading user would have it: the 4 legacy RC plugins
 *  plus the user's own telegram/discord, but NO browser and NO research-superpower. */
function legacyProjectConfig() {
  return {
    browser: {
      enabled: true,
      defaultProfile: 'research-claw',
      profiles: { 'research-claw': { cdpPort: 18800, color: '#EF4444' } },
    },
    plugins: {
      enabled: true,
      allow: [
        'research-claw-core',
        'research-plugins',
        'openclaw-weixin',
        'telegram',
        'discord',
        'dual-model-supervisor',
      ],
      load: {
        paths: [
          './extensions/research-claw-core',
          './extensions/openclaw-weixin',
          './extensions/dual-model-supervisor',
        ],
      },
      entries: {
        'research-claw-core': { enabled: true },
        'openclaw-weixin': { enabled: true },
        'dual-model-supervisor': { enabled: true },
        // An explicit entry is operator intent. An allow-only Discord id has
        // no installed/configured target and is cleaned as a legacy orphan.
        discord: { enabled: false },
      },
    },
  };
}

function pluginsOf(configPath: string) {
  return JSON.parse(fs.readFileSync(configPath, 'utf8')).plugins;
}

describe('ensure-config.cjs — plugin wiring (browser + research-superpower)', () => {
  let tmpDir: string;
  let configPath: string;
  let isolatedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    // Project layout: <root>/config/openclaw.json (NOT under ~/.openclaw → isGlobal=false)
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-plugwire-test-'));
    const configDir = path.join(tmpDir, 'config');
    fs.mkdirSync(configDir, { recursive: true });
    configPath = path.join(configDir, 'openclaw.json');
    isolatedEnv = {
      ...process.env,
      HOME: path.join(tmpDir, 'home'),
      XDG_CACHE_HOME: path.join(tmpDir, 'xdg-cache'),
      XDG_CONFIG_HOME: path.join(tmpDir, 'xdg-config'),
      XDG_DATA_HOME: path.join(tmpDir, 'xdg-data'),
      XDG_STATE_HOME: path.join(tmpDir, 'xdg-state'),
    };
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function runEnsure(): void {
    execFileSync('node', [ENSURE_CONFIG, configPath], {
      env: isolatedEnv,
    });
  }

  it('adds browser to plugins.allow so the browser control service starts', () => {
    fs.writeFileSync(configPath, JSON.stringify(legacyProjectConfig(), null, 2));
    runEnsure();
    expect(pluginsOf(configPath).allow).toContain('browser');
  });

  it('wires research-superpower into allow + load.paths', () => {
    fs.writeFileSync(configPath, JSON.stringify(legacyProjectConfig(), null, 2));
    runEnsure();
    const plugins = pluginsOf(configPath);
    expect(plugins.allow).toContain('research-superpower');
    expect(
      plugins.load.paths.some((p: string) => p.endsWith('/extensions/research-superpower')),
    ).toBe(true);
  });

  it('preserves user-added Telegram and explicitly configured Discord trust', () => {
    fs.writeFileSync(configPath, JSON.stringify(legacyProjectConfig(), null, 2));
    runEnsure();
    const allow = pluginsOf(configPath).allow;
    expect(allow).toContain('telegram');
    expect(allow).toContain('discord');
  });

  it('preserves unrelated custom plugins installed under node_modules', () => {
    const config = legacyProjectConfig();
    const customPlugin = '/opt/lab/node_modules/custom-plugin';
    const staleResearchPlugins =
      '/opt/openclaw/node_modules/@wentorai/research-plugins';
    config.plugins.load.paths.push(customPlugin, staleResearchPlugins);
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

    runEnsure();

    const paths = pluginsOf(configPath).load.paths;
    expect(paths).toContain(customPlugin);
    expect(paths).not.toContain(staleResearchPlugins);
  });

  it('allows the core agent_end hook to read post-run conversation metadata', () => {
    fs.writeFileSync(configPath, JSON.stringify(legacyProjectConfig(), null, 2));
    runEnsure();
    const coreEntry = pluginsOf(configPath).entries['research-claw-core'];
    expect(coreEntry.hooks?.allowConversationAccess).toBe(true);
  });

  it('is idempotent — no duplicate allow / load.paths entries across two boots', () => {
    fs.writeFileSync(configPath, JSON.stringify(legacyProjectConfig(), null, 2));
    runEnsure();
    runEnsure();
    const plugins = pluginsOf(configPath);
    expect(plugins.allow.filter((id: string) => id === 'browser')).toHaveLength(1);
    expect(plugins.allow.filter((id: string) => id === 'research-superpower')).toHaveLength(1);
    expect(
      plugins.load.paths.filter((p: string) => p.endsWith('/extensions/research-superpower')),
    ).toHaveLength(1);
  });

  it('does not mistake a project beside .openclaw for the global config', () => {
    const homeDir = String(isolatedEnv.HOME);
    configPath = path.join(
      homeDir,
      '.openclaw-research-claw',
      'config',
      'openclaw.json',
    );
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(legacyProjectConfig(), null, 2));

    runEnsure();

    const plugins = pluginsOf(configPath);
    expect(plugins.allow).toContain('research-claw-core');
    expect(plugins.allow).toContain('browser');
    expect(
      plugins.load.paths.some(
        (entry: string) =>
          entry.endsWith('/extensions/research-claw-core'),
      ),
    ).toBe(true);
  });
});

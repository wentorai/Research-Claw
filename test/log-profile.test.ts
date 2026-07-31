import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(__dirname, '..');
const PROFILE_SCRIPT = path.join(ROOT, 'scripts', 'log-profile.cjs');
const RUN_SCRIPT = path.join(ROOT, 'scripts', 'run.sh');
const USER_LOGGING = {
  level: 'info',
  consoleLevel: 'error',
  file: '~/.research-claw/logs/openclaw.log',
};
const LEGACY_LOGGING = {
  ...USER_LOGGING,
  consoleLevel: 'warn',
};

type Resolution = {
  profile: 'user' | 'developer' | 'support';
  source: string;
  launcherVerbose: boolean;
  gatewayLogLevel: string | null;
  markerStatus: string;
};

type Marker = {
  schemaVersion: number;
  installation: string;
  logging: {
    managed: boolean;
    lastApplied: typeof USER_LOGGING | null;
  };
};

type ProfileModule = {
  resolveLogProfile: (options: {
    root: string;
    env?: NodeJS.ProcessEnv;
    markerPath?: string;
  }) => Resolution;
  markManagedNativeInstall: (options: {
    root: string;
    configPath: string;
    fresh: boolean;
    markerPath?: string;
  }) => Marker;
};

describe('native log profiles and managed-install marker', () => {
  let tempRoot: string;
  let configPath: string;
  let markerPath: string;
  let profile: ProfileModule;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-log-profile-'));
    configPath = path.join(tempRoot, 'config', 'openclaw.json');
    markerPath = path.join(tempRoot, '.research-claw-install.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    profile = require(PROFILE_SCRIPT) as ProfileModule;
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  const writeConfig = (logging?: Record<string, unknown>) => {
    fs.writeFileSync(
      configPath,
      `${JSON.stringify(logging === undefined ? {} : { logging }, null, 2)}\n`,
    );
  };

  const writeMarker = (value: unknown) => {
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(markerPath, `${JSON.stringify(value, null, 2)}\n`);
  };

  it('defaults an unmarked source checkout to developer debug', () => {
    expect(profile.resolveLogProfile({ root: tempRoot, env: {}, markerPath }))
      .toMatchObject({
        profile: 'developer',
        source: 'source-checkout',
        launcherVerbose: true,
        gatewayLogLevel: 'debug',
        markerStatus: 'missing',
      });
  });

  it('defaults a valid managed native install to the quiet user profile', () => {
    writeMarker({
      schemaVersion: 1,
      installation: 'managed-native',
      logging: { managed: true, lastApplied: USER_LOGGING },
    });
    expect(profile.resolveLogProfile({ root: tempRoot, env: {}, markerPath }))
      .toMatchObject({
        profile: 'user',
        source: 'managed-native-marker',
        launcherVerbose: false,
        gatewayLogLevel: null,
        markerStatus: 'valid',
      });
  });

  it('uses a marker path outside the migratable project data directory', () => {
    writeConfig();
    profile.markManagedNativeInstall({
      root: tempRoot,
      configPath,
      fresh: true,
    });
    expect(fs.existsSync(path.join(tempRoot, '.research-claw-install.json')))
      .toBe(true);
    expect(fs.existsSync(path.join(tempRoot, '.research-claw', 'install.json')))
      .toBe(false);
  });

  it('keeps the install identity after legacy project data is migrated away', () => {
    writeConfig();
    profile.markManagedNativeInstall({
      root: tempRoot,
      configPath,
      fresh: true,
    });
    const legacyDataDir = path.join(tempRoot, '.research-claw');
    const migratedDataDir = path.join(tempRoot, 'home', '.research-claw');
    fs.mkdirSync(legacyDataDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDataDir, 'library.db'), 'fixture');
    fs.mkdirSync(path.dirname(migratedDataDir), { recursive: true });
    fs.renameSync(legacyDataDir, migratedDataDir);

    expect(profile.resolveLogProfile({ root: tempRoot, env: {} }))
      .toMatchObject({
        profile: 'user',
        source: 'managed-native-marker',
        markerStatus: 'valid',
      });
  });

  it('keeps an unmanaged valid install marker in the user profile', () => {
    writeMarker({
      schemaVersion: 1,
      installation: 'managed-native',
      logging: { managed: false, lastApplied: null },
    });
    expect(profile.resolveLogProfile({ root: tempRoot, env: {}, markerPath }))
      .toMatchObject({
        profile: 'user',
        source: 'managed-native-marker',
        gatewayLogLevel: null,
      });
  });

  it.each(['user', 'developer', 'support'] as const)(
    'gives explicit RC_LOG_PROFILE=%s highest profile priority',
    explicit => {
      expect(profile.resolveLogProfile({
        root: tempRoot,
        markerPath,
        env: { RC_LOG_PROFILE: explicit },
      }).profile).toBe(explicit);
    },
  );

  it('rejects an invalid explicit profile with an actionable error', () => {
    expect(() => profile.resolveLogProfile({
      root: tempRoot,
      markerPath,
      env: { RC_LOG_PROFILE: 'noisy' },
    })).toThrow(/RC_LOG_PROFILE.*user.*developer.*support/i);
  });

  it('treats a corrupt existing marker as user-safe instead of enabling debug', () => {
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(markerPath, '{ broken\n');
    expect(profile.resolveLogProfile({ root: tempRoot, env: {}, markerPath }))
      .toMatchObject({
        profile: 'user',
        source: 'corrupt-managed-marker',
        gatewayLogLevel: null,
        markerStatus: 'corrupt',
      });
  });

  it('never lets RC_VERBOSE downgrade an explicit debug/trace override', () => {
    writeMarker({
      schemaVersion: 1,
      installation: 'managed-native',
      logging: { managed: true, lastApplied: USER_LOGGING },
    });
    for (const level of ['debug', 'trace']) {
      expect(profile.resolveLogProfile({
        root: tempRoot,
        markerPath,
        env: { RC_VERBOSE: '1', OPENCLAW_LOG_LEVEL: level },
      })).toMatchObject({
        profile: 'user',
        launcherVerbose: true,
        gatewayLogLevel: null,
      });
    }
  });

  it('keeps RC_VERBOSE backward-compatible at info for a managed user run', () => {
    writeMarker({
      schemaVersion: 1,
      installation: 'managed-native',
      logging: { managed: true, lastApplied: USER_LOGGING },
    });
    expect(profile.resolveLogProfile({
      root: tempRoot,
      markerPath,
      env: { RC_VERBOSE: '1' },
    })).toMatchObject({
      profile: 'user',
      launcherVerbose: true,
      gatewayLogLevel: 'info',
    });
  });

  it('marks a fresh install and writes the managed user defaults', () => {
    writeConfig();
    const marker = profile.markManagedNativeInstall({
      root: tempRoot,
      configPath,
      markerPath,
      fresh: true,
    });
    expect(JSON.parse(fs.readFileSync(configPath, 'utf8')).logging)
      .toEqual(USER_LOGGING);
    expect(marker.logging).toEqual({
      managed: true,
      lastApplied: USER_LOGGING,
    });
  });

  it('migrates the exact legacy RC default on first marker adoption', () => {
    writeConfig(LEGACY_LOGGING);
    const marker = profile.markManagedNativeInstall({
      root: tempRoot,
      configPath,
      markerPath,
      fresh: false,
    });
    expect(JSON.parse(fs.readFileSync(configPath, 'utf8')).logging)
      .toEqual(USER_LOGGING);
    expect(marker.logging.managed).toBe(true);
  });

  it('preserves an explicit operator logging choice during marker adoption', () => {
    const custom = {
      level: 'trace',
      consoleLevel: 'debug',
      file: '/custom/gateway.log',
      redactSensitive: 'off',
    };
    writeConfig(custom);
    const marker = profile.markManagedNativeInstall({
      root: tempRoot,
      configPath,
      markerPath,
      fresh: false,
    });
    expect(JSON.parse(fs.readFileSync(configPath, 'utf8')).logging)
      .toEqual(custom);
    expect(marker.logging).toEqual({ managed: false, lastApplied: null });
  });

  it('stops managing logging after the user changes a previously managed value', () => {
    writeConfig({ ...USER_LOGGING, consoleLevel: 'debug' });
    writeMarker({
      schemaVersion: 1,
      installation: 'managed-native',
      logging: { managed: true, lastApplied: USER_LOGGING },
    });
    const marker = profile.markManagedNativeInstall({
      root: tempRoot,
      configPath,
      markerPath,
      fresh: false,
    });
    expect(JSON.parse(fs.readFileSync(configPath, 'utf8')).logging.consoleLevel)
      .toBe('debug');
    expect(marker.logging).toEqual({ managed: false, lastApplied: null });
  });

  it('rewrites a corrupt marker without changing the existing config', () => {
    const custom = { level: 'debug', consoleLevel: 'info', file: '/custom/log' };
    writeConfig(custom);
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(markerPath, '{ broken\n');
    const marker = profile.markManagedNativeInstall({
      root: tempRoot,
      configPath,
      markerPath,
      fresh: false,
    });
    expect(JSON.parse(fs.readFileSync(configPath, 'utf8')).logging)
      .toEqual(custom);
    expect(marker.logging.managed).toBe(false);
  });

  it('is resolved by the real run.sh subprocess rather than a script grep', () => {
    const output = execFileSync('bash', [RUN_SCRIPT], {
      cwd: ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        RC_LOG_PROFILE_CHECK: '1',
        RC_LOG_MARKER_PATH: markerPath,
        RC_LOG_PROFILE: 'support',
      },
    });
    expect(JSON.parse(output)).toMatchObject({
      profile: 'support',
      launcherVerbose: true,
      gatewayLogLevel: 'debug',
    });
  });
});

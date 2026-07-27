import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  patchDockerConfig,
} = require('../scripts/docker-config-patch.cjs') as {
  patchDockerConfig: (
    config: Record<string, any>,
    env?: NodeJS.ProcessEnv,
  ) => boolean;
};

function configWithLevel(level?: unknown): Record<string, any> {
  return {
    logging: {
      ...(level !== undefined ? { level } : {}),
      consoleLevel: 'warn',
      file: '/tmp/openclaw.log',
      redactSensitive: 'tools',
    },
    gateway: {
      auth: { mode: 'token', token: 'custom-token' },
      controlUi: {},
    },
    plugins: {
      entries: {
        'research-claw-core': { config: {} },
        'dual-model-supervisor': { config: {} },
      },
    },
  };
}

describe('Docker config patch — logging level policy', () => {
  it.each(['silent', 'fatal', 'error', 'warn'])(
    'raises %s to info so docker logs retain diagnostics',
    (level) => {
      const config = configWithLevel(level);
      expect(patchDockerConfig(config)).toBe(true);
      expect(config.logging.level).toBe('info');
      expect(config.logging.consoleLevel).toBe('info');
      expect(config.logging.file).toBe('/app/.research-claw/logs/openclaw.log');
      expect(config.logging.redactSensitive).toBe('tools');
    },
  );

  it('fills a missing level with info', () => {
    const config = configWithLevel();
    patchDockerConfig(config);
    expect(config.logging.level).toBe('info');
  });

  it.each(['info', 'debug', 'trace'])(
    'preserves an existing %s file-log level',
    (level) => {
      const config = configWithLevel(level);
      patchDockerConfig(config);
      expect(config.logging.level).toBe(level);
    },
  );

  it('repairs a non-object logging block to Docker defaults', () => {
    const config = configWithLevel('debug');
    config.logging = ['invalid'];
    patchDockerConfig(config);
    expect(config.logging).toEqual({
      consoleLevel: 'info',
      level: 'info',
      file: '/app/.research-claw/logs/openclaw.log',
    });
  });

  it('preserves a custom token while applying gateway and volume paths', () => {
    const config = configWithLevel('debug');
    patchDockerConfig(config, { OPENCLAW_GATEWAY_TOKEN: 'environment-token' });
    expect(config.gateway).toMatchObject({
      bind: 'lan',
      auth: { mode: 'token', token: 'custom-token' },
      controlUi: {
        dangerouslyAllowHostHeaderOriginFallback: true,
        dangerouslyDisableDeviceAuth: true,
      },
    });
    expect(
      config.plugins.entries['research-claw-core'].config.dbPath,
    ).toBe('/app/.research-claw/library.db');
    expect(
      config.plugins.entries['dual-model-supervisor'].config.dbPath,
    ).toBe('/app/.research-claw/supervisor.db');
  });

  it('is idempotent after a complete Docker patch', () => {
    const config = configWithLevel('trace');
    expect(patchDockerConfig(config)).toBe(true);
    expect(patchDockerConfig(config)).toBe(false);
  });
});

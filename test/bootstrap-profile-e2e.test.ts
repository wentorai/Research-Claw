import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const PROBE = path.join(ROOT, 'scripts/probe-bootstrap-profile-e2e.mjs');
const execFileAsync = promisify(execFile);

function isolatedHostEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    'PATH', 'Path', 'PATHEXT', 'SHELL', 'COMSPEC', 'SYSTEMROOT', 'SystemRoot',
    'WINDIR', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'TZ', 'TERM', 'CI',
  ]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

describe('Bootstrap Capsule same-instance product E2E', () => {
  it('applies one Profile through the real OpenClaw runtime and preserves lifecycle contracts', async () => {
    const { stdout: raw } = await execFileAsync(process.execPath, [PROBE], {
      cwd: ROOT,
      env: isolatedHostEnv(),
      encoding: 'utf8',
      timeout: 240_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    const result = JSON.parse(raw) as any;

    expect(result.openClawVersion).toBe('2026.6.1');
    expect(result.transaction.initial).toEqual([
      'staged', 'applied', 'real-config-valid', 'runtime-verified', 'verified', 'committed',
    ]);
    expect(result.readiness).toMatchObject({ ok: true, core: { ok: true } });
    expect(result.readiness.probes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        method: 'rc.periph.devices.list',
        ok: true,
        expectedUnavailable: true,
      }),
      expect.objectContaining({ method: 'rc.supervisor.reviews.list', ok: true }),
    ]));

    expect(result.model).toMatchObject({
      providerId: 'custom-rc-profile-thermoelectric-user-a',
      modelId: 'thermoelectric-fixture-model',
      initialConversation: 'T09_CONVERSATION_OK',
      expectedAuthorizationOnly: true,
    });
    expect(result.skills.inventory).toEqual([
      { name: 'develop-flexible-bismuth-telluride', source: 'openclaw-workspace' },
      { name: 'engineer-gete-thermoelectrics', source: 'openclaw-workspace' },
      { name: 'research-thermoelectric-semiconductors', source: 'openclaw-workspace' },
    ]);
    expect(result.skills.triggered).toEqual([
      'research-thermoelectric-semiconductors',
      'develop-flexible-bismuth-telluride',
      'engineer-gete-thermoelectrics',
    ]);
    expect(result.supervisor).toMatchObject({
      dangerousToolBlocked: true,
      blockAuditObserved: true,
    });
    expect(result.policy).toMatchObject({
      peripherals: 'disabled',
      peripheralTools: [],
      plaudTools: [],
      peripheralRpc: [],
    });
    expect(result.lifecycle).toMatchObject({
      sameDigestNoop: true,
      liveAssetsStable: true,
      driftRepaired: true,
      failedProbeRolledBack: true,
      rotatedKeyOnly: true,
      profileSwitchClean: true,
    });
    expect(result.cleanup).toBe('clean');
  }, 245_000);
});

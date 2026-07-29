import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const INSTALL_SCRIPT = path.join(ROOT, 'scripts', 'install.sh');
const RUN_SCRIPT = path.join(ROOT, 'scripts', 'run.sh');
const DOCKER_ENTRYPOINT = path.join(ROOT, 'scripts', 'docker-entrypoint.sh');
const POSIX_UPDATER = path.join(ROOT, 'scripts', 'update-research-claw.sh');
const WINDOWS_UPDATER = path.join(ROOT, 'scripts', 'update-research-claw.ps1');
const DOCKER_VERIFIER = path.join(
  ROOT,
  'scripts',
  'verify-docker-config.mjs',
);
const SHARED_INSTALLER = 'install-research-plugins.cjs';

describe('native installer research-plugins degradation contract', () => {
  it('reconciles and validates config after the optional plugin attempt', () => {
    const script = fs.readFileSync(INSTALL_SCRIPT, 'utf8');
    const pluginStage = script.indexOf('step 8 "Research plugins"');
    const postPluginEnsure = script.lastIndexOf(
      'scripts/ensure-config.cjs',
    );
    const postPluginValidation = script.lastIndexOf(
      'config validate --json',
    );

    expect(pluginStage).toBeGreaterThan(-1);
    expect(postPluginEnsure).toBeGreaterThan(pluginStage);
    expect(postPluginValidation).toBeGreaterThan(postPluginEnsure);
  });

  it('explains that base features remain usable and rerunning restores research features', () => {
    const script = fs.readFileSync(INSTALL_SCRIPT, 'utf8');

    expect(
      script.includes(
        'Research features are temporarily unavailable; the core assistant can still start.',
      ),
    ).toBe(true);
    expect(
      script.includes('Run this installer again to restore research features.'),
    ).toBe(true);
  });

  it('reconciles Docker config after the baked plugin has been restored', () => {
    const script = fs.readFileSync(DOCKER_ENTRYPOINT, 'utf8');
    const pluginSync = script.indexOf(
      'Sync research-plugins from image → volume',
    );
    const postPluginEnsure = script.lastIndexOf('ensure-config.cjs');
    const postEnsureDockerPatch = script.lastIndexOf(
      'docker-config-patch.cjs',
    );
    const postPluginValidation = script.lastIndexOf('config validate --json');

    expect(pluginSync).toBeGreaterThan(-1);
    expect(postPluginEnsure).toBeGreaterThan(pluginSync);
    expect(postEnsureDockerPatch).toBeGreaterThan(postPluginEnsure);
    expect(postPluginValidation).toBeGreaterThan(postEnsureDockerPatch);
    expect(script).not.toContain(
      'Added research-plugins to plugins.load.paths',
    );
  });

  it('reconciles both update paths after their plugin update attempt', () => {
    const posix = fs.readFileSync(POSIX_UPDATER, 'utf8');
    const windows = fs.readFileSync(WINDOWS_UPDATER, 'utf8');

    for (const script of [posix, windows]) {
      const pluginAttempt = script.indexOf(SHARED_INSTALLER);
      expect(pluginAttempt).toBeGreaterThan(-1);
      expect(script.lastIndexOf('ensure-config.cjs')).toBeGreaterThan(
        pluginAttempt,
      );
      expect(script.lastIndexOf('config validate --json')).toBeGreaterThan(
        script.lastIndexOf('ensure-config.cjs'),
      );
      expect(script).not.toContain(
        'plugins install @wentorai/research-plugins',
      );
      expect(script).not.toContain(
        "plugins install '@wentorai/research-plugins'",
      );
    }
  });

  it('uses the shared atomic installer in native install and atomic copy in Docker', () => {
    const native = fs.readFileSync(INSTALL_SCRIPT, 'utf8');
    const docker = fs.readFileSync(DOCKER_ENTRYPOINT, 'utf8');

    expect(native).toContain(SHARED_INSTALLER);
    expect(docker).toContain(SHARED_INSTALLER);
    expect(docker).toContain('--source-dir /defaults/research-plugins');
    expect(docker).not.toContain(
      'rm -rf /root/.openclaw/extensions/research-plugins',
    );
    expect(docker).not.toContain(
      '&& { [ "$IMAGE_RP_VER" != "$VOL_RP_VER" ] || ! $VOL_RP_READY; }',
    );
  });

  it('makes startup reconciliation and real config validation mandatory', () => {
    const run = fs.readFileSync(RUN_SCRIPT, 'utf8');
    const reconciliation = run.indexOf('ensure-config.cjs');
    const validation = run.indexOf('config validate --json');

    expect(reconciliation).toBeGreaterThan(-1);
    expect(validation).toBeGreaterThan(reconciliation);
    expect(run).not.toMatch(/ensure-config\.cjs[^\n]*\|\|\s*true/);
    expect(run).toContain('install-research-plugins.cjs');
    expect(run).toContain(
      'Run the installer again to restore research features.',
    );
  });

  it('tests the candidate Docker helper and verifies plugin integrity and discovery', () => {
    const verifier = fs.readFileSync(DOCKER_VERIFIER, 'utf8');

    for (const script of [
      'install-research-plugins.cjs',
      'research-plugins-install-utils.cjs',
      'ensure-config.cjs',
    ]) {
      expect(verifier).toContain(script);
    }
    expect(verifier).toContain("'--check'");
    expect(verifier).toMatch(
      /'plugins',\s*'list',\s*'--json'/,
    );
    expect(verifier).toContain("candidate.id === 'research-plugins'");
    const badConfigProbe = verifier.indexOf(
      'async function assertBadConfigVisible',
    );
    const warningObserved = verifier.indexOf(
      'await waitForLog(',
      badConfigProbe,
    );
    const terminalObserved = verifier.indexOf(
      'await waitForContainerExit(name)',
      badConfigProbe,
    );
    const finalLogsObserved = verifier.indexOf(
      'const logs = await containerLogs(name)',
      terminalObserved,
    );
    expect(warningObserved).toBeGreaterThan(badConfigProbe);
    expect(terminalObserved).toBeGreaterThan(warningObserved);
    expect(finalLogsObserved).toBeGreaterThan(terminalObserved);
  });
});

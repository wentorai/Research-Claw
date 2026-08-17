import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const VERIFIER = path.join(ROOT, 'scripts', 'verify-extension-build.cjs');
const REQUIRED_OUTPUTS = [
  'extensions/research-claw-core/dist/index.js',
  'extensions/dual-model-supervisor/dist/index.js',
  'extensions/wentor-connect/dist/index.js',
  'extensions/openclaw-weixin/dist/index.js',
];

function fixtureRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-extension-build-'));
  for (const relative of REQUIRED_OUTPUTS) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'export {};\n');
  }
  return root;
}

function verify(root: string) {
  return spawnSync(process.execPath, [VERIFIER, '--root', root, '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
}

describe('Extension build verifier', () => {
  it('accepts the exact four non-empty regular runtime entries', () => {
    const root = fixtureRoot();
    try {
      const result = verify(root);
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        ok: true,
        outputs: REQUIRED_OUTPUTS,
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    ['missing', (target: string) => fs.rmSync(target)],
    ['empty', (target: string) => fs.truncateSync(target, 0)],
    ['symlink', (target: string) => {
      fs.rmSync(target);
      fs.symlinkSync(path.join(ROOT, 'package.json'), target);
    }],
  ])('rejects a %s runtime entry', (_label, mutate) => {
    const root = fixtureRoot();
    try {
      mutate(path.join(root, REQUIRED_OUTPUTS[0]));
      const result = verify(root);
      expect(result.status).toBe(78);
      expect(result.stderr).toContain('EXTENSION_BUILD_INCOMPLETE');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('binds the explicit four-package build and verifies before installer success', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const build = packageJson.scripts['build:extensions'];
    for (const packageName of [
      '@research-claw/core',
      '@research-claw/dual-model-supervisor',
      '@research-claw/wentor-connect',
      '@tencent-weixin/openclaw-weixin',
    ]) {
      expect(build).toContain(`--filter ${packageName}`);
    }
    expect(build).toContain('verify-extension-build.cjs');

    const installer = fs.readFileSync(path.join(ROOT, 'scripts', 'install.sh'), 'utf8');
    const verification = installer.indexOf('scripts/verify-extension-build.cjs');
    const success = installer.indexOf('ok "Build complete"');
    expect(verification).toBeGreaterThan(0);
    expect(verification).toBeLessThan(success);
  });
});

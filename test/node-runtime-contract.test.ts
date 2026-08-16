import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const { evaluateRuntime } = require('../scripts/runtime-contract.cjs') as {
  evaluateRuntime: (versions: { node: string; modules: string }) => {
    compatible: boolean;
    expected: string;
  };
};

const ROOT = path.resolve(__dirname, '..');
const RESOLVER = path.join(ROOT, 'scripts', 'node-runtime.cjs');

describe('Research-Claw Node runtime contract', () => {
  it('rejects runtime drift even when a native module happens to load there', () => {
    expect(evaluateRuntime({ node: '22.22.2', modules: '127' }).compatible).toBe(true);
    expect(evaluateRuntime({ node: '22.15.1', modules: '127' }).compatible).toBe(false);
    expect(evaluateRuntime({ node: '24.5.0', modules: '137' }).compatible).toBe(false);
    expect(evaluateRuntime({ node: '22.22.2', modules: '137' }).compatible).toBe(false);
    expect(evaluateRuntime({ node: '24.5.0', modules: '137' }).expected).toContain('ABI 127');
  });

  it('resolves one Node 22 runtime with a stable native-module ABI', () => {
    const runtime = JSON.parse(execFileSync(process.execPath, [RESOLVER, 'resolve'], {
      encoding: 'utf8',
    })) as { path: string; version: string; modules: string; compatible: boolean };

    expect(runtime.version).toMatch(/^22\./);
    expect(Number(runtime.version.split('.')[1])).toBeGreaterThanOrEqual(16);
    expect(runtime.modules).toBe('127');
    expect(runtime.compatible).toBe(true);
    expect(fs.realpathSync(runtime.path)).toBe(runtime.path);
  });

  it('uses the same resolver for build and Gateway launch', () => {
    const rootPackage = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const launcher = fs.readFileSync(path.join(ROOT, 'scripts', 'run.sh'), 'utf8');
    const installer = fs.readFileSync(path.join(ROOT, 'scripts', 'install.sh'), 'utf8');

    expect(rootPackage.engines.node).toBe('>=22.16.0 <23');
    expect(rootPackage.scripts.build).toContain('node-runtime.cjs exec');
    expect(rootPackage.scripts['build:runtime']).toBeTruthy();
    expect(launcher).toContain('node-runtime.cjs resolve --shell');
    expect(installer).toContain('node-runtime.cjs" resolve --shell');
    expect(installer).toContain('NODE_MAX=22');
  });

  it('executes child commands under the resolved runtime even when the parent differs', () => {
    const output = execFileSync(process.execPath, [
      RESOLVER,
      'exec',
      '--',
      'node',
      '-p',
      'process.versions.node + ":" + process.versions.modules',
    ], { encoding: 'utf8' }).trim();

    expect(output).toMatch(/^22\..*:127$/);
  });

  it('routes pnpm through the JavaScript runner under native Windows process rules', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-node-runtime-win32-'));
    const resolver = path.join(root, 'node-runtime.cjs');
    const runner = path.join(root, 'run-pnpm.cjs');
    try {
      fs.copyFileSync(RESOLVER, resolver);
      fs.copyFileSync(path.join(ROOT, 'scripts', 'runtime-contract.cjs'), path.join(root, 'runtime-contract.cjs'));
      fs.writeFileSync(runner, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n');
      const probe = [
        "Object.defineProperty(process, 'platform', { value: 'win32' });",
        `process.argv = [process.execPath, ${JSON.stringify(resolver)}, 'exec', '--', 'pnpm', 'build:runtime'];`,
        `require(${JSON.stringify(resolver)});`,
      ].join('\n');
      const output = execFileSync(process.execPath, ['-e', probe], { encoding: 'utf8' });
      expect(JSON.parse(output)).toEqual(['build:runtime']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

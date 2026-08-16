import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';

import { afterEach, describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const ENTRY = path.join(ROOT, 'scripts/apply-bootstrap-profile.cjs');
const ENSURE_CONFIG = path.join(ROOT, 'scripts/ensure-config.cjs');
const EXAMPLE_CONFIG = path.join(ROOT, 'config/openclaw.example.json');
const CAPSULE = path.join(ROOT, 'profiles/fixtures/thermoelectric-user-a/capsule.json');
const require = createRequire(import.meta.url);
const storage = require('../scripts/bootstrap-profile/storage.cjs');
const { ensureInitialized } = require('../scripts/bootstrap-profile/maintenance-lease.cjs');

type Harness = ReturnType<typeof makeHarness>;

const roots: string[] = [];
const children = new Set<ChildProcess>();

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  children.clear();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
}

function makeHarness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-bootstrap-secure-hardening-'));
  roots.push(root);
  if (process.platform !== 'win32') fs.chmodSync(root, 0o700);
  const configRoot = path.join(root, 'config');
  const workspace = path.join(root, 'workspace');
  const stateDir = path.join(root, 'state');
  const dataRoot = path.join(root, 'data');
  for (const directory of [configRoot, workspace, stateDir, dataRoot]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') fs.chmodSync(directory, 0o700);
  }
  const paths = {
    rcRoot: ROOT,
    configPath: path.join(configRoot, 'openclaw.json'),
    workspace,
    stateDir,
    dbPath: path.join(dataRoot, 'library.db'),
    globalConfigPath: path.join(stateDir, 'openclaw.json'),
  };
  writeJson(paths.configPath, {
    agents: { defaults: { model: { primary: 'user/model' } } },
    models: { mode: 'merge', providers: {} },
    plugins: { entries: {
      'research-claw-core': { enabled: true, config: {} },
      'dual-model-supervisor': {
        enabled: false, config: { enabled: false, reviewMode: 'off' },
      },
    } },
    tools: { deny: [] },
  });
  writeJson(paths.globalConfigPath, {});
  writeJson(path.join(stateDir, 'agents/main/agent/auth-profiles.json'), {
    version: 1, profiles: {},
  });
  ensureInitialized({ ...paths, externalStopVerified: true });
  return { root, paths };
}

function stageArgs(harness: Harness, file: string): string[] {
  return [
    ENTRY, 'stage',
    '--rc-root', ROOT,
    '--config', harness.paths.configPath,
    '--workspace', harness.paths.workspace,
    '--state-dir', harness.paths.stateDir,
    '--db', harness.paths.dbPath,
    '--global-config', harness.paths.globalConfigPath,
    '--capsule-file', file,
  ];
}

function runCapsuleFile(harness: Harness, file: string) {
  return spawnSync(process.execPath, stageArgs(harness, file), {
    cwd: ROOT,
    env: { PATH: process.env.PATH ?? '' },
    encoding: 'utf8',
    timeout: 3_000,
    killSignal: 'SIGKILL',
  });
}

function privateCapsule(harness: Harness, name: string): string {
  const file = path.join(harness.root, name);
  fs.copyFileSync(CAPSULE, file);
  if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
  return file;
}

describe('CLI --capsule-file descriptor security', () => {
  it('accepts only an owner-held regular nlink=1 file with exact 0600 mode', () => {
    const harness = makeHarness();
    const file = privateCapsule(harness, 'capsule.json');
    const result = runCapsuleFile(harness, file);
    expect(result.error).toBeUndefined();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  }, 15_000);

  it('stages a Profile without unsupported directory fsync under native Windows rules', () => {
    const harness = makeHarness();
    const file = privateCapsule(harness, 'windows-capsule.json');
    const platformHook = path.join(harness.root, 'win32-platform.cjs');
    fs.writeFileSync(
      platformHook,
      "Object.defineProperty(process, 'platform', { value: 'win32' });\n",
      { mode: 0o600 },
    );
    const result = spawnSync(process.execPath, stageArgs(harness, file), {
      cwd: ROOT,
      env: {
        PATH: process.env.PATH ?? '',
        NODE_OPTIONS: `--require=${platformHook}`,
      },
      encoding: 'utf8',
      timeout: 15_000,
      killSignal: 'SIGKILL',
    });
    expect(result.error).toBeUndefined();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  }, 20_000);

  it.skipIf(process.platform === 'win32').each([0o400, 0o640, 0o700])(
    'rejects a valid Capsule whose mode is %s instead of exact 0600',
    (mode) => {
      const harness = makeHarness();
      const file = privateCapsule(harness, `capsule-${mode.toString(8)}.json`);
      fs.chmodSync(file, mode);
      const result = runCapsuleFile(harness, file);
      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).not.toContain(file);
    },
  );

  it('rejects a hardlinked Capsule without changing either directory entry', () => {
    const harness = makeHarness();
    const outside = privateCapsule(harness, 'outside.json');
    const linked = path.join(harness.root, 'linked.json');
    fs.linkSync(outside, linked);
    const before = fs.readFileSync(outside);
    const result = runCapsuleFile(harness, linked);
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(fs.readFileSync(outside)).toEqual(before);
    expect(fs.statSync(outside).nlink).toBe(2);
  });

  it.skipIf(process.platform === 'win32')(
    'rejects symlink and FIFO inputs within the bounded child deadline',
    () => {
      const harness = makeHarness();
      const outside = privateCapsule(harness, 'outside.json');
      const symlink = path.join(harness.root, 'capsule-link.json');
      fs.symlinkSync(outside, symlink);
      const symlinkResult = runCapsuleFile(harness, symlink);
      expect(symlinkResult.error).toBeUndefined();
      expect(symlinkResult.status).not.toBe(0);

      const fifo = path.join(harness.root, 'capsule.fifo');
      const mkfifo = spawnSync('mkfifo', [fifo], { encoding: 'utf8' });
      expect(mkfifo.status, mkfifo.stderr).toBe(0);
      const fifoResult = runCapsuleFile(harness, fifo);
      expect(fifoResult.error).toBeUndefined();
      expect(fifoResult.status).not.toBe(0);
      expect(fifoResult.signal).not.toBe('SIGKILL');
    },
    15_000,
  );
});

describe('private atomic-write durability', () => {
  it('does not open unsupported directory handles under native Windows rules', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-win-dir-fsync-'));
    const probe = [
      "Object.defineProperty(process, 'platform', { value: 'win32' });",
      "const fs = require('node:fs');",
      `const root = ${JSON.stringify(root)};`,
      "const originalOpen = fs.openSync;",
      "let directoryOpenAttempts = 0;",
      "fs.openSync = function(target, ...args) {",
      "  if (String(target) === root) {",
      "    directoryOpenAttempts += 1;",
      "    const error = new Error('synthetic Windows directory-open failure');",
      "    error.code = 'EPERM';",
      "    throw error;",
      "  }",
      "  return originalOpen.call(this, target, ...args);",
      "};",
      `const storage = require(${JSON.stringify(path.join(ROOT, 'scripts/bootstrap-profile/storage.cjs'))});`,
      "try { storage.fsyncDirectory(root); } finally { fs.openSync = originalOpen; }",
      "process.stdout.write(JSON.stringify({ directoryOpenAttempts }));",
    ].join('\n');
    try {
      const result = spawnSync(process.execPath, ['-e', probe], {
        cwd: ROOT,
        encoding: 'utf8',
      });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ directoryOpenAttempts: 0 });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('readbacks the staged descriptor and removes the private temp when publication fails', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-bootstrap-atomic-write-'));
    roots.push(root);
    const target = path.join(root, 'openclaw.json');
    fs.writeFileSync(target, 'old\n', { mode: 0o600 });
    let reads = 0;
    const originalReadSync = fs.readSync;
    fs.readSync = ((...args: Parameters<typeof fs.readSync>) => {
      reads += 1;
      return (originalReadSync as any)(...args);
    }) as typeof fs.readSync;
    try {
      expect(() => storage.writeBytesAtomic(
        target,
        Buffer.from('new\n'),
        0o600,
        { beforeRename: () => { throw new Error('synthetic publication failure'); } },
      )).toThrow('synthetic publication failure');
    } finally {
      fs.readSync = originalReadSync;
    }
    expect(reads).toBeGreaterThan(0);
    expect(fs.readFileSync(target, 'utf8')).toBe('old\n');
    expect(fs.readdirSync(root)).toEqual(['openclaw.json']);
  });

  it.skipIf(process.platform === 'win32')(
    'ensure-config ignores the legacy predictable temp symlink attack and publishes a regular 0600 file',
    async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-ensure-writer-attack-'));
      roots.push(root);
      const configRoot = path.join(root, 'config');
      fs.mkdirSync(configRoot, { mode: 0o700 });
      const config = path.join(configRoot, 'openclaw.json');
      writeJson(config, { agents: { defaults: { timeoutSeconds: 300 } } });
      const templatePipe = path.join(root, 'template.fifo');
      expect(spawnSync('mkfifo', [templatePipe]).status).toBe(0);
      const victim = path.join(root, 'victim.txt');
      fs.writeFileSync(victim, 'PRESERVE_VICTIM\n', { mode: 0o600 });

      const child = spawn(process.execPath, [ENSURE_CONFIG, config], {
        cwd: ROOT,
        env: {
          PATH: process.env.PATH ?? '',
          RC_CONFIG_TEMPLATE_PATH: templatePipe,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      children.add(child);
      expect(child.pid).toBeTypeOf('number');
      const planted = `${config}.tmp.${child.pid}`;
      fs.symlinkSync(victim, planted);
      fs.writeFileSync(templatePipe, fs.readFileSync(EXAMPLE_CONFIG));
      const output = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
        let stdout = '';
        let stderr = '';
        child.stdout?.on('data', (chunk) => { stdout += chunk; });
        child.stderr?.on('data', (chunk) => { stderr += chunk; });
        child.once('close', (code) => resolve({ code, stdout, stderr }));
      });
      children.delete(child);

      expect(output.code, `${output.stdout}\n${output.stderr}`).toBe(0);
      expect(fs.readFileSync(victim, 'utf8')).toBe('PRESERVE_VICTIM\n');
      expect(fs.lstatSync(planted).isSymbolicLink()).toBe(true);
      const metadata = fs.lstatSync(config);
      expect(metadata.isFile()).toBe(true);
      expect(metadata.isSymbolicLink()).toBe(false);
      expect(metadata.mode & 0o777).toBe(0o600);
    },
    15_000,
  );
});

describe.skipIf(process.platform === 'win32')('transaction preimage privacy', () => {
  it('stores content as 0600 while retaining the original mode only in snapshot metadata', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-bootstrap-preimage-mode-'));
    roots.push(root);
    const source = path.join(root, 'source.json');
    const snapshot = path.join(root, 'snapshot');
    const restored = path.join(root, 'restored.json');
    fs.writeFileSync(source, 'RC_TEST_ONLY_PREIMAGE_SECRET\n', { mode: 0o644 });
    fs.chmodSync(source, 0o644);

    const digest = storage.snapshotPath(source, snapshot);
    const metadata = JSON.parse(fs.readFileSync(path.join(snapshot, 'snapshot.json'), 'utf8'));
    const entry = metadata.entries.find((candidate: any) => candidate.path === '');
    expect(entry).toMatchObject({ type: 'file', mode: 0o644 });
    expect(fs.statSync(path.join(snapshot, 'content/__root_file__')).mode & 0o777).toBe(0o600);

    storage.restorePath(restored, snapshot, digest);
    expect(fs.readFileSync(restored)).toEqual(fs.readFileSync(source));
    expect(fs.statSync(restored).mode & 0o777).toBe(0o644);
  });
});

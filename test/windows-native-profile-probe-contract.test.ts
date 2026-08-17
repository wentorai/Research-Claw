import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const PROBE_ROOT = path.join(
  ROOT,
  'scripts',
  'acceptance',
  'windows-native-profile-probe',
);
const PROBE = path.join(PROBE_ROOT, 'probe-windows-profile.cjs');
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function treeInventory(root: string): string[] {
  const entries: string[] = [];
  const visit = (target: string, relative: string): void => {
    const metadata = fs.lstatSync(target);
    entries.push(`${relative}:${metadata.isDirectory() ? 'directory' : 'file'}`);
    if (metadata.isDirectory()) {
      for (const name of fs.readdirSync(target).sort()) {
        visit(path.join(target, name), relative ? `${relative}/${name}` : name);
      }
    }
  };
  if (fs.existsSync(root)) visit(root, '.');
  return entries;
}

describe('Windows native Profile phase probe package', () => {
  it('passes its platform-independent safety self-test', () => {
    const result = spawnSync(process.execPath, [PROBE, '--self-test'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ ok: true, cases: 7 });
  });

  it('ships ASCII-only double-click launchers without credentials', () => {
    const files = [
      'Run-Wentor-Profile-Probe.cmd',
      'Run-Wentor-Profile-Probe.ps1',
      'README.txt',
      'SHA256SUMS.txt',
      'probe-windows-profile.cjs',
    ];
    for (const name of files) {
      expect(fs.statSync(path.join(PROBE_ROOT, name)).isFile()).toBe(true);
    }
    for (const name of files.filter((value) => value.endsWith('.cmd') || value.endsWith('.ps1'))) {
      const bytes = fs.readFileSync(path.join(PROBE_ROOT, name));
      expect([...bytes].every((byte) => byte > 0 && byte < 0x80)).toBe(true);
    }
    const launcher = fs.readFileSync(path.join(PROBE_ROOT, 'Run-Wentor-Profile-Probe.ps1'), 'utf8');
    const pinnedProbe = launcher.match(/\$probeSha256 = '([0-9a-f]{64})'/)?.[1];
    expect(pinnedProbe).toBe(crypto.createHash('sha256').update(fs.readFileSync(PROBE)).digest('hex'));
    const source = fs.readFileSync(PROBE, 'utf8');
    for (const [name, constant] of [
      ['maintenance-lease.cjs', 'CANDIDATE_MAINTENANCE_SHA256'],
      ['storage.cjs', 'CANDIDATE_STORAGE_SHA256'],
    ] as const) {
      const sourceBytes = fs.readFileSync(path.join(ROOT, 'scripts', 'bootstrap-profile', name));
      const candidateBytes = fs.readFileSync(path.join(PROBE_ROOT, 'candidate', name));
      expect(candidateBytes).toEqual(sourceBytes);
      const expected = crypto.createHash('sha256').update(sourceBytes).digest('hex');
      expect(source.match(new RegExp(`const ${constant} = '([0-9a-f]{64})'`))?.[1]).toBe(expected);
      const psName = name === 'maintenance-lease.cjs'
        ? 'candidateMaintenanceSha256' : 'candidateStorageSha256';
      expect(launcher.match(new RegExp(`\\$${psName} = '([0-9a-f]{64})'`))?.[1]).toBe(expected);
    }
    const combined = files.map((name) => fs.readFileSync(path.join(PROBE_ROOT, name), 'utf8')).join('\n');
    const operatorFiles = files
      .filter((name) => name !== 'probe-windows-profile.cjs')
      .map((name) => fs.readFileSync(path.join(PROBE_ROOT, name), 'utf8'))
      .join('\n');
    expect(combined).not.toMatch(/rca_[A-Za-z0-9_-]{43,}/);
    expect(combined).not.toMatch(/(^|[^A-Za-z0-9_-])sk-(?:proj-)?[A-Za-z0-9_-]{16,}/m);
    expect(operatorFiles).not.toMatch(/Authorization\s*:\s*Bearer\s+\S+/i);
    expect(combined).not.toContain('AuthToken');
  });

  it('keeps live access read-only and isolates every mutating phase', () => {
    const source = fs.readFileSync(PROBE, 'utf8');
    expect(source).toContain("const LIVE_OPERATIONS = new Set(['status'])");
    expect(source).toContain("'initialize-locks', 'recover', 'stage', 'apply', 'verify', 'rollback'");
    expect(source).not.toContain("'commit'");
    expect(source).toContain("'ProfileProbe', runId");
    expect(source).toContain("'Windows path - \\u7a7a\\u683c - Profile probe'");
    expect(source).toContain("key.startsWith('RC_TEST_ONLY_')");
    expect(source).toContain('transactionSurfaceDigest(paths)');
    expect(source).toContain('transactionControlState(paths)');
    expect(source).toContain("['.rc-bootstrap-transactions']");
    expect(source).toContain('candidateMaintenanceOverlay: true');
    expect(source).toContain('loadCandidateMaintenance(payload)');
    expect(source).not.toContain('--auth-token');
  });

  it('closes child stdin and publishes phase-specific non-secret errors', () => {
    const source = fs.readFileSync(PROBE, 'utf8');
    expect(source).toContain("stdio: ['ignore', 'pipe', 'pipe']");
    expect(source).toContain('safeErrorDetails');
    expect(source).toContain('syscall');
    expect(source).toContain('pathClass');
    expect(source).toContain('firstFailedPhase');
    expect(source).toContain('Refusing to publish a report containing a secret shape');
  });

  it('drives the real isolated stage/apply/verify/rollback sequence through workers', () => {
    const taskRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-profile-probe-contract-'));
    temporaryRoots.push(taskRoot);
    const isolatedRoot = path.join(taskRoot, 'Windows path - 空格 - Profile probe');
    const candidateRoot = path.join(taskRoot, 'candidate');
    fs.mkdirSync(candidateRoot, { recursive: true, mode: 0o700 });
    for (const name of ['maintenance-lease.cjs', 'storage.cjs']) {
      fs.copyFileSync(path.join(ROOT, 'scripts', 'bootstrap-profile', name), path.join(candidateRoot, name));
    }
    const paths = {
      rcRoot: ROOT,
      configPath: path.join(isolatedRoot, 'config', 'openclaw.json'),
      workspace: path.join(isolatedRoot, 'workspace'),
      stateDir: path.join(isolatedRoot, 'state'),
      dbPath: path.join(isolatedRoot, 'data', 'library.db'),
      globalConfigPath: path.join(isolatedRoot, 'state', 'openclaw.json'),
      capsuleFile: path.join(isolatedRoot, 'capsule', 'capsule.json'),
    };
    fs.mkdirSync(path.dirname(paths.dbPath), { recursive: true, mode: 0o700 });
    writeJson(paths.configPath, {
      agents: { defaults: { model: { primary: 'user-provider/user-model' } } },
      models: {
        mode: 'merge',
        providers: {
          'user-provider': {
            baseUrl: 'https://user.invalid/v1',
            api: 'openai-completions',
            models: [{ id: 'user-model', name: 'User model', input: ['text'], contextWindow: 1, maxTokens: 1 }],
            userOwned: true,
          },
        },
      },
      plugins: { entries: {
        'research-claw-core': { enabled: true, config: { userField: 'preserve' } },
        'dual-model-supervisor': { enabled: false, config: { enabled: false, reviewMode: 'off' } },
      } },
      tools: { deny: ['user_deny'] },
    });
    const authFile = path.join(paths.stateDir, 'agents', 'main', 'agent', 'auth-profiles.json');
    writeJson(authFile, {
      version: 1,
      profiles: {
        'user-provider:manual': {
          type: 'api_key', provider: 'user-provider', key: 'RC_TEST_ONLY_USER_OWNED_FAKE_KEY',
        },
      },
    });
    writeJson(paths.globalConfigPath, { userGlobal: { preserve: true } });
    const userSkill = path.join(paths.workspace, 'skills', 'user-skill', 'SKILL.md');
    fs.mkdirSync(path.dirname(userSkill), { recursive: true, mode: 0o700 });
    fs.writeFileSync(userSkill, '---\nname: user-skill\ndescription: probe fixture\n---\n\nPRESERVE\n');
    fs.mkdirSync(path.dirname(paths.capsuleFile), { recursive: true, mode: 0o700 });
    fs.copyFileSync(
      path.join(ROOT, 'profiles', 'fixtures', 'thermoelectric-user-a', 'capsule.json'),
      paths.capsuleFile,
    );
    if (process.platform !== 'win32') fs.chmodSync(paths.capsuleFile, 0o600);

    const before = {
      config: fs.readFileSync(paths.configPath),
      auth: fs.readFileSync(authFile),
      global: fs.readFileSync(paths.globalConfigPath),
      skill: fs.readFileSync(userSkill),
    };
    const run = (operation: string, txId: string | null = null): any => {
      const payloadFile = path.join(taskRoot, `payload-${operation}.json`);
      writeJson(payloadFile, { scope: 'isolated', operation, paths, txId, candidateRoot });
      const result = spawnSync(process.execPath, [PROBE, '--worker', payloadFile], {
        cwd: ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const parsed = JSON.parse(result.stdout);
      expect(result.status, `${operation}: ${result.stderr}\n${result.stdout}`).toBe(0);
      expect(parsed).toMatchObject({ ok: true, phase: operation });
      return parsed;
    };

    run('initialize-locks');
    run('recover');
    const transactionSurfaceRoots = [
      path.dirname(paths.configPath),
      paths.workspace,
      paths.stateDir,
      path.dirname(paths.dbPath),
      path.dirname(paths.capsuleFile),
    ];
    const surfaceBeforeStage = transactionSurfaceRoots.flatMap((root) => (
      treeInventory(root).map((entry) => `${root}:${entry}`)
    ));
    const staged = run('stage');
    run('apply', staged.result.txId);
    run('verify', staged.result.txId);
    run('rollback', staged.result.txId);

    expect(fs.readFileSync(paths.configPath)).toEqual(before.config);
    expect(fs.readFileSync(authFile)).toEqual(before.auth);
    expect(fs.readFileSync(paths.globalConfigPath)).toEqual(before.global);
    expect(fs.readFileSync(userSkill)).toEqual(before.skill);
    expect(fs.existsSync(path.join(
      path.dirname(paths.configPath),
      '.rc-bootstrap',
      'receipt.json',
    ))).toBe(false);
    expect(fs.readdirSync(path.join(
      path.dirname(paths.configPath),
      '.rc-bootstrap',
      'transactions',
    ))).toEqual([]);
    const surfaceAfterRollback = transactionSurfaceRoots.flatMap((root) => (
      treeInventory(root).map((entry) => `${root}:${entry}`)
    ));
    expect(surfaceAfterRollback.filter((entry) => !surfaceBeforeStage.includes(entry))).toEqual([
      `${path.dirname(paths.configPath)}:./.rc-bootstrap/cron-worker-cleanup-quarantine:directory`,
      `${path.dirname(paths.configPath)}:./.rc-bootstrap/transactions:directory`,
      `${paths.workspace}:./.rc-bootstrap-transactions:directory`,
      `${paths.stateDir}:./.rc-bootstrap-transactions:directory`,
      `${path.dirname(paths.dbPath)}:./.rc-bootstrap-transactions:directory`,
    ]);
    for (const root of [
      path.join(path.dirname(paths.configPath), '.rc-bootstrap', 'cron-worker-cleanup-quarantine'),
      path.join(path.dirname(paths.configPath), '.rc-bootstrap', 'transactions'),
      path.join(paths.workspace, '.rc-bootstrap-transactions'),
      path.join(paths.stateDir, '.rc-bootstrap-transactions'),
      path.join(path.dirname(paths.dbPath), '.rc-bootstrap-transactions'),
    ]) expect(fs.readdirSync(root)).toEqual([]);
  }, 30_000);
});

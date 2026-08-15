import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { afterEach, describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const ROOT_GITIGNORE = path.join(ROOT, '.gitignore');
const INSTALLER = path.join(ROOT, 'scripts/install.sh');
const REQUIRED_DIRECTORY_RULES = [
  'config/.rc-bootstrap/',
  'config/.rc-bootstrap-lock-authority/',
] as const;
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', ['-c', 'core.excludesFile=/dev/null', ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
    },
  });
  expect(result.error).toBeUndefined();
  expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
  return result.stdout;
}

function writePrivate(file: string, bytes: string | Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(path.dirname(file), 0o700);
  fs.writeFileSync(file, bytes, { mode: 0o600 });
  if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
}

function makeGitFixture(): {
  root: string;
  privateFiles: string[];
  trackedExample: string;
  ordinaryUntracked: string;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-bootstrap-git-clean-'));
  temporaryRoots.push(root);
  fs.copyFileSync(ROOT_GITIGNORE, path.join(root, '.gitignore'));
  const trackedExample = path.join(root, 'config', 'openclaw.example.json');
  fs.mkdirSync(path.dirname(trackedExample), { recursive: true });
  fs.writeFileSync(trackedExample, '{"tracked":"baseline"}\n');
  git(root, ['init', '--quiet']);
  git(root, ['config', 'user.name', 'RC Bootstrap Test']);
  git(root, ['config', 'user.email', 'rc-bootstrap-test@invalid.example']);
  git(root, ['add', '.gitignore', 'config/openclaw.example.json']);
  git(root, ['commit', '--quiet', '-m', 'fixture baseline']);

  const txId = 'tx-00000000-0000-4000-8000-000000000001';
  const privateFiles = [
    path.join(root, 'config', '.rc-bootstrap-lock-authority', 'authority.json'),
    path.join(root, 'config', '.rc-bootstrap', 'locks', 'authority.json'),
    path.join(root, 'config', '.rc-bootstrap', 'locks', 'identity.json'),
    path.join(root, 'config', '.rc-bootstrap', 'locks', 'operation.sqlite'),
    path.join(root, 'config', '.rc-bootstrap', 'locks', 'runtime.sqlite'),
    path.join(root, 'config', '.rc-bootstrap', 'transactions', txId, 'manifest.json'),
    path.join(root, 'config', '.rc-bootstrap', 'transactions', txId, 'capsule.json'),
    path.join(
      root,
      'config',
      '.rc-bootstrap',
      'transactions',
      txId,
      'preimage',
      'auth',
      'content',
      '__root_file__',
    ),
  ];
  const contents: Array<string | Buffer> = [
    '{"version":1,"rootUuid":"outer-authority"}\n',
    '{"version":1,"rootUuid":"inner-authority"}\n',
    '{"version":1,"rootUuid":"lock-identity"}\n',
    Buffer.from([0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x00, 0x01]),
    Buffer.from([0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x00, 0x02]),
    `{"version":1,"txId":"${txId}","state":"applying"}\n`,
    '{"schemaVersion":1,"secrets":{"modelApiKey":"RC_TEST_ONLY_FAKE_GIT_CLEAN_KEY"}}\n',
    '{"version":1,"profiles":{"old":{"key":"RC_TEST_ONLY_FAKE_PREIMAGE_KEY"}}}\n',
  ];
  for (const [index, file] of privateFiles.entries()) writePrivate(file, contents[index]);
  const ordinaryUntracked = path.join(root, 'ordinary-untracked.txt');
  fs.writeFileSync(ordinaryUntracked, 'git clean must remove this control file\n');
  fs.writeFileSync(trackedExample, '{"tracked":"must-reset"}\n');
  return { root, privateFiles, trackedExample, ordinaryUntracked };
}

function byteIdentity(file: string): { digest: string; size: number; mode: number | null } {
  const metadata = fs.statSync(file);
  return {
    digest: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
    size: metadata.size,
    mode: process.platform === 'win32' ? null : metadata.mode & 0o777,
  };
}

describe('bootstrap private state survives installer git cleanup', () => {
  it('ignores both private config directories as whole trees and never enumerates their contents', () => {
    const sourceRules = fs.readFileSync(ROOT_GITIGNORE, 'utf8')
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#'));
    for (const rule of REQUIRED_DIRECTORY_RULES) expect(sourceRules).toContain(rule);

    const fixture = makeGitFixture();
    const status = git(fixture.root, ['status', '--porcelain=v1', '--untracked-files=all']);
    expect(status).toBe(' M config/openclaw.example.json\n?? ordinary-untracked.txt\n');
    for (const file of fixture.privateFiles) {
      const relative = path.relative(fixture.root, file).split(path.sep).join('/');
      const ignored = git(fixture.root, ['check-ignore', '--no-index', '--verbose', relative]);
      expect(ignored).toContain(`\t${relative}\n`);
      expect(status).not.toContain(relative);
    }
  });

  it('preserves authority, identity, transaction, preimage, and Capsule bytes across real reset and clean', () => {
    const installer = fs.readFileSync(INSTALLER, 'utf8');
    expect(installer).toContain('git reset --hard HEAD');
    expect(installer).toContain('git clean -fd');
    const fixture = makeGitFixture();
    const before = new Map(fixture.privateFiles.map((file) => [file, byteIdentity(file)]));

    // These are the same destructive Git operations used by scripts/install.sh.
    git(fixture.root, ['reset', '--hard', 'HEAD']);
    git(fixture.root, ['clean', '-fd']);

    expect(fs.readFileSync(fixture.trackedExample, 'utf8')).toBe('{"tracked":"baseline"}\n');
    expect(fs.existsSync(fixture.ordinaryUntracked)).toBe(false);
    for (const file of fixture.privateFiles) {
      expect(fs.existsSync(file), `${path.relative(fixture.root, file)} must survive git clean`).toBe(true);
      expect(byteIdentity(file)).toEqual(before.get(file));
    }
    expect(git(fixture.root, ['status', '--porcelain=v1', '--untracked-files=all'])).toBe('');
  });
});

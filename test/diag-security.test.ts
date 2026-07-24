import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const DIAG = path.join(ROOT, 'scripts', 'diag.sh');
const REDACTOR = path.join(ROOT, 'scripts', 'diag-redact.mjs');

function readAllFiles(root: string): string {
  const chunks: string[] = [];
  const visit = (entryPath: string): void => {
    const stat = fs.statSync(entryPath);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(entryPath)) visit(path.join(entryPath, name));
      return;
    }
    chunks.push(fs.readFileSync(entryPath, 'utf8'));
  };
  visit(root);
  return chunks.join('\n');
}

describe('diag.sh security boundary', () => {
  let tempRoot: string;
  let homeDir: string;
  let stateDir: string;
  let configPath: string;
  let outDir: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rc-diag-'quoted-"));
    homeDir = path.join(tempRoot, "home-'with-quote");
    stateDir = path.join(tempRoot, "state-'with-quote");
    configPath = path.join(tempRoot, "config-'with-quote.json");
    outDir = path.join(tempRoot, "output-'with-quote");
    fs.mkdirSync(path.join(homeDir, '.research-claw', 'logs'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs', 'stability'), { recursive: true });
    fs.mkdirSync(outDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('redacts every collected artifact while preserving useful non-sensitive context', () => {
    const secrets = {
      array: 'sk-test-DIAG_ARRAY_SECRET_1234567890',
      cookie: 'DIAG_COOKIE_SECRET_1234567890',
      webhook: 'DIAG_WEBHOOK_SECRET_1234567890',
      proxyUser: 'DIAG_PROXY_USER',
      proxyPass: 'DIAG_PROXY_PASS_1234567890',
      passphrase: 'DIAG_PASSPHRASE_SECRET_1234567890',
      audit: 'DIAG_AUDIT_SECRET_1234567890',
      crash: 'DIAG_CRASH_SECRET_1234567890',
    };
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        logging: { redactSensitive: 'off' },
        keep: 'keep-config-context',
        command: ['provider', '--api-key', secrets.array],
        headers: { Cookie: `session=${secrets.cookie}` },
        webhook: `https://hooks.slack.com/services/T/B/${secrets.webhook}`,
        passphrase: secrets.passphrase,
        env: {
          vars: {
            HTTPS_PROXY: `http://${secrets.proxyUser}:${secrets.proxyPass}@proxy.example:7890`,
          },
        },
      }, null, 2),
    );
    fs.writeFileSync(
      path.join(homeDir, '.research-claw', 'logs', 'openclaw.log'),
      `keep-openclaw-context\nCookie: session=${secrets.cookie}\n`,
    );
    fs.writeFileSync(
      path.join(homeDir, '.research-claw', 'logs', 'run-latest.log'),
      `keep-run-context\nProxy: http://${secrets.proxyUser}:${secrets.proxyPass}@proxy.example:7890\n`,
    );
    fs.writeFileSync(
      path.join(stateDir, 'logs', 'config-audit.jsonl'),
      `${JSON.stringify({ event: 'keep-audit-context', bearer: secrets.audit })}\n`,
    );
    fs.writeFileSync(
      path.join(stateDir, 'logs', 'stability', 'gateway-startup_failed-fixture.json'),
      JSON.stringify({ keep: 'keep-crash-context', authorization: secrets.crash }),
    );

    const result = spawnSync('bash', [DIAG], {
      cwd: ROOT,
      env: {
        ...process.env,
        HOME: homeDir,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: configPath,
        RC_DIAG_OUT: outDir,
        RC_DIAG_TS: 'security-test',
      },
      encoding: 'utf8',
      timeout: 30_000,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain('best-effort');
    expect(`${result.stdout}\n${result.stderr}`).toContain('redactSensitive=off');

    const bundle = path.join(outDir, 'rc-diag-security-test.tar.gz');
    expect(fs.statSync(bundle).mode & 0o777).toBe(0o600);
    const extracted = path.join(tempRoot, 'extracted');
    fs.mkdirSync(extracted);
    execFileSync('tar', ['xzf', bundle, '-C', extracted]);

    for (const relativePath of [
      'MANIFEST.txt',
      'versions.txt',
      'health.txt',
      'logs/openclaw.log',
      'logs/run-latest.log',
      'config/project-openclaw.json',
      'config-audit.jsonl',
      'stability/gateway-startup_failed-fixture.json',
    ]) {
      expect(
        fs.existsSync(path.join(extracted, relativePath)),
        `${relativePath}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      ).toBe(true);
    }

    const bundleText = readAllFiles(extracted);
    for (const secret of Object.values(secrets)) {
      expect(bundleText, `leaked ${secret}`).not.toContain(secret);
    }
    for (const useful of [
      'keep-config-context',
      'keep-openclaw-context',
      'keep-run-context',
      'keep-audit-context',
      'keep-crash-context',
    ]) {
      expect(bundleText).toContain(useful);
    }
  }, 20_000);

  it('fails closed without printing success when the output path is not a directory', () => {
    const notDirectory = path.join(tempRoot, 'not-a-directory');
    fs.writeFileSync(notDirectory, 'occupied');
    fs.writeFileSync(configPath, JSON.stringify({ keep: true }));

    const result = spawnSync('bash', [DIAG], {
      cwd: ROOT,
      env: {
        ...process.env,
        HOME: homeDir,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: configPath,
        RC_DIAG_OUT: notDirectory,
        RC_DIAG_TS: 'must-fail',
        TMPDIR: tempRoot,
      },
      encoding: 'utf8',
      timeout: 30_000,
    });

    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain('诊断包已生成');
    expect(
      fs.readdirSync(tempRoot).filter((name) => name.startsWith('rc-diag-')),
    ).toEqual([]);
  });

  it('reports tar failure and removes its protected staging directory via EXIT trap', () => {
    const fakeBin = path.join(tempRoot, 'fake-bin');
    const stagingRoot = path.join(tempRoot, 'staging');
    fs.mkdirSync(fakeBin);
    fs.mkdirSync(stagingRoot);
    const fakeTar = path.join(fakeBin, 'tar');
    fs.writeFileSync(fakeTar, '#!/bin/sh\nexit 9\n');
    fs.chmodSync(fakeTar, 0o700);
    fs.writeFileSync(configPath, JSON.stringify({ keep: true }));

    const result = spawnSync('bash', [DIAG], {
      cwd: ROOT,
      env: {
        ...process.env,
        HOME: homeDir,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: configPath,
        RC_DIAG_OUT: outDir,
        RC_DIAG_TS: 'tar-failure',
        TMPDIR: stagingRoot,
        PATH: `${fakeBin}:${process.env.PATH}`,
      },
      encoding: 'utf8',
      timeout: 30_000,
    });

    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain('诊断包已生成');
    expect(result.stderr).toContain('tar 打包失败');
    expect(fs.readdirSync(stagingRoot)).toEqual([]);
    expect(fs.existsSync(path.join(outDir, 'rc-diag-tar-failure.tar.gz'))).toBe(false);
  }, 15_000);

  it('reduces a proxy URL to scheme, host, and port for run.sh logging', () => {
    const secretUser = 'DIAG_PROXY_LOG_USER';
    const secretPass = 'DIAG_PROXY_LOG_PASSWORD';
    const output = execFileSync(
      process.execPath,
      [REDACTOR, 'proxy', '-', '-'],
      {
        input: `http://${secretUser}:${secretPass}@127.0.0.1:7890/private`,
        encoding: 'utf8',
      },
    );

    expect(output).toBe('http://127.0.0.1:7890');
    expect(output).not.toContain(secretUser);
    expect(output).not.toContain(secretPass);
    expect(output).not.toContain('/private');
  });
});

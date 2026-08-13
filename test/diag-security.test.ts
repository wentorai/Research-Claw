import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const DIAG = path.join(ROOT, 'scripts', 'diag.sh');
const REDACTOR = path.join(ROOT, 'scripts', 'diag-redact.mjs');

/**
 * diag.sh spawns a node redactor per collected artifact, so it is the slowest
 * thing this repo tests: ~4s on an idle box, ~18s when the machine is
 * oversubscribed. Two budgets, and the order between them matters — a test cap
 * below the subprocess budget it grants kills the run being measured partway
 * through, which surfaces as a flaky assertion (SIGTERM → exit 143) rather than
 * as the slow-machine symptom it actually is. Keep TEST strictly above SUBPROCESS.
 */
const DIAG_SUBPROCESS_TIMEOUT_MS = 90_000;
const DIAG_TEST_TIMEOUT_MS = 120_000;

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
      [
        JSON.stringify({ message: 'keep-openclaw-context', Cookie: `session=${secrets.cookie}` }),
        '{"message":"malformed-openclaw-context","token":"broken-json-secret"',
        JSON.stringify({ message: 'keep-openclaw-after-malformed' }),
        '',
      ].join('\n'),
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
      timeout: DIAG_SUBPROCESS_TIMEOUT_MS,
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
      'keep-openclaw-after-malformed',
      'keep-run-context',
      'keep-audit-context',
      'keep-crash-context',
    ]) {
      expect(bundleText).toContain(useful);
    }
    expect(result.stdout).toContain('openclaw.log: malformed JSONL lines=1');
    expect(bundleText).toContain('"malformed":true');
    const manifest = fs.readFileSync(path.join(extracted, 'MANIFEST.txt'), 'utf8');
    expect(manifest).toContain('openclaw.log: ok (3 lines; malformed_count=1)');
    for (const line of fs.readFileSync(path.join(extracted, 'logs', 'openclaw.log'), 'utf8').split('\n')) {
      if (line) expect(() => JSON.parse(line)).not.toThrow();
    }
  }, DIAG_TEST_TIMEOUT_MS);

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
      timeout: DIAG_SUBPROCESS_TIMEOUT_MS,
    });

    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain('诊断包已生成');
    expect(
      fs.readdirSync(tempRoot).filter((name) => name.startsWith('rc-diag-')),
    ).toEqual([]);
  }, DIAG_TEST_TIMEOUT_MS);

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
      timeout: DIAG_SUBPROCESS_TIMEOUT_MS,
    });

    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain('诊断包已生成');
    expect(result.stderr).toContain('tar 打包失败');
    // Assert on the staging directories diag.sh owns, not on the whole TMPDIR.
    // Node writes its own scratch state here (`node-compile-cache`), so an
    // emptiness assertion measures the runtime's housekeeping rather than the
    // EXIT trap under test, and fails on any machine that has the compile cache
    // enabled — which CI does, since nothing sets NODE_DISABLE_COMPILE_CACHE.
    expect(
      fs.readdirSync(stagingRoot).filter((name) => name.startsWith('rc-diag-')),
    ).toEqual([]);
    expect(fs.existsSync(path.join(outDir, 'rc-diag-tar-failure.tar.gz'))).toBe(false);
  }, DIAG_TEST_TIMEOUT_MS);

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

  // Log tails are the weakest artifact in the bundle: they are copied as free
  // text, cut at an arbitrary line, and pack headers into one blob. These are
  // the secret shapes that survived the line-by-line pass.
  describe('log-tail text redaction', () => {
    const redactText = (input: string): string =>
      execFileSync(process.execPath, [REDACTOR, 'text', '-', '-'], {
        input,
        encoding: 'utf8',
      });

    it('folds a multi-line PEM private key before the per-line pass sees it', () => {
      const body = 'DIAG_PEM_BODY_SECRET_1234567890';
      const output = redactText(
        [
          'keep-before-context',
          '-----BEGIN RSA PRIVATE KEY-----', // pragma: allowlist secret
          `MIIBOwIBAAJB${body}AAAAAAAAAAAAAAAA`,
          `BBBB${body}CCCCCCCCCCCCCCCCCCCC`,
          '-----END RSA PRIVATE KEY-----',
          'keep-after-context',
        ].join('\n'),
      );

      expect(output).not.toContain(body);
      expect(output).toContain('keep-before-context');
      expect(output).toContain('keep-after-context');
    });

    it('redacts a PEM key truncated by tail at either marker', () => {
      const head = 'DIAG_PEM_HEAD_SECRET_1234567890';
      // A real PEM body is base64, which is what identifies an orphaned tail.
      const tail = 'DIAGPEMTAILSECRET1234567890';

      expect(
        redactText(`-----BEGIN OPENSSH PRIVATE KEY-----\n${head}AAAAAAAAAAAA\n`), // pragma: allowlist secret
      ).not.toContain(head);
      expect(
        redactText(
          `keep-before-context\n${tail}BBBBBBBBBBBB\n-----END RSA PRIVATE KEY-----\n`,
        ),
      ).not.toContain(tail);
    });

    it('redacts a Cookie header packed mid-line', () => {
      const secret = 'DIAG_INLINE_COOKIE_SECRET_1234567890';
      const output = redactText(
        `DEBUG req GET /x headers={host: a.com, Cookie: sid=${secret}; theme=dark} ua=curl\n`,
      );

      expect(output).not.toContain(secret);
      expect(output).toContain('ua=curl');
    });

    it('redacts scheme-less proxy userinfo without clobbering ordinary key:value', () => {
      const secret = 'DIAG_SCHEMELESS_PROXY_PASS_1234567890';
      const output = redactText(
        `HTTPS_PROXY=proxyuser:${secret}@10.0.0.1:7890\nINFO host=api.example.com:443 t=12:30:45\n`,
      );

      expect(output).not.toContain(secret);
      expect(output).toContain('host=api.example.com:443');
      expect(output).toContain('t=12:30:45');
    });
  });

  /**
   * The redactor runs OpenClaw's redactSensitiveText first and the local rules
   * second. If that import ever breaks, the local rules still run — so every
   * test above keeps passing while the bundle quietly scrubs less. These assert
   * the first net is present, so an OpenClaw upgrade that moves or renames it
   * fails here instead of shipping a weaker bundle.
   */
  describe('OpenClaw redaction layer', () => {
    it('still exports redactSensitiveText from the imported entrypoint', async () => {
      const loggingCore = await import('openclaw/plugin-sdk/logging-core');
      expect(typeof loggingCore.redactSensitiveText).toBe('function');
    });

    it('runs without reporting a degraded layer', () => {
      const result = spawnSync(process.execPath, [REDACTOR, 'text', '-', '-'], {
        input: 'INFO nothing sensitive here\n',
        encoding: 'utf8',
      });

      expect(result.status).toBe(0);
      expect(result.stderr).not.toContain('openclaw redaction layer unavailable');
    });
  });
});

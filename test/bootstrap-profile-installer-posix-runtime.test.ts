import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { afterEach, describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const roots: string[] = [];
const SECRET = `rca_${'A'.repeat(43)}`;

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function extractProfileBlock(file: string): { source: string; redeemsInline: boolean } {
  const content = fs.readFileSync(file, 'utf8');
  const start = content.indexOf('RC_BOOTSTRAP_REDEEM_URL=');
  const end = content.indexOf('\n# ── Diagnostic breadcrumb log', start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const source = content.slice(start, end);
  return {
    source,
    redeemsInline: source.includes('rc_profile_redeem\n'),
  };
}

function makeRuntime(installer: 'native' | 'docker') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `rc-installer-${installer}-`));
  roots.push(root);
  const temp = path.join(root, 'tmp');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(temp, { mode: 0o700 });
  fs.mkdirSync(bin, { mode: 0o700 });
  const observations = path.join(root, 'observations');
  fs.mkdirSync(observations, { mode: 0o700 });
  const fakeCurl = path.join(bin, 'curl');
  fs.writeFileSync(fakeCurl, `#!/usr/bin/env bash
set -eu
case " $* " in
  *'/healthz'*)
    printf '%s\\n' "$*" >> "$RC_TEST_OBSERVATIONS/health-argv"
    exit "\${RC_TEST_HEALTH_EXIT:-0}"
    ;;
esac
[ "\${1:-}" = '-q' ] && [ "\${2:-}" = '--config' ] || exit 96
printf '%s\\n' "$@" > "$RC_TEST_OBSERVATIONS/curl-argv"
env | LC_ALL=C sort > "$RC_TEST_OBSERVATIONS/curl-env"
config="$3"
test "$(grep -Fxc 'header = "Accept: application/json"' "$config")" = 1
if [ "$(uname -s)" = Darwin ]; then
  mode=$(stat -f '%Lp' "$config")
  root_mode=$(stat -f '%Lp' "$(dirname "$config")")
else
  mode=$(stat -c '%a' "$config")
  root_mode=$(stat -c '%a' "$(dirname "$config")")
fi
printf '%s %s\\n' "$root_mode" "$mode" > "$RC_TEST_OBSERVATIONS/modes"
if [ "\${RC_TEST_CURL_FAIL:-0}" = 1 ]; then exit 22; fi
headers=$(sed -n 's/^dump-header = "\\(.*\\)"$/\\1/p' "$config")
case "\${RC_TEST_REDEEM_MODE:-valid}" in
  oversized)
    length=3145728
    ;;
  *) length=17 ;;
esac
content_type='application/json; charset=utf-8'
content_encoding='identity'
declared_length="$length"
case "\${RC_TEST_REDEEM_MODE:-valid}" in
  wrong-content-type) content_type='text/plain; charset=utf-8' ;;
  compressed) content_encoding='gzip' ;;
  mismatched-length) declared_length=$((length + 1)) ;;
esac
status='200 OK'
case "\${RC_TEST_REDEEM_MODE:-valid}" in
  wrong-status) status='201 Created' ;;
esac
printf 'HTTP/1.1 %s\\r\\nContent-Type: %s\\r\\nContent-Encoding: %s\\r\\n' \
  "$status" \
  "$content_type" "$content_encoding" > "$headers"
case "\${RC_TEST_REDEEM_MODE:-valid}" in
  missing-length) printf '\\r\\n' >> "$headers" ;;
  chunked-with-length)
    printf 'Transfer-Encoding: chunked\\r\\nContent-Length: %s\\r\\n\\r\\n' \
      "$declared_length" >> "$headers"
    ;;
  chunked-trailer-length)
    printf 'Transfer-Encoding: chunked\\r\\n\\r\\nContent-Length: %s\\r\\n\\r\\n' \
      "$declared_length" >> "$headers"
    ;;
  *) printf 'Content-Length: %s\\r\\n\\r\\n' "$declared_length" >> "$headers" ;;
esac
case "\${RC_TEST_REDEEM_MODE:-valid}" in
  oversized) dd if=/dev/zero bs=1048576 count=3 2>/dev/null ;;
  *) printf '{"fixture":true}\\n' ;;
esac
`, { mode: 0o700 });

  const file = installer === 'native'
    ? path.join(ROOT, 'scripts/install.sh') : path.join(ROOT, 'scripts/install-docker.sh');
  const block = extractProfileBlock(file);
  const runner = path.join(root, 'runner.sh');
  fs.writeFileSync(runner, `#!/usr/bin/env bash
set -euo pipefail
R='' G='' C='' Y='' B='' D='' N=''
INSTALL_DIR="$RC_TEST_ROOT/install"
GW_NODE=/does/not/exist
IMAGE=fixture.invalid/research-claw:latest
CONTAINER=research-claw
ROLLBACK_CONTAINER=research-claw-rollback
PORT=28789
die() { printf 'installer-error\\n' >&2; exit 64; }
${block.source}
${block.redeemsInline ? '' : 'rc_profile_redeem'}
test -z "\${RC_PROFILE_AUTH_TOKEN+x}"
test -s "$RC_PROFILE_CAPSULE"
test "$(cat "$RC_PROFILE_CAPSULE")" = '{"fixture":true}'
rc_profile_cleanup_host_secret
trap - EXIT
test -z "$(find "$TMPDIR" -mindepth 1 -maxdepth 1 -print -quit)"
printf 'runtime-ok\\n'
`, { mode: 0o700 });

  const env = {
    PATH: `${bin}:/usr/bin:/bin`,
    HOME: path.join(root, 'home'),
    TMPDIR: temp,
    RC_TEST_ROOT: root,
    RC_TEST_OBSERVATIONS: observations,
  };
  return { root, temp, observations, runner, env };
}

function runDockerRestoreState(state: string, rollbackExit = 0) {
  const runtime = makeRuntime('docker');
  const dockerLog = path.join(runtime.root, 'docker.log');
  const fakeDocker = path.join(runtime.root, 'bin', 'docker');
  fs.writeFileSync(fakeDocker, `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$RC_TEST_DOCKER_LOG"
case " $* " in
  *' /app/scripts/apply-bootstrap-profile.cjs rollback '*)
    if [ ${rollbackExit} -ne 0 ]; then exit ${rollbackExit}; fi
    printf '{"state":"rolled-back"}\\n'
    ;;
esac
`, { mode: 0o700 });
  const block = extractProfileBlock(path.join(ROOT, 'scripts/install-docker.sh')).source;
  const runner = path.join(runtime.root, 'restore-state-runner.sh');
  fs.writeFileSync(runner, `#!/usr/bin/env bash
set -euo pipefail
R='' G='' C='' Y='' B='' D='' N=''
IMAGE=fixture.invalid/research-claw:latest
CONTAINER=research-claw
ROLLBACK_CONTAINER=research-claw-rollback
PORT=28789
HEALTH_TIMEOUT=2
die() { exit 64; }
warn() { :; }
ok() { :; }
err() { :; }
rclog() { :; }
${block}
${state}
set +e
restore_previous_container
code=$?
set -e
printf 'restore-code=%s\\n' "$code"
exit "$code"
`, { mode: 0o700 });
  const result = spawnSync(runner, [], {
    env: { ...runtime.env, RC_TEST_DOCKER_LOG: dockerLog }, encoding: 'utf8',
  });
  const calls = fs.existsSync(dockerLog)
    ? fs.readFileSync(dockerLog, 'utf8').trim().split('\n').filter(Boolean) : [];
  return { runtime, result, calls };
}

describe.skipIf(process.platform === 'win32')('POSIX installer Token runtime boundary', () => {
  it.each(['native', 'docker'] as const)(
    '%s keeps the Token out of curl argv/env and deletes private host artifacts',
    (installer) => {
      const runtime = makeRuntime(installer);
      const result = spawnSync(runtime.runner, ['--auth-token', SECRET], {
        env: runtime.env,
        encoding: 'utf8',
      });
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stdout).toBe('runtime-ok\n');
      expect(`${result.stdout}${result.stderr}`).not.toContain(SECRET);
      const argv = fs.readFileSync(path.join(runtime.observations, 'curl-argv'), 'utf8');
      const curlEnv = fs.readFileSync(path.join(runtime.observations, 'curl-env'), 'utf8');
      expect(argv.split('\n').filter(Boolean)).toEqual([
        '-q', '--config', expect.stringMatching(/\/redeem\.curl$/),
      ]);
      expect(argv).not.toContain(SECRET);
      expect(curlEnv).not.toContain(SECRET);
      expect(fs.readFileSync(path.join(runtime.observations, 'modes'), 'utf8').trim())
        .toBe('700 600');
      expect(fs.readdirSync(runtime.temp)).toEqual([]);
    },
  );

  it.each(['native', 'docker'] as const)(
    '%s rejects missing, duplicate, and unknown arguments before curl or temp mutation',
    (installer) => {
      for (const args of [
        ['--auth-token'],
        ['--auth-token', 'one', '--auth-token', 'two'],
        ['--auth-token', 'not-a-bootstrap-token'],
        ['--auth-token', `rca_${'A'.repeat(42)}\nurl=https://attacker.invalid`],
        ['--unknown', 'value'],
      ]) {
        const runtime = makeRuntime(installer);
        const result = spawnSync(runtime.runner, args, { env: runtime.env, encoding: 'utf8' });
        expect(result.status).not.toBe(0);
        expect(fs.existsSync(path.join(runtime.observations, 'curl-argv'))).toBe(false);
        expect(fs.readdirSync(runtime.temp)).toEqual([]);
      }
    },
  );

  it.each(['native', 'docker'] as const)(
    '%s removes the private root when redemption fails without echoing the Token',
    (installer) => {
      const runtime = makeRuntime(installer);
      const result = spawnSync(runtime.runner, ['--auth-token', SECRET], {
        env: { ...runtime.env, RC_TEST_CURL_FAIL: '1' },
        encoding: 'utf8',
      });
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).not.toContain(SECRET);
      expect(fs.readdirSync(runtime.temp)).toEqual([]);
    },
  );

  it.each(['native', 'docker'] as const)(
    '%s rejects drifted response metadata and oversized bytes before later mutation',
    (installer) => {
      for (const mode of [
        'wrong-content-type', 'compressed', 'missing-length',
        'mismatched-length', 'oversized', 'wrong-status',
        'chunked-with-length', 'chunked-trailer-length',
      ]) {
        const runtime = makeRuntime(installer);
        const result = spawnSync(runtime.runner, ['--auth-token', SECRET], {
          env: { ...runtime.env, RC_TEST_REDEEM_MODE: mode },
          encoding: 'utf8',
        });
        expect(result.status, `${mode}\n${result.stdout}\n${result.stderr}`).not.toBe(0);
        expect(`${result.stdout}${result.stderr}`).not.toContain(SECRET);
        expect(fs.readdirSync(runtime.temp)).toEqual([]);
      }
    },
  );

  it.each(['native', 'docker'] as const)(
    '%s deletes private host artifacts when TMPDIR has a trailing slash',
    (installer) => {
      const runtime = makeRuntime(installer);
      const result = spawnSync(runtime.runner, ['--auth-token', SECRET], {
        env: { ...runtime.env, TMPDIR: `${runtime.temp}/` },
        encoding: 'utf8',
      });
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(`${result.stdout}${result.stderr}`).not.toContain(SECRET);
      expect(fs.readdirSync(runtime.temp)).toEqual([]);
    },
  );

  it.each(['native', 'docker'] as const)(
    '%s freezes the physical temp parent across a TMPDIR symlink swap',
    (installer) => {
      const runtime = makeRuntime(installer);
      const replacement = path.join(runtime.root, 'replacement-temp');
      const tempLink = path.join(runtime.root, 'tmp-link');
      fs.mkdirSync(replacement, { mode: 0o700 });
      fs.symlinkSync(runtime.temp, tempLink, 'dir');
      const file = installer === 'native'
        ? path.join(ROOT, 'scripts/install.sh') : path.join(ROOT, 'scripts/install-docker.sh');
      const block = extractProfileBlock(file);
      fs.writeFileSync(runtime.runner, `#!/usr/bin/env bash
set -euo pipefail
R='' G='' C='' Y='' B='' D='' N=''
INSTALL_DIR="$RC_TEST_ROOT/install"
GW_NODE=/does/not/exist
IMAGE=fixture.invalid/research-claw:latest
CONTAINER=research-claw
ROLLBACK_CONTAINER=research-claw-rollback
PORT=28789
die() { exit 64; }
${block.source}
${block.redeemsInline ? '' : 'rc_profile_redeem'}
private_root="$RC_PROFILE_TEMP_ROOT"
private_name="$(basename "$private_root")"
rm -- "$RC_TEST_TMP_LINK"
ln -s "$RC_TEST_SWAP_TARGET" "$RC_TEST_TMP_LINK"
mkdir -p "$RC_TEST_SWAP_TARGET/$private_name"
printf 'decoy\\n' > "$RC_TEST_SWAP_TARGET/$private_name/capsule.json"
rc_profile_cleanup_host_secret
test ! -e "$private_root"
test -f "$RC_TEST_SWAP_TARGET/$private_name/capsule.json"
trap - EXIT
`, { mode: 0o700 });
      const result = spawnSync(runtime.runner, ['--auth-token', SECRET], {
        env: {
          ...runtime.env,
          TMPDIR: tempLink,
          RC_TEST_TMP_LINK: tempLink,
          RC_TEST_SWAP_TARGET: replacement,
        },
        encoding: 'utf8',
      });
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(`${result.stdout}${result.stderr}`).not.toContain(SECRET);
      expect(fs.readdirSync(runtime.temp)).toEqual([]);
      expect(fs.readdirSync(replacement)).toHaveLength(1);
    },
  );

  it.each(['native', 'docker'] as const)(
    '%s cleanup trap removes the redeemed Capsule after a later phase fails',
    (installer) => {
      const runtime = makeRuntime(installer);
      const file = installer === 'native'
        ? path.join(ROOT, 'scripts/install.sh') : path.join(ROOT, 'scripts/install-docker.sh');
      const block = extractProfileBlock(file);
      fs.writeFileSync(runtime.runner, `#!/usr/bin/env bash
set -euo pipefail
R='' G='' C='' Y='' B='' D='' N=''
INSTALL_DIR="$RC_TEST_ROOT/install"
GW_NODE=/does/not/exist
IMAGE=fixture.invalid/research-claw:latest
CONTAINER=research-claw
ROLLBACK_CONTAINER=research-claw-rollback
PORT=28789
die() { exit 64; }
${block.source}
${block.redeemsInline ? '' : 'rc_profile_redeem'}
exit 23
`, { mode: 0o700 });
      const result = spawnSync(runtime.runner, ['--auth-token', SECRET], {
        env: runtime.env,
        encoding: 'utf8',
      });
      expect(result.status).toBe(23);
      expect(`${result.stdout}${result.stderr}`).not.toContain(SECRET);
      expect(fs.readdirSync(runtime.temp)).toEqual([]);
    },
  );

  it.each([
    ['native', 'TERM'],
    ['native', 'INT'],
    ['docker', 'TERM'],
    ['docker', 'INT'],
  ] as const)('%s removes redeemed host secrets on %s', (installer, signal) => {
    const runtime = makeRuntime(installer);
    const file = installer === 'native'
      ? path.join(ROOT, 'scripts/install.sh') : path.join(ROOT, 'scripts/install-docker.sh');
    const block = extractProfileBlock(file);
    fs.writeFileSync(runtime.runner, `#!/usr/bin/env bash
set -euo pipefail
R='' G='' C='' Y='' B='' D='' N=''
INSTALL_DIR="$RC_TEST_ROOT/install"
GW_NODE=/does/not/exist
IMAGE=fixture.invalid/research-claw:latest
CONTAINER=research-claw
ROLLBACK_CONTAINER=research-claw-rollback
PORT=28789
die() { exit 64; }
${block.source}
${block.redeemsInline ? '' : 'rc_profile_redeem'}
trap 'exit 130' INT TERM
kill -${signal} $$
exit 99
`, { mode: 0o700 });
    const result = spawnSync(runtime.runner, ['--auth-token', SECRET], {
      env: runtime.env,
      encoding: 'utf8',
    });
    expect(result.status).toBe(130);
    expect(`${result.stdout}${result.stderr}`).not.toContain(SECRET);
    expect(fs.readdirSync(runtime.temp)).toEqual([]);
  });

  it.each(['native', 'docker'] as const)(
    '%s no-token branch creates no Profile temp, curl, or transaction side effect',
    (installer) => {
      const runtime = makeRuntime(installer);
      const file = installer === 'native'
        ? path.join(ROOT, 'scripts/install.sh') : path.join(ROOT, 'scripts/install-docker.sh');
      const block = extractProfileBlock(file);
      fs.writeFileSync(runtime.runner, `#!/usr/bin/env bash
set -euo pipefail
R='' G='' C='' Y='' B='' D='' N=''
INSTALL_DIR="$RC_TEST_ROOT/install"
GW_NODE=/does/not/exist
IMAGE=fixture.invalid/research-claw:latest
CONTAINER=research-claw
ROLLBACK_CONTAINER=research-claw-rollback
PORT=28789
die() { exit 64; }
${block.source}
${block.redeemsInline ? '' : 'rc_profile_redeem'}
test -z "$RC_PROFILE_AUTH_TOKEN"
test -z "$RC_PROFILE_CAPSULE"
printf 'no-token-ok\\n'
`, { mode: 0o700 });
      const result = spawnSync(runtime.runner, [], { env: runtime.env, encoding: 'utf8' });
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stdout).toBe('no-token-ok\n');
      expect(fs.existsSync(path.join(runtime.observations, 'curl-argv'))).toBe(false);
      expect(fs.readdirSync(runtime.temp)).toEqual([]);
    },
  );

  it('Native active run-lock fails closed before any applier operation', () => {
    const runtime = makeRuntime('native');
    const nodeLog = path.join(runtime.root, 'node.log');
    const runLock = path.join(runtime.temp, 'research-claw-gateway.lock');
    fs.mkdirSync(runLock, { mode: 0o700 });
    const block = extractProfileBlock(path.join(ROOT, 'scripts/install.sh')).source;
    const runner = path.join(runtime.root, 'active-run-lock.sh');
    fs.writeFileSync(runner, `#!/usr/bin/env bash
set -euo pipefail
R='' G='' C='' Y='' B='' D='' N=''
INSTALL_DIR="$RC_TEST_ROOT/install"
GW_NODE=/does/not/exist
PORT=28789
die() { exit 73; }
${block}
printf '%s\\n' "$$" > "$RC_RUN_LOCK_DIR/pid"
rc_profile_assert_gateway_stopped
printf 'unexpected-mutation\\n' > "$RC_TEST_NODE_LOG"
`, { mode: 0o700 });
    const result = spawnSync(runner, [], {
      env: { ...runtime.env, RC_RUN_LOCK_DIR: runLock, RC_TEST_NODE_LOG: nodeLog },
      encoding: 'utf8',
    });
    expect(result.status).toBe(73);
    expect(fs.existsSync(nodeLog)).toBe(false);
  });

  it('Docker failure restores volume bytes before renaming and starting the old container', () => {
    const runtime = makeRuntime('docker');
    const dockerLog = path.join(runtime.root, 'docker.log');
    const fakeDocker = path.join(runtime.root, 'bin', 'docker');
    fs.writeFileSync(fakeDocker, `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$RC_TEST_DOCKER_LOG"
case " $* " in
  *' /app/scripts/apply-bootstrap-profile.cjs rollback '*) printf '{"state":"rolled-back"}\\n' ;;
esac
`, { mode: 0o700 });
    const block = extractProfileBlock(path.join(ROOT, 'scripts/install-docker.sh')).source;
    const runner = path.join(runtime.root, 'rollback-runner.sh');
    fs.writeFileSync(runner, `#!/usr/bin/env bash
set -euo pipefail
R='' G='' C='' Y='' B='' D='' N=''
IMAGE=fixture.invalid/research-claw:latest
CONTAINER=research-claw
ROLLBACK_CONTAINER=research-claw-rollback
PORT=28789
die() { exit 64; }
warn() { :; }
ok() { :; }
err() { :; }
rclog() { :; }
${block}
RC_PROFILE_TX_ID=tx-11111111-1111-4111-8111-111111111111
HAD_PREVIOUS=true
REPLACEMENT_ATTEMPTED=true
restore_previous_container
`, { mode: 0o700 });
    const result = spawnSync(runner, [], {
      env: { ...runtime.env, RC_TEST_DOCKER_LOG: dockerLog }, encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    const calls = fs.readFileSync(dockerLog, 'utf8').trim().split('\n');
    const remove = calls.findIndex((line) => line === 'rm -f research-claw');
    const rollback = calls.findIndex((line) => line.includes(
      '/app/scripts/apply-bootstrap-profile.cjs rollback',
    ));
    const rename = calls.findIndex((line) => line === 'rename research-claw-rollback research-claw');
    const start = calls.findIndex((line) => line === 'start research-claw');
    expect(remove).toBeGreaterThanOrEqual(0);
    expect(rollback).toBeGreaterThan(remove);
    expect(rename).toBeGreaterThan(rollback);
    expect(start).toBeGreaterThan(rename);
    expect(fs.readFileSync(path.join(runtime.observations, 'health-argv'), 'utf8'))
      .toContain('http://127.0.0.1:28789/healthz');
  });

  it('Docker pre-stage failure rolls back the transaction before restarting the canonical old container', () => {
    const { result, calls } = runDockerRestoreState(`
RC_PROFILE_TX_ID=tx-11111111-1111-4111-8111-111111111111
OLD_CONTAINER_STOPPED=true
`);
    expect(result.status, result.stderr).toBe(0);
    const rollback = calls.findIndex((line) => line.includes(
      '/app/scripts/apply-bootstrap-profile.cjs rollback',
    ));
    const start = calls.findIndex((line) => line === 'start research-claw');
    expect(rollback).toBeGreaterThanOrEqual(0);
    expect(start).toBeGreaterThan(rollback);
    expect(calls).not.toContain('rm -f research-claw');
    expect(calls).not.toContain('rename research-claw-rollback research-claw');
  });

  it('Docker fresh-install failure removes the attempted container and rolls volumes back without inventing an old container', () => {
    const { result, calls } = runDockerRestoreState(`
RC_PROFILE_TX_ID=tx-11111111-1111-4111-8111-111111111111
REPLACEMENT_ATTEMPTED=true
`);
    expect(result.status, result.stderr).toBe(0);
    const remove = calls.findIndex((line) => line === 'rm -f research-claw');
    const rollback = calls.findIndex((line) => line.includes(
      '/app/scripts/apply-bootstrap-profile.cjs rollback',
    ));
    expect(remove).toBeGreaterThanOrEqual(0);
    expect(rollback).toBeGreaterThan(remove);
    expect(calls.some((line) => line.startsWith('rename '))).toBe(false);
    expect(calls.some((line) => line.startsWith('start '))).toBe(false);
  });

  it('Docker refuses to restore the old container when volume rollback fails', () => {
    const { result, calls } = runDockerRestoreState(`
RC_PROFILE_TX_ID=tx-11111111-1111-4111-8111-111111111111
HAD_PREVIOUS=true
REPLACEMENT_ATTEMPTED=true
`, 19);
    expect(result.status).toBe(1);
    expect(calls).toContain('rm -f research-claw');
    expect(calls.some((line) => line.includes(
      '/app/scripts/apply-bootstrap-profile.cjs rollback',
    ))).toBe(true);
    expect(calls.some((line) => line.startsWith('rename '))).toBe(false);
    expect(calls.some((line) => line.startsWith('start '))).toBe(false);
  });

  it('Docker restore is a byte-no-op before replacement or Profile transaction begins', () => {
    const runtime = makeRuntime('docker');
    const dockerLog = path.join(runtime.root, 'docker.log');
    const fakeDocker = path.join(runtime.root, 'bin', 'docker');
    fs.writeFileSync(fakeDocker, `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$RC_TEST_DOCKER_LOG"
`, { mode: 0o700 });
    const block = extractProfileBlock(path.join(ROOT, 'scripts/install-docker.sh')).source;
    const runner = path.join(runtime.root, 'noop-restore-runner.sh');
    fs.writeFileSync(runner, `#!/usr/bin/env bash
set -euo pipefail
R='' G='' C='' Y='' B='' D='' N=''
IMAGE=fixture.invalid/research-claw:latest
CONTAINER=research-claw
ROLLBACK_CONTAINER=research-claw-rollback
PORT=28789
die() { exit 64; }
warn() { :; }
ok() { :; }
err() { :; }
rclog() { :; }
${block}
restore_previous_container
`, { mode: 0o700 });
    const result = spawnSync(runner, [], {
      env: { ...runtime.env, RC_TEST_DOCKER_LOG: dockerLog }, encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(fs.existsSync(dockerLog)).toBe(false);
  });

  it('Native EXIT cleanup invokes transaction rollback and preserves the original exit code', () => {
    const runtime = makeRuntime('native');
    const installDir = path.join(runtime.root, 'install');
    const fakeNode = path.join(runtime.root, 'fake-node');
    const nodeLog = path.join(runtime.root, 'node.log');
    fs.mkdirSync(path.join(installDir, 'scripts'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(installDir, 'scripts/apply-bootstrap-profile.cjs'), '', {
      mode: 0o600,
    });
    fs.writeFileSync(fakeNode, `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$RC_TEST_NODE_LOG"
`, { mode: 0o700 });
    const block = extractProfileBlock(path.join(ROOT, 'scripts/install.sh')).source;
    const runner = path.join(runtime.root, 'native-exit-runner.sh');
    fs.writeFileSync(runner, `#!/usr/bin/env bash
set -euo pipefail
R='' G='' C='' Y='' B='' D='' N=''
INSTALL_DIR="$RC_TEST_ROOT/install"
GW_NODE="$RC_TEST_ROOT/fake-node"
PORT=28789
die() { exit 64; }
${block}
RC_PROFILE_TX_ID=tx-11111111-1111-4111-8111-111111111111
trap rc_profile_exit_cleanup EXIT
exit 17
`, { mode: 0o700 });
    const result = spawnSync(runner, [], {
      env: { ...runtime.env, RC_TEST_NODE_LOG: nodeLog }, encoding: 'utf8',
    });
    expect(result.status).toBe(17);
    expect(fs.readFileSync(nodeLog, 'utf8')).toContain(
      'apply-bootstrap-profile.cjs rollback',
    );
  });

  it('Native stage publication failure discovers and rolls back the durable transaction', () => {
    const runtime = makeRuntime('native');
    const installDir = path.join(runtime.root, 'install');
    const applier = path.join(installDir, 'scripts/apply-bootstrap-profile.cjs');
    const state = path.join(runtime.root, 'native-state');
    fs.mkdirSync(path.dirname(applier), { recursive: true, mode: 0o700 });
    fs.writeFileSync(applier, `
const fs = require('node:fs');
const command = process.argv[2];
if (command === 'stage') {
  fs.writeFileSync(process.env.RC_TEST_NATIVE_STATE, 'staged');
  process.exit(31);
}
if (command === 'status') {
  const pending = fs.existsSync(process.env.RC_TEST_NATIVE_STATE);
  process.stdout.write(JSON.stringify({ pendingTransaction: pending ? {
    txId: 'tx-11111111-1111-4111-8111-111111111111', state: 'staged',
  } : null }));
  process.exit(0);
}
if (command === 'rollback') {
  fs.rmSync(process.env.RC_TEST_NATIVE_STATE, { force: true });
  fs.writeFileSync(process.env.RC_TEST_NATIVE_STATE + '.rolled-back', 'yes');
  process.stdout.write('{"state":"rolled-back"}');
  process.exit(0);
}
process.exit(90);
`, { mode: 0o600 });
    const capsule = path.join(runtime.root, 'capsule.json');
    fs.writeFileSync(capsule, '{}\n', { mode: 0o600 });
    const block = extractProfileBlock(path.join(ROOT, 'scripts/install.sh')).source;
    const runner = path.join(runtime.root, 'native-stage-failure.sh');
    fs.writeFileSync(runner, `#!/usr/bin/env bash
set -euo pipefail
R='' G='' C='' Y='' B='' D='' N=''
INSTALL_DIR="$RC_TEST_ROOT/install"
GW_NODE="$RC_TEST_NODE"
PORT=28789
die() { exit 64; }
${block}
RC_PROFILE_CAPSULE="$RC_TEST_CAPSULE"
trap rc_profile_exit_cleanup EXIT
rc_profile_stage_native
`, { mode: 0o700 });
    const result = spawnSync(runner, [], {
      env: {
        ...runtime.env,
        RC_TEST_NODE: process.execPath,
        RC_TEST_CAPSULE: capsule,
        RC_TEST_NATIVE_STATE: state,
      },
      encoding: 'utf8',
    });
    expect(result.status).not.toBe(0);
    expect(fs.existsSync(state)).toBe(false);
    expect(fs.readFileSync(`${state}.rolled-back`, 'utf8')).toBe('yes');
  });

  it('Native commit cleanup failure after the global point finishes committed cleanup', () => {
    const runtime = makeRuntime('native');
    const installDir = path.join(runtime.root, 'install');
    const applier = path.join(installDir, 'scripts/apply-bootstrap-profile.cjs');
    const state = path.join(runtime.root, 'native-commit-state');
    fs.mkdirSync(path.dirname(applier), { recursive: true, mode: 0o700 });
    fs.writeFileSync(state, 'verified');
    fs.writeFileSync(applier, `
const fs = require('node:fs');
const command = process.argv[2];
const state = process.env.RC_TEST_NATIVE_STATE;
if (command === 'commit') {
  fs.writeFileSync(state, 'committed');
  process.exit(34);
}
if (command === 'status') {
  const pending = fs.existsSync(state) ? fs.readFileSync(state, 'utf8') : null;
  process.stdout.write(JSON.stringify({
    profile: pending ? null : { id: 'fixture-profile', revision: 1 },
    pendingTransaction: pending ? {
      txId: 'tx-11111111-1111-4111-8111-111111111111', state: pending,
    } : null,
  }));
  process.exit(0);
}
if (command === 'rollback' && fs.readFileSync(state, 'utf8') === 'committed') {
  fs.rmSync(state);
  fs.writeFileSync(state + '.cleanup-done', 'yes');
  process.stdout.write('{"state":"committed"}');
  process.exit(0);
}
process.exit(90);
`, { mode: 0o600 });
    const block = extractProfileBlock(path.join(ROOT, 'scripts/install.sh')).source;
    const runner = path.join(runtime.root, 'native-commit-win.sh');
    fs.writeFileSync(runner, `#!/usr/bin/env bash
set -euo pipefail
R='' G='' C='' Y='' B='' D='' N=''
INSTALL_DIR="$RC_TEST_ROOT/install"
GW_NODE="$RC_TEST_NODE"
PORT=28789
die() { exit 64; }
${block}
RC_PROFILE_TX_ID=tx-11111111-1111-4111-8111-111111111111
rc_profile_commit_native
`, { mode: 0o700 });
    const result = spawnSync(runner, [], {
      env: { ...runtime.env, RC_TEST_NODE: process.execPath, RC_TEST_NATIVE_STATE: state },
      encoding: 'utf8',
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(fs.existsSync(state)).toBe(false);
    expect(fs.readFileSync(`${state}.cleanup-done`, 'utf8')).toBe('yes');
    expect(result.stdout).toContain('Bootstrap Profile fixture-profile revision 1');
  });
});

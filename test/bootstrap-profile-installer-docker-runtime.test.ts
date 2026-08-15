import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { afterEach, describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const INSTALLER = path.join(ROOT, 'scripts/install-docker.sh');
const SECRET = `rca_${'B'.repeat(43)}`;
const TX = 'tx-11111111-1111-4111-8111-111111111111';
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function executable(file: string, source: string): void {
  fs.writeFileSync(file, source, { mode: 0o700 });
}

function runInstaller(options: {
  phase?: string;
  existing?: boolean;
  rollback?: boolean;
  pending?: string;
  token?: boolean;
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-docker-installer-flow-'));
  roots.push(root);
  const bin = path.join(root, 'bin');
  const temp = path.join(root, 'tmp');
  const state = path.join(root, 'state');
  const dockerLog = path.join(root, 'docker.log');
  const healthLog = path.join(root, 'health.log');
  fs.mkdirSync(bin, { mode: 0o700 });
  fs.mkdirSync(temp, { mode: 0o700 });
  fs.mkdirSync(state, { mode: 0o700 });
  if (options.existing) {
    fs.writeFileSync(path.join(state, 'canonical'), 'old\n');
    fs.writeFileSync(path.join(state, 'canonical-kind'), 'old\n');
  }
  if (options.rollback) fs.writeFileSync(path.join(state, 'rollback'), 'old\n');
  if (options.pending) fs.writeFileSync(path.join(state, 'pending'), `${options.pending}\n`);

executable(path.join(bin, 'curl'), `#!/usr/bin/env bash
set -eu
if [ "\${1:-}" = -q ] && [ "\${2:-}" = --config ]; then
  printf '%s\\n' "$*" >> "$RC_TEST_CURL_LOG"
  config="$3"
  test "$(grep -Fxc 'header = "Accept: application/json"' "$config")" = 1
  headers=$(sed -n 's/^dump-header = "\\(.*\\)"$/\\1/p' "$config")
  length=17
  printf 'HTTP/1.1 200 OK\\r\\nContent-Type: application/json; charset=utf-8\\r\\nContent-Encoding: identity\\r\\nContent-Length: %s\\r\\n\\r\\n' "$length" > "$headers"
  printf '{"fixture":true}\\n'
  exit 0
fi
printf '%s\\n' "$*" >> "$RC_TEST_HEALTH_LOG"
if [ "\${RC_TEST_PHASE:-}" = health ] && [ -f "$RC_TEST_STATE/canonical-kind" ] \
    && grep -qx new "$RC_TEST_STATE/canonical-kind" \
    && [ ! -f "$RC_TEST_STATE/rollback-done" ]; then
  exit 22
fi
exit 0
`);

  executable(path.join(bin, 'docker'), `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$*" >> "$RC_TEST_DOCKER_LOG"
command_line=" $* "

if [[ "$command_line" == *' /app/scripts/apply-bootstrap-profile.cjs '* ]]; then
  operation=''
  for candidate in initialize-locks recover status stage apply verify commit rollback; do
    if [[ "$command_line" == *" /app/scripts/apply-bootstrap-profile.cjs $candidate "* ]]; then
      operation="$candidate"
      break
    fi
  done
  case "$operation" in
    initialize-locks) printf '{"state":"initialized","created":true}\\n' ;;
    recover)
      rm -f "$RC_TEST_STATE/pending"
      printf '{"recovered":[]}\\n'
      ;;
    status)
      if [ -f "$RC_TEST_STATE/pending" ]; then
        pending_state=$(cat "$RC_TEST_STATE/pending")
        printf '{"profile":null,"pendingTransaction":{"txId":"${TX}","state":"%s","profileId":"fixture-profile","revision":1,"digest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}\\n' "$pending_state"
      elif [ -f "$RC_TEST_STATE/committed" ]; then
        printf '{"profile":{"id":"fixture-profile","revision":1},"pendingTransaction":null}\\n'
      else
        printf '{"profile":null,"pendingTransaction":null}\\n'
      fi
      ;;
    stage)
      printf 'staged\\n' > "$RC_TEST_STATE/pending"
      if [ "\${RC_TEST_PHASE:-}" = stage ]; then exit 31; fi
      printf '{"txId":"${TX}","state":"staged"}\\n'
      ;;
    apply)
      printf 'applied\\n' > "$RC_TEST_STATE/pending"
      if [ "\${RC_TEST_PHASE:-}" = interrupt ]; then kill -INT "$PPID"; exit 130; fi
      if [ "\${RC_TEST_PHASE:-}" = apply ]; then exit 32; fi
      printf '{"state":"applied"}\\n'
      ;;
    verify)
      if [ "\${RC_TEST_PHASE:-}" = verify ]; then exit 33; fi
      printf '{"state":"verified"}\\n'
      ;;
    commit)
      if [ "\${RC_TEST_PHASE:-}" = commit-won ]; then
        printf 'committed\\n' > "$RC_TEST_STATE/pending"
        touch "$RC_TEST_STATE/committed"
        exit 34
      fi
      if [ "\${RC_TEST_PHASE:-}" = commit ]; then exit 34; fi
      rm -f "$RC_TEST_STATE/pending"
      touch "$RC_TEST_STATE/committed"
      printf '{"state":"committed"}\\n'
      ;;
    rollback)
      if [ "\${RC_TEST_PHASE:-}" = rollback ]; then exit 35; fi
      if [ -f "$RC_TEST_STATE/pending" ] && grep -qx committed "$RC_TEST_STATE/pending"; then
        rm -f "$RC_TEST_STATE/pending"
        touch "$RC_TEST_STATE/commit-cleanup-done"
        printf '{"state":"committed"}\\n'
        exit 0
      fi
      rm -f "$RC_TEST_STATE/pending"
      touch "$RC_TEST_STATE/rollback-done"
      printf '{"state":"rolled-back"}\\n'
      ;;
    *) exit 91 ;;
  esac
  exit 0
fi

case "\${1:-}" in
  info)
    printf 'Operating System: Docker Desktop\\n'
    ;;
  --version)
    printf 'Docker version 29.0.0, build fixture\\n'
    ;;
  pull)
    if [ "\${RC_TEST_PHASE:-}" = pull ]; then exit 41; fi
    printf 'pulled\\n'
    ;;
  ps)
    if [ -f "$RC_TEST_STATE/canonical" ]; then printf 'research-claw\\n'; fi
    if [ -f "$RC_TEST_STATE/rollback" ]; then printf 'research-claw-rollback\\n'; fi
    ;;
  stop)
    [ -f "$RC_TEST_STATE/canonical" ] || exit 42
    touch "$RC_TEST_STATE/stopped"
    ;;
  start)
    [ -f "$RC_TEST_STATE/canonical" ] || exit 43
    rm -f "$RC_TEST_STATE/stopped"
    ;;
  rename)
    if [ "$2" = research-claw ] && [ "$3" = research-claw-rollback ]; then
      rm -f "$RC_TEST_STATE/canonical" "$RC_TEST_STATE/canonical-kind" "$RC_TEST_STATE/stopped"
      touch "$RC_TEST_STATE/rollback"
    elif [ "$2" = research-claw-rollback ] && [ "$3" = research-claw ]; then
      rm -f "$RC_TEST_STATE/rollback"
      printf 'old\\n' > "$RC_TEST_STATE/canonical"
      printf 'old\\n' > "$RC_TEST_STATE/canonical-kind"
      touch "$RC_TEST_STATE/restored-old"
    else
      exit 44
    fi
    ;;
  rm)
    target="\${*: -1}"
    if [ "$target" = research-claw ]; then
      rm -f "$RC_TEST_STATE/canonical" "$RC_TEST_STATE/canonical-kind" "$RC_TEST_STATE/stopped"
    elif [ "$target" = research-claw-rollback ]; then
      rm -f "$RC_TEST_STATE/rollback"
    fi
    ;;
  inspect)
    if [ "\${RC_TEST_PHASE:-}" = crash ] && [ -f "$RC_TEST_STATE/canonical-kind" ] \
        && grep -qx new "$RC_TEST_STATE/canonical-kind"; then
      printf 'false\\n'
    elif [ -f "$RC_TEST_STATE/canonical" ] && [ ! -f "$RC_TEST_STATE/stopped" ]; then
      printf 'true\\n'
    else
      printf 'false\\n'
    fi
    ;;
  image)
    printf 'Total reclaimed space: 0B\\n'
    ;;
  logs) ;;
  run)
    if [[ "$command_line" == *' /app/scripts/version-info.cjs '* ]]; then
      printf 'Research-Claw v0.8.3 (OpenClaw 2026.6.1)\\n'
    elif [[ "$command_line" == *' /app/scripts/bootstrap-profile/model-probe.cjs '* ]]; then
      if [ "\${RC_TEST_PHASE:-}" = probe ]; then exit 45; fi
    elif [[ "$command_line" == *' -d '* ]]; then
      if [ "\${RC_TEST_PHASE:-}" = start ]; then exit 46; fi
      printf 'new\\n' > "$RC_TEST_STATE/canonical"
      printf 'new\\n' > "$RC_TEST_STATE/canonical-kind"
      rm -f "$RC_TEST_STATE/stopped"
      printf 'fixture-container-id\\n'
    fi
    ;;
esac
`);

  executable(path.join(bin, 'sleep'), '#!/usr/bin/env bash\nexit 0\n');
  executable(path.join(bin, 'open'), '#!/usr/bin/env bash\nexit 0\n');
  executable(path.join(bin, 'xdg-open'), '#!/usr/bin/env bash\nexit 0\n');

  const curlLog = path.join(root, 'curl.log');
  const args = options.token === false ? [] : ['--auth-token', SECRET];
  const result = spawnSync('bash', [INSTALLER, ...args], {
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      HOME: path.join(root, 'home'),
      TMPDIR: temp,
      RC_TEST_STATE: state,
      RC_TEST_DOCKER_LOG: dockerLog,
      RC_TEST_CURL_LOG: curlLog,
      RC_TEST_HEALTH_LOG: healthLog,
      RC_TEST_PHASE: options.phase || '',
    },
    encoding: 'utf8',
    timeout: 20_000,
  });
  const dockerCalls = fs.existsSync(dockerLog)
    ? fs.readFileSync(dockerLog, 'utf8').trim().split('\n').filter(Boolean) : [];
  const hostBootstrapArtifacts = fs.readdirSync(temp)
    .filter((name) => name.startsWith('rc-bootstrap-installer.'));
  return {
    root, state, result, dockerCalls, hostBootstrapArtifacts,
    combined: `${result.stdout}${result.stderr}`,
  };
}

function operationIndex(calls: string[], operation: string): number {
  return calls.findIndex((line) => line.includes(
    `/app/scripts/apply-bootstrap-profile.cjs ${operation}`,
  ));
}

describe.skipIf(process.platform === 'win32')('Docker installer end-to-end fake runtime', () => {
  it('completes the Profile transaction without exposing the Token to Docker metadata or output', () => {
    const run = runInstaller();
    expect(run.result.status, run.combined).toBe(0);
    expect(operationIndex(run.dockerCalls, 'stage')).toBeGreaterThanOrEqual(0);
    expect(operationIndex(run.dockerCalls, 'apply')).toBeGreaterThan(
      operationIndex(run.dockerCalls, 'stage'),
    );
    expect(operationIndex(run.dockerCalls, 'commit')).toBeGreaterThan(
      operationIndex(run.dockerCalls, 'verify'),
    );
    expect(operationIndex(run.dockerCalls, 'rollback')).toBe(-1);
    expect(run.dockerCalls.join('\n')).not.toContain(SECRET);
    expect(run.combined).not.toContain(SECRET);
    expect(run.hostBootstrapArtifacts).toEqual([]);
  });

  it('keeps the no-Token execution free of every Profile CLI operation', () => {
    const run = runInstaller({ token: false });
    expect(run.result.status, run.combined).toBe(0);
    for (const operation of [
      'initialize-locks', 'recover', 'status', 'stage', 'apply', 'verify', 'commit', 'rollback',
    ]) {
      expect(operationIndex(run.dockerCalls, operation)).toBe(-1);
    }
    expect(run.hostBootstrapArtifacts).toEqual([]);
  });

  it('no-Token rerun fails closed instead of restoring only the old container over pending Profile volumes', () => {
    const run = runInstaller({ token: false, existing: true, rollback: true, pending: 'applied' });
    expect(run.result.status).not.toBe(0);
    expect(operationIndex(run.dockerCalls, 'status')).toBeGreaterThanOrEqual(0);
    expect(operationIndex(run.dockerCalls, 'rollback')).toBe(-1);
    expect(run.dockerCalls).not.toContain('rm -f research-claw');
    expect(run.dockerCalls).not.toContain('rename research-claw-rollback research-claw');
    expect(fs.existsSync(path.join(run.state, 'canonical'))).toBe(true);
    expect(fs.existsSync(path.join(run.state, 'rollback'))).toBe(true);
    expect(fs.existsSync(path.join(run.state, 'pending'))).toBe(true);
    expect(run.hostBootstrapArtifacts).toEqual([]);
  });

  it.each(['stage', 'apply', 'start', 'crash', 'health', 'verify', 'probe', 'commit'])(
    '%s failure rolls back the fresh Profile transaction and removes host secrets',
    (phase) => {
      const run = runInstaller({ phase });
      expect(run.result.status).not.toBe(0);
      expect(operationIndex(run.dockerCalls, 'rollback')).toBeGreaterThanOrEqual(0);
      expect(fs.existsSync(path.join(run.state, 'pending'))).toBe(false);
      expect(run.dockerCalls.join('\n')).not.toContain(SECRET);
      expect(run.combined).not.toContain(SECRET);
      expect(run.hostBootstrapArtifacts).toEqual([]);
    },
  );

  it('pull failure mutates neither Profile transaction nor host secret state', () => {
    const run = runInstaller({ phase: 'pull' });
    expect(run.result.status).not.toBe(0);
    expect(operationIndex(run.dockerCalls, 'stage')).toBe(-1);
    expect(operationIndex(run.dockerCalls, 'rollback')).toBe(-1);
    expect(run.hostBootstrapArtifacts).toEqual([]);
    expect(run.combined).not.toContain(SECRET);
  });

  it('INT during apply exits resumably after rollback and host cleanup', () => {
    const run = runInstaller({ phase: 'interrupt' });
    expect(run.result.status).toBe(130);
    expect(operationIndex(run.dockerCalls, 'rollback')).toBeGreaterThan(
      operationIndex(run.dockerCalls, 'apply'),
    );
    expect(run.hostBootstrapArtifacts).toEqual([]);
    expect(run.combined).not.toContain(SECRET);
  });

  it('keeps the healthy new container when commit cleanup fails after the global commit point', () => {
    const run = runInstaller({ phase: 'commit-won', existing: true });
    expect(run.result.status, run.combined).toBe(0);
    expect(fs.existsSync(path.join(run.state, 'commit-cleanup-done'))).toBe(true);
    expect(fs.readFileSync(path.join(run.state, 'canonical-kind'), 'utf8').trim()).toBe('new');
    expect(fs.existsSync(path.join(run.state, 'rollback'))).toBe(false);
    expect(run.dockerCalls).not.toContain('rename research-claw-rollback research-claw');
    expect(run.hostBootstrapArtifacts).toEqual([]);
  });

  it('update health failure rolls volume transaction back before restoring and rechecking old container', () => {
    const run = runInstaller({ phase: 'health', existing: true });
    expect(run.result.status).not.toBe(0);
    const rollback = operationIndex(run.dockerCalls, 'rollback');
    const renameOld = run.dockerCalls.findIndex(
      (line) => line === 'rename research-claw-rollback research-claw',
    );
    const startOld = run.dockerCalls.findIndex(
      (line, index) => index > renameOld && line === 'start research-claw',
    );
    expect(rollback).toBeGreaterThanOrEqual(0);
    expect(renameOld, run.dockerCalls.join('\n')).toBeGreaterThan(rollback);
    expect(startOld, run.dockerCalls.join('\n')).toBeGreaterThan(renameOld);
    expect(fs.existsSync(path.join(run.state, 'restored-old'))).toBe(true);
    expect(fs.readFileSync(path.join(run.state, 'canonical-kind'), 'utf8').trim()).toBe('old');
    expect(run.hostBootstrapArtifacts).toEqual([]);
  });
});

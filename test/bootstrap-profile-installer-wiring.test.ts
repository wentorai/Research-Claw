import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const native = fs.readFileSync(path.join(ROOT, 'scripts/install.sh'), 'utf8');
const dockerPosix = fs.readFileSync(path.join(ROOT, 'scripts/install-docker.sh'), 'utf8');
const dockerWindows = fs.readFileSync(path.join(ROOT, 'scripts/install-docker.ps1'), 'utf8');
const entrypoint = fs.readFileSync(path.join(ROOT, 'scripts/docker-entrypoint.sh'), 'utf8');
const entrypointAdmission = fs.readFileSync(
  path.join(ROOT, 'scripts/bootstrap-profile/entrypoint-admission.cjs'), 'utf8',
);

const REDEEM = 'https://wentor.ai/api/v1/rc/bootstrap/redeem';

function expectOrdered(source: string, fragments: string[]): void {
  let cursor = -1;
  for (const fragment of fragments) {
    const next = source.indexOf(fragment, cursor + 1);
    expect(next, `missing or out-of-order fragment: ${fragment}`).toBeGreaterThan(cursor);
    cursor = next;
  }
}

describe('Bootstrap Profile installer ABI and secret boundary', () => {
  it.each([
    ['Native Bash', native],
    ['Docker Bash', dockerPosix],
  ])('%s strictly parses --auth-token without an environment fallback', (_label, source) => {
    expect(source).toContain('--auth-token');
    expect(source).toContain('rc_profile_parse_args "$@"');
    expect(source).toContain('^rca_[A-Za-z0-9_-]{43,}$');
    expect(source).not.toMatch(/AUTH_TOKEN="\$\{AUTH_TOKEN:-/);
    expect(source).not.toMatch(/RC_AUTH_TOKEN="\$\{RC_AUTH_TOKEN:-/);
  });

  it('PowerShell exposes the approved top-level scriptblock ABI', () => {
    const paramIndex = dockerWindows.indexOf('param([string]$AuthToken)');
    const bodyIndex = dockerWindows.indexOf('& {');
    expect(paramIndex).toBeGreaterThan(0);
    expect(paramIndex).toBeLessThan(bodyIndex);
    expect(dockerWindows).toContain("$RcBootstrapRedeemUrl = '" + REDEEM + "'");
    expect(dockerWindows).toContain("'^rca_[A-Za-z0-9_-]{43,}$'");
  });

  it('PowerShell clears both copies of the bound Token immediately after redeem', () => {
    expect(dockerWindows).not.toContain('$script:AuthToken = $null');
    expect(
      dockerWindows.match(/Set-Variable -Name AuthToken -Scope 1 -Value \$null/g),
    ).toHaveLength(2);
    expect(
      dockerWindows.match(/parentBoundParameters\.Remove\('AuthToken'\)/g),
    ).toHaveLength(2);
    expectOrdered(dockerWindows, [
      'try {\n    Redeem-RcBootstrapProfile',
      'Set-Variable -Name AuthToken -Scope 1 -Value $null',
      "parentBoundParameters.Remove('AuthToken')",
      'Write-Step 3 "Pull image"',
    ]);
  });

  it('all installers fail closed on an oversized or metadata-drifted Capsule response', () => {
    for (const source of [native, dockerPosix]) {
      expect(source).toContain('dump-header = "$RC_PROFILE_HEADERS"');
      expect(source).toContain('header = "Accept: application/json"');
      expect(source).toContain('header = "Accept-Encoding: identity"');
      expect(source).toContain('max-filesize = 2097152');
      expect(source).toContain('transfer-encoding');
      expect(source).toContain('head -c 2097153 > "$RC_PROFILE_CAPSULE"');
      expect(source).not.toContain('output = "$RC_PROFILE_CAPSULE"');
      expect(source).toContain('rc_profile_validate_redeem_response');
      expect(source).toContain('application/json; charset=utf-8');
      expect(source).toContain('content-encoding');
      expect(source).toContain('content-length');
      expect(source).toContain('2097152');
    }

    expect(dockerWindows).toContain('$RcBootstrapMaxCapsuleBytes = 2 * 1024 * 1024');
    expect(dockerWindows).toContain("TryAddWithoutValidation('Accept-Encoding', 'identity')");
    expect(dockerWindows).toContain('LoadIntoBufferAsync($RcBootstrapMaxCapsuleBytes)');
    expect(dockerWindows).toContain("MediaType -ine 'application/json'");
    expect(dockerWindows).toContain("CharSet -ine 'utf-8'");
    expect(dockerWindows).toContain("contentEncoding[0] -ine 'identity'");
    expect(dockerWindows).toContain('$bytes.Length -ne $declaredLength');
    expect(dockerWindows).toContain(
      "throw 'Could not remove the Bootstrap Profile private files.'",
    );
  });

  it.each([
    ['Native Bash', native],
    ['Docker Bash', dockerPosix],
  ])('%s redeems through a private curl config before installation mutation', (_label, source) => {
    expect(source).toContain(`RC_BOOTSTRAP_REDEEM_URL="${REDEEM}"`);
    expect(source).toContain('umask 077');
    expect(source).toContain('chmod 700 "$RC_PROFILE_TEMP_ROOT"');
    expect(source).toContain(
      'chmod 600 "$RC_PROFILE_CURL_CONFIG" "$RC_PROFILE_HEADERS" "$RC_PROFILE_CAPSULE"',
    );
    expect(source).toContain('curl -q --config "$RC_PROFILE_CURL_CONFIG"');
    expect(source).toContain('max-redirs = 0');
    expect(source).toContain('proto = "=https"');
    expect(source).toContain('unset RC_PROFILE_AUTH_TOKEN');
    expect(source).toContain('rm -f "$RC_PROFILE_CURL_CONFIG"');
    expect(source).toContain('Could not remove Bootstrap Profile private files.');
  });

  it('never passes the Token or Capsule through Docker metadata', () => {
    for (const source of [dockerPosix, dockerWindows]) {
      expect(source).not.toMatch(/docker\s+run[^\n]*(AUTH_TOKEN|AuthToken)/i);
      expect(source).not.toMatch(/--label[^\n]*(AUTH_TOKEN|AuthToken)/i);
      expect(source).not.toMatch(/--build-arg[^\n]*(AUTH_TOKEN|AuthToken)/i);
    }
    expect(dockerPosix).toContain('< "$RC_PROFILE_CAPSULE"');
    expect(dockerWindows).toContain('RedirectStandardInput');
    expect(dockerPosix).toContain('RC_BOOTSTRAP_TX_ID=$RC_PROFILE_TX_ID');
    expect(dockerWindows).toContain('RC_BOOTSTRAP_TX_ID=$($script:RcProfileTxId)');
  });
});

describe('Bootstrap Profile installer transaction ordering', () => {
  it('Native update falls back to the other official mirror without changing origin', () => {
    expect(native).toContain('_ORIGIN_URL="$(git remote get-url origin 2>/dev/null || true)"');
    expect(native).toContain('_FALLBACK_REPO="$GITHUB_REPO"');
    expect(native).toContain('*github.com*wentorai*Research-Claw.git*)');
    expect(native).toContain('_FALLBACK_REPO="$GITEE_REPO"');
    expect(native).toContain('git remote set-url "$_FALLBACK_REMOTE" "$_FALLBACK_REPO"');
    expect(native).toContain('git fetch --depth 1 "$_FALLBACK_REMOTE" "$_BRANCH"');
    expect(native).toContain('git reset --hard "$_FALLBACK_REMOTE/$_BRANCH"');
    expect(native).not.toContain('git remote set-url origin "$GITHUB_REPO"');
    expect(native).not.toContain('git remote set-url origin "$GITEE_REPO"');
  });

  it('runs every credential probe in an isolated scratch state with read-only Docker volumes', () => {
    expect(native).toContain('scripts/bootstrap-profile/model-probe.cjs');
    expect(native).toContain('--scratch-root "$RC_PROFILE_TEMP_ROOT"');
    for (const source of [dockerPosix, dockerWindows]) {
      expect(source).toContain('/app/scripts/bootstrap-profile/model-probe.cjs');
      expect(source).toContain('--scratch-root /tmp');
      expect(source).toContain('rc-config:/app/config:ro');
      expect(source).toContain('rc-state:/root/.openclaw:ro');
    }
  });

  it('Native recovers under stop proof after the candidate exists, then stages and applies', () => {
    expectOrdered(native, [
      'rc_profile_parse_args "$@"',
      "trap 'exit 130' INT TERM",
      'rc_profile_redeem',
      'git clone',
      'rc_profile_assert_gateway_stopped',
      'rc_profile_prepare_native_data_root',
      'rc_profile_recover_native',
      'rc_profile_stage_native',
      'rc_profile_apply_native',
      'scripts/ensure-config.cjs',
      'config validate --json',
      'rc_profile_verify_native',
      'rc_profile_probe_native',
      'rc_profile_commit_native',
    ]);
    expect(native).toContain('rc_profile_rollback_native');
  });

  it('Docker Bash rolls volumes back before restoring the previous container', () => {
    expectOrdered(dockerPosix, [
      'rc_profile_parse_args "$@"',
      'rc_profile_redeem',
      '_pull_with_retry "$IMAGE"',
      'docker stop "$CONTAINER"',
      'rc_profile_recover_docker',
      'rc_profile_stage_docker',
      'rc_profile_apply_docker',
      'docker run -d',
      'rc_profile_verify_docker',
      'rc_profile_probe_docker',
      'rc_profile_commit_docker',
      'docker rm "$ROLLBACK_CONTAINER"',
    ]);
    const rollbackBody = dockerPosix.slice(
      dockerPosix.indexOf('restore_previous_container()'),
      dockerPosix.indexOf('# ── Diagnostic breadcrumb log'),
    );
    expect(rollbackBody.indexOf('rc_profile_rollback_docker'))
      .toBeLessThan(rollbackBody.indexOf('docker rename "$ROLLBACK_CONTAINER" "$CONTAINER"'));
    const main = dockerPosix.slice(dockerPosix.indexOf('ok "Image pulled"'));
    const stage = main.indexOf('rc_profile_stage_docker');
    const rename = main.indexOf('docker rename "$CONTAINER" "$ROLLBACK_CONTAINER"', stage);
    const apply = main.indexOf('rc_profile_apply_docker', rename);
    expect(stage).toBeGreaterThan(0);
    expect(rename).toBeGreaterThan(stage);
    expect(apply).toBeGreaterThan(rename);
    expect(main).toContain('RC_PROFILE_PENDING_STATE');
    expect(main).toContain('ROLLBACK_EXISTS');
    expect(main).toContain('[ "$RC_PROFILE_PENDING_STATE" = committed ]');
  });

  it('PowerShell uses the same volume-first rollback and commit-before-delete order', () => {
    expectOrdered(dockerWindows, [
      'Redeem-RcBootstrapProfile',
      'docker pull',
      'docker stop $Container',
      'Recover-RcBootstrapProfile',
      'Stage-RcBootstrapProfile',
      'Apply-RcBootstrapProfile',
      'docker run -d',
      'Verify-RcBootstrapProfile',
      'Probe-RcBootstrapProfile',
      'Commit-RcBootstrapProfile',
      'docker rm $RollbackContainer',
    ]);
    const rollbackBody = dockerWindows.slice(
      dockerWindows.indexOf('function Restore-PreviousContainer'),
      dockerWindows.indexOf('# -- 1. Check Docker'),
    );
    expect(rollbackBody.indexOf('Rollback-RcBootstrapProfile'))
      .toBeLessThan(rollbackBody.indexOf('docker rename $RollbackContainer $Container'));
    const main = dockerWindows.slice(dockerWindows.indexOf('Write-Host "  + Image pulled"'));
    const stage = main.indexOf('Stage-RcBootstrapProfile');
    const rename = main.indexOf('docker rename $Container $RollbackContainer', stage);
    const apply = main.indexOf('Apply-RcBootstrapProfile', rename);
    expect(stage).toBeGreaterThan(0);
    expect(rename).toBeGreaterThan(stage);
    expect(apply).toBeGreaterThan(rename);
    expect(main).toContain('$script:RcProfilePendingState');
    expect(main).toContain('$rollbackExists');
    expect(main).toContain("$script:RcProfilePendingState -eq 'committed'");
  });

  it('PowerShell turns every terminal operational failure into a terminating error', () => {
    for (const message of [
      'Docker is unavailable.',
      'The container image could not be pulled.',
      'The Research-Claw port is already in use.',
      'The replacement container could not be started.',
      'The replacement container exited before becoming ready.',
      'The replacement gateway did not become ready.',
      'Could not remove the stale rollback container.',
      'Could not remove the verified rollback container.',
    ]) {
      expect(dockerWindows).toContain(`throw '${message}'`);
    }
  });

  it('does not send an applied Profile user back to Setup Wizard for an API Key', () => {
    expect(dockerWindows).toContain('if ($RcProfileRequested) {');
    expect(dockerWindows).toContain(
      'Bootstrap Profile ready - no Setup Wizard API Key entry is required.',
    );
    const setupTip = dockerWindows.indexOf(
      'TIP:  First time? Open the Dashboard -> Setup Wizard -> enter your API Key.',
    );
    const noTokenBranch = dockerWindows.lastIndexOf('} else {', setupTip);
    expect(setupTip).toBeGreaterThan(noTokenBranch);
  });

  it('Docker entrypoint fails closed on a pending Profile transaction without fetching', () => {
    expect(entrypoint).toContain('apply-bootstrap-profile.cjs status');
    expect(entrypoint).toContain('bootstrap-profile/entrypoint-admission.cjs');
    expect(entrypointAdmission).toContain('pendingTransaction');
    expect(entrypointAdmission).toContain('admitted === pending.txId');
    expect(entrypoint).toContain('re-run the installer');
    expect(entrypoint).not.toContain(REDEEM);
  });
});

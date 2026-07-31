import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const INSTALLER_PATH = path.join(ROOT, 'scripts', 'install.sh');

function writeExecutable(filePath: string, content: string): void {
  writeFileSync(filePath, content);
  chmodSync(filePath, 0o755);
}

function extractPnpmFunctions(installer: string): string {
  const start = installer.indexOf('activate_private_pnpm() {');
  const end = installer.indexOf('# --- Disable Corepack strict mode ---');
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return installer.slice(start, end);
}

describe('native installer pnpm version selection', () => {
  it('rejects a working pnpm 9 and selects an isolated pnpm 10.34.4', () => {
    const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'rc-pnpm-selection-'));
    const fakeBin = path.join(tempRoot, 'bin');
    const privatePrefix = path.join(tempRoot, 'private-pnpm');
    const npmCalls = path.join(tempRoot, 'npm-calls.log');

    try {
      mkdirSync(fakeBin, { recursive: true });
      writeExecutable(
        path.join(fakeBin, 'pnpm'),
        `#!/bin/sh
if [ "\${1:-}" = "--version" ]; then
  printf '9.15.9\\n'
  exit 0
fi
exit 0
`,
      );
      writeExecutable(
        path.join(fakeBin, 'npm'),
        `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "$NPM_CALLS"
prefix=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --prefix)
      prefix="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done
[ -n "$prefix" ]
mkdir -p "$prefix/bin"
cat > "$prefix/bin/pnpm" <<'PNPM'
#!/bin/sh
if [ "\${1:-}" = "--version" ]; then
  printf '10.34.4\\n'
  exit 0
fi
exit 0
PNPM
chmod +x "$prefix/bin/pnpm"
`,
      );

      const installer = readFileSync(INSTALLER_PATH, 'utf8');
      const functions = extractPnpmFunctions(installer);
      const harness = `set -euo pipefail
PNPM_VERSION=10.34.4
RC_PNPM_PREFIX="\${RC_PNPM_PREFIX:?}"
PNPM_BIN=""
info() { :; }
ok() { :; }
warn() { :; }
die() { printf 'DIE=%s\\n' "$1" >&2; exit 1; }
${functions}
ensure_pnpm
printf 'SELECTED=%s\\n' "$PNPM_BIN"
printf 'VERSION=%s\\n' "$("$PNPM_BIN" --version)"
`;
      const result = spawnSync('/bin/bash', ['-c', harness], {
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: tempRoot,
          NPM_CALLS: npmCalls,
          PATH: `${fakeBin}:/usr/bin:/bin:/usr/sbin:/sbin`,
          RC_PNPM_PREFIX: privatePrefix,
        },
      });
      const calls = existsSync(npmCalls) ? readFileSync(npmCalls, 'utf8') : '';

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(
        `SELECTED=${path.join(privatePrefix, 'bin', 'pnpm')}`,
      );
      expect(result.stdout).toContain('VERSION=10.34.4');
      expect(calls).toContain(
        `install --prefix ${privatePrefix} -g pnpm@10.34.4`,
      );
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('verifies the isolated pnpm itself instead of the old checkout version', () => {
    const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'rc-pnpm-first-hop-'));
    const fakeBin = path.join(tempRoot, 'bin');
    const privatePrefix = path.join(tempRoot, 'private-pnpm');

    try {
      mkdirSync(fakeBin, { recursive: true });
      writeExecutable(
        path.join(fakeBin, 'pnpm'),
        `#!/bin/sh
if [ "\${1:-}" = "--version" ]; then
  printf '9.15.0\\n'
  exit 0
fi
exit 0
`,
      );
      writeExecutable(
        path.join(fakeBin, 'npm'),
        `#!/bin/sh
set -eu
prefix=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --prefix)
      prefix="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done
[ -n "$prefix" ]
mkdir -p "$prefix/bin"
cat > "$prefix/bin/pnpm" <<'PNPM'
#!/bin/sh
if [ "\${1:-}" = "--version" ]; then
  if [ "\${npm_config_manage_package_manager_versions:-}" = "false" ]; then
    printf '10.34.4\\n'
  else
    printf '9.15.0\\n'
  fi
  exit 0
fi
exit 0
PNPM
chmod +x "$prefix/bin/pnpm"
`,
      );

      const installer = readFileSync(INSTALLER_PATH, 'utf8');
      const functions = extractPnpmFunctions(installer);
      const harness = `set -euo pipefail
PNPM_VERSION=10.34.4
RC_PNPM_PREFIX="\${RC_PNPM_PREFIX:?}"
PNPM_BIN=""
info() { :; }
ok() { :; }
warn() { :; }
die() { printf 'DIE=%s\\n' "$1" >&2; exit 1; }
${functions}
ensure_pnpm
printf 'SELECTED=%s\\n' "$PNPM_BIN"
printf 'VERSION=%s\\n' "$(pnpm_version "$PNPM_BIN")"
`;
      const result = spawnSync('/bin/bash', ['-c', harness], {
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: tempRoot,
          PATH: `${fakeBin}:/usr/bin:/bin:/usr/sbin:/sbin`,
          RC_PNPM_PREFIX: privatePrefix,
        },
      });

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(
        `SELECTED=${path.join(privatePrefix, 'bin', 'pnpm')}`,
      );
      expect(result.stdout).toContain('VERSION=10.34.4');
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('puts an existing isolated pnpm ahead of an older PATH entry', () => {
    const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'rc-pnpm-path-order-'));
    const oldBin = path.join(tempRoot, 'old-bin');
    const privatePrefix = path.join(tempRoot, 'private-pnpm');
    const privateBin = path.join(privatePrefix, 'bin');

    try {
      mkdirSync(oldBin, { recursive: true });
      mkdirSync(privateBin, { recursive: true });
      writeExecutable(
        path.join(oldBin, 'pnpm'),
        '#!/bin/sh\nprintf "9.15.0\\n"\n',
      );
      writeExecutable(
        path.join(privateBin, 'pnpm'),
        '#!/bin/sh\nprintf "10.34.4\\n"\n',
      );

      const installer = readFileSync(INSTALLER_PATH, 'utf8');
      const functions = extractPnpmFunctions(installer);
      const harness = `set -euo pipefail
PNPM_VERSION=10.34.4
RC_PNPM_PREFIX="\${RC_PNPM_PREFIX:?}"
PNPM_BIN=""
info() { :; }
ok() { :; }
warn() { :; }
die() { printf 'DIE=%s\\n' "$1" >&2; exit 1; }
${functions}
ensure_pnpm
printf 'COMMAND=%s\\n' "$(command -v pnpm)"
printf 'SELECTED=%s\\n' "$PNPM_BIN"
`;
      const result = spawnSync('/bin/bash', ['-c', harness], {
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: tempRoot,
          PATH: `${oldBin}:${privateBin}:/usr/bin:/bin:/usr/sbin:/sbin`,
          RC_PNPM_PREFIX: privatePrefix,
        },
      });

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(`COMMAND=${path.join(privateBin, 'pnpm')}`);
      expect(result.stdout).toContain(`SELECTED=${path.join(privateBin, 'pnpm')}`);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('skips pnpm migration when an update failed and the old install is runnable', () => {
    const installer = readFileSync(INSTALLER_PATH, 'utf8');
    expect(installer).toMatch(
      /# --- \[5\/8 cont\.\] pnpm ---\s+if ! \$UPDATE_FAILED; then\s+ensure_pnpm\s+fi/,
    );
  });
});

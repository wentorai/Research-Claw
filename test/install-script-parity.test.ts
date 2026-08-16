import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const scripts = {
  native: path.join(ROOT, 'scripts', 'install.sh'),
  dockerPosix: path.join(ROOT, 'scripts', 'install-docker.sh'),
  dockerWindows: path.join(ROOT, 'scripts', 'install-docker.ps1'),
  nativeWindows: path.join(ROOT, 'scripts', 'install-windows.ps1'),
  dockerEntrypoint: path.join(ROOT, 'scripts', 'docker-entrypoint.sh'),
  updatePosix: path.join(ROOT, 'scripts', 'update-research-claw.sh'),
  updateWindows: path.join(ROOT, 'scripts', 'update-research-claw.ps1'),
  ensureConfig: path.join(ROOT, 'scripts', 'ensure-config.cjs'),
};

function read(file: string): string {
  return fs.readFileSync(file, 'utf8');
}

describe('release installation surfaces', () => {
  it('keeps canonical installers in the Research-Claw repository', () => {
    expect(fs.existsSync(scripts.native)).toBe(true);
    expect(fs.existsSync(scripts.dockerPosix)).toBe(true);
    expect(fs.existsSync(scripts.dockerWindows)).toBe(true);
    expect(fs.existsSync(scripts.nativeWindows)).toBe(true);
  });

  it('provides a native Windows bootstrap without WSL or Docker', () => {
    const native = read(scripts.native);
    const windows = read(scripts.nativeWindows);
    const runtime = read(path.join(ROOT, 'scripts', 'node-runtime.cjs'));

    expect(native).toMatch(/MINGW\*\|MSYS\*\|CYGWIN\*\).*RC_OS=windows/);
    expect(native).toContain('--auth-token-file');
    expect(native).toContain('cmd.exe /c start "" "$DASHBOARD_URL"');
    expect(windows).toContain("$NodeVersion = '22.22.2'");
    expect(windows).toContain("$NodeSha256 = '7c93e9d92bf68c07182b471aa187e35ee6cd08ef0f24ab060dfff605fcc1c57c'");
    expect(windows).toContain("$GitVersion = '2.55.0'");
    expect(windows).toContain("$GitRelease = '2.55.0.4'");
    expect(windows).toContain("$GitSha256 = '016e84230a3767f0c6b3788e79ba0c58a17377086801719d46700fca4f7b36b5'");
    expect(windows).toContain("$SevenZipSha256 = '56b8cc9f4971cef253644fafe54063ed7fdca551d4dee0f8c6baa81b855acd72'");
    const installSha = crypto.createHash('sha256').update(native).digest('hex');
    expect(windows).toContain(`$InstallShSha256 = '${installSha}'`);
    expect(windows).toContain('https://npmmirror.com/mirrors/node/');
    expect(windows).toContain('https://registry.npmmirror.com/-/binary/git-for-windows/');
    expect(windows).toContain('https://github.com/git-for-windows/git/releases/download/');
    expect(windows).toContain('function Resolve-BundledAsset');
    expect(windows).toContain("$extractArguments = @('x', '-y', \"-o$extract\", $archive)");
    expect(windows).toContain('& $sevenZip @extractArguments | Out-Host');
    expect(windows).toContain("& $stageLauncher '--no-needs-console' '--hide' '--no-cd' '--command=post-install.bat' | Out-Host");
    expect(windows).toContain("$env:RC_WINDOWS_NATIVE = '1'");
    expect(windows).toContain("$arguments += @('--auth-token-file', $tokenPosix)");
    expect(windows).not.toMatch(/\bwsl\.exe\b|\bwinget(?:\.exe)?\b|docker\.exe/i);
    expect(runtime).toContain("if (process.platform !== 'win32') return value;");
    expect(runtime).toContain('drive[1].toLowerCase()');
    expect(runtime).toContain("process.platform === 'win32' && executable === 'pnpm'");
    expect(runtime).toContain("path.join(__dirname, 'run-pnpm.cjs')");
  });

  it('the native installer explicitly covers macOS, Linux and WSL2', () => {
    const native = read(scripts.native);
    expect(native).toMatch(/Darwin\).*RC_OS=mac/);
    expect(native).toMatch(/Linux\).*RC_OS=linux/);
    expect(native).toContain('WSL');
    expect(native).toContain('scripts/ensure-config.cjs');
  });

  it('does not make a Gitee install depend on the GitHub-only ppt-master submodule URL', () => {
    const native = read(scripts.native);

    expect(native).toContain(
      'PPT_MASTER_GITHUB="https://github.com/hugohe3/ppt-master.git"',
    );
    expect(native).toContain(
      'PPT_MASTER_ATOMGIT="https://atomgit.com/hugohe3/ppt-master.git"',
    );
    expect(native).toContain(
      'git -C "$INSTALL_DIR" config submodule.ppt-master.url "$primary_url"',
    );
    expect(native).toContain(
      'git -C "$INSTALL_DIR" config submodule.ppt-master.url "$fallback_url"',
    );
    expect(native).toContain(
      'git -C "$INSTALL_DIR" -c http.version=HTTP/1.1 submodule update',
    );
  });

  it('installs the ffmpeg runtime required by camera and RTSP features', () => {
    const native = read(scripts.native);
    const dockerfile = read(path.join(ROOT, 'Dockerfile'));

    expect(native).toContain('ensure_ffmpeg');
    expect(native).toContain('pkg_install ffmpeg');
    expect(native).toContain('brew install ffmpeg');
    expect(dockerfile).toMatch(/apt-get[^\n]*\binstall\b[\s\S]*\bffmpeg\b/);
  });

  it('native and Docker startup both pass through the shared idempotent config migration', () => {
    expect(read(scripts.native)).toContain('node scripts/ensure-config.cjs');
    expect(read(scripts.dockerEntrypoint)).toContain('node /app/scripts/ensure-config.cjs');
    expect(read(scripts.ensureConfig)).toContain('Supervisor lifecycle cleanup');
  });

  it('records and verifies the managed-native profile before an install can start', () => {
    const native = read(scripts.native);
    const markIndex = native.indexOf('log-profile.cjs mark-native');
    const skipStartIndex = native.indexOf('if [ "${SKIP_START:-0}" = "1" ]');
    const launchIndex = native.indexOf('exec bash "$INSTALL_DIR/scripts/run.sh"');

    expect(markIndex).toBeGreaterThan(0);
    expect(markIndex).toBeLessThan(skipStartIndex);
    expect(markIndex).toBeLessThan(launchIndex);
    expect(native).toContain('die "Could not record the native-install log profile.');
  });

  it('provides a public URL parity gate for the curl installer', () => {
    const verifier = read(path.join(ROOT, 'scripts', 'verify-installer-copies.mjs'));

    expect(verifier).toContain("optionalFlag('--public-url')");
    expect(verifier).toContain("optionalFlag('--web-root')");
    expect(verifier).toContain('DRIFT public native installer');
    expect(verifier).toContain("createHash('sha256')");
  });

  it('verifies all three public and built copies in an independent Web worktree', () => {
    const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-installer-copy-parity-'));
    const verifier = path.join(ROOT, 'scripts', 'verify-installer-copies.mjs');
    const copyMap = [
      [scripts.native, 'install.sh'],
      [scripts.dockerPosix, 'docker-install.sh'],
      [scripts.dockerWindows, 'docker-install.ps1'],
    ] as const;
    try {
      for (const directory of ['public', 'dist']) {
        fs.mkdirSync(path.join(staging, directory), { recursive: true });
        for (const [source, name] of copyMap) {
          fs.copyFileSync(source, path.join(staging, directory, name));
        }
      }

      const clean = spawnSync(process.execPath, [verifier, '--web-root', staging], {
        cwd: ROOT,
        encoding: 'utf8',
      });
      expect(clean.status, `${clean.stdout}\n${clean.stderr}`).toBe(0);
      expect(clean.stdout.match(/^MATCH /gm)).toHaveLength(6);

      fs.appendFileSync(path.join(staging, 'public', 'docker-install.ps1'), '# T10 drift\n');
      const drifted = spawnSync(process.execPath, [verifier, '--web-root', staging], {
        cwd: ROOT,
        encoding: 'utf8',
      });
      expect(drifted.status).toBe(1);
      expect(drifted.stderr).toContain('DRIFT Windows Docker installer');
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  });

  it('POSIX and PowerShell source updates complete the shared config migration before reporting success', () => {
    const posix = read(scripts.updatePosix);
    const windows = read(scripts.updateWindows);

    expect(posix).toContain('ensure-config.cjs');
    expect(windows).toContain('ensure-config.cjs');
    expect(posix.indexOf('ensure-config.cjs')).toBeLessThan(posix.indexOf('version-info.cjs'));
    expect(windows.indexOf('ensure-config.cjs')).toBeLessThan(windows.indexOf('version-info.cjs'));
  });

  it('the POSIX Docker installer is valid Bash', () => {
    execFileSync('bash', ['-n', scripts.dockerPosix]);
  });

  it.each([
    ['POSIX Docker', scripts.dockerPosix],
    ['Windows Docker', scripts.dockerWindows],
  ])('%s installer preserves the same data and health contract', (_label, file) => {
    const content = read(file);
    for (const volume of ['rc-config', 'rc-data', 'rc-workspace', 'rc-state']) {
      expect(content).toContain(volume);
    }
    expect(content).toContain('127.0.0.1');
    expect(content).toContain('28789');
    expect(content).toContain('/healthz');
    expect(content).toContain('ghcr.io/wentorai/research-claw');
    expect(content).toContain('cn-hangzhou.personal.cr.aliyuncs.com/wentorai/research-claw');
  });

  it('the two Docker installers expose matching operational stages', () => {
    const posix = read(scripts.dockerPosix);
    const windows = read(scripts.dockerWindows);
    const obligations = [
      /docker info/i,
      /docker pull/i,
      /docker rm/i,
      /docker run/i,
      /unless-stopped/i,
      /MIRROR/i,
    ];

    for (const obligation of obligations) {
      expect(posix).toMatch(obligation);
      expect(windows).toMatch(obligation);
    }
  });

  it('Docker updates keep the old service alive until the replacement image is available', () => {
    const posix = read(scripts.dockerPosix);
    const windows = read(scripts.dockerWindows);

    expect(posix.indexOf('if docker ps -a')).toBeGreaterThan(posix.indexOf('ok "Image pulled"'));
    expect(windows.indexOf('$existing =')).toBeGreaterThan(
      windows.indexOf('Write-Host "  + Image pulled"'),
    );
  });

  it('Docker updates retain the previous container until the replacement passes health checks', () => {
    const posix = read(scripts.dockerPosix);
    const windows = read(scripts.dockerWindows);

    expect(posix).toContain('ROLLBACK_CONTAINER="${CONTAINER}-rollback"');
    expect(windows).toContain('$RollbackContainer = "${Container}-rollback"');
    expect(posix).toContain('docker rename "$CONTAINER" "$ROLLBACK_CONTAINER"');
    expect(windows).toContain('docker rename $Container $RollbackContainer');
    expect(posix).toContain('restore_previous_container');
    expect(windows).toContain('Restore-PreviousContainer');
    expect(posix).toContain('trap on_interrupt INT TERM');
    expect(posix).toContain("curl -sf --noproxy '*'");
    expect(windows).toContain('$currentHealthy');
    expect(posix.lastIndexOf('docker rm "$ROLLBACK_CONTAINER"')).toBeGreaterThan(
      posix.indexOf('if [ "$READY" = false ]'),
    );
    expect(windows.lastIndexOf('docker rm $RollbackContainer')).toBeGreaterThan(
      windows.indexOf('if (-not $ready)'),
    );
  });

  it('Docker installers never terminate an unrelated process merely because it owns the port', () => {
    expect(read(scripts.dockerPosix)).not.toMatch(/xargs\s+kill/);
    expect(read(scripts.dockerWindows)).not.toMatch(/Stop-Process\s+-Id/);
  });

  it('the two Docker installers display the version read from the pulled image', () => {
    for (const file of [scripts.dockerPosix, scripts.dockerWindows]) {
      const content = read(file);
      expect(content).toContain('/app/scripts/version-info.cjs');
      expect(content).toMatch(/--entrypoint\s+node/i);
    }
  });

  it('the two Docker installers pin the same operational constants', () => {
    const posix = read(scripts.dockerPosix);
    const windows = read(scripts.dockerWindows);

    expect(posix).toContain('CONTAINER="research-claw"');
    expect(windows).toContain('$Container      = "research-claw"');
    expect(posix).toContain('PORT=28789');
    expect(windows).toContain('$Port           = 28789');
    expect(posix).toContain('HEALTH_TIMEOUT=60');
    expect(windows).toContain('$HealthTimeout  = 60');
    expect(posix).toContain('IMAGE="${IMAGE_REPO}:latest"');
    expect(windows).toContain('$Image          = "${ImageRepo}:latest"');
  });
});

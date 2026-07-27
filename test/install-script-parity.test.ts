import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const scripts = {
  native: path.join(ROOT, 'scripts', 'install.sh'),
  dockerPosix: path.join(ROOT, 'scripts', 'install-docker.sh'),
  dockerWindows: path.join(ROOT, 'scripts', 'install-docker.ps1'),
  dockerEntrypoint: path.join(ROOT, 'scripts', 'docker-entrypoint.sh'),
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
  });

  it('the native installer explicitly covers macOS, Linux and WSL2', () => {
    const native = read(scripts.native);
    expect(native).toMatch(/Darwin\).*RC_OS=mac/);
    expect(native).toMatch(/Linux\).*RC_OS=linux/);
    expect(native).toContain('WSL');
    expect(native).toContain('scripts/ensure-config.cjs');
  });

  it('native and Docker startup both pass through the shared idempotent config migration', () => {
    expect(read(scripts.native)).toContain('node scripts/ensure-config.cjs');
    expect(read(scripts.dockerEntrypoint)).toContain('node /app/scripts/ensure-config.cjs');
    expect(read(scripts.ensureConfig)).toContain('Supervisor lifecycle cleanup');
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

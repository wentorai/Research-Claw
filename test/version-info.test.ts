import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const VERSION_INFO = path.join(ROOT, 'scripts', 'version-info.cjs');

describe('user-visible Research-Claw version', () => {
  it('has one executable helper backed by the installed package metadata', () => {
    const raw = execFileSync(process.execPath, [VERSION_INFO, '--root', ROOT, '--json'], {
      encoding: 'utf8',
    });
    const info = JSON.parse(raw) as {
      researchClaw: string;
      openClaw: string;
      commit: string;
    };
    const rootPackage = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const openClawPackage = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'node_modules', 'openclaw', 'package.json'), 'utf8'),
    );

    expect(info.researchClaw).toBe(rootPackage.version);
    expect(info.openClaw).toBe(openClawPackage.version);
    expect(info.commit).toMatch(/^[0-9a-f]{7,40}$|^unknown$/);
  });

  it('prints a concise human-readable line suitable for native and Docker startup', () => {
    const line = execFileSync(process.execPath, [VERSION_INFO, '--root', ROOT], {
      encoding: 'utf8',
    }).trim();

    expect(line).toMatch(/^Research-Claw v\d+\.\d+\.\d+ · OpenClaw \S+ · commit [0-9a-f]{7,40}$/);
  });

  it('all supported launch/update surfaces consume the shared helper', () => {
    for (const relative of [
      'scripts/install.sh',
      'scripts/run.sh',
      'scripts/docker-entrypoint.sh',
      'scripts/update-research-claw.sh',
      'scripts/update-research-claw.ps1',
    ]) {
      expect(fs.readFileSync(path.join(ROOT, relative), 'utf8')).toContain('version-info.cjs');
    }
  });

  it('Docker config migration and Dashboard compatibility share package.json as the version source', () => {
    const entrypoint = fs.readFileSync(
      path.join(ROOT, 'scripts', 'docker-entrypoint.sh'),
      'utf8',
    );

    expect(entrypoint).not.toMatch(/^IMAGE_VERSION="\d+\.\d+\.\d+"$/m);
    expect(entrypoint).toMatch(/IMAGE_VERSION=.*package\.json/);
    expect(entrypoint).toContain('RESEARCH_CLAW_UI_VERSION="$IMAGE_VERSION"');
  });

  it('keeps the release version aligned across user-visible core plugins', () => {
    const expected = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'),
    ).version;
    const files = [
      'extensions/research-claw-core/package.json',
      'extensions/research-claw-core/openclaw.plugin.json',
      'extensions/wentor-connect/package.json',
      'extensions/wentor-connect/openclaw.plugin.json',
    ];

    for (const relative of files) {
      const metadata = JSON.parse(fs.readFileSync(path.join(ROOT, relative), 'utf8'));
      expect(metadata.version, relative).toBe(expected);
    }
    for (const relative of [
      'extensions/research-claw-core/index.ts',
      'extensions/wentor-connect/index.ts',
    ]) {
      expect(fs.readFileSync(path.join(ROOT, relative), 'utf8')).toContain(
        `version: '${expected}'`,
      );
    }
  });

  it('makes the frozen source commit observable inside release images', () => {
    const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
    expect(dockerfile).toContain('FROM node:22-slim');
    expect(dockerfile).not.toContain('FROM --platform=');
    expect(dockerfile).toContain('ARG RC_BUILD_COMMIT=unknown');
    expect(dockerfile).toContain('ENV RC_BUILD_COMMIT=${RC_BUILD_COMMIT}');
    expect(dockerfile).toContain('org.opencontainers.image.revision=${RC_BUILD_COMMIT}');
    expect(dockerfile.indexOf('ARG RC_BUILD_COMMIT=unknown')).toBeGreaterThan(
      dockerfile.indexOf('RUN pnpm build'),
    );
  });
});

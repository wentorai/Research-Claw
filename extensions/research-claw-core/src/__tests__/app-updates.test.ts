import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { compareSemver, parseSemver, stripVersionPrefix, checkUpdates } from '../app-updates.js';
import * as path from 'node:path';
import * as fs from 'node:fs';

describe('app-updates semver', () => {
  it('stripVersionPrefix', () => {
    expect(stripVersionPrefix('v1.2.3')).toBe('1.2.3');
    expect(stripVersionPrefix('V0.6.1')).toBe('0.6.1');
    expect(stripVersionPrefix('0.6.1')).toBe('0.6.1');
    expect(stripVersionPrefix('  v1.0.0  ')).toBe('1.0.0');
  });

  it('parseSemver', () => {
    expect(parseSemver('0.6.1')).toEqual([0, 6, 1]);
    expect(parseSemver('v10.20.30-beta')).toEqual([10, 20, 30]);
    expect(parseSemver('not-a-version')).toBeNull();
    expect(parseSemver('')).toBeNull();
  });

  it('compareSemver', () => {
    expect(compareSemver('0.6.0', '0.6.1')).toBeLessThan(0);
    expect(compareSemver('0.6.1', '0.6.1')).toBe(0);
    expect(compareSemver('0.7.0', '0.6.9')).toBeGreaterThan(0);
    // Major version difference
    expect(compareSemver('1.0.0', '0.99.99')).toBeGreaterThan(0);
    // Non-semver strings fall back to localeCompare
    expect(compareSemver('abc', 'def')).toBeLessThan(0);
  });
});

describe('app-updates scripts', () => {
  // Navigate from extensions/research-claw-core/src/__tests__/ to project root
  const repoRoot = path.resolve(__dirname, '../../../..');

  it('bash update script exists', () => {
    const bashScript = path.join(repoRoot, 'scripts', 'update-research-claw.sh');
    expect(fs.existsSync(bashScript)).toBe(true);
  });

  it('PowerShell update script exists', () => {
    const psScript = path.join(repoRoot, 'scripts', 'update-research-claw.ps1');
    expect(fs.existsSync(psScript)).toBe(true);
  });

  it('PowerShell script contains expected commands', () => {
    const psScript = path.join(repoRoot, 'scripts', 'update-research-claw.ps1');
    const content = fs.readFileSync(psScript, 'utf8');

    expect(content).toContain('git pull --ff-only');
    expect(content).toContain('pnpm install');
    expect(content).toContain('pnpm build');
    expect(content).toContain('ErrorActionPreference');
  });

  it('bash script contains expected commands', () => {
    const bashScript = path.join(repoRoot, 'scripts', 'update-research-claw.sh');
    const content = fs.readFileSync(bashScript, 'utf8');

    expect(content).toContain('git pull --ff-only');
    expect(content).toContain('pnpm install');
    expect(content).toContain('pnpm build');
    expect(content).toContain('set -euo pipefail');
  });
});

describe('checkUpdates', () => {
  const repoRoot = path.resolve(__dirname, '../../../..');
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    // Reset fetch mock before each test
    globalThis.fetch = originalFetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('reads local version from package.json', async () => {
    // checkUpdates reads local version; even if remote fails, `current` should match package.json
    const pkgPath = path.join(repoRoot, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version: string };

    // Mock fetch to fail so we exercise the error path
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network unreachable'));

    const result = await checkUpdates(repoRoot);
    expect(result.current).toBe(pkg.version);
    expect(result.upToDate).toBe(true); // error path returns upToDate: true
    expect(result.error).toBeDefined();
    expect(result.repoRoot).toBe(repoRoot);
  });

  it('returns error message when GitHub API fails', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('DNS resolution failed'));

    const result = await checkUpdates(repoRoot);
    expect(result.error).toBe('DNS resolution failed');
    expect(result.latest).toBeNull();
    expect(result.latestTag).toBeNull();
    expect(result.releaseUrl).toContain('github.com');
  });

  it('detects newer remote version', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        tag_name: 'v99.99.99',
        html_url: 'https://github.com/wentorai/Research-Claw/releases/tag/v99.99.99',
        published_at: '2026-04-17T00:00:00Z',
      }),
    });

    const result = await checkUpdates(repoRoot);
    expect(result.upToDate).toBe(false);
    expect(result.latest).toBe('99.99.99');
    expect(result.latestTag).toBe('v99.99.99');
  });

  it('detects current version is up-to-date', async () => {
    const pkgPath = path.join(repoRoot, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version: string };

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        tag_name: `v${pkg.version}`,
        html_url: `https://github.com/wentorai/Research-Claw/releases/tag/v${pkg.version}`,
        published_at: '2026-04-17T00:00:00Z',
      }),
    });

    const result = await checkUpdates(repoRoot);
    expect(result.upToDate).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('generates correct shell update hints', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('offline'));
    const result = await checkUpdates(repoRoot);
    // On macOS/Linux (CI), hint should use single quotes + &&
    if (process.platform !== 'win32') {
      expect(result.shellUpdateHint).toContain("&&");
      expect(result.shellUpdateHint).toContain("git pull --ff-only");
    }
  });

  it('falls back to tags API when releases endpoint returns 404', async () => {
    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      callCount++;
      if (url.includes('/releases/latest')) {
        return { ok: false, status: 404 };
      }
      // Tags endpoint
      return {
        ok: true,
        json: async () => [
          { name: 'v1.0.0' },
          { name: 'not-semver' },
        ],
      };
    });

    const result = await checkUpdates(repoRoot);
    expect(callCount).toBe(2); // releases + tags
    expect(result.latest).toBe('1.0.0');
  });
});

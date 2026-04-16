import { describe, expect, it } from 'vitest';
import { compareSemver, parseSemver, stripVersionPrefix } from '../app-updates.js';
import * as path from 'node:path';
import * as fs from 'node:fs';

describe('app-updates semver', () => {
  it('stripVersionPrefix', () => {
    expect(stripVersionPrefix('v1.2.3')).toBe('1.2.3');
    expect(stripVersionPrefix('V0.6.1')).toBe('0.6.1');
  });

  it('parseSemver', () => {
    expect(parseSemver('0.6.1')).toEqual([0, 6, 1]);
    expect(parseSemver('v10.20.30-beta')).toEqual([10, 20, 30]);
    expect(parseSemver('not-a-version')).toBeNull();
  });

  it('compareSemver', () => {
    expect(compareSemver('0.6.0', '0.6.1')).toBeLessThan(0);
    expect(compareSemver('0.6.1', '0.6.1')).toBe(0);
    expect(compareSemver('0.7.0', '0.6.9')).toBeGreaterThan(0);
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

    // Verify the PowerShell script contains the necessary commands
    expect(content).toContain('git pull --ff-only');
    expect(content).toContain('pnpm install');
    expect(content).toContain('pnpm build');
    expect(content).toContain('ErrorActionPreference');
  });

  it('bash script contains expected commands', () => {
    const bashScript = path.join(repoRoot, 'scripts', 'update-research-claw.sh');
    const content = fs.readFileSync(bashScript, 'utf8');

    // Verify the bash script contains the necessary commands
    expect(content).toContain('git pull --ff-only');
    expect(content).toContain('pnpm install');
    expect(content).toContain('pnpm build');
    expect(content).toContain('set -euo pipefail');
  });
});

import fs from 'node:fs';
import path from 'node:path';

import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');

function readJson(relativePath: string): Record<string, any> {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), 'utf8'));
}

function discoverOpenClawExtensionImporters(): string[] {
  const extensionsRoot = path.join(ROOT, 'extensions');

  return fs
    .readdirSync(extensionsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `extensions/${entry.name}`)
    .filter((importer) => {
      const manifestPath = path.join(ROOT, importer, 'package.json');
      if (!fs.existsSync(manifestPath)) return false;
      const manifest = readJson(`${importer}/package.json`);
      return typeof manifest.peerDependencies?.openclaw === 'string';
    })
    .sort();
}

describe('OpenClaw release lock', () => {
  it('uses the root-pinned OpenClaw version for every extension development environment', () => {
    const rootPackage = readJson('package.json');
    const expected = rootPackage.dependencies.openclaw;
    const openClawImporters = discoverOpenClawExtensionImporters();

    expect(expected).toBe('2026.6.1');
    expect(openClawImporters.length).toBeGreaterThan(0);
    for (const importer of openClawImporters) {
      const extensionPackage = readJson(`${importer}/package.json`);
      expect(extensionPackage.devDependencies?.openclaw).toBe(expected);
    }
  });

  it('contains no independently auto-installed OpenClaw version in the lockfile', () => {
    const lockfile = parse(
      fs.readFileSync(path.join(ROOT, 'pnpm-lock.yaml'), 'utf8'),
    ) as {
      importers: Record<
        string,
        { devDependencies?: Record<string, { specifier?: string }> }
      >;
      packages: Record<string, unknown>;
      snapshots: Record<string, unknown>;
    };
    const openClawImporters = discoverOpenClawExtensionImporters();

    const openClawPackages = Object.keys(lockfile.packages)
      .filter((key) => key.startsWith('openclaw@'));
    const openClawSnapshots = Object.keys(lockfile.snapshots)
      .filter((key) => key.startsWith('openclaw@'));

    expect(openClawPackages).toEqual(['openclaw@2026.6.1']);
    expect(openClawSnapshots.length).toBeGreaterThan(0);
    for (const snapshot of openClawSnapshots) {
      expect(snapshot).toMatch(/^openclaw@2026\.6\.1\(patch_hash=/);
    }
    for (const importer of openClawImporters) {
      expect(
        lockfile.importers[importer]?.devDependencies?.openclaw?.specifier,
      ).toBe('2026.6.1');
    }
  });
});

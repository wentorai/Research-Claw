import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');

function workspacePackageDirs(): string[] {
  const dirs = ['dashboard'];
  for (const name of readdirSync(path.join(root, 'extensions'))) {
    const relative = path.posix.join('extensions', name);
    const absolute = path.join(root, relative);
    if (
      statSync(absolute).isDirectory()
      && (() => {
        try {
          return statSync(path.join(absolute, 'package.json')).isFile();
        } catch {
          return false;
        }
      })()
    ) {
      dirs.push(relative);
    }
  }
  return dirs.sort();
}

describe('Docker dependency layer tracks every pnpm workspace package', () => {
  it('copies every workspace package.json before pnpm install', () => {
    const dockerfile = readFileSync(path.join(root, 'Dockerfile'), 'utf8');
    const installOffset = dockerfile.indexOf('RUN pnpm install --node-linker=hoisted');
    expect(installOffset).toBeGreaterThan(0);
    const dependencyLayer = dockerfile.slice(0, installOffset);

    for (const dir of workspacePackageDirs()) {
      expect(
        dependencyLayer,
        `${dir}/package.json must be copied before pnpm install`,
      ).toContain(`COPY ${dir}/package.json`);
    }
  });
});

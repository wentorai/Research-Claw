import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCacheBustPlugin } from '../../vite.config';

const tempDirs: string[] = [];

function tempOutputFile(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'rc-cache-bust-'));
  tempDirs.push(dir);
  return path.join(dir, 'theme-init.js');
}

function callHook(hook: unknown, ...args: unknown[]): unknown {
  const candidate = typeof hook === 'function'
    ? hook
    : (hook as { handler?: unknown } | undefined)?.handler;
  if (typeof candidate !== 'function') {
    throw new TypeError('expected a callable plugin hook');
  }
  return Reflect.apply(candidate, {}, args);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('Vite cache-bust plugin', () => {
  it('does not mask the original Rollup error when no output was written', () => {
    const file = tempOutputFile();
    const plugin = createCacheBustPlugin(file);

    callHook(plugin.buildEnd, new Error('primary build failure'));

    expect(() => callHook(plugin.closeBundle)).not.toThrow();
  });

  it('still fails a nominally successful build when theme-init.js is missing', () => {
    const file = tempOutputFile();
    const plugin = createCacheBustPlugin(file);

    callHook(plugin.buildEnd);

    expect(() => callHook(plugin.closeBundle)).toThrow(/theme-init\.js/);
  });

  it('replaces the cache token after a successful build', () => {
    const file = tempOutputFile();
    writeFileSync(file, 'const BUILD = "__RC_BUILD_HASH__";');
    const plugin = createCacheBustPlugin(file);

    callHook(plugin.buildEnd);
    callHook(plugin.closeBundle);

    const output = readFileSync(file, 'utf8');
    expect(output).not.toContain('__RC_BUILD_HASH__');
    expect(output).toMatch(/const BUILD = "[a-f0-9]{12}";/);
  });
});

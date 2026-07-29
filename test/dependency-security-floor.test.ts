import fs from 'node:fs';
import path from 'node:path';

import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const REVIEWED_PACKAGE_MANAGER = 'pnpm@10.34.4';
const REQUIRED_BUILD_SCRIPTS = [
  '@google/genai',
  '@parcel/watcher',
  'better-sqlite3',
  'esbuild',
  'openclaw',
  'protobufjs',
  'tree-sitter-bash',
] as const;
const SECURITY_OVERRIDES = {
  '@hono/node-server@<1.19.13': '1.19.13',
  'body-parser@>=2.0.0 <2.3.0': '2.3.0',
  'brace-expansion@>=2.0.0 <5.0.8': '5.0.8',
  'fast-uri@>=3.0.0 <3.1.4': '3.1.4',
  'hono@>=4.0.0 <4.12.27': '4.12.27',
  'ip-address@>=10.0.0 <=10.1.0': '10.1.1',
  'path-to-regexp@>=8.0.0 <8.4.0': '8.4.0',
  'protobufjs@>=7.0.0 <=7.6.2': '7.6.5',
  'qs@>=6.11.1 <=6.15.1': '6.15.2',
  'tar@>=7.0.0 <7.5.21': '7.5.21',
  'undici@>=8.0.0 <8.5.0': '8.5.0',
  'yaml@>=1.0.0 <1.10.3': '1.10.3',
} as const;

const RESOLVED_SECURITY_VERSIONS = {
  '@hono/node-server': ['1.19.13'],
  'body-parser': ['2.3.0'],
  'brace-expansion': ['5.0.8'],
  'fast-uri': ['3.1.4'],
  hono: ['4.12.27'],
  'ip-address': ['10.1.1'],
  'path-to-regexp': ['8.4.0'],
  protobufjs: ['7.6.5'],
  qs: ['6.15.2'],
  tar: ['7.5.21'],
  undici: ['8.5.0'],
  yaml: ['1.10.3', '2.9.0'],
} as const;

describe('production dependency security floors', () => {
  it('pins the reviewed package manager and required dependency build scripts', () => {
    const rootPackage = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'),
    ) as {
      packageManager?: string;
      pnpm?: { onlyBuiltDependencies?: string[] };
    };

    expect(rootPackage.packageManager).toBe(REVIEWED_PACKAGE_MANAGER);
    expect(rootPackage.pnpm?.onlyBuiltDependencies?.sort()).toEqual(
      [...REQUIRED_BUILD_SCRIPTS].sort(),
    );
  });

  it('uses the reviewed package manager in native and Docker install entrypoints', () => {
    const reviewedVersion = REVIEWED_PACKAGE_MANAGER.slice('pnpm@'.length);
    const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
    const nativeInstaller = fs.readFileSync(
      path.join(ROOT, 'scripts', 'install.sh'),
      'utf8',
    );

    const dockerPins = [...dockerfile.matchAll(/\bnpm install -g pnpm@([^\s]+)/g)]
      .map((match) => match[1]);
    const nativePins = [
      ...nativeInstaller.matchAll(/^PNPM_VERSION=([^\s#]+)$/gm),
    ].map((match) => match[1]);

    expect(dockerPins).toEqual([reviewedVersion]);
    expect(nativePins).toEqual([reviewedVersion]);
  });

  it('keeps the reviewed transitive-dependency overrides in the root manifest', () => {
    const rootPackage = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'),
    ) as {
      pnpm?: { overrides?: Record<string, string> };
    };

    for (const [selector, version] of Object.entries(SECURITY_OVERRIDES)) {
      expect(rootPackage.pnpm?.overrides?.[selector]).toBe(version);
    }
  });

  it('resolves only the reviewed non-critical/non-high versions', () => {
    const lockfile = parse(
      fs.readFileSync(path.join(ROOT, 'pnpm-lock.yaml'), 'utf8'),
    ) as {
      packages: Record<string, unknown>;
    };
    const packageKeys = Object.keys(lockfile.packages);

    for (const [packageName, versions] of Object.entries(
      RESOLVED_SECURITY_VERSIONS,
    )) {
      const resolved = packageKeys
        .filter((key) => key.startsWith(`${packageName}@`))
        .map((key) => key.slice(packageName.length + 1))
        .sort();
      expect(resolved).toEqual(versions);
    }
  });
});

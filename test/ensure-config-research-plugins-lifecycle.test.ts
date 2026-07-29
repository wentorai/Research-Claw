import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const ENSURE_CONFIG = path.join(ROOT, 'scripts', 'ensure-config.cjs');
const EXAMPLE_CONFIG = path.join(ROOT, 'config', 'openclaw.example.json');
const OPENCLAW = path.join(ROOT, 'node_modules', '.bin', 'openclaw');
const requireFromTest = createRequire(import.meta.url);
const {
  writeResearchPluginsIntegrityRecord,
}: {
  writeResearchPluginsIntegrityRecord: (pluginDir: string) => void;
} = requireFromTest(
  path.join(ROOT, 'scripts', 'research-plugins-install-utils.cjs'),
);

function researchPluginPaths(configPath: string): string[] {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  return (config.plugins?.load?.paths ?? []).filter((entry: unknown) =>
    typeof entry === 'string'
      && /(?:^|[/\\])\.openclaw[/\\]extensions[/\\]research-plugins[/\\]?$/.test(entry),
  );
}

function writeUsableResearchPluginsFixture(pluginDir: string): void {
  fs.mkdirSync(path.join(pluginDir, 'dist'), { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, 'package.json'),
    JSON.stringify({
      name: '@wentorai/research-plugins',
      version: '0.0.0-test',
    }),
  );
  fs.writeFileSync(
    path.join(pluginDir, 'openclaw.plugin.json'),
    JSON.stringify({
      id: 'research-plugins',
      version: '0.0.0-test',
      name: 'Research Plugins test fixture',
      main: 'dist/index.js',
      configSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {},
      },
    }),
  );
  fs.writeFileSync(
    path.join(pluginDir, 'catalog.json'),
    JSON.stringify({
      version: 1,
      items: [{
        id: 'fixture-skill',
        type: 'skill',
        name: 'fixture-skill',
        description: 'Fixture',
        category: 'test',
        subcategory: 'test',
        keywords: ['fixture'],
        path: 'skills/test/fixture-skill',
      }],
    }),
  );
  fs.writeFileSync(
    path.join(pluginDir, 'dist', 'index.js'),
    'export default function register() {}\n',
  );
  const skillDir = path.join(
    pluginDir,
    'skills',
    'test',
    'fixture-skill',
  );
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    '---\nname: fixture-skill\ndescription: Fixture\n---\n',
  );
  writeResearchPluginsIntegrityRecord(pluginDir);
}

describe('ensure-config research-plugins lifecycle', () => {
  let tmpDir: string;
  let homeDir: string;
  let configPath: string;
  let pluginDir: string;
  let isolatedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-rp-lifecycle-'));
    homeDir = path.join(tmpDir, 'home');
    const configDir = path.join(tmpDir, 'project', 'config');
    pluginDir = path.join(
      homeDir,
      '.openclaw',
      'extensions',
      'research-plugins',
    );
    configPath = path.join(configDir, 'openclaw.json');
    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(homeDir, { recursive: true });
    fs.copyFileSync(EXAMPLE_CONFIG, configPath);

    isolatedEnv = {
      ...process.env,
      HOME: homeDir,
      XDG_CACHE_HOME: path.join(tmpDir, 'xdg-cache'),
      XDG_CONFIG_HOME: path.join(tmpDir, 'xdg-config'),
      XDG_DATA_HOME: path.join(tmpDir, 'xdg-data'),
      XDG_STATE_HOME: path.join(tmpDir, 'xdg-state'),
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_STATE_DIR: path.join(tmpDir, 'openclaw-state'),
      NODE_ENV: 'production',
    };
    delete isolatedEnv.VITEST;
    delete isolatedEnv.VITEST_POOL_ID;
    delete isolatedEnv.VITEST_WORKER_ID;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function runEnsure(): void {
    execFileSync('node', [ENSURE_CONFIG, configPath], {
      cwd: ROOT,
      env: isolatedEnv,
    });
  }

  it('keeps a clean installation valid when research-plugins is absent', () => {
    expect(fs.existsSync(pluginDir)).toBe(false);

    runEnsure();
    const afterFirst = fs.readFileSync(configPath, 'utf8');
    runEnsure();

    expect(researchPluginPaths(configPath)).toEqual([]);
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.plugins.allow).not.toContain('research-plugins');
    expect(config.plugins.installs?.['research-plugins']).toBeUndefined();
    const raw = execFileSync(OPENCLAW, ['config', 'validate', '--json'], {
      cwd: ROOT,
      env: isolatedEnv,
      encoding: 'utf8',
    });
    expect(JSON.parse(raw)).toMatchObject({ valid: true });
    expect(fs.readFileSync(configPath, 'utf8')).toBe(afterFirst);
  });

  it('removes stale research-plugins homes without touching unrelated plugin paths', () => {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const unrelated = '/opt/operator-plugins/custom-lab-tool';
    config.plugins.load.paths.push(
      '/Users/previous-user/.openclaw/extensions/research-plugins',
      unrelated,
    );
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

    runEnsure();
    const afterFirst = fs.readFileSync(configPath, 'utf8');
    runEnsure();

    expect(researchPluginPaths(configPath)).toEqual([]);
    const after = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(after.plugins.load.paths).toContain(unrelated);
    expect(fs.readFileSync(configPath, 'utf8')).toBe(afterFirst);
  });

  it('does not treat a partial installation directory as an installed plugin', () => {
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, 'package.json'),
      JSON.stringify({
        name: '@wentorai/research-plugins',
        version: '0.0.0-partial',
      }),
    );

    runEnsure();

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(researchPluginPaths(configPath)).toEqual([]);
    expect(config.plugins.allow).not.toContain('research-plugins');
    expect(config.plugins.installs?.['research-plugins']).toBeUndefined();
  });

  it('does not enable a package whose declared production dependency is missing', () => {
    writeUsableResearchPluginsFixture(pluginDir);
    const packagePath = path.join(pluginDir, 'package.json');
    const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    packageJson.dependencies = { '@sinclair/typebox': '0.34.48' };
    fs.writeFileSync(packagePath, JSON.stringify(packageJson));

    runEnsure();

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(researchPluginPaths(configPath)).toEqual([]);
    expect(config.plugins.allow).not.toContain('research-plugins');
    expect(config.plugins.installs?.['research-plugins']).toBeUndefined();
  });

  it('does not enable a dependency shell whose runtime entry is missing', () => {
    writeUsableResearchPluginsFixture(pluginDir);
    const packagePath = path.join(pluginDir, 'package.json');
    const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    packageJson.dependencies = { '@wentorai/broken-runtime': '1.0.0' };
    fs.writeFileSync(packagePath, JSON.stringify(packageJson));
    const dependencyDir = path.join(
      pluginDir,
      'node_modules',
      '@wentorai',
      'broken-runtime',
    );
    fs.mkdirSync(dependencyDir, { recursive: true });
    fs.writeFileSync(
      path.join(dependencyDir, 'package.json'),
      JSON.stringify({
        name: '@wentorai/broken-runtime',
        version: '1.0.0',
        main: 'missing.js',
      }),
    );

    runEnsure();

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(researchPluginPaths(configPath)).toEqual([]);
    expect(config.plugins.allow).not.toContain('research-plugins');
    expect(config.plugins.installs?.['research-plugins']).toBeUndefined();
  });

  it('does not enable catalog entries that would crash runtime skill search', () => {
    writeUsableResearchPluginsFixture(pluginDir);
    const catalogPath = path.join(pluginDir, 'catalog.json');
    const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
    delete catalog.items[0].description;
    fs.writeFileSync(catalogPath, JSON.stringify(catalog));

    runEnsure();

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(researchPluginPaths(configPath)).toEqual([]);
    expect(config.plugins.allow).not.toContain('research-plugins');
    expect(config.plugins.installs?.['research-plugins']).toBeUndefined();
  });

  it('adds an installed research-plugins path exactly once and remains idempotent', () => {
    writeUsableResearchPluginsFixture(pluginDir);
    const before = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    before.plugins.installs ??= {};
    before.plugins.installs['research-plugins'] = {
      source: 'npm',
      spec: '@wentorai/research-plugins',
      installPath: '/tmp/old-openclaw-managed-project',
    };
    fs.writeFileSync(configPath, JSON.stringify(before, null, 2));

    runEnsure();
    const afterFirst = fs.readFileSync(configPath, 'utf8');
    runEnsure();

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(researchPluginPaths(configPath)).toEqual([pluginDir]);
    expect(config.plugins.allow).toContain('research-plugins');
    expect(config.plugins.installs?.['research-plugins']).toMatchObject({
      source: 'npm',
      spec: '@wentorai/research-plugins',
      installPath: '~/.openclaw/extensions/research-plugins',
    });
    const raw = execFileSync(OPENCLAW, ['config', 'validate', '--json'], {
      cwd: ROOT,
      env: isolatedEnv,
      encoding: 'utf8',
    });
    expect(JSON.parse(raw)).toMatchObject({ valid: true });
    expect(fs.readFileSync(configPath, 'utf8')).toBe(afterFirst);
  });
});

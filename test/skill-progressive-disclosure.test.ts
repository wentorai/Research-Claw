import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

const ROOT = path.resolve(__dirname, '..');
const ENSURE_CONFIG = path.join(ROOT, 'scripts', 'ensure-config.cjs');
const EXAMPLE_CONFIG = path.join(ROOT, 'config', 'openclaw.example.json');
const requireFromTest = createRequire(import.meta.url);
const {
  writeResearchPluginsIntegrityRecord,
}: {
  writeResearchPluginsIntegrityRecord: (pluginDir: string) => void;
} = requireFromTest(
  path.join(ROOT, 'scripts', 'research-plugins-install-utils.cjs'),
);

const ROUTER_DIRS = [
  'research-analysis-router',
  'research-domains-router',
  'research-literature-router',
  'research-methods-router',
  'research-tools-router',
  'research-writing-router',
] as const;

const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

function readFrontmatter(filePath: string): Record<string, unknown> {
  const source = fs.readFileSync(filePath, 'utf8');
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source);
  if (!match) throw new Error(`missing frontmatter: ${filePath}`);
  return parseYaml(match[1]) as Record<string, unknown>;
}

function writeResearchPluginsFixture(pluginDir: string): void {
  const routerDir = path.join(pluginDir, 'skills', 'test');
  const leafDir = path.join(routerDir, 'fixture-leaf');
  fs.mkdirSync(path.join(pluginDir, 'dist'), { recursive: true });
  fs.mkdirSync(leafDir, { recursive: true });
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
      main: 'dist/index.js',
    }),
  );
  fs.writeFileSync(path.join(pluginDir, 'dist', 'index.js'), 'export default {};\n');
  fs.writeFileSync(
    path.join(routerDir, 'SKILL.md'),
    [
      '---',
      'name: fixture-router-skills',
      'description: Fixture router',
      '---',
      '',
      '# Fixture',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(leafDir, 'SKILL.md'),
    [
      '---',
      'name: fixture-leaf',
      'description: Fixture leaf',
      '---',
      '',
      '# Fixture leaf',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(pluginDir, 'catalog.json'),
    JSON.stringify({
      version: 1,
      items: [{
        id: 'fixture-leaf',
        type: 'skill',
        name: 'fixture-leaf',
        description: 'Fixture leaf',
        category: 'test',
        subcategory: 'test',
        keywords: ['fixture'],
        path: 'skills/test/fixture-leaf',
      }],
    }),
  );
  writeResearchPluginsIntegrityRecord(pluginDir);
}

function createFixtureConfig(): {
  configPath: string;
  pluginDir: string;
  env: NodeJS.ProcessEnv;
} {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-skill-disclosure-'));
  tempDirs.push(tempDir);
  const homeDir = path.join(tempDir, 'home');
  const projectDir = path.join(tempDir, 'project');
  const configDir = path.join(projectDir, 'config');
  const configPath = path.join(configDir, 'openclaw.json');
  const pluginDir = path.join(
    homeDir,
    '.openclaw',
    'extensions',
    'research-plugins',
  );
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(homeDir, { recursive: true });
  fs.copyFileSync(EXAMPLE_CONFIG, configPath);
  writeResearchPluginsFixture(pluginDir);
  return {
    configPath,
    pluginDir,
    env: {
      ...process.env,
      HOME: homeDir,
      XDG_CACHE_HOME: path.join(tempDir, 'xdg-cache'),
      XDG_CONFIG_HOME: path.join(tempDir, 'xdg-config'),
      XDG_DATA_HOME: path.join(tempDir, 'xdg-data'),
      XDG_STATE_HOME: path.join(tempDir, 'xdg-state'),
    },
  };
}

describe('progressive Skill disclosure defaults', () => {
  it('ships exactly six short research routers that require search then one load', () => {
    for (const routerDir of ROUTER_DIRS) {
      const filePath = path.join(ROOT, 'skills', routerDir, 'SKILL.md');
      expect(fs.existsSync(filePath), routerDir).toBe(true);
      const metadata = readFrontmatter(filePath);
      expect(String(metadata.description ?? '').length).toBeLessThanOrEqual(180);
      const body = fs.readFileSync(filePath, 'utf8');
      expect(body).toContain('skill_search');
      expect(body).toContain('skill_load');
      expect(body).not.toMatch(/\.\.\/.*\/SKILL\.md/);
    }
  });

  it('keeps native workspace discovery singular and configures bounded rich metadata', () => {
    const config = JSON.parse(fs.readFileSync(EXAMPLE_CONFIG, 'utf8'));
    expect(config.skills.load.extraDirs).toEqual(['./skills']);
    expect(config.skills.limits).toMatchObject({
      maxSkillsInPrompt: 100,
      maxSkillsPromptChars: 26000,
    });
    expect(config.skills.install).toEqual({
      allowUploadedArchives: true,
    });
    expect(config.tools.toolSearch).toBe(false);
  });

  it('migrates defaults once, disables RP leaf routers, and stays idempotent', () => {
    const fixture = createFixtureConfig();
    const before = JSON.parse(fs.readFileSync(fixture.configPath, 'utf8'));
    before.skills.load.extraDirs = ['./skills', './workspace/skills'];
    delete before.skills.limits;
    delete before.skills.install;
    delete before.skills.entries;
    delete before.tools.toolSearch;
    fs.writeFileSync(fixture.configPath, JSON.stringify(before, null, 2));

    execFileSync('node', [ENSURE_CONFIG, fixture.configPath], {
      cwd: ROOT,
      env: fixture.env,
    });
    const first = fs.readFileSync(fixture.configPath, 'utf8');
    execFileSync('node', [ENSURE_CONFIG, fixture.configPath], {
      cwd: ROOT,
      env: fixture.env,
    });
    const config = JSON.parse(fs.readFileSync(fixture.configPath, 'utf8'));

    expect(config.skills.load.extraDirs).toEqual(['./skills']);
    expect(config.skills.entries['fixture-router-skills']).toEqual({ enabled: false });
    expect(config.skills.limits).toMatchObject({
      maxSkillsInPrompt: 100,
      maxSkillsPromptChars: 26000,
    });
    expect(config.skills.install).toEqual({
      allowUploadedArchives: true,
    });
    expect(config.tools.toolSearch).toBe(false);
    expect(fs.readFileSync(fixture.configPath, 'utf8')).toBe(first);
  });

  it('preserves explicit operator choices instead of forcing experimental defaults', () => {
    const fixture = createFixtureConfig();
    const config = JSON.parse(fs.readFileSync(fixture.configPath, 'utf8'));
    config.skills.entries = {
      'fixture-router-skills': { enabled: true },
    };
    config.skills.limits = {
      maxSkillsInPrompt: 75,
      maxSkillsPromptChars: 22000,
    };
    config.skills.install = {
      allowUploadedArchives: false,
    };
    config.tools.toolSearch = false;
    fs.writeFileSync(fixture.configPath, JSON.stringify(config, null, 2));

    execFileSync('node', [ENSURE_CONFIG, fixture.configPath], {
      cwd: ROOT,
      env: fixture.env,
    });
    const migrated = JSON.parse(fs.readFileSync(fixture.configPath, 'utf8'));

    expect(migrated.skills.entries['fixture-router-skills']).toEqual({ enabled: true });
    expect(migrated.skills.limits).toEqual({
      maxSkillsInPrompt: 75,
      maxSkillsPromptChars: 22000,
    });
    expect(migrated.skills.install).toEqual({
      allowUploadedArchives: false,
    });
    expect(migrated.tools.toolSearch).toBe(false);
  });
});

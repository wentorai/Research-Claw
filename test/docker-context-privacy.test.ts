import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');

function dockerIgnoreRules(): string[] {
  return readFileSync(path.join(root, '.dockerignore'), 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

describe('Docker build context excludes local runtime data by default', () => {
  it('deny-lists workspace and config trees, then reopens only release templates', () => {
    const rules = dockerIgnoreRules();
    const workspaceRules = rules.filter(
      (rule) =>
        rule === 'workspace/**' ||
        rule === 'workspace/.ResearchClaw/**' ||
        rule.startsWith('!workspace/'),
    );
    const configRules = rules.filter(
      (rule) => rule === 'config/**' || rule.startsWith('!config/'),
    );
    const pptMasterRules = rules.filter(
      (rule) => rule === 'ppt-master/**' || rule.startsWith('!ppt-master/'),
    );

    expect(workspaceRules).toEqual([
      'workspace/**',
      '!workspace/.ResearchClaw/',
      'workspace/.ResearchClaw/**',
      '!workspace/.ResearchClaw/AGENTS.md',
      '!workspace/.ResearchClaw/HEARTBEAT.md',
      '!workspace/.ResearchClaw/SOUL.md.example',
      '!workspace/.ResearchClaw/IDENTITY.md.example',
      '!workspace/.ResearchClaw/TOOLS.md.example',
      '!workspace/.ResearchClaw/BOOTSTRAP.md.example',
      '!workspace/.ResearchClaw/USER.md.example',
      '!workspace/MEMORY.md.example',
    ]);
    expect(configRules).toEqual([
      'config/**',
      '!config/openclaw.example.json',
      '!config/research-compaction-instructions.txt',
    ]);
    expect(pptMasterRules).toEqual([
      'ppt-master/**',
      '!ppt-master/skills/',
      '!ppt-master/skills/ppt-master/',
      '!ppt-master/skills/ppt-master/**',
    ]);
  });

  it('makes a missing ppt-master runtime fail the image build explicitly', () => {
    const dockerfile = readFileSync(path.join(root, 'Dockerfile'), 'utf8');
    expect(dockerfile).toContain(
      'test -f ppt-master/skills/ppt-master/scripts/project_manager.py',
    );
    expect(dockerfile).toContain(
      'test -f ppt-master/skills/ppt-master/scripts/svg_to_pptx.py',
    );
  });

  it('keeps the Bootstrap same-instance test harness out of release images', () => {
    const rules = dockerIgnoreRules();
    expect(rules).toContain('scripts/probe-bootstrap-profile-e2e.mjs');
    expect(rules).toContain('scripts/verify-installer-powershell.ps1');
    expect(rules).toContain('scripts/verify-updater-powershell.ps1');
    expect(rules).toContain('scripts/verify-log-levels.mjs');
    expect(rules).toContain('scripts/build-profile-capsule.mjs');
    expect(rules).toContain('scripts/validate-profile-pack.mjs');
    expect(rules).toContain('scripts/acceptance/');
    expect(rules).toContain('.github/');
  });

  it('keeps every private Capsule fixture out of the Docker build context', () => {
    const rules = dockerIgnoreRules();
    expect(rules).toContain('profiles/');
  });

  it('keeps nested test sources and fixtures out of release images', () => {
    const rules = dockerIgnoreRules();
    expect(rules).toContain('test/');
    expect(rules).toContain('tests/');
    expect(rules).toContain('**/__tests__/');
    expect(rules).toContain('**/__fixtures__/');
    expect(rules).toContain('**/*.test.*');
    expect(rules).toContain('**/*.spec.*');
  });

  it('keeps generated evaluation runs and artifacts out of release images', () => {
    const rules = dockerIgnoreRules();
    expect(rules).toContain('eval/artifacts/');
    expect(rules).toContain('eval/.run/');
  });

  it('keeps ignored TypeScript incremental build metadata out of release images', () => {
    const rules = dockerIgnoreRules();
    expect(rules).toContain('**/*.tsbuildinfo');
    expect(rules).toContain('**/*.d.ts.map');

    const dockerfile = readFileSync(path.join(root, 'Dockerfile'), 'utf8');
    expect(dockerfile).toMatch(
      /RUN pnpm build && \\\n\s+find dashboard extensions -type f \\\( -name '\*\.tsbuildinfo' -o -name '\*\.d\.ts\.map' \\\) -delete/,
    );
  });
});

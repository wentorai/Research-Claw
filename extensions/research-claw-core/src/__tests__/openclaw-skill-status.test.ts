import * as fs from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  OpenClawCliStatusProvider,
  type OpenClawJsonRunner,
} from '../skills/openclaw-status.js';

const fixture = JSON.parse(fs.readFileSync(
  new URL('../__fixtures__/openclaw-skills-status-2026.6.1.json', import.meta.url),
  'utf8',
)) as {
  workspaceDir: string;
  managedSkillsDir: string;
  skills: unknown[];
  info: Record<string, unknown>;
};

class FixtureRunner implements OpenClawJsonRunner {
  calls: string[][] = [];

  async run(args: string[]): Promise<unknown> {
    this.calls.push(args);
    if (args[1] === 'list') return fixture;
    if (args[1] === 'info') return fixture.info[args[2] ?? ''] ?? { error: 'not found' };
    throw new Error(`unexpected command: ${args.join(' ')}`);
  }
}

describe('OpenClaw 2026.6.1 Skill status adapter', () => {
  it('parses the real list/info JSON shape and preserves source/eligibility metadata', async () => {
    const runner = new FixtureRunner();
    const provider = new OpenClawCliStatusProvider({
      runner,
      agentId: 'main',
      snapshotVersion: () => 7,
    });

    const report = await provider.list();
    expect(report.skills).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'deep-research-skills',
        source: 'openclaw-extra',
        eligible: true,
        modelVisible: true,
      }),
      expect.objectContaining({
        name: '1password',
        source: 'openclaw-bundled',
        eligible: false,
        modelVisible: false,
      }),
    ]));
    expect(await provider.info('deep-research-skills')).toMatchObject({
      skillKey: 'deep-research-skills',
      filePath: expect.stringContaining('/plugin-skills/deep-research/SKILL.md'),
    });
    expect(runner.calls).toEqual([
      ['skills', 'list', '--json', '--agent', 'main'],
      ['skills', 'info', 'deep-research-skills', '--json', '--agent', 'main'],
    ]);
  });

  it('caches by OpenClaw Skill snapshot version and supports an explicit force refresh', async () => {
    const runner = new FixtureRunner();
    let version = 3;
    const provider = new OpenClawCliStatusProvider({
      runner,
      snapshotVersion: () => version,
    });

    await provider.list();
    await provider.list();
    expect(runner.calls).toHaveLength(1);
    version = 4;
    await provider.list();
    expect(runner.calls).toHaveLength(2);
    await provider.list({ force: true });
    expect(runner.calls).toHaveLength(3);
  });

  it('returns null for the public not-found info payload', async () => {
    const provider = new OpenClawCliStatusProvider({
      runner: new FixtureRunner(),
      snapshotVersion: () => 1,
    });
    expect(await provider.info('missing-skill')).toBeNull();
  });
});

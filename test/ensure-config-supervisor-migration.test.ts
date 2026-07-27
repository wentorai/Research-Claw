import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const ENSURE_CONFIG = path.join(ROOT, 'scripts', 'ensure-config.cjs');
const EXAMPLE_CONFIG = path.join(ROOT, 'config', 'openclaw.example.json');
const tempRoots: string[] = [];

function migrate(supervisorConfig: Record<string, unknown>) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-supervisor-config-'));
  tempRoots.push(tempRoot);
  const configPath = path.join(tempRoot, 'project', 'config', 'openclaw.json');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      plugins: {
        entries: {
          'dual-model-supervisor': {
            enabled: true,
            config: supervisorConfig,
          },
        },
      },
    }, null, 2),
  );

  execFileSync(process.execPath, [ENSURE_CONFIG, configPath]);
  const firstBytes = fs.readFileSync(configPath, 'utf8');
  execFileSync(process.execPath, [ENSURE_CONFIG, configPath]);
  const secondBytes = fs.readFileSync(configPath, 'utf8');
  const config = JSON.parse(secondBytes);
  return {
    supervisor: config.plugins.entries['dual-model-supervisor'].config,
    llm: config.plugins.entries['dual-model-supervisor'].llm,
    firstBytes,
    secondBytes,
  };
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('ensure-config Supervisor lifecycle migrations', () => {
  it('removes withdrawn surfaces and the known validation-only reviewer placeholder', () => {
    const { supervisor, llm, firstBytes, secondBytes } = migrate({
      enabled: true,
      supervisorModel: 'test/reviewer',
      reviewMode: 'full',
      appendReviewToChannelOutput: true,
      memoryGuard: {
        enabled: true,
        keyCategories: ['research_goal'],
      },
      courseCorrection: {
        enabled: true,
        deviationThreshold: 0.4,
      },
      operatorExtension: {
        keep: true,
      },
    });

    expect(supervisor.supervisorModel).toBe('');
    expect(supervisor.reviewMode).toBe('correct');
    expect(supervisor).not.toHaveProperty('appendReviewToChannelOutput');
    expect(supervisor).not.toHaveProperty('memoryGuard');
    expect(supervisor.courseCorrection).toEqual({
      enabled: true,
      deviationThreshold: 0.4,
    });
    expect(supervisor.operatorExtension).toEqual({ keep: true });
    expect(llm).toEqual({ allowModelOverride: true });
    expect(secondBytes).toBe(firstBytes);
  });

  it('does not erase an operator-selected reviewer merely because its provider is external', () => {
    const { supervisor } = migrate({
      enabled: true,
      supervisorModel: 'lab-relay/reviewer-v2',
      reviewMode: 'correct',
    });

    expect(supervisor.supervisorModel).toBe('lab-relay/reviewer-v2');
  });

  it('ships no withdrawn Supervisor setting in the fresh-install template', () => {
    const example = JSON.parse(fs.readFileSync(EXAMPLE_CONFIG, 'utf8'));
    const supervisor =
      example.plugins.entries['dual-model-supervisor'].config;
    const llm = example.plugins.entries['dual-model-supervisor'].llm;

    expect(supervisor).not.toHaveProperty('appendReviewToChannelOutput');
    expect(supervisor).not.toHaveProperty('memoryGuard');
    expect(supervisor.reviewMode).not.toBe('full');
    expect(llm).toEqual({ allowModelOverride: true });
  });
});

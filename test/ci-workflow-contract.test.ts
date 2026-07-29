import fs from 'node:fs';
import path from 'node:path';

import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'ci.yml');

type Step = {
  name?: string;
  uses?: string;
  run?: string;
  shell?: unknown;
  if?: unknown;
  'continue-on-error'?: unknown;
  with?: Record<string, unknown>;
};

type Job = {
  name?: string;
  needs?: unknown;
  if?: unknown;
  'continue-on-error'?: unknown;
  defaults?: unknown;
  permissions?: unknown;
  uses?: string;
  steps?: Step[];
};

const REVIEWED_ACTIONS = new Set([
  'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
  'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
  'pnpm/action-setup@0ebf47130e4866e96fce0953f49152a61190b271',
]);

function workflow(): Record<string, any> {
  return parse(fs.readFileSync(WORKFLOW, 'utf8'));
}

function stepsOf(job?: Job): Step[] {
  return job?.steps ?? [];
}

describe('GitHub Actions release gate contract', () => {
  it('freezes the complete executable graph of both required checks', () => {
    const config = workflow();

    expect(Object.keys(config).sort()).toEqual([
      'jobs',
      'name',
      'on',
      'permissions',
    ]);
    expect(Object.keys(config.jobs).sort()).toEqual(['e2e', 'unit']);
    expect(config.jobs.unit).toEqual({
      name: 'CI / Unit',
      'runs-on': 'ubuntu-latest',
      'timeout-minutes': 30,
      steps: [
        {
          uses: 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
        },
        {
          name: 'Secret scan',
          run: 'bash scripts/secret-scan.sh --all',
        },
        {
          uses: 'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
          with: { 'node-version': 22 },
        },
        {
          uses: 'pnpm/action-setup@0ebf47130e4866e96fce0953f49152a61190b271',
        },
        {
          name: 'Install dependencies',
          run: 'pnpm install --frozen-lockfile',
        },
        {
          name: 'Build',
          run: 'pnpm build',
        },
        {
          name: 'Test',
          run: 'pnpm test',
        },
      ],
    });
    expect(config.jobs.e2e).toEqual({
      name: 'CI / E2E',
      'runs-on': 'ubuntu-latest',
      'timeout-minutes': 30,
      steps: [
        {
          uses: 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
        },
        {
          uses: 'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
          with: { 'node-version': 22 },
        },
        {
          uses: 'pnpm/action-setup@0ebf47130e4866e96fce0953f49152a61190b271',
        },
        {
          name: 'Install dependencies',
          run: 'pnpm install --frozen-lockfile',
        },
        {
          name: 'Build',
          run: 'pnpm build',
        },
        {
          name: 'Verify (end-to-end)',
          run: 'pnpm verify:e2e',
        },
      ],
    });
  });

  it('exposes independent, stable Unit and E2E checks', () => {
    const config = workflow();
    const unit = config.jobs?.unit as Job;
    const e2e = config.jobs?.e2e as Job;

    expect(config.defaults).toBeUndefined();
    expect(unit?.name).toBe('CI / Unit');
    expect(e2e?.name).toBe('CI / E2E');
    expect(unit?.defaults).toBeUndefined();
    expect(e2e?.defaults).toBeUndefined();
    expect(unit?.needs).toBeUndefined();
    expect(unit?.if).toBeUndefined();
    expect(unit?.['continue-on-error']).toBeUndefined();
    expect(e2e?.needs).toBeUndefined();
    expect(e2e?.if).toBeUndefined();
    expect(e2e?.['continue-on-error']).toBeUndefined();
  });

  it('runs the real E2E command without a skippable condition', () => {
    const config = workflow();
    const e2e = config.jobs.e2e as Job;
    const steps = stepsOf(e2e);
    const verifySteps = steps.filter(
      (step) => step.run?.trim() === 'pnpm verify:e2e',
    );

    expect(verifySteps).toHaveLength(1);
    expect(verifySteps[0]?.if).toBeUndefined();
    expect(verifySteps[0]?.['continue-on-error']).toBeUndefined();
    expect(verifySteps[0]?.shell).toBeUndefined();
    expect(steps.some((step) => step.run?.includes('pnpm test'))).toBe(false);
    const installIndex = steps.findIndex(
      (step) => step.run?.trim() === 'pnpm install --frozen-lockfile',
    );
    const buildIndex = steps.findIndex(
      (step) => step.run?.trim() === 'pnpm build',
    );
    const verifyIndex = steps.indexOf(verifySteps[0]);
    expect(installIndex).toBeGreaterThan(-1);
    expect(buildIndex).toBeGreaterThan(installIndex);
    expect(verifyIndex).toBeGreaterThan(buildIndex);
  });

  it('runs unit tests separately and fixes the product runtime at Node 22', () => {
    const config = workflow();
    const unitSteps = stepsOf(config.jobs.unit as Job);
    const e2eSteps = stepsOf(config.jobs.e2e as Job);
    const testSteps = unitSteps.filter(
      (step) => step.run?.trim() === 'pnpm test',
    );

    expect(testSteps).toHaveLength(1);
    expect(testSteps[0]?.if).toBeUndefined();
    expect(testSteps[0]?.['continue-on-error']).toBeUndefined();
    expect(testSteps[0]?.shell).toBeUndefined();
    expect(
      unitSteps.some(
        (step) => step.run?.trim() === 'pnpm install --frozen-lockfile',
      ),
    ).toBe(true);
    expect(
      unitSteps.some((step) => step.run?.trim() === 'pnpm build'),
    ).toBe(true);
    for (const steps of [unitSteps, e2eSteps]) {
      const setupNodeSteps = steps.filter((step) =>
        step.uses?.startsWith('actions/setup-node@'),
      );
      expect(setupNodeSteps).toHaveLength(1);
      expect(String(setupNodeSteps[0]?.with?.['node-version'])).toBe('22');
    }
  });

  it('pins every external action to an independently reviewed immutable SHA', () => {
    const config = workflow();
    const jobs = Object.values(config.jobs as Record<string, Job>);
    const externalUses = [
      ...jobs.map((job) => job.uses),
      ...jobs.flatMap((job) => stepsOf(job)).map((step) => step.uses),
    ]
      .filter((value): value is string => Boolean(value));

    expect(externalUses.length).toBeGreaterThan(0);
    for (const action of externalUses) {
      expect(action).toMatch(/@[0-9a-f]{40}$/);
      expect(REVIEWED_ACTIONS.has(action)).toBe(true);
    }
  });

  it('runs on main pushes, pull requests and merge queues with read-only contents', () => {
    const config = workflow();
    const jobs = Object.values(config.jobs as Record<string, Job>);

    expect(config.on?.push?.branches).toContain('main');
    expect(config.on?.pull_request?.branches).toContain('main');
    expect(config.on?.merge_group).toBeDefined();
    expect(config.permissions).toEqual({ contents: 'read' });
    for (const job of jobs) {
      expect(job.permissions).toBeUndefined();
    }
  });
});

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const ENSURE_CONFIG = path.resolve(__dirname, '../scripts/ensure-config.cjs');
const INSTALL_SCRIPT = path.resolve(__dirname, '../scripts/install.sh');
const RUN_SCRIPT = path.resolve(__dirname, '../scripts/run.sh');
const DOCKER_ENTRYPOINT = path.resolve(
  __dirname,
  '../scripts/docker-entrypoint.sh',
);
const DOCKERFILE = path.resolve(__dirname, '../Dockerfile');
const OPENCLAW = path.resolve(__dirname, '../node_modules/.bin/openclaw');
const EXAMPLE_CONFIG = path.resolve(__dirname, '../config/openclaw.example.json');
const PROMPT_SOURCE = path.resolve(
  __dirname,
  '../config/research-compaction-instructions.txt',
);
const EXPECTED_PROMPT = fs.readFileSync(PROMPT_SOURCE, 'utf8').trim();

const REQUIRED_SCIENTIFIC_CONCEPTS = [
  /research questions?/i,
  /hypotheses/i,
  /negative results?/i,
  /conflicting evidence/i,
  /numbers? with units?/i,
  /uncertainty|error/i,
  /sample sizes?/i,
  /experimental conditions?/i,
  /datasets? and versions?/i,
  /parameters?/i,
  /reproduction steps?/i,
  /DOIs?/,
  /URLs?/,
  /file paths?/i,
  /commit hashes?/i,
  /decisions? with rationale/i,
  /unresolved questions?/i,
  /blockers?/i,
  /observations?.*inferences?.*hypotheses.*plans?/is,
  /never turn uncertainty into fact/i,
];

function expectScientificDefault(value: unknown): void {
  expect(typeof value).toBe('string');
  const prompt = value as string;
  expect(prompt.trim().length).toBeGreaterThan(300);
  for (const concept of REQUIRED_SCIENTIFIC_CONCEPTS) {
    expect(prompt).toMatch(concept);
  }
}

function compactionOf(configPath: string): Record<string, unknown> {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  return config.agents?.defaults?.compaction ?? {};
}

describe('ensure-config scientific compaction migration', () => {
  let tmpDir: string;
  let configPath: string;
  let isolatedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-scientific-compaction-'));
    const configDir = path.join(tmpDir, 'config');
    fs.mkdirSync(configDir, { recursive: true });
    configPath = path.join(configDir, 'openclaw.json');
    isolatedEnv = {
      ...process.env,
      HOME: path.join(tmpDir, 'home'),
      XDG_CACHE_HOME: path.join(tmpDir, 'xdg-cache'),
      XDG_CONFIG_HOME: path.join(tmpDir, 'xdg-config'),
      XDG_DATA_HOME: path.join(tmpDir, 'xdg-data'),
      XDG_STATE_HOME: path.join(tmpDir, 'xdg-state'),
      OPENCLAW_STATE_DIR: path.join(tmpDir, 'state'),
    };
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function runEnsure(...args: string[]): void {
    execFileSync('node', [ENSURE_CONFIG, ...args], {
      env: isolatedEnv,
    });
  }

  it('keeps the Docker-shipped scientific prompt complete and within the 800-char delivery budget', () => {
    expect(Array.from(EXPECTED_PROMPT).length).toBeLessThanOrEqual(800);
    expect(EXPECTED_PROMPT).toContain(
      'Remove greetings, repetition, and process noise; do not drop conditions or qualifiers needed for scientific conclusions.',
    );
    expectScientificDefault(EXPECTED_PROMPT);
  });

  it('seeds compaction.mode and writes no retired customInstructions when compaction is absent', () => {
    fs.writeFileSync(configPath, JSON.stringify({ agents: { defaults: {} } }));

    runEnsure(configPath);

    const compaction = compactionOf(configPath);
    expect(compaction.mode).toBe('safeguard');
    expect(compaction).not.toHaveProperty('customInstructions');
  });

  it('strips whitespace-only customInstructions like any other retired prompt', () => {
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        agents: {
          defaults: {
            compaction: { mode: 'safeguard', customInstructions: ' \n\t ' },
          },
        },
      }),
    );

    runEnsure(configPath);

    const compaction = compactionOf(configPath);
    expect(compaction.mode).toBe('safeguard');
    expect(compaction).not.toHaveProperty('customInstructions');
  });

  it('strips a user-provided legacy instruction and is idempotent', () => {
    const customInstructions = '  Preserve MY ΔT shorthand exactly.  ';
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        agents: {
          defaults: {
            compaction: { mode: 'safeguard', customInstructions },
          },
        },
      }),
    );

    runEnsure(configPath);
    const afterFirst = fs.readFileSync(configPath, 'utf8');
    expect(compactionOf(configPath)).not.toHaveProperty('customInstructions');

    runEnsure(configPath);
    expect(fs.readFileSync(configPath, 'utf8')).toBe(afterFirst);
    expect(compactionOf(configPath)).not.toHaveProperty('customInstructions');
  });

  it('accepts --inherit-global-compaction without copying the retired prompt into either config', () => {
    const globalConfigPath = path.join(
      tmpDir,
      'home',
      '.openclaw',
      'openclaw.json',
    );
    fs.mkdirSync(path.dirname(globalConfigPath), { recursive: true });
    const customInstructions =
      '  Preserve my established lab compaction protocol ΔT exactly.  ';
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        agents: {
          defaults: {
            compaction: {
              mode: 'safeguard',
              customInstructions: EXPECTED_PROMPT,
            },
          },
        },
      }),
    );
    fs.writeFileSync(
      globalConfigPath,
      JSON.stringify({
        agents: {
          defaults: {
            compaction: { customInstructions },
          },
        },
      }),
    );

    runEnsure(
      '--inherit-global-compaction',
      configPath,
      globalConfigPath,
    );

    expect(compactionOf(configPath)).not.toHaveProperty('customInstructions');
    expect(compactionOf(globalConfigPath).customInstructions).toBe(customInstructions);
  });

  it('strips an explicit project instruction during install migration without consulting the global prompt', () => {
    const globalConfigPath = path.join(
      tmpDir,
      'home',
      '.openclaw',
      'openclaw.json',
    );
    fs.mkdirSync(path.dirname(globalConfigPath), { recursive: true });
    const projectInstructions = '  Project-specific protocol must win.  ';
    const globalInstructions = '  Existing global protocol.  ';
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        agents: {
          defaults: {
            compaction: { customInstructions: projectInstructions },
          },
        },
      }),
    );
    fs.writeFileSync(
      globalConfigPath,
      JSON.stringify({
        agents: {
          defaults: {
            compaction: { customInstructions: globalInstructions },
          },
        },
      }),
    );

    runEnsure(
      '--inherit-global-compaction',
      configPath,
      globalConfigPath,
    );

    expect(compactionOf(configPath)).not.toHaveProperty('customInstructions');
    expect(compactionOf(globalConfigPath).customInstructions).toBe(globalInstructions);
  });

  it('wires the global-inheritance mode only into the install migration', () => {
    const installScript = fs.readFileSync(INSTALL_SCRIPT, 'utf8');
    const runScript = fs.readFileSync(RUN_SCRIPT, 'utf8');
    expect(installScript).toContain(
      'node scripts/ensure-config.cjs --inherit-global-compaction',
    );
    expect(runScript).not.toContain('--inherit-global-compaction');
  });

  it('ships 2026.9.2-valid compaction defaults in the example config', () => {
    const example = JSON.parse(fs.readFileSync(EXAMPLE_CONFIG, 'utf8'));
    expect(example.agents?.defaults?.compaction?.mode).toBe('safeguard');
    expect(example.agents?.defaults?.compaction).not.toHaveProperty(
      'customInstructions',
    );
  });

  it('seeds the scientific prompt before Docker config reconciliation', () => {
    const dockerfile = fs.readFileSync(DOCKERFILE, 'utf8');
    const entrypoint = fs.readFileSync(DOCKER_ENTRYPOINT, 'utf8');
    expect(dockerfile).toContain(
      'cp config/research-compaction-instructions.txt /defaults/research-compaction-instructions.txt',
    );
    expect(entrypoint).toContain(
      'COMPACTION_INSTRUCTIONS=$CONFIG_DIR/research-compaction-instructions.txt',
    );
    expect(entrypoint).toContain(
      'cp /defaults/research-compaction-instructions.txt "$COMPACTION_INSTRUCTIONS"',
    );
    expect(entrypoint.indexOf('COMPACTION_INSTRUCTIONS=')).toBeLessThan(
      entrypoint.indexOf('node /app/scripts/ensure-config.cjs'),
    );
  });

  it(
    'is accepted by the installed OpenClaw 2026.9.2 config schema',
    () => {
      fs.copyFileSync(EXAMPLE_CONFIG, configPath);
      runEnsure(configPath);

      // OpenClaw intentionally silences its CLI when it inherits Vitest's process
      // markers. The subprocess is the product CLI, so run it with production-like
      // markers while retaining the rest of the environment.
      const cliEnv = { ...isolatedEnv };
      delete cliEnv.VITEST;
      delete cliEnv.VITEST_POOL_ID;
      delete cliEnv.VITEST_WORKER_ID;
      cliEnv.NODE_ENV = 'production';
      cliEnv.OPENCLAW_CONFIG_PATH = configPath;

      const raw = execFileSync(OPENCLAW, ['config', 'validate', '--json'], {
        encoding: 'utf8',
        env: cliEnv,
      });
      const result = JSON.parse(raw) as {
        valid: boolean;
        path: string;
        issues?: unknown[];
        warnings?: unknown[];
      };

      expect(result.valid).toBe(true);
      expect(result.issues ?? []).toEqual([]);
      expect(result.warnings ?? []).toEqual([]);
      expect(path.resolve(result.path)).toBe(path.resolve(configPath));
    },
    30_000,
  );
});

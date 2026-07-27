import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const ENSURE_CONFIG = path.resolve(__dirname, '../scripts/ensure-config.cjs');
const INSTALL_SCRIPT = path.resolve(__dirname, '../scripts/install.sh');
const RUN_SCRIPT = path.resolve(__dirname, '../scripts/run.sh');
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

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-scientific-compaction-'));
    const configDir = path.join(tmpDir, 'config');
    fs.mkdirSync(configDir, { recursive: true });
    configPath = path.join(configDir, 'openclaw.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('fits OpenClaw 2026.6.1 custom-instruction delivery without truncation', () => {
    expect(Array.from(EXPECTED_PROMPT).length).toBeLessThanOrEqual(800);
    expect(EXPECTED_PROMPT).toContain(
      'Remove greetings, repetition, and process noise; do not drop conditions or qualifiers needed for scientific conclusions.',
    );
  });

  it('adds the scientific default when customInstructions is absent', () => {
    fs.writeFileSync(configPath, JSON.stringify({ agents: { defaults: {} } }));

    execFileSync('node', [ENSURE_CONFIG, configPath]);

    const compaction = compactionOf(configPath);
    expect(compaction.mode).toBe('safeguard');
    expect(compaction.customInstructions).toBe(EXPECTED_PROMPT);
    expectScientificDefault(compaction.customInstructions);
  });

  it('replaces whitespace-only customInstructions with the scientific default', () => {
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

    execFileSync('node', [ENSURE_CONFIG, configPath]);

    const customInstructions = compactionOf(configPath).customInstructions;
    expect(customInstructions).toBe(EXPECTED_PROMPT);
    expectScientificDefault(customInstructions);
  });

  it('preserves a user-provided non-empty instruction byte-for-byte and is idempotent', () => {
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

    execFileSync('node', [ENSURE_CONFIG, configPath]);
    const afterFirst = fs.readFileSync(configPath, 'utf8');
    expect(compactionOf(configPath).customInstructions).toBe(customInstructions);

    execFileSync('node', [ENSURE_CONFIG, configPath]);
    expect(fs.readFileSync(configPath, 'utf8')).toBe(afterFirst);
    expect(compactionOf(configPath).customInstructions).toBe(customInstructions);
  });

  it('inherits a pre-existing global user instruction during install migration', () => {
    const globalConfigPath = path.join(tmpDir, 'global-openclaw.json');
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

    execFileSync('node', [
      ENSURE_CONFIG,
      '--inherit-global-compaction',
      configPath,
      globalConfigPath,
    ]);

    expect(compactionOf(configPath).customInstructions).toBe(customInstructions);
    expect(compactionOf(globalConfigPath).customInstructions).toBe(customInstructions);
  });

  it('does not overwrite an explicit project instruction during install migration', () => {
    const globalConfigPath = path.join(tmpDir, 'global-openclaw.json');
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

    execFileSync('node', [
      ENSURE_CONFIG,
      '--inherit-global-compaction',
      configPath,
      globalConfigPath,
    ]);

    expect(compactionOf(configPath).customInstructions).toBe(projectInstructions);
  });

  it('wires the global-inheritance mode only into the install migration', () => {
    const installScript = fs.readFileSync(INSTALL_SCRIPT, 'utf8');
    const runScript = fs.readFileSync(RUN_SCRIPT, 'utf8');
    expect(installScript).toContain(
      'node scripts/ensure-config.cjs --inherit-global-compaction',
    );
    expect(runScript).not.toContain('--inherit-global-compaction');
  });

  it('ships the same scientific default in the example config', () => {
    const example = JSON.parse(fs.readFileSync(EXAMPLE_CONFIG, 'utf8'));
    const customInstructions =
      example.agents?.defaults?.compaction?.customInstructions;
    expect(customInstructions).toBe(EXPECTED_PROMPT);
    expectScientificDefault(customInstructions);
  });

  it(
    'is accepted by the installed OpenClaw 2026.6.1 config schema',
    () => {
      fs.copyFileSync(EXAMPLE_CONFIG, configPath);
      execFileSync('node', [ENSURE_CONFIG, configPath]);

      // OpenClaw intentionally silences its CLI when it inherits Vitest's process
      // markers. The subprocess is the product CLI, so run it with production-like
      // markers while retaining the rest of the environment.
      const cliEnv = { ...process.env };
      delete cliEnv.VITEST;
      delete cliEnv.VITEST_POOL_ID;
      delete cliEnv.VITEST_WORKER_ID;
      cliEnv.NODE_ENV = 'production';
      cliEnv.OPENCLAW_CONFIG_PATH = configPath;
      cliEnv.OPENCLAW_STATE_DIR = path.join(tmpDir, 'state');

      const raw = execFileSync(OPENCLAW, ['config', 'validate', '--json'], {
        encoding: 'utf8',
        env: cliEnv,
      });
      const result = JSON.parse(raw) as { valid: boolean; path: string };

      expect(result.valid).toBe(true);
      expect(path.resolve(result.path)).toBe(path.resolve(configPath));
    },
    30_000,
  );
});

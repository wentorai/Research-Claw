import { describe, expect, it } from 'vitest';

import {
  buildSaveConfig,
  RC_SCIENTIFIC_COMPACTION_INSTRUCTIONS,
  type ConfigPatchInput,
} from './config-patch';

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

function input(): ConfigPatchInput {
  return {
    provider: 'custom-relay',
    baseUrl: 'https://relay.example.invalid/v1',
    api: 'openai-completions',
    apiKey: 'test-key',
    textModel: 'research-model',
  };
}

function compactionOf(config: Record<string, unknown>): Record<string, unknown> {
  return (
    (config.agents as { defaults: { compaction: Record<string, unknown> } })
      .defaults.compaction
  );
}

function expectScientificDefault(value: unknown): void {
  expect(typeof value).toBe('string');
  const prompt = value as string;
  expect(prompt.trim().length).toBeGreaterThan(300);
  for (const concept of REQUIRED_SCIENTIFIC_CONCEPTS) {
    expect(prompt).toMatch(concept);
  }
}

describe('Research-Claw compaction config (OpenClaw 2026.9.2)', () => {
  it('writes safeguard mode and no retired prompt to a new Dashboard-generated config', () => {
    const compaction = compactionOf(buildSaveConfig(null, input()));

    expect(compaction.mode).toBe('safeguard');
    expect(compaction).not.toHaveProperty('customInstructions');
    expect(compaction).not.toHaveProperty('identifierInstructions');
    // The prompt is no longer a config field; the shipped text must stay intact
    // for the compaction provider / hook that will consume it.
    expectScientificDefault(RC_SCIENTIFIC_COMPACTION_INSTRUCTIONS);
  });

  it('strips an absent, empty, or whitespace-only legacy instruction on save', () => {
    for (const customInstructions of [undefined, '', '  \n\t ']) {
      const current = {
        agents: {
          defaults: {
            compaction: { mode: 'safeguard', customInstructions },
          },
        },
      };
      const compaction = compactionOf(buildSaveConfig(current, input()));
      expect(compaction.mode).toBe('safeguard');
      expect(compaction).not.toHaveProperty('customInstructions');
    }
  });

  it('strips a user-provided legacy instruction instead of round-tripping a retired key', () => {
    const customInstructions = '  Keep MY lab shorthand ΔT exactly; do not normalize.  ';
    const current = {
      agents: {
        defaults: {
          compaction: { mode: 'safeguard', customInstructions },
        },
      },
    };

    const compaction = compactionOf(buildSaveConfig(current, input()));

    expect(compaction).not.toHaveProperty('customInstructions');
    expect(compaction.mode).toBe('safeguard');
  });
});

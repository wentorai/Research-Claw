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

describe('Research-Claw scientific compaction instructions', () => {
  it('adds the scientific default to a new Dashboard-generated config', () => {
    const compaction = compactionOf(buildSaveConfig(null, input()));

    expect(compaction.mode).toBe('safeguard');
    expect(compaction.customInstructions).toBe(RC_SCIENTIFIC_COMPACTION_INSTRUCTIONS);
    expectScientificDefault(compaction.customInstructions);
  });

  it('replaces an absent or whitespace-only instruction with the scientific default', () => {
    for (const customInstructions of [undefined, '', '  \n\t ']) {
      const current = {
        agents: {
          defaults: {
            compaction: { mode: 'safeguard', customInstructions },
          },
        },
      };
      const compaction = compactionOf(buildSaveConfig(current, input()));
      expect(compaction.customInstructions).toBe(RC_SCIENTIFIC_COMPACTION_INSTRUCTIONS);
      expectScientificDefault(compaction.customInstructions);
    }
  });

  it('preserves a user-provided non-empty instruction byte-for-byte on unrelated saves', () => {
    const customInstructions = '  Keep MY lab shorthand ΔT exactly; do not normalize.  ';
    const current = {
      agents: {
        defaults: {
          compaction: { mode: 'safeguard', customInstructions },
        },
      },
    };

    const compaction = compactionOf(buildSaveConfig(current, input()));

    expect(compaction.customInstructions).toBe(customInstructions);
  });
});

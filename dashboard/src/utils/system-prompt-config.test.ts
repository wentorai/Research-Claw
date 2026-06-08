import { describe, it, expect, beforeEach } from 'vitest';
import {
  readSystemPromptAppendFromConfig,
  buildSystemPromptAppendPatch,
  resetSystemPromptPersistState,
} from './system-prompt-config';

describe('system-prompt-config', () => {
  beforeEach(() => {
    resetSystemPromptPersistState();
  });

  describe('readSystemPromptAppendFromConfig', () => {
    it('returns empty string when config is null', () => {
      expect(readSystemPromptAppendFromConfig(null)).toBe('');
    });

    it('reads ui.researchClaw.systemPromptAppend', () => {
      const config = {
        ui: {
          researchClaw: {
            systemPromptAppend: 'Be concise.',
          },
        },
      };
      expect(readSystemPromptAppendFromConfig(config)).toBe('Be concise.');
    });

    it('ignores non-string values', () => {
      const config = {
        ui: {
          researchClaw: {
            systemPromptAppend: 42,
          },
        },
      };
      expect(readSystemPromptAppendFromConfig(config)).toBe('');
    });
  });

  describe('buildSystemPromptAppendPatch', () => {
    it('trims text and nests under ui.researchClaw', () => {
      expect(buildSystemPromptAppendPatch('  hello  ')).toEqual({
        ui: {
          researchClaw: {
            systemPromptAppend: 'hello',
          },
        },
      });
    });
  });
});

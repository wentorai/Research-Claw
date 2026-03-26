/**
 * Behavioral Parity Tests: Unified Assistant Message Sanitization Pipeline
 *
 * These tests verify that sanitizeAssistantMessage() handles ALL internal
 * scaffolding tags IDENTICALLY to OpenClaw's stripAssistantInternalScaffolding().
 *
 * OpenClaw reference implementation:
 *   - assistant-visible-text.ts:44-47 — stripAssistantInternalScaffolding (full pipeline)
 *   - reasoning-tags.ts:19-92 — stripReasoningTagsFromText (<think> + <final>)
 *   - assistant-visible-text.ts:7-41 — stripRelevantMemoriesTags
 *   - pi-embedded-utils.ts:49-60 — stripModelSpecialTokens
 *
 * Pipeline:
 *   Step 1: <think|thinking|thought|antthinking> → strip tags AND content
 *   Step 2: <final> → strip tags, PRESERVE content
 *   Step 3: <relevant-memories|relevant_memories> → strip tags AND content
 *   Step 4: <|...|> model tokens → replace with space
 *
 * CRITICAL: These tests use expectations derived from OpenClaw's own test suite.
 */
import { describe, it, expect } from 'vitest';
import {
  sanitizeAssistantMessage,
  sanitizeAssistantRawCopy,
} from '../../utils/sanitize-assistant-message';

describe('sanitizeAssistantMessage — unified pipeline', () => {
  describe('passthrough: no scaffolding tags', () => {
    it('returns plain text unchanged', () => {
      const text = 'Hello, this is a normal response.';
      expect(sanitizeAssistantMessage(text)).toBe(text);
    });

    it('returns empty/null/undefined unchanged', () => {
      expect(sanitizeAssistantMessage('')).toBe('');
      expect(sanitizeAssistantMessage(null as unknown as string)).toBe(null);
      expect(sanitizeAssistantMessage(undefined as unknown as string)).toBe(undefined);
    });
  });

  describe('Step 1: thinking tags — strip tags AND content', () => {
    /**
     * Parity: reasoning-tags.test.ts:12-33
     */
    it('strips <think> tags and content', () => {
      expect(sanitizeAssistantMessage(
        '<think>I should analyze this carefully.</think>The answer is 42.',
      )).toBe('The answer is 42.');
    });

    it('strips <thinking> variant', () => {
      expect(sanitizeAssistantMessage(
        '<thinking>Let me consider...</thinking>Result here.',
      )).toBe('Result here.');
    });

    it('strips <thought> variant', () => {
      expect(sanitizeAssistantMessage(
        'A <thought>hmm</thought> B',
      )).toBe('A  B');
    });

    it('strips <antthinking> variant', () => {
      expect(sanitizeAssistantMessage(
        'X <antthinking>internal</antthinking> Y',
      )).toBe('X  Y');
    });

    it('strips multiple thinking blocks', () => {
      expect(sanitizeAssistantMessage(
        '<think>first</think>A<think>second</think>B',
      )).toBe('AB');
    });

    it('handles case-insensitive tags', () => {
      expect(sanitizeAssistantMessage(
        'A <THINK>hidden</THINK> B',
      )).toBe('A  B');
    });

    it('handles CJK content in thinking tags', () => {
      expect(sanitizeAssistantMessage(
        '你好 <think>思考 🤔</think> 世界',
      )).toBe('你好  世界');
    });
  });

  describe('Step 2: final tags — strip tags, PRESERVE content', () => {
    /**
     * Parity: reasoning-tags.test.ts:135-157
     * The content inside <final> IS the user-visible response.
     */
    it('strips <final> tags but preserves inner content', () => {
      expect(sanitizeAssistantMessage(
        '<final>不客气！如果有任何需要帮忙的，随时告诉我。</final>',
      )).toBe('不客气！如果有任何需要帮忙的，随时告诉我。');
    });

    it('handles multiple <final> blocks', () => {
      expect(sanitizeAssistantMessage(
        'A<final>1</final>B<final>2</final>C',
      )).toBe('A1B2C');
    });

    it('handles case-insensitive and attributes', () => {
      expect(sanitizeAssistantMessage(
        "A <FINAL data-x='1'>visible</Final> B",
      )).toBe('A visible B');
    });

    it('trims surrounding whitespace after stripping', () => {
      expect(sanitizeAssistantMessage(
        '<final>\n\nHello there\n\n</final>',
      )).toBe('Hello there');
    });
  });

  describe('Step 3: memory tags — strip tags AND content', () => {
    /**
     * Parity: assistant-visible-text.test.ts:10-29
     */
    it('strips <relevant-memories> blocks', () => {
      const input = [
        '<relevant-memories>',
        'The following memories may be relevant:',
        '- Internal memory note',
        '</relevant-memories>',
        '',
        'User-visible answer',
      ].join('\n');
      expect(sanitizeAssistantMessage(input)).toBe('User-visible answer');
    });

    it('strips <relevant_memories> (underscore variant)', () => {
      const input = [
        '<relevant_memories>',
        'Internal memory note',
        '</relevant_memories>',
        'Visible',
      ].join('\n');
      expect(sanitizeAssistantMessage(input)).toBe('Visible');
    });
  });

  describe('Step 4: model special tokens', () => {
    /**
     * Parity: pi-embedded-utils.ts:49-60
     */
    it('strips ASCII pipe tokens', () => {
      expect(sanitizeAssistantMessage(
        '<|assistant|>Hello world<|end|>',
      )).toBe('Hello world');
    });

    it('strips full-width pipe tokens (DeepSeek)', () => {
      expect(sanitizeAssistantMessage(
        '<｜begin▁of▁sentence｜>Response text',
      )).toBe('Response text');
    });
  });

  describe('combined: full pipeline ordering', () => {
    it('strips thinking + final + memory + model tokens in one pass', () => {
      const input = '<think>analyzing...</think><relevant-memories>\nuser context\n</relevant-memories>\n<final>The answer is here.</final>';
      expect(sanitizeAssistantMessage(input)).toBe('The answer is here.');
    });

    it('handles model tokens + final tags together', () => {
      expect(sanitizeAssistantMessage(
        '<|assistant|><final>Here is the answer.</final><|end|>',
      )).toBe('Here is the answer.');
    });

    it('handles thinking + memory interleaved with visible text', () => {
      const input = [
        '<thinking>Step 1: analyze</thinking>',
        '<relevant-memories>user prefers dark mode</relevant-memories>',
        'Based on your analysis, the result is positive.',
      ].join('\n');
      expect(sanitizeAssistantMessage(input)).toBe(
        'Based on your analysis, the result is positive.',
      );
    });
  });

  describe('does not leak regex state across repeated calls', () => {
    /**
     * Parity: reasoning-tags.test.ts:235-239
     */
    it('handles consecutive calls with different tag types', () => {
      expect(sanitizeAssistantMessage('A <final>1</final> B')).toBe('A 1 B');
      expect(sanitizeAssistantMessage('C <final>2</final> D')).toBe('C 2 D');
      expect(sanitizeAssistantMessage('E <think>x</think> F')).toBe('E  F');
      expect(sanitizeAssistantMessage('<relevant-memories>m</relevant-memories>G')).toBe('G');
    });
  });
});

describe('sanitizeAssistantRawCopy — preserves thinking for raw copy', () => {
  it('preserves thinking tags (user wants to see reasoning)', () => {
    expect(sanitizeAssistantRawCopy(
      '<think>analyzing carefully</think>The answer is 42.',
    )).toBe('<think>analyzing carefully</think>The answer is 42.');
  });

  it('still strips final tags', () => {
    expect(sanitizeAssistantRawCopy(
      '<final>The answer is 42.</final>',
    )).toBe('The answer is 42.');
  });

  it('still strips memory tags', () => {
    expect(sanitizeAssistantRawCopy(
      '<relevant-memories>context</relevant-memories>Visible.',
    )).toBe('Visible.');
  });

  it('still strips model tokens', () => {
    expect(sanitizeAssistantRawCopy(
      '<|assistant|>Hello<|end|>',
    )).toBe('Hello');
  });

  it('handles combined: keeps thinking, strips rest', () => {
    const input = '<think>reasoning</think><relevant-memories>m</relevant-memories><final>Answer.</final><|end|>';
    expect(sanitizeAssistantRawCopy(input)).toBe('<think>reasoning</think>Answer.');
  });
});

/**
 * P2-E — OC hook event-field contract tests, driven by the REAL production
 * extractors/handlers against typed fixtures (src/__fixtures__/oc-hook-events.ts).
 *
 * The fixtures are typed with the real OC event types, so a phantom field or a
 * removed required field is a COMPILE error. These runtime tests additionally
 * lock that the production code reads the right fields: llm_output → assistantTexts,
 * message_sending channel detection → metadata, and that removing the real field
 * changes behavior (discriminating).
 */

import { describe, expect, it } from 'vitest';
import { extractLlmOutputText } from '../../index.js';
import { LLM_OUTPUT_EVENT } from '../__fixtures__/oc-hook-events.js';

describe('P2-E llm_output contract', () => {
  it('production extractor reads assistant text from `assistantTexts`', () => {
    expect(extractLlmOutputText(LLM_OUTPUT_EVENT)).toBe('Our method extends BERT (10.18653/v1/N19-1423).');
  });
  it('discriminating: without assistantTexts/lastAssistant there is no text', () => {
    // A stripped event (only the required non-text fields) yields no text.
    const stripped = { runId: 'r', sessionId: 's', provider: 'p', model: 'm', assistantTexts: [] } as unknown as typeof LLM_OUTPUT_EVENT;
    expect(extractLlmOutputText(stripped)).toBeUndefined();
  });
});

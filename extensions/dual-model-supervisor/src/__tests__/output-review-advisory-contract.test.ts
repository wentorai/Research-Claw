/**
 * Output review (llm_output) — the reviewer's verdict is ADVISORY, and the wire
 * contract must say so.
 *
 * OC fires `llm_output` fire-and-forget: the message is already delivered when the
 * reviewer runs. The plugin never withholds it and never substitutes text. So the
 * reviewer cannot "block" anything and its rewrite is never "applied" — it is a
 * suggestion recorded in the audit log.
 *
 * The reviewer is an LLM: the schema we hand it in the system prompt IS the
 * specification it reasons from. Fields named `blocked` / `corrected` instruct it
 * to believe it is an enforcement gate, so it calibrates against a power it does
 * not have. The field names themselves must carry the advisory semantics, which
 * also makes the false claim structurally impossible to reintroduce.
 *
 * (`ToolReviewResult.blocked` is a DIFFERENT type on the before_tool_call path,
 * where blocking is real. It is deliberately untouched.)
 */

import { describe, expect, it } from 'vitest';
import { OUTPUT_REVIEW_SYSTEM_PROMPT } from '../core/prompts.js';
import { validateReviewResult } from '../core/validators.js';

/** The response schema the prompt hands the reviewer model, as the model reads it. */
function promptResponseSchema(): Record<string, unknown> {
  const m = OUTPUT_REVIEW_SYSTEM_PROMPT.match(/\{[\s\S]*?\n\}/);
  expect(m, 'the prompt must contain a JSON response template').not.toBeNull();
  return JSON.parse(m![0]) as Record<string, unknown>;
}

describe('output review is advisory — the reviewer contract may not claim enforcement', () => {
  it('the system prompt never tells the reviewer its verdict blocks or applies a correction', () => {
    expect(OUTPUT_REVIEW_SYSTEM_PROMPT).not.toMatch(/\bblock(ed|ing|s)?\b/i);
    expect(OUTPUT_REVIEW_SYSTEM_PROMPT).not.toMatch(/corrected version|correction was applied|"corrected"/i);
    // And it must state the truth the reviewer needs in order to calibrate.
    expect(OUTPUT_REVIEW_SYSTEM_PROMPT).toMatch(/already been delivered/i);
    expect(OUTPUT_REVIEW_SYSTEM_PROMPT).toMatch(/advisory/i);
  });

  it('the response template in the prompt is accepted by the validator (prompt ↔ validator agree)', () => {
    // A rename applied to only one side leaves the reviewer emitting a body the
    // validator rejects as schema_invalid — every deep review would degrade.
    const sample = promptResponseSchema();
    expect(validateReviewResult(sample)).not.toBeNull();
  });

  it('the validated result exposes no field that asserts the output was blocked or rewritten', () => {
    const result = validateReviewResult(promptResponseSchema())!;
    const keys = Object.keys(result);
    expect(keys).not.toContain('blocked');
    expect(keys).not.toContain('corrected');
    expect(keys).not.toContain('correctedVersion');
    expect(keys).toContain('flagged');
    expect(keys).toContain('hasSuggestion');
  });
});

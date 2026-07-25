/**
 * Course correction — TRUTHFUL semantics.
 *
 * What actually happens on deviation: the turn's output has ALREADY been delivered
 * (agent_end fires after delivery, and the supervisor never blocks). All the corrector
 * can do is queue an instruction into the NEXT turn's prompt (before_prompt_build).
 *
 * Therefore nothing is blocked and nothing is auto-corrected, and neither the audit
 * trail nor the prompt may claim otherwise. `action: 'block'` in particular is a
 * machine-readable claim that delivery was prevented — it must not be used here.
 */

import { describe, expect, it, vi } from 'vitest';
import { CourseCorrector } from '../hooks/course-corrector.js';
import { FORCE_REGENERATE_CORRECTION_PROMPT } from '../core/prompts.js';
import { parseConfig } from '../core/config.js';
import type { AuditLogService } from '../core/audit-log.js';
import type { AuditLogEntry, SessionState } from '../core/types.js';

const LOGGER = { info() {}, warn() {}, error() {} };

function makeConfig() {
  return parseConfig({
    enabled: true,
    supervisorModel: 'x/y',
    reviewMode: 'correct',
    courseCorrection: { deviationThreshold: 0.5, forceRegenerate: true, maxRegenerateAttempts: 3 },
  });
}

/** Mirrors index.ts `newSessionState()` — the real shape the hooks receive at runtime. */
function makeState(): SessionState {
  return {
    sessionId: 's1',
    researchGoal: 'Study X',
    targetConclusions: ['C1'],
    goalConfirmed: false,
    keyConclusions: [],
    userPreferences: [],
    methodologyDecisions: [],
    recentOutputs: [],
    recentSummaries: [],
    preCompactionMemory: [],
    regenerateAttempts: 0,
    regenerateHistory: [],
    lastLlmOutput: 'some drifted output',
    lastReviewReport: undefined,
  };
}

/** Drives the real analyze path with a stub reviewer: high deviation → correction queued. */
async function runAnalysis(): Promise<AuditLogEntry[]> {
  const entries: AuditLogEntry[] = [];
  const auditLog = { record: (e: AuditLogEntry) => { entries.push(e); return { ok: true }; } } as unknown as AuditLogService;
  const reviewer = {
    review: vi.fn()
      .mockResolvedValueOnce({ deviation: 0.9, memoryLoss: false, qualityScore: 0.4, courseCorrection: 'Refocus on X', summary: 'drifted' })
      .mockResolvedValueOnce({ correctionInstruction: 'Return to goal X', deviationSummary: 'off topic', requiredTopics: [], forbiddenTopics: [] }),
  };
  const cc = new CourseCorrector(makeConfig(), LOGGER, reviewer as never, auditLog);
  const state = makeState();
  cc.analyzeSession('s1', state);
  // analyzeSession is fire-and-forget; let both stubbed reviewer calls settle.
  await vi.waitFor(() => expect(entries.some((e) => e.type === 'force_regenerate')).toBe(true));
  return entries;
}

describe('course correction records only what it actually did', () => {
  it("a queued next-turn correction is never audited as action 'block'", async () => {
    const entries = await runAnalysis();
    const fr = entries.find((e) => e.type === 'force_regenerate')!;
    expect(fr.action).not.toBe('block'); // nothing was blocked — the output already shipped
    expect(fr.action).toBe('warn');
  });

  it('the audit details describe a next-turn instruction, not a completed correction', async () => {
    const entries = await runAnalysis();
    const fr = entries.find((e) => e.type === 'force_regenerate')!;
    expect(fr.details).toMatch(/next turn/i);
    expect(fr.details).not.toMatch(/triggered force regeneration/i);
    expect(fr.details).not.toMatch(/\bblocked\b/i);
  });

  it('the injected prompt never tells the model its output was blocked', () => {
    const cc = new CourseCorrector(makeConfig(), LOGGER, { review: vi.fn() } as never, { record: () => ({ ok: true }) } as unknown as AuditLogService);
    const state = makeState();
    state.pendingForceRegenerate = {
      deviationScore: 0.9,
      correctionInstruction: 'Return to goal X',
      originalOutputPreview: 'some deviated output',
    };
    const { prependContext } = cc.buildContextInjection(state);
    expect(prependContext).toBeDefined();
    expect(prependContext!).not.toMatch(/BLOCKED/i);
    // It must state the truth: the previous output already reached the user.
    expect(prependContext!).toMatch(/already been (delivered|sent)/i);
  });

  it('the session summary reports corrections as QUEUED, never as applied', () => {
    const cc = new CourseCorrector(makeConfig(), LOGGER, { review: vi.fn() } as never, { record: () => ({ ok: true }) } as unknown as AuditLogService);
    const state = makeState();
    state.regenerateAttempts = 3; // at the configured cap
    state.regenerateHistory = [{
      attempt: 1, timestamp: 1, deviationScore: 0.9,
      originalOutputPreview: 'x', correctionInstruction: 'y', result: 'correction_queued',
    }];
    const summary = cc.buildRegenerationSummary(state);
    expect(summary).toMatch(/queued for the following turn/i);
    expect(summary).toMatch(/Maximum course corrections reached/i);
    expect(summary).not.toMatch(/successfully corrected|✅ Corrected|Regenerating/i);
  });

  it('the reviewer prompt does not tell the reviewer the output was blocked or regenerated', () => {
    // This prompt is what makes the reviewer word `correctionInstruction`. If it says the
    // output "was blocked" / asks for guidance on "the regenerated output", the reviewer
    // writes instructions premised on a rewrite that never happens.
    expect(FORCE_REGENERATE_CORRECTION_PROMPT).not.toMatch(/was blocked|rejected by the supervisor|regenerated output/i);
    expect(FORCE_REGENERATE_CORRECTION_PROMPT).toMatch(/already (been )?delivered/i);
    expect(FORCE_REGENERATE_CORRECTION_PROMPT).toMatch(/next (turn|response)/i);
  });
});

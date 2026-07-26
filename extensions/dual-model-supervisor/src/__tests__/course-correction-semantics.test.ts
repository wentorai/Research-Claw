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
import { DEFAULT_CONFIG } from '../core/types.js';
import type { AuditLogEntry, SessionState } from '../core/types.js';

const LOGGER = { info() {}, warn() {}, error() {} };

function makeConfig(courseCorrection: Record<string, unknown> = {}) {
  return parseConfig({
    enabled: true,
    supervisorModel: 'x/y',
    reviewMode: 'correct',
    courseCorrection: { deviationThreshold: 0.5, forceRegenerate: true, maxRegenerateAttempts: 3, ...courseCorrection },
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

/**
 * Drives the real analyze path with a stub reviewer reporting `deviation`.
 *
 * `analyzeSession` is fire-and-forget, so the caller has to name the entry that means
 * "this run is finished" — and it differs by branch. Over threshold, the corrector records
 * `session_analysis` and then `force_regenerate`; under threshold it records only
 * `session_analysis` and returns (course-corrector.ts:103-112). Waiting on
 * `force_regenerate` in the under-threshold case would hang until the timeout and then
 * fail for the wrong reason, so the settle condition is a parameter rather than a constant.
 */
async function drive(
  settleOn: AuditLogEntry['type'],
  courseCorrection?: Record<string, unknown>,
  deviation = 0.9,
): Promise<AuditLogEntry[]> {
  const entries: AuditLogEntry[] = [];
  const auditLog = { record: (e: AuditLogEntry) => { entries.push(e); return { ok: true }; } } as unknown as AuditLogService;
  const reviewer = {
    review: vi.fn()
      .mockResolvedValueOnce({ deviation, memoryLoss: false, qualityScore: 0.4, courseCorrection: 'Refocus on X', summary: 'drifted' })
      .mockResolvedValueOnce({ correctionInstruction: 'Return to goal X', deviationSummary: 'off topic', requiredTopics: [], forbiddenTopics: [] }),
  };
  const cc = new CourseCorrector(makeConfig(courseCorrection), LOGGER, reviewer as never, auditLog);
  const state = makeState();
  cc.analyzeSession('s1', state);
  await vi.waitFor(() => expect(entries.some((e) => e.type === settleOn)).toBe(true));
  return entries;
}

/** Deviation over threshold: settles once the next-turn correction has been queued. */
function runAnalysis(courseCorrection?: Record<string, unknown>, deviation?: number): Promise<AuditLogEntry[]> {
  return drive('force_regenerate', courseCorrection, deviation);
}

/**
 * Deviation under threshold: settles on the analysis record, which is written on both
 * branches, so a `force_regenerate` that should not exist is still visible in the result
 * rather than being raced past.
 */
async function runAnalysisWithoutCorrection(courseCorrection?: Record<string, unknown>, deviation?: number): Promise<AuditLogEntry[]> {
  const entries = await drive('session_analysis', courseCorrection, deviation);
  // session_analysis is recorded first; give the (absent) correction a turn to land anyway,
  // so "no force_regenerate" means absent rather than not-yet-written.
  await new Promise((resolve) => setTimeout(resolve, 20));
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

/**
 * The threshold must not have a setting that silently switches correction off.
 *
 * `validateDeviationAnalysis` clamps the reviewer's `deviation` to [0,1] (validators.ts:214),
 * so with a strict `>` a threshold of exactly 1 can never be exceeded by anything: course
 * correction stops firing forever while the Dashboard still reports it enabled. That value
 * is not exotic — the Settings slider is `min=0 max=1 step=0.1` (SettingsPanel.tsx:2726-2733),
 * so one drag to the right end reaches it. Clamping the parser's range does not help here
 * and initially made it worse: `deviationThreshold: 99` (which the manifest permits, since
 * it declares a plain `number` whose description says "(0-1)" but carries no
 * `minimum`/`maximum`) clamps onto exactly that dead 1. The range and the comparison are
 * two separate obligations; only `>=` closes the second one.
 *
 * The NaN/Infinity cases below are defensive rather than reachable — JSON cannot express
 * either, and both callers of parseConfig get their input from JSON. They are tested
 * because NaN survives Math.min/Math.max unchanged and would reproduce the same dead
 * switch by a route the clamp alone does not cover.
 */
describe('course correction cannot be silently switched off by an unusable threshold', () => {
  it('still corrects at the top of the slider, where a strict > would never fire', async () => {
    // deviation is clamped to [0,1], so threshold 1 is only reachable by `>=`. This is the
    // whole-range liveness check: no setting the UI can produce may mean "never correct".
    const entries = await runAnalysis({ deviationThreshold: 1 }, 1);
    expect(entries.some((e) => e.type === 'session_analysis' && e.action === 'warn')).toBe(true);
    expect(entries.some((e) => e.type === 'force_regenerate')).toBe(true);
  });

  it('normalises an out-of-range threshold onto the documented range', () => {
    // The parser's job, and only that: 99 becomes the maximum legal threshold. It does not
    // by itself make 99 behave sensibly — the test above is what keeps that maximum live.
    expect(parseConfig({ courseCorrection: { deviationThreshold: 99 } }).courseCorrection.deviationThreshold).toBe(1);
    expect(parseConfig({ courseCorrection: { deviationThreshold: -1 } }).courseCorrection.deviationThreshold).toBe(0);
  });

  it('leaves a threshold above the deviation alone — no correction is queued', async () => {
    // Negative control with teeth: 0.95 is in range and really is above the 0.9 deviation,
    // so the correct behaviour is silence. A control set below 0.9 would take the same
    // branch as the case above and could not distinguish anything. This is also what stops
    // the `>=` fix from degenerating into "always correct".
    const entries = await runAnalysisWithoutCorrection({ deviationThreshold: 0.95 });
    expect(entries.some((e) => e.type === 'session_analysis' && e.action === 'info')).toBe(true);
    expect(entries.some((e) => e.type === 'force_regenerate')).toBe(false);
  });

  it('keeps NaN and Infinity out of the parsed threshold', () => {
    // Defensive: unreachable from JSON. `Math.min(1, Math.max(0, NaN))` is NaN, and
    // `x > NaN` is false for every x — the dead switch again, past the clamp.
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const v = parseConfig({ courseCorrection: { deviationThreshold: bad } }).courseCorrection.deviationThreshold;
      expect(Number.isFinite(v), `deviationThreshold ${String(bad)} produced ${String(v)}`).toBe(true);
    }
    expect(parseConfig({ courseCorrection: { deviationThreshold: Number.NaN } }).courseCorrection.deviationThreshold).toBe(
      DEFAULT_CONFIG.courseCorrection.deviationThreshold,
    );
  });

  it('keeps maxRegenerateAttempts a usable count, so the retry budget cannot be zeroed out', () => {
    // Reachable: the manifest does not declare this field at all, so `0` arrives intact
    // and `regenerateAttempts < 0` is false — force-regenerate would never fire.
    expect(parseConfig({ courseCorrection: { maxRegenerateAttempts: 0 } }).courseCorrection.maxRegenerateAttempts).toBe(1);
    expect(parseConfig({ courseCorrection: { maxRegenerateAttempts: -3 } }).courseCorrection.maxRegenerateAttempts).toBe(1);
    expect(parseConfig({ courseCorrection: { maxRegenerateAttempts: 5 } }).courseCorrection.maxRegenerateAttempts).toBe(5);
    // Defensive: `< NaN` is false and `< Infinity` is always true — never stops.
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const v = parseConfig({ courseCorrection: { maxRegenerateAttempts: bad } }).courseCorrection.maxRegenerateAttempts;
      expect(Number.isFinite(v), `maxRegenerateAttempts ${String(bad)} produced ${String(v)}`).toBe(true);
      expect(v).toBeGreaterThanOrEqual(1);
    }
  });
});

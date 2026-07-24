/**
 * P1-C — the SAFETY-CRITICAL `blocked` field is strictly gated; malformed → degrade,
 * never a silent pass. (Advisory fields — warnings/scores — are intentionally coerced,
 * NOT a full strict schema; only the block/pass decision is hard-validated.)
 *
 * The reviewer returns JSON. The consumers (tool-reviewer / output-reviewer) key
 * their block/pass decision on `blocked`. A coercing validator that turns any
 * malformed object into `{ blocked: false }` makes schema drift / missing fields
 * read as "not blocked" — a silent fail-open with no observable degrade. So a missing
 * or wrong-typed `blocked` returns null and the consumer records a degrade audit
 * (distinguishing reviewer-unavailable from schema-invalid) and fails open only
 * with visibility. A reviewer BLOCK must never be silently dropped, so `blocked:true`
 * without a reason is still honored as a block (synthesized reason). Cross-field
 * coherence: `corrected:true` is demoted to false unless a `correctedVersion` is present.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { validateToolReviewResult, validateReviewResult } from '../core/validators.js';
import { loadPluginFresh } from './harness/plugin-harness.js';

describe('P1-C strict validateToolReviewResult', () => {
  it('rejects {} (missing blocked) → null, not a coerced not-blocked pass', () => {
    expect(validateToolReviewResult({}, [])).toBeNull();
  });
  it('rejects wrong-typed blocked → null', () => {
    expect(validateToolReviewResult({ blocked: 'yes' }, [])).toBeNull();
    expect(validateToolReviewResult({ blocked: 1 }, [])).toBeNull();
    expect(validateToolReviewResult({ blocked: [] }, [])).toBeNull();
  });
  it('rejects non-object (array / null / string) → null', () => {
    expect(validateToolReviewResult([], [])).toBeNull();
    expect(validateToolReviewResult(null, [])).toBeNull();
    expect(validateToolReviewResult('blocked', [])).toBeNull();
  });
  it('accepts a clean not-blocked result', () => {
    const r = validateToolReviewResult({ blocked: false, warnings: ['x'] }, []);
    expect(r).not.toBeNull();
    expect(r!.blocked).toBe(false);
  });
  it('honors blocked:true even without a reason (never fail-open a block)', () => {
    const r = validateToolReviewResult({ blocked: true }, []);
    expect(r).not.toBeNull();
    expect(r!.blocked).toBe(true);
    expect(typeof r!.blockReason).toBe('string');
    expect(r!.blockReason!.length).toBeGreaterThan(0);
  });
  it('still filters correctedParams to a subset of original keys', () => {
    const r = validateToolReviewResult({ blocked: false, correctedParams: { a: 1, evil: 2 } }, ['a']);
    expect(r!.correctedParams).toEqual({ a: 1 });
  });
});

describe('P1-C strict validateReviewResult', () => {
  it('rejects {} (missing blocked) → null', () => {
    expect(validateReviewResult({})).toBeNull();
  });
  it('rejects wrong-typed blocked → null', () => {
    expect(validateReviewResult({ blocked: 'no' })).toBeNull();
  });
  it('accepts a clean result', () => {
    const r = validateReviewResult({ blocked: false, qualityScore: 0.9 });
    expect(r).not.toBeNull();
    expect(r!.blocked).toBe(false);
  });
});

// Integration: a malformed reviewer response for a high-risk tool must produce
// an OBSERVABLE degrade audit — not a silent pass.
const CONFIG = {
  enabled: true,
  supervisorModel: 'testprov/testmodel',
  reviewMode: 'correct',
  highRiskTools: ['exec'],
  providers: {
    testprov: {
      api: 'openai-completions',
      baseUrl: 'http://mock.local/v1/chat/completions',
      apiKey: 'k',
      models: [{ id: 'testmodel', maxTokens: 1000 }],
    },
  },
};

interface LogEntry { type: string; action: string; details: string }

const origFetch = globalThis.fetch;
/** Reviewer that responds with a MALFORMED body (`{}` — missing `blocked`). */
function installMalformedReviewer() {
  (globalThis as { fetch: unknown }).fetch = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content: '{}' } }] }),
    text: async () => '',
  }));
}

describe('P1-C tool review degrade audit on malformed reviewer response', () => {
  beforeEach(() => installMalformedReviewer());
  afterEach(() => {
    (globalThis as { fetch: unknown }).fetch = origFetch;
    vi.restoreAllMocks();
  });

  it('records a schema_invalid degrade audit (not a silent pass) for a high-risk tool', async () => {
    const h = await loadPluginFresh(CONFIG);
    // benign exec (passes quick-check) → reaches the deep reviewer → malformed body
    const result = await h.fire(
      'before_tool_call',
      { toolName: 'exec', params: { command: 'ls -la' } },
      { sessionKey: 'agent:main:skA', sessionId: 'skA', toolName: 'exec' },
    );
    // fail-open (not blocked) is acceptable for high-risk-but-not-determined-danger…
    expect((result as { block?: boolean }).block ?? false).toBe(false);
    // …but it MUST be observable as a degrade, and must NOT be recorded as a pass.
    const log = (await h.rpc.get('rc.supervisor.log')!({ type: 'tool_review', limit: 20 })) as { entries: LogEntry[] };
    const degraded = log.entries.some((e) => /degrad|schema_invalid|unavailable/i.test(e.details));
    expect(degraded).toBe(true);
    expect(log.entries.some((e) => /passed deep review|passed/i.test(e.details))).toBe(false);
  });
});

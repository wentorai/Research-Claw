/**
 * P2 grounding — Unicode titles (P2-B), privacy networkPolicy (P2-D),
 * in-flight dedup + cleanup (P2-A), and the existence verdict branches.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  extractCitations,
  normTitle,
  titleMatches,
  checkExistence,
  inflightCount,
  GroundingChecker,
  extractReferenceLines,
  isLikelyCleanTitle,
} from '../hooks/grounding-checker.js';
import { parseConfig } from '../core/config.js';
import type { AuditLogService } from '../core/audit-log.js';
import type { SessionState } from '../core/types.js';

// ── P2-B: Unicode / CJK title matching ───────────────────────────────
describe('P2-B normTitle / titleMatches (Unicode-safe)', () => {
  it('does NOT strip non-ASCII: a Chinese title survives normalization', () => {
    expect(normTitle('深度学习研究综述').length).toBeGreaterThan(0);
  });
  it('matches identical Chinese titles', () => {
    expect(titleMatches('深度学习研究综述', '深度学习研究综述')).toBe(true);
  });
  it('folds full-width punctuation / spacing (NFKC)', () => {
    expect(titleMatches('深度学习：综述', '深度学习 综述')).toBe(true);
  });
  it('does NOT make different Chinese titles match (no CJK containment over-match)', () => {
    expect(titleMatches('机器学习导论', '深度学习研究综述')).toBe(false);
    expect(titleMatches('学习', '深度学习研究综述')).toBe(false); // short substring must not match
  });
  it('English still works: exact + token-overlap, and rejects unrelated', () => {
    expect(titleMatches('Deep Learning', 'deep learning')).toBe(true);
    expect(titleMatches('Attention Is All You Need', 'Attention is all you need!')).toBe(true);
    expect(titleMatches('Deep Learning', 'Reinforcement Learning')).toBe(false);
  });
});

describe('extractCitations', () => {
  it('extracts DOI, labeled arXiv, and reference titles', () => {
    expect(extractCitations('see 10.1038/nature14539')[0].doi).toBe('10.1038/nature14539');
    expect(extractCitations('arXiv:1706.03762 rocks')[0].arxivId).toBe('1706.03762');
    expect(extractCitations('', ['Attention Is All You Need']).some((c) => c.title === 'Attention Is All You Need')).toBe(true);
  });
});

// ── fetch mock ───────────────────────────────────────────────────────
const origFetch = globalThis.fetch;
function mockFetch(route: (url: string) => { status?: number; json?: unknown; throw?: boolean }) {
  const fn = vi.fn(async (url: string) => {
    const r = route(String(url));
    if (r.throw) throw new Error('neterr');
    const status = r.status ?? 200;
    return { ok: status >= 200 && status < 300, status, json: async () => r.json ?? null };
  });
  (globalThis as { fetch: unknown }).fetch = fn;
  return fn;
}

describe('P2-D checkExistence privacy networkPolicy', () => {
  afterEach(() => { (globalThis as { fetch: unknown }).fetch = origFetch; vi.restoreAllMocks(); });

  it("'off' makes ZERO external requests and returns unverifiable (local-only)", async () => {
    const fetchFn = mockFetch(() => ({ status: 200, json: { id: 'W' } }));
    const r = await checkExistence({ raw: 'x', doi: '10.1/x', title: 'T' }, { networkPolicy: 'off' });
    expect(r.verdict).toBe('unverifiable');
    expect(r.via).toBe('local-only');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("'identifiers-only' never sends the title to a title-search endpoint", async () => {
    const fetchFn = mockFetch((url) => (url.includes('works/doi:') ? { status: 404 } : { status: 404 }));
    await checkExistence({ raw: 'x', doi: '10.9/x', title: 'Unpublished Secret Title' }, { networkPolicy: 'identifiers-only' });
    const calledUrls = fetchFn.mock.calls.map((c) => String(c[0]));
    expect(calledUrls.some((u) => u.includes('title.search'))).toBe(false);
    expect(calledUrls.some((u) => u.includes('Unpublished'))).toBe(false);
  });

  it("'full' allows the title-search endpoint", async () => {
    const fetchFn = mockFetch((url) => {
      if (url.includes('works/doi:')) return { status: 404 };
      if (url.includes('title.search')) return { status: 200, json: { results: [{ title: 'Attention Is All You Need' }] } };
      return { status: 404 };
    });
    const r = await checkExistence({ raw: 'x', doi: '10.5/x', title: 'Attention Is All You Need' }, { networkPolicy: 'full' });
    expect(r.verdict).toBe('exists');
    expect(r.via).toBe('openalex_title');
    expect(fetchFn.mock.calls.some((c) => String(c[0]).includes('title.search'))).toBe(true);
  });
});

// ── H4-c: findings must carry per-registry sources + normalized identity ──
describe('P2 (reopened) grounding finding completeness', () => {
  afterEach(() => { (globalThis as { fetch: unknown }).fetch = origFetch; vi.restoreAllMocks(); });
  const logger = { info() {}, warn() {}, error() {} };
  const auditLog = { record() {} } as unknown as AuditLogService;
  function makeChecker(networkPolicy: 'off' | 'identifiers-only' | 'full') {
    const cfg = parseConfig({ enabled: true, supervisorModel: 'x/y', reviewMode: 'correct', grounding: { networkPolicy, verdictMode: 'flag' } });
    return new GroundingChecker(cfg, logger, auditLog);
  }
  const emptyState = () => ({ groundingFindings: [] } as unknown as SessionState);

  it('a finding carries per-registry sources + normalized identity (token grammar only, no response body)', async () => {
    mockFetch(() => ({ status: 404 })); // every registry cleanly misses
    const findings = await makeChecker('identifiers-only').runCheck('builds on 10.5555/abc', 's', [], emptyState());
    expect(findings).toHaveLength(1);
    expect(findings[0].sources).toBeDefined();
    expect(Object.keys(findings[0].sources!).length).toBeGreaterThan(0); // registries were consulted → recorded
    for (const v of Object.values(findings[0].sources!)) expect(v).toMatch(/^(hit|miss|err)/); // never a leaked body
    expect(findings[0].identity?.doi).toBe('10.5555/abc'); // normalized identity carried
  });

  it("networkPolicy 'off' yields a defined (empty) sources object, never undefined", async () => {
    const findings = await makeChecker('off').runCheck('builds on 10.5555/abc', 's', [], emptyState());
    expect(findings[0].sources).toBeDefined();
  });
});

// ── H3: the CURRENT turn's title-only citations (in a References section) must be
// verified, not silently skipped as if the turn cited nothing. ──
describe('P2 (reopened) current-turn title-only citations', () => {
  afterEach(() => { (globalThis as { fetch: unknown }).fetch = origFetch; vi.restoreAllMocks(); });
  const logger = { info() {}, warn() {}, error() {} };
  const auditLog = { record() {} } as unknown as AuditLogService;
  function makeChecker(networkPolicy: 'off' | 'identifiers-only' | 'full') {
    const cfg = parseConfig({ enabled: true, supervisorModel: 'x/y', reviewMode: 'correct', grounding: { networkPolicy, verdictMode: 'flag' } });
    return new GroundingChecker(cfg, logger, auditLog);
  }
  const emptyState = () => ({ groundingFindings: [] } as unknown as SessionState);

  const OUTPUT = [
    'Our method builds on prior work in representation learning.',
    '',
    'References',
    '- Deep Residual Learning for Image Recognition',
  ].join('\n');

  it('extracts + checks a title-only citation from THIS turn (fresh session, no prior refs)', async () => {
    mockFetch(() => ({ status: 404 })); // title-search misses
    // priorRefs is EMPTY (async summary has not pushed the current turn yet).
    const findings = await makeChecker('full').runCheck(OUTPUT, 's', [], emptyState());
    expect(findings.length).toBeGreaterThan(0); // the current-turn title was verified, not skipped
    expect(findings.some((f) => f.raw.includes('Deep Residual Learning'))).toBe(true);
  });

  it('extractReferenceLines pulls entries from a References section (stripping list markers)', () => {
    const lines = extractReferenceLines('intro\n\nReferences\n1. Attention Is All You Need\n- Some Other Paper Title Here');
    expect(lines).toContain('Attention Is All You Need');
    expect(lines).toContain('Some Other Paper Title Here');
    // free prose before the heading is NOT harvested
    expect(lines.some((l) => l.includes('intro'))).toBe(false);
  });

  // SAFETY (core invariant): a real paper's bibliographic line must NEVER be flagged
  // as fabricated. Raw biblio lines (author+year+journal) are too noisy to title-search,
  // so they must be represented as UNVERIFIABLE, never not_found.
  it('does NOT false-flag a real paper: a bibliographic reference line under full is unverifiable, never not_found', async () => {
    mockFetch(() => ({ status: 404 })); // title-search (if it ran) would miss → not_found
    const output = 'Our method.\n\nReferences\n- Smith, J., & LeCun, Y. (2020). Deep learning for science. Nature, 521, 436-444.';
    const findings = await makeChecker('full').runCheck(output, 's', [], emptyState());
    expect(findings.length).toBeGreaterThan(0);
    for (const f of findings) expect(f.verdict).not.toBe('not_found'); // never accuse a real paper
  });

  it('detects a bold-markdown **References** heading', () => {
    const lines = extractReferenceLines('**References**\n1. Deep Residual Learning for Image Recognition');
    expect(lines.some((l) => l.includes('Deep Residual Learning'))).toBe(true);
  });

  it('does NOT harvest trailing non-reference prose after the section (marker required)', () => {
    const lines = extractReferenceLines('References\n- Deep Residual Learning for Image Recognition\n\nNote: all papers were accessed in January 2024 via institutional access.');
    expect(lines.some((l) => l.includes('Deep Residual Learning'))).toBe(true);
    expect(lines.some((l) => l.includes('Note:'))).toBe(false); // trailing prose (no list marker) not harvested
  });

  // H3 priorRefs: a summary reference (passed as priorRefs) that is a RAW bibliographic
  // line must NOT be title-searched — that false-flags a real paper as not_found.
  it('does NOT false-flag a real paper cited via priorRefs (raw biblio line stays unverifiable)', async () => {
    mockFetch(() => ({ status: 404 })); // title-search (if it ran) would miss → not_found
    const priorRefs = ['Vaswani, A. et al. (2017). Attention Is All You Need. NeurIPS, 30, 5998-6008.'];
    const findings = await makeChecker('full').runCheck('Our work builds on prior art.', 's', priorRefs, emptyState());
    expect(findings.length).toBeGreaterThan(0);
    for (const f of findings) expect(f.verdict).not.toBe('not_found'); // never accuse a real paper
  });

  it('a reliably-CLEAN title in priorRefs IS still title-searched (not over-suppressed)', async () => {
    const fetchFn = mockFetch((url) => (url.includes('title.search') ? { status: 200, json: { results: [{ title: 'Attention Is All You Need' }] } } : { status: 404 }));
    const findings = await makeChecker('full').runCheck('builds on prior art.', 's', ['Attention Is All You Need'], emptyState());
    expect(findings.some((f) => f.verdict === 'exists')).toBe(true); // clean title verified online
    expect(fetchFn.mock.calls.some((c) => String(c[0]).includes('title.search'))).toBe(true);
  });

  it('isLikelyCleanTitle: clean titles pass, bibliographic lines are rejected', () => {
    expect(isLikelyCleanTitle('Attention Is All You Need')).toBe(true);
    expect(isLikelyCleanTitle('Deep Residual Learning for Image Recognition')).toBe(true);
    expect(isLikelyCleanTitle('Vaswani, A. et al. (2017). Attention Is All You Need. NeurIPS, 30, 5998-6008.')).toBe(false);
    expect(isLikelyCleanTitle('Smith, J. (2020). Deep learning. Nature, 521, 436-444.')).toBe(false);
    expect(isLikelyCleanTitle('see https://example.com/paper')).toBe(false);
  });

  it('a title-only finding carries a non-empty identity (normTitle from raw), never {}', async () => {
    mockFetch(() => ({ status: 404 }));
    const findings = await makeChecker('identifiers-only').runCheck('References\n- Deep Residual Learning for Image Recognition', 's', [], emptyState());
    const f = findings.find((x) => x.raw.includes('Deep Residual'))!;
    expect(f.identity).toBeDefined();
    expect(f.identity!.normTitle && f.identity!.normTitle.length > 0).toBe(true); // never an empty identity
  });
});

describe('checkExistence verdict branches (identifiers-only)', () => {
  afterEach(() => { (globalThis as { fetch: unknown }).fetch = origFetch; vi.restoreAllMocks(); });

  it('exists when OpenAlex DOI resolves', async () => {
    mockFetch((url) => (url.includes('openalex.org/works/doi:') ? { status: 200, json: { id: 'W' } } : { status: 404 }));
    expect((await checkExistence({ raw: 'x', doi: '10.1/x' }, { networkPolicy: 'identifiers-only' })).verdict).toBe('exists');
  });
  it('not_found when all sources cleanly miss', async () => {
    mockFetch(() => ({ status: 404 }));
    expect((await checkExistence({ raw: 'x', doi: '10.9/fake' }, { networkPolicy: 'identifiers-only' })).verdict).toBe('not_found');
  });
  it('unverifiable (never false-flag) when a source errors', async () => {
    mockFetch((url) => (url.includes('openalex') ? { throw: true } : { status: 404 }));
    expect((await checkExistence({ raw: 'x', doi: '10.1/x' }, { networkPolicy: 'identifiers-only' })).verdict).toBe('unverifiable');
  });
});

// ── P2-A: in-flight dedup + cleanup ──────────────────────────────────
describe('P2-A grounding in-flight dedup', () => {
  afterEach(() => { (globalThis as { fetch: unknown }).fetch = origFetch; vi.restoreAllMocks(); });

  it('concurrent checks of the same DOI issue exactly ONE external lookup, and clean up', async () => {
    let resolveFirst: (() => void) | null = null;
    const gate = new Promise<void>((res) => { resolveFirst = () => res(); });
    let calls = 0;
    (globalThis as { fetch: unknown }).fetch = vi.fn(async (url: string) => {
      calls++;
      await gate; // hold the first (and only) lookup open so both callers overlap
      return { ok: String(url).includes('doi:'), status: String(url).includes('doi:') ? 200 : 404, json: async () => ({ id: 'W' }) };
    });

    const doi = { raw: 'd', doi: '10.1234/shared' };
    const p1 = checkExistence(doi, { networkPolicy: 'identifiers-only' });
    const p2 = checkExistence(doi, { networkPolicy: 'identifiers-only' });
    expect(inflightCount()).toBe(1); // both share one in-flight lookup
    resolveFirst!();
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.verdict).toBe('exists');
    expect(r2.verdict).toBe('exists');
    expect(calls).toBe(1); // only ONE external lookup for the concurrent pair
    expect(inflightCount()).toBe(0); // cleaned up after settle
  });

  it('clears the in-flight entry even when the lookup errors (no permanent lock)', async () => {
    (globalThis as { fetch: unknown }).fetch = vi.fn(async () => { throw new Error('boom'); });
    await checkExistence({ raw: 'e', doi: '10.1/err' }, { networkPolicy: 'identifiers-only' });
    expect(inflightCount()).toBe(0);
    // a subsequent retry is not blocked by a stale lock
    const r = await checkExistence({ raw: 'e', doi: '10.1/err' }, { networkPolicy: 'identifiers-only' });
    expect(r.verdict).toBe('unverifiable');
  });
});

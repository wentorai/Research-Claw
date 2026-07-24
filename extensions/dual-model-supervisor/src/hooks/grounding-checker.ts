/**
 * Dual Model Supervisor — Grounding Checker (citation existence verification).
 *
 * Detects fabricated citations by verifying each cited paper's EXISTENCE against
 * free registries (OpenAlex / CrossRef / arXiv). Deterministic (no LLM). A
 * citation EXISTS if any registry confirms it, NOT_FOUND only if all cleanly
 * miss, UNVERIFIABLE if any source errors (never false-flag a real paper).
 *
 * P2 hardening baked in:
 *  - Privacy (networkPolicy): default 'off' → ZERO external requests
 *    (unverifiable/local-only). 'identifiers-only' sends only DOI/arXiv ids;
 *    'full' additionally allows title-search (may reveal unpublished titles).
 *  - Unicode/CJK titles: normalization keeps letters/numbers of ALL scripts
 *    (\p{L}\p{N}), so Chinese titles match instead of collapsing to empty.
 *  - In-flight dedup: concurrent checks of the same identifier share ONE
 *    external lookup; the in-flight entry is cleared on success/miss/error/timeout.
 *  - never-block: `check()` is fire-and-forget and never throws.
 */

import type {
  AuditLogEntry,
  GroundingFinding,
  GroundingVerdict,
  PluginLogger,
  SessionState,
  SupervisorConfig,
} from '../core/types.js';
import { AuditLogService } from '../core/audit-log.js';

export interface Citation {
  raw: string; // Token as it appeared (dedup key + display)
  doi?: string;
  arxivId?: string;
  title?: string;
}

export type GroundingNetworkPolicy = SupervisorConfig['grounding']['networkPolicy'];

export interface ExistenceResult {
  verdict: GroundingVerdict;
  via?: string;
  sources?: Record<string, string>;
}

const DEFAULT_GROUNDING_TIMEOUT_MS = 20_000;
const UA = 'wentor-research-claw-supervisor/0.2 (mailto:research@wentor.ai)';
const MAX_FINDINGS = 50;
const MAX_CITATIONS_PER_OUTPUT = 25;
const MIN_TITLE_LEN = 12;

const DOI_RE = /\b10\.\d{4,9}\/[-._;()/:a-z0-9]+/gi;
const ARXIV_LABELED_RE = /\barxiv:\s*(\d{4}\.\d{4,5})(v\d+)?/gi;

function cleanDoi(doi: string): string {
  return doi.replace(/[.,;)\]]+$/, '');
}

/**
 * Extract citations: structured ids (DOI / arXiv) from the raw text, plus bare
 * titles from the `references` list (never guessed out of free prose). Deduped.
 */
export function extractCitations(text: string, references: string[] = []): Citation[] {
  const out: Citation[] = [];
  const seen = new Set<string>();

  const push = (c: Citation): void => {
    const key = c.raw.toLowerCase().trim();
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(c);
  };

  const scanIds = (src: string, title?: string): boolean => {
    let found = false;
    DOI_RE.lastIndex = 0;
    for (let m = DOI_RE.exec(src); m; m = DOI_RE.exec(src)) {
      const doi = cleanDoi(m[0]);
      push({ raw: doi, doi, title });
      found = true;
    }
    ARXIV_LABELED_RE.lastIndex = 0;
    for (let m = ARXIV_LABELED_RE.exec(src); m; m = ARXIV_LABELED_RE.exec(src)) {
      push({ raw: m[0], arxivId: m[1], title });
      found = true;
    }
    return found;
  };

  if (text) scanIds(text);
  for (const ref of references) {
    const r = (ref ?? '').trim();
    if (!r) continue;
    const hadId = scanIds(r, r);
    if (!hadId && r.length >= MIN_TITLE_LEN) push({ raw: r, title: r });
  }
  return out;
}

// ── Title normalization (Unicode/CJK safe) ───────────────────────────

/**
 * Normalize a title for comparison. Unicode-aware: NFKC folds full-width forms,
 * then everything EXCEPT letters/numbers (any script) and spaces is collapsed to
 * a space. Critically does NOT strip non-ASCII, so CJK titles survive.
 */
export function normTitle(t: string): string {
  return (t || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N} ]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Fuzzy title match, robust for both space-delimited (English) and
 * non-space-delimited (CJK) scripts, without making all short CJK titles match:
 *  - exact normalized equality, OR
 *  - containment where the shorter is ≥60% of the longer (avoids "学习" ⊂ "深度学习"), OR
 *  - ≥0.8 token (space) overlap when BOTH sides are genuinely multi-token.
 */
export function titleMatches(a: string, b: string): boolean {
  const na = normTitle(a);
  const nb = normTitle(b);
  if (!na || !nb) return false;
  if (na === nb) return true;

  const shorter = na.length <= nb.length ? na : nb;
  const longer = na.length <= nb.length ? nb : na;
  if (longer.includes(shorter) && shorter.length / longer.length >= 0.6) return true;

  const ta = na.split(' ').filter(Boolean);
  const tb = nb.split(' ').filter(Boolean);
  if (ta.length >= 2 && tb.length >= 2) {
    const sa = new Set(ta);
    const sb = new Set(tb);
    const inter = [...sa].filter((w) => sb.has(w)).length;
    if (inter / Math.max(sa.size, sb.size) >= 0.8) return true;
  }
  return false;
}

// ── Registry fetch helpers ───────────────────────────────────────────

interface JsonResult { ok: boolean; status?: number; json?: unknown; err?: string }
interface StatusResult { ok: boolean; status?: number; err?: string }

async function getJson(url: string, timeoutMs: number): Promise<JsonResult> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 404) return { ok: true, status: 404, json: null };
    if (!res.ok) return { ok: false, status: res.status };
    return { ok: true, status: 200, json: await res.json() };
  } catch (e) {
    return { ok: false, err: String(e).slice(0, 80) };
  }
}

async function getStatus(url: string, timeoutMs: number): Promise<StatusResult> {
  try {
    const res = await fetch(url, { method: 'GET', headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(timeoutMs) });
    return { ok: true, status: res.status };
  } catch (e) {
    return { ok: false, err: String(e).slice(0, 80) };
  }
}

// ── Existence check with privacy gating + in-flight dedup ────────────

/** In-flight existence lookups keyed by identifier — shared across sessions
 *  (existence is a public registry fact; no session data is shared here). */
const _inflight = new Map<string, Promise<ExistenceResult>>();

function dedupeKey(c: Citation, policy: GroundingNetworkPolicy): string {
  return `${policy}::${c.doi ?? c.arxivId ?? normTitle(c.title ?? c.raw)}`;
}

/**
 * Multi-source existence check. Respects `networkPolicy`:
 *  - 'off'              → no fetch; unverifiable (local-only).
 *  - 'identifiers-only' → DOI + arXiv id lookups only (NO title search).
 *  - 'full'             → also OpenAlex title search.
 * Concurrent calls for the same identifier share one lookup (in-flight dedup).
 */
export async function checkExistence(
  c: Citation,
  opts?: { timeoutMs?: number; networkPolicy?: GroundingNetworkPolicy },
): Promise<ExistenceResult> {
  const policy: GroundingNetworkPolicy = opts?.networkPolicy ?? 'off';
  if (policy === 'off') {
    return { verdict: 'unverifiable', via: 'local-only', sources: {} };
  }

  const key = dedupeKey(c, policy);
  const existing = _inflight.get(key);
  if (existing) return existing;

  const run = doCheckExistence(c, policy, opts?.timeoutMs ?? DEFAULT_GROUNDING_TIMEOUT_MS)
    .finally(() => { _inflight.delete(key); }); // cleanup on success/miss/error/timeout
  _inflight.set(key, run);
  return run;
}

async function doCheckExistence(c: Citation, policy: GroundingNetworkPolicy, timeoutMs: number): Promise<ExistenceResult> {
  const sources: Record<string, string> = {};

  if (c.doi) {
    const r = await getJson(`https://api.openalex.org/works/doi:${encodeURIComponent(c.doi)}`, timeoutMs);
    sources.openalex_doi = r.ok ? (r.status === 200 ? 'hit' : 'miss') : `err:${r.status ?? r.err}`;
    if (r.ok && r.status === 200) return { verdict: 'exists', via: 'openalex_doi', sources };
  }

  // Title search sends the TITLE externally — only under explicit 'full' opt-in.
  if (c.title && policy === 'full') {
    const r = await getJson(
      `https://api.openalex.org/works?filter=title.search:${encodeURIComponent(c.title)}&per-page=5`,
      timeoutMs,
    );
    const results = (r.json as { results?: Array<{ title?: string; display_name?: string }> } | undefined)?.results;
    if (r.ok && results?.length) {
      const hit = results.some((w) => titleMatches(c.title!, w.title || w.display_name || ''));
      sources.openalex_title = hit ? 'hit' : 'miss';
      if (hit) return { verdict: 'exists', via: 'openalex_title', sources };
    } else {
      sources.openalex_title = r.ok ? 'miss' : `err:${r.err ?? r.status}`;
    }
  }

  if (c.doi) {
    const r = await getStatus(`https://api.crossref.org/works/${encodeURIComponent(c.doi)}`, timeoutMs);
    sources.crossref_doi = r.ok ? (r.status === 200 ? 'hit' : 'miss') : `err:${r.err}`;
    if (r.ok && r.status === 200) return { verdict: 'exists', via: 'crossref_doi', sources };
  }

  if (c.arxivId) {
    const r = await getStatus(`https://arxiv.org/abs/${encodeURIComponent(c.arxivId)}`, timeoutMs);
    sources.arxiv = r.ok ? (r.status === 200 ? 'hit' : 'miss') : `err:${r.err}`;
    if (r.ok && r.status === 200) return { verdict: 'exists', via: 'arxiv', sources };
  }

  // A citation with ONLY a title and no external title search possible
  // (identifiers-only) can't be verified → unverifiable, not not_found.
  if (!c.doi && !c.arxivId && Object.keys(sources).length === 0) {
    return { verdict: 'unverifiable', via: 'no-identifier', sources };
  }

  const anyErr = Object.values(sources).some((v) => v.startsWith('err'));
  return { verdict: anyErr ? 'unverifiable' : 'not_found', sources };
}

/** Testing/lifecycle aid: number of in-flight external lookups (should return to 0). */
export function inflightCount(): number {
  return _inflight.size;
}

// ── GroundingChecker (llm_output wiring) ─────────────────────────────

export class GroundingChecker {
  private config: SupervisorConfig;
  private logger: PluginLogger;
  private auditLog: AuditLogService;

  constructor(config: SupervisorConfig, logger: PluginLogger, auditLog: AuditLogService) {
    this.config = config;
    this.logger = logger;
    this.auditLog = auditLog;
  }

  updateConfig(config: SupervisorConfig): void {
    this.config = config;
  }

  /** Fire-and-forget entry point. Never blocks, never throws. Automatic grounding
   *  runs only when the network policy opts in ('off' = no automatic external work). */
  check(output: string, sessionId: string, references: string[], sessionState: SessionState): void {
    if (this.config.grounding.networkPolicy === 'off') return;
    this.runCheck(output, sessionId, references, sessionState).catch((err) => {
      this.logger.error(`[Supervisor] grounding check failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  /** Awaitable worker. Returns the fresh findings verified this call. Never throws. */
  async runCheck(output: string, sessionId: string, references: string[], sessionState: SessionState): Promise<GroundingFinding[]> {
    try {
      const citations = extractCitations(output, references);
      if (!citations.length) return [];

      const already = new Set((sessionState.groundingFindings ?? []).map((f) => f.raw.toLowerCase()));
      const fresh = citations
        .filter((c) => !already.has(c.raw.toLowerCase()))
        .slice(0, MAX_CITATIONS_PER_OUTPUT);
      if (!fresh.length) return [];

      const findings = await Promise.all(fresh.map((c) => this.checkOne(c, sessionId)));
      const merged = [...(sessionState.groundingFindings ?? []), ...findings];
      sessionState.groundingFindings = merged.slice(-MAX_FINDINGS);
      return findings;
    } catch (err) {
      this.logger.error(`[Supervisor] grounding runCheck error: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  private async checkOne(c: Citation, sessionId: string): Promise<GroundingFinding> {
    let result: ExistenceResult;
    try {
      result = await checkExistence(c, { networkPolicy: this.config.grounding.networkPolicy });
    } catch {
      result = { verdict: 'unverifiable' };
    }
    const verdict = this.applyVerdictMode(result.verdict);
    const action: AuditLogEntry['action'] = verdict === 'not_found' ? 'warn' : 'info';

    this.auditLog.record({
      sessionId,
      type: 'grounding',
      action,
      details: `${verdict}: ${c.raw}${result.via ? ` via ${result.via}` : ''}`,
      metadata: JSON.stringify({ raw: c.raw, doi: c.doi, arxivId: c.arxivId, verdict, via: result.via, sources: result.sources }),
      timestamp: Date.now(),
    });
    // Carry per-registry outcomes + normalized identity onto the finding itself, so a
    // PERSISTED review record is auditable (hit/miss/err per registry) without leaking
    // any response body. `sources` is always an object (empty when networkPolicy='off').
    return {
      raw: c.raw,
      verdict,
      via: result.via,
      sources: result.sources ?? {},
      identity: { doi: c.doi, arxivId: c.arxivId, normTitle: c.title ? normTitle(c.title) : undefined },
    };
  }

  /** In 'info' mode never assert fabrication: soften not_found → unverifiable. */
  private applyVerdictMode(v: GroundingVerdict): GroundingVerdict {
    if (this.config.grounding.verdictMode === 'info' && v === 'not_found') return 'unverifiable';
    return v;
  }
}

import type { PaperReview } from '../gateway/paper-review-types';

export type ReviewEvidenceSufficiency = 'sufficient' | 'partial' | 'not_found';

export interface PaperReviewBrief {
  summary: string | null;
  score: number | null;
  confidence: string | null;
  verdict: string | null;
  topRejectReason: string | null;
  evidenceSufficiency: ReviewEvidenceSufficiency | null;
  evidenceSufficiencyDetail: string | null;
}

function extractSection(markdown: string, heading: string): string | null {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const untilNext = new RegExp(
    `^#\\s*${escaped}\\s*\\n+([\\s\\S]*?)(?=\\n#\\s)`,
    'im',
  );
  const untilEnd = new RegExp(
    `^#\\s*${escaped}\\s*\\n+([\\s\\S]*)$`,
    'im',
  );
  const match = markdown.match(untilNext) ?? markdown.match(untilEnd);
  if (!match) return null;
  const text = match[1].trim();
  return text || null;
}

export function parseReviewScore(text: string | null | undefined): number | null {
  if (!text) return null;
  const match = text.match(/(\d+(?:\.\d+)?)\s*(?:\/\s*10)?/);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value < 1 || value > 10) return null;
  return value;
}

/** Parse Evidence Sufficiency status from report section body. */
export function parseEvidenceSufficiencyStatus(text: string | null | undefined): ReviewEvidenceSufficiency | null {
  if (!text?.trim()) return null;
  const firstLine = text.trim().split('\n')[0].trim().toLowerCase();
  if (/^not[_\s-]?found\b|^not found\b|文中未找到|证据不足/.test(firstLine)) return 'not_found';
  if (/^partial\b|^部分/.test(firstLine)) return 'partial';
  if (/^sufficient\b|^充分\b|^足够/.test(firstLine)) return 'sufficient';
  return null;
}

/** Fields synced to rc.review.update after Dashboard merges staged outputs. */
export function parseReviewSyncFieldsFromReport(markdown: string): {
  summary: string | null;
  strengths: string | null;
  weaknesses: string | null;
  suggestions: string | null;
  overall_score: number | null;
} {
  return {
    summary: extractSection(markdown, 'Summary'),
    strengths: extractSection(markdown, 'Strengths'),
    weaknesses: extractSection(markdown, 'Weaknesses'),
    suggestions: extractSection(markdown, 'Questions For Authors'),
    overall_score: parseReviewScore(extractSection(markdown, 'Final Score (1-10)')),
  };
}

export function buildPaperReviewBrief(review: PaperReview | null | undefined): PaperReviewBrief {
  if (!review) {
    return {
      summary: null,
      score: null,
      confidence: null,
      verdict: null,
      topRejectReason: null,
      evidenceSufficiency: null,
      evidenceSufficiencyDetail: null,
    };
  }

  const report = review.report_markdown ?? '';
  const summary =
    review.summary?.trim()
    || extractSection(report, 'Summary')
    || null;
  const score =
    review.overall_score
    ?? parseReviewScore(extractSection(report, 'Final Score (1-10)'))
    ?? parseReviewScore(report);
  const confidence = extractSection(report, 'Confidence (1-5)');
  const verdict = extractSection(report, 'Accept / Borderline / Reject');
  const rejectBlock = extractSection(report, 'Top 5 Reject Reasons');
  const topRejectReason = rejectBlock
    ? rejectBlock.split('\n').map((line) => line.replace(/^[-*\d.]+\s*/, '').trim()).find(Boolean) ?? null
    : null;
  const evidenceBlock = extractSection(report, 'Evidence Sufficiency');
  const evidenceSufficiency = parseEvidenceSufficiencyStatus(evidenceBlock);
  const evidenceSufficiencyDetail = evidenceBlock?.trim() || null;

  return {
    summary,
    score,
    confidence,
    verdict,
    topRejectReason,
    evidenceSufficiency,
    evidenceSufficiencyDetail,
  };
}

/** Chronological sequence: 1 = oldest, N = newest (list is newest-first). */
export function getReviewSequenceNumber(indexNewestFirst: number, total: number): number {
  return total - indexNewestFirst;
}

export function formatReviewDateTime(isoString: string): string {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return isoString;
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const h = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  return `${y}-${m}-${d} ${h}:${min}`;
}

export function buildReviewRecordSummary(review: PaperReview | null | undefined): {
  score: string;
  verdict: string;
} {
  const brief = buildPaperReviewBrief(review);
  const score = brief.score != null ? `${brief.score}/10` : '—';
  const verdict = brief.verdict
    ? brief.verdict.replace(/\*\*/g, '').split('\n')[0].replace(/^[-*\d.]+\s*/, '').trim() || '—'
    : '—';
  return { score, verdict };
}

export function reviewOutputPath(filePath: string, reviewId?: string): string {
  const base = filePath.split('/').pop()?.replace(/\.[^.]+$/, '') ?? 'paper';
  const safe = base.replace(/[^\w\u4e00-\u9fff.-]+/g, '_').slice(0, 60);
  if (reviewId) {
    const shortId = reviewId.replace(/-/g, '').slice(0, 8);
    return `outputs/reviews/${safe}-${shortId}-review.md`;
  }
  return `outputs/reviews/${safe}-review.md`;
}

/** Legacy single-file path (pre multi-review); used as hydrate fallback. */
export function legacyReviewOutputPath(filePath: string): string {
  return reviewOutputPath(filePath);
}

/** Parse embedded review id from agent-written report headers. */
export function extractReviewIdFromReport(markdown: string): string | null {
  const patterns = [
    /Review(?:\s+Record)?\s+ID:[^\n]*?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
    /Paper\s+ID:[^\n]*?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
    /评审记录\s*ID[：:][^\n]*?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
  ];
  for (const pattern of patterns) {
    const match = markdown.match(pattern);
    if (match?.[1]) return match[1];
  }
  return null;
}

export function reportBelongsToReview(
  markdown: string | null | undefined,
  reviewId: string,
  options?: { legacyFallback?: boolean },
): boolean {
  if (!markdown?.trim()) return false;
  const embedded = extractReviewIdFromReport(markdown);
  if (embedded) return embedded === reviewId;
  // Legacy single-file fallback must include a matching id — otherwise it may be another run.
  if (options?.legacyFallback) return false;
  // Per-review output file (path includes review id) — accept reports without an embedded id.
  return true;
}

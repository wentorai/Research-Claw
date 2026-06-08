import { normalizeSessionKey } from './session-key';

/** Background review cron runs need long thinking + writing; match openclaw cron payload timeout. */
export const REVIEW_RUN_TIMEOUT_SECONDS = 600;

/** Per-stage cron timeout (shorter output → lower idle risk). */
export const REVIEW_STAGE_TIMEOUT_SECONDS = 300;

/** Extra buffer after run timeout before dashboard gives up polling. */
export const REVIEW_POLL_GRACE_MS = 60_000;

export type PaperReviewRunMode = 'staged' | 'single';

export interface PaperReviewStageProgress {
  current: number;
  total: number;
  stageId: string;
}

export interface PendingPaperReviewRun {
  reviewId: string;
  filePath: string;
  fileName: string;
  startedAtMs: number;
  stageIndex?: number;
  stageId?: string;
}

export function stagePollDeadlineMs(startedAtMs: number): number {
  return startedAtMs + REVIEW_STAGE_TIMEOUT_SECONDS * 1000 + 30_000;
}

export function stagedReviewPollDeadlineMs(startedAtMs: number, stageCount: number): number {
  return startedAtMs + stageCount * (REVIEW_STAGE_TIMEOUT_SECONDS * 1000 + 30_000) + REVIEW_POLL_GRACE_MS;
}

export function reviewPollDeadlineMs(startedAtMs: number): number {
  return startedAtMs + REVIEW_RUN_TIMEOUT_SECONDS * 1000 + REVIEW_POLL_GRACE_MS;
}

export function isPaperReviewCronSessionKey(sessionKey: string | undefined): boolean {
  const key = normalizeSessionKey(sessionKey);
  if (!key) return false;
  return key.startsWith('cron:') || key.includes(':cron:');
}

export interface PaperReviewCronSessionRow {
  key: string;
  label?: string;
  displayName?: string;
  derivedTitle?: string;
}

export function paperReviewCronSessionLabel(session: PaperReviewCronSessionRow): string {
  return [session.label, session.displayName, session.derivedTitle, session.key]
    .filter((value): value is string => Boolean(value?.trim()))
    .join(' ');
}

/** Sidebar / cleanup: cron sessions created by Dashboard paper review runs. */
export function isPaperReviewCronSessionRow(session: PaperReviewCronSessionRow): boolean {
  if (/\[rc-review\]/i.test(paperReviewCronSessionLabel(session))) return true;
  return normalizeSessionKey(session.key).toLowerCase().startsWith('cron:rc-review:');
}

export function paperReviewCronSessionMatchesRun(
  session: PaperReviewCronSessionRow,
  reviewId: string,
  fileName: string,
): boolean {
  if (!isPaperReviewCronSessionRow(session)) return false;
  const bare = normalizeSessionKey(session.key).toLowerCase();
  const reviewPrefix = `cron:rc-review:${reviewId.toLowerCase()}:`;
  if (bare.startsWith(reviewPrefix)) return true;
  return paperReviewCronSessionLabel(session).includes(fileName);
}

export function isStaleInProgressReview(
  updatedAt: string | undefined,
  nowMs = Date.now(),
): boolean {
  if (!updatedAt) return false;
  const updatedMs = Date.parse(updatedAt);
  if (!Number.isFinite(updatedMs)) return false;
  return nowMs > reviewPollDeadlineMs(updatedMs);
}

export function formatReviewFailureReason(raw: string | undefined): string {
  const trimmed = raw?.trim();
  if (!trimmed) return 'Review run failed';
  if (/timed out|timeout/i.test(trimmed)) {
    return 'Review timed out while the model was generating the report. Try again or use a faster model.';
  }
  return trimmed;
}

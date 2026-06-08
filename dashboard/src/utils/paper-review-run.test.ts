import { describe, expect, it } from 'vitest';
import {
  REVIEW_POLL_GRACE_MS,
  REVIEW_RUN_TIMEOUT_SECONDS,
  isPaperReviewCronSessionRow,
  isPaperReviewCronSessionKey,
  isStaleInProgressReview,
  paperReviewCronSessionMatchesRun,
  reviewPollDeadlineMs,
} from './paper-review-run';

describe('paper-review-run', () => {
  it('detects cron session keys', () => {
    expect(isPaperReviewCronSessionKey('agent:main:cron:job-1:run:123')).toBe(true);
    expect(isPaperReviewCronSessionKey('cron:rc-review:abc')).toBe(true);
    expect(isPaperReviewCronSessionKey('main')).toBe(false);
  });

  it('computes single-run poll deadline from run timeout + grace', () => {
    const started = 1_000;
    expect(reviewPollDeadlineMs(started)).toBe(
      started + REVIEW_RUN_TIMEOUT_SECONDS * 1000 + REVIEW_POLL_GRACE_MS,
    );
  });

  it('marks in_progress reviews stale after single-run deadline', () => {
    const now = Date.parse('2026-06-06T12:00:00.000Z');
    const fresh = new Date(now - 60_000).toISOString();
    const stale = new Date(now - reviewPollDeadlineMs(0) - 1).toISOString();
    expect(isStaleInProgressReview(fresh, now)).toBe(false);
    expect(isStaleInProgressReview(stale, now)).toBe(true);
  });

  it('detects paper review cron session rows for sidebar filtering', () => {
    expect(isPaperReviewCronSessionRow({
      key: 'agent:main:cron:job-1:run:abc',
      label: 'Cron: [rc-review] paper.pdf (full)',
    })).toBe(true);
    expect(isPaperReviewCronSessionRow({
      key: 'cron:rc-review:rid-1:full',
    })).toBe(true);
    expect(isPaperReviewCronSessionRow({
      key: 'agent:main:cron:job-2:run:def',
      label: 'Cron: [rc-monitor] GitHub Trending',
    })).toBe(false);
  });

  it('matches cleanup targets by review id or filename label', () => {
    const row = {
      key: 'agent:main:cron:x:run:y',
      label: 'Cron: [rc-review] paper.pdf (full)',
    };
    expect(paperReviewCronSessionMatchesRun(row, 'other-id', 'paper.pdf')).toBe(true);
    expect(paperReviewCronSessionMatchesRun(row, 'rid-1', 'other.pdf')).toBe(false);
    expect(paperReviewCronSessionMatchesRun({
      key: 'cron:rc-review:rid-1:full',
    }, 'rid-1', 'paper.pdf')).toBe(true);
  });
});

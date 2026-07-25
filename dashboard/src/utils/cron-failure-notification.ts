import {
  classifyRunFailure,
  isConfigPermanentFailure,
  type RunFailureKind,
} from './run-failure';
import type { PanelTab } from '../stores/ui';

type SilentReason =
  | 'not-a-completion'
  | 'non-error-completion'
  | 'missing-consecutive-count'
  | 'below-notify-threshold'
  | 'duplicate-completion-event'
  | 'episode-already-reported';

type CronNotifyAction = 'notify-config' | 'notify-transient' | 'notify-skip';

/**
 * What was last reported to the user about one job's current failure run.
 *
 * OpenClaw gives us no success timestamp and no total-run counter — only the
 * consecutive counters — so this is the whole of the state needed to tell
 * "we already said this" from "this is new".
 */
export interface CronFailureEpisode {
  /** Identity of the run that produced the report (runId, else its start time). */
  occurrence: string;
  /** OpenClaw's consecutive counter as of that run. */
  consecutiveCount: number;
  /** Which of the three notifications was raised; a change of kind is new news. */
  notifyAction: CronNotifyAction;
  /**
   * The gateway event-stream epoch this report was made under. Counting runs
   * only means anything within one uninterrupted stream — see the note on
   * CronCompletionContext.epoch.
   */
  epoch: number;
}

/** The state write a decision implies. Applied by the caller, so classification stays pure. */
export type CronEpisodeEffect =
  | { kind: 'record'; jobId: string; episode: CronFailureEpisode }
  | { kind: 'clear'; jobId: string };

export type CronCompletionDecision =
  | { action: 'success'; jobId: string; episodeEffect?: CronEpisodeEffect }
  | { action: 'silent'; reason: SilentReason; episodeEffect?: CronEpisodeEffect }
  | {
      action: CronNotifyAction;
      jobId: string;
      failureKind: RunFailureKind;
      rawError: string;
      consecutiveCount: number;
      dedupKey: string;
      targetSessionKey?: string;
      targetPanel?: PanelTab;
      episodeEffect?: CronEpisodeEffect;
    };

export interface CronCompletionContext {
  /** Per-job record of what has already been reported, keyed by job id. */
  reportedEpisodes?: ReadonlyMap<string, CronFailureEpisode>;
  /**
   * The gateway's event-stream epoch (useGatewayStore.eventEpoch), which changes
   * whenever frames may have been lost.
   *
   * The contiguity rule below reasons about counter arithmetic across successive
   * events, and that reasoning is only valid while no event went missing. After
   * a gap or a reconnect it is not: a counter of 2 above a watermark of 1 is
   * then equally "the next run of the reported episode" and "the second run of a
   * new episode whose first run we never saw". Carrying the epoch on the
   * watermark makes that distinction observable instead of assumed.
   */
  epoch?: number;
}

/** Apply a decision's state write. Exported so the reducer is covered by tests. */
export function applyCronEpisodeEffect(
  episodes: Map<string, CronFailureEpisode>,
  effect: CronEpisodeEffect | undefined,
): void {
  if (!effect) return;
  if (effect.kind === 'clear') episodes.delete(effect.jobId);
  else episodes.set(effect.jobId, effect.episode);
}

/** A misconfiguration will not fix itself, so its first occurrence is worth reporting. */
const CONFIG_FAILURE_THRESHOLD = 1;
/** OpenClaw retries transient failures with backoff; three in a row is not self-healing. */
const REPEATED_FAILURE_THRESHOLD = 3;

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === 'object' ? value as UnknownRecord : null;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * Interpret the real OpenClaw cron completion protocol.
 *
 * OpenClaw emits every completed run as action="finished"; execution failures
 * are distinguished by status="error". The included job snapshot is already
 * updated, so state.consecutiveErrors (error) / consecutiveSkipped (provider
 * preflight skip) are the authoritative, success-resetting counters and must
 * not be reimplemented in the dashboard.
 *
 * Reporting is gated on the episode, never on hitting one exact counter value.
 * The gateway broadcasts cron events with dropIfSlow, and the dashboard may be
 * closed, so any "only when the count is N" rule silently loses the report when
 * that single event is the one that goes missing.
 */
export function classifyCronCompletion(
  payload: unknown,
  context: CronCompletionContext = {},
): CronCompletionDecision {
  const event = asRecord(payload);
  if (!event || event.action !== 'finished') {
    return { action: 'silent', reason: 'not-a-completion' };
  }
  const jobId = nonEmptyString(event.jobId) ?? 'unknown-job';
  // A success zeroes both counters, so whatever we were tracking is over.
  if (event.status === 'ok') {
    return { action: 'success', jobId, episodeEffect: { kind: 'clear', jobId } };
  }
  if (event.status !== 'error' && event.status !== 'skipped') {
    return { action: 'silent', reason: 'non-error-completion' };
  }

  const job = asRecord(event.job);
  const state = asRecord(job?.state);
  const skipped = event.status === 'skipped';
  const countValue = skipped ? state?.consecutiveSkipped : state?.consecutiveErrors;
  if (typeof countValue !== 'number' || !Number.isFinite(countValue)) {
    return { action: 'silent', reason: 'missing-consecutive-count' };
  }
  const consecutiveCount = Math.max(0, Math.floor(countValue));
  const rawError =
    nonEmptyString(event.error)
    ?? nonEmptyString(state?.lastError)
    ?? nonEmptyString(event.summary)
    ?? nonEmptyString(state?.lastErrorReason)
    ?? '';
  const failure = classifyRunFailure(rawError, undefined, { origin: 'background' });
  const occurrence =
    nonEmptyString(event.runId)
    ?? (typeof event.runAtMs === 'number' ? String(event.runAtMs) : undefined)
    ?? (typeof state?.lastRunAtMs === 'number' ? String(state.lastRunAtMs) : undefined)
    ?? `${consecutiveCount}:${failure.kind}`;
  const targetSessionKey = nonEmptyString(event.sessionKey);

  const configPermanent = isConfigPermanentFailure(failure.kind);
  const notifyAction: CronNotifyAction = configPermanent
    ? 'notify-config'
    : skipped
      ? 'notify-skip'
      : 'notify-transient';
  const threshold = configPermanent ? CONFIG_FAILURE_THRESHOLD : REPEATED_FAILURE_THRESHOLD;

  const epoch = context.epoch ?? 0;
  const prior = context.reportedEpisodes?.get(jobId);
  // One run is one data point however many times it is delivered. Checked ahead
  // of the epoch, so a discontinuity re-opens the question "is this episode
  // still the one I reported?" without ever re-opening "is this run new?".
  // (The wire protocol has no replay — no resume token, no server-side buffer —
  // so this is a defensive invariant, not an observed shape.)
  if (prior?.occurrence === occurrence) {
    return { action: 'silent', reason: 'duplicate-completion-event' };
  }

  /**
   * A run continues what we already reported only if it is the very next step of
   * it: same notification kind, counter exactly one higher.
   *
   * Requiring contiguity rather than merely "the counter went up" is deliberate.
   * OpenClaw resets a consecutive counter on any run that did not fail the same
   * way (an error zeroes consecutiveSkipped, a skip zeroes consecutiveErrors, a
   * success zeroes both), and we may never see the resetting event. So a counter
   * of 5 sitting above a watermark of 3 is ambiguous: it is either this episode
   * two runs later, or a fresh episode whose earlier events were dropped. Under
   * "went up" we would call it a continuation and stay silent — the exact silent
   * failure this gate exists to prevent. Treating it as new costs a repeat of a
   * statement that is still true; treating it as old costs the user the news.
   *
   * Contiguity is also only meaningful inside one epoch. Across a gap or a
   * reconnect, "exactly one higher" stops being evidence of adjacency: the
   * resetting success and the new episode's first run can both have gone
   * missing, leaving a count of 2 that looks like the sequel to a reported 1.
   */
  const continuesReportedEpisode =
    !!prior
    && prior.epoch === epoch
    && prior.notifyAction === notifyAction
    && consecutiveCount === prior.consecutiveCount + 1;
  const episode: CronFailureEpisode = { occurrence, consecutiveCount, notifyAction, epoch };
  if (continuesReportedEpisode) {
    return {
      action: 'silent',
      reason: 'episode-already-reported',
      // Advance the watermark so the next run is still measured against reality.
      episodeEffect: { kind: 'record', jobId, episode },
    };
  }

  if (consecutiveCount < threshold) {
    // Nothing reported yet, so nothing to remember: leave any prior watermark in
    // place rather than overwriting it with a run the user never heard about.
    return { action: 'silent', reason: 'below-notify-threshold' };
  }

  const episodeEffect: CronEpisodeEffect = { kind: 'record', jobId, episode };
  if (configPermanent) {
    return {
      action: 'notify-config',
      jobId,
      failureKind: failure.kind,
      rawError,
      consecutiveCount,
      dedupKey: `cron:failure:${jobId}:config:${occurrence}`,
      targetPanel: 'settings',
      episodeEffect,
    };
  }
  if (skipped) {
    // A preflight skip returns before the run session is ever persisted
    // (cron/isolated-agent/run.ts returns status "skipped" ahead of
    // persistSessionEntry), so offering "view the failed run" would open a
    // session that does not exist. The provider endpoint is the actionable
    // surface, so route to settings instead.
    return {
      action: 'notify-skip',
      jobId,
      failureKind: failure.kind,
      rawError,
      consecutiveCount,
      dedupKey: `cron:failure:${jobId}:skipped:${occurrence}`,
      targetPanel: 'settings',
      episodeEffect,
    };
  }
  return {
    action: 'notify-transient',
    jobId,
    failureKind: failure.kind,
    rawError,
    consecutiveCount,
    dedupKey: `cron:failure:${jobId}:transient:${occurrence}`,
    targetSessionKey,
    episodeEffect,
  };
}

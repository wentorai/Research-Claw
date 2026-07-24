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
  | 'below-transient-threshold'
  | 'config-already-reported'
  | 'transient-threshold-already-reported';

export type CronCompletionDecision =
  | { action: 'success' }
  | { action: 'silent'; reason: SilentReason }
  | {
      action: 'notify-config' | 'notify-transient';
      failureKind: RunFailureKind;
      rawError: string;
      consecutiveCount: number;
      dedupKey: string;
      targetSessionKey?: string;
      targetPanel?: PanelTab;
    };

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
 */
export function classifyCronCompletion(payload: unknown): CronCompletionDecision {
  const event = asRecord(payload);
  if (!event || event.action !== 'finished') {
    return { action: 'silent', reason: 'not-a-completion' };
  }
  if (event.status === 'ok') return { action: 'success' };
  if (event.status !== 'error' && event.status !== 'skipped') {
    return { action: 'silent', reason: 'non-error-completion' };
  }

  const job = asRecord(event.job);
  const state = asRecord(job?.state);
  const countValue = event.status === 'skipped'
    ? state?.consecutiveSkipped
    : state?.consecutiveErrors;
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
  const jobId = nonEmptyString(event.jobId) ?? 'unknown-job';
  const occurrence =
    nonEmptyString(event.runId)
    ?? (typeof event.runAtMs === 'number' ? String(event.runAtMs) : undefined)
    ?? (typeof state?.lastRunAtMs === 'number' ? String(state.lastRunAtMs) : undefined)
    ?? `${consecutiveCount}:${failure.kind}`;
  const targetSessionKey = nonEmptyString(event.sessionKey);

  if (isConfigPermanentFailure(failure.kind)) {
    if (consecutiveCount !== 1) {
      return { action: 'silent', reason: 'config-already-reported' };
    }
    return {
      action: 'notify-config',
      failureKind: failure.kind,
      rawError,
      consecutiveCount,
      dedupKey: `cron:failure:${jobId}:config:${occurrence}`,
      targetPanel: 'settings',
    };
  }

  if (consecutiveCount < 3) {
    return { action: 'silent', reason: 'below-transient-threshold' };
  }
  if (consecutiveCount > 3) {
    return { action: 'silent', reason: 'transient-threshold-already-reported' };
  }
  return {
    action: 'notify-transient',
    failureKind: failure.kind,
    rawError,
    consecutiveCount,
    dedupKey: `cron:failure:${jobId}:transient:${occurrence}`,
    targetSessionKey,
  };
}

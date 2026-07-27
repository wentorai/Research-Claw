/**
 * OpenClaw 2026.6.1 cron completion payloads.
 *
 * Shape is copied from the real CronEvent emitted by
 * src/cron/service/timer.ts:emitJobFinished: failures are `action:"finished"`
 * plus `status:"error"`, and the post-run job snapshot carries the
 * success-resetting `state.consecutiveErrors` counter.
 */
const timeoutError =
  'The model did not produce a response before the model idle timeout. Please try again, or increase `models.providers.<id>.timeoutSeconds` for slow local or self-hosted providers. If `agents.defaults.timeoutSeconds` or a run-specific timeout is lower, raise that ceiling too; provider timeouts cannot extend the whole agent run.';

function failedJob(consecutiveErrors: number, error: string, lastErrorReason: string) {
  return {
    id: 'monitor-job-7',
    agentId: 'main',
    name: 'Citation monitor',
    enabled: true,
    createdAtMs: 1784915000000,
    updatedAtMs: 1784915600000,
    schedule: { kind: 'cron', expr: '0 */6 * * *' },
    sessionTarget: 'isolated',
    wakeMode: 'now',
    payload: {
      kind: 'agentTurn',
      message: 'Check citation changes.',
    },
    delivery: { mode: 'none' },
    state: {
      lastRunAtMs: 1784915599000,
      lastRunStatus: 'error',
      lastStatus: 'error',
      lastError: error,
      lastErrorReason,
      consecutiveErrors,
      consecutiveSkipped: 0,
      lastDurationMs: 1000,
      nextRunAtMs: 1784937200000,
    },
  };
}

export const CRON_TIMEOUT_FIRST = {
  jobId: 'monitor-job-7',
  action: 'finished',
  status: 'error',
  error: timeoutError,
  job: failedJob(1, timeoutError, 'timeout'),
  sessionId: 'session-timeout-1',
  sessionKey: 'agent:main:cron:monitor-job-7:run:timeout-1',
  runAtMs: 1784915599000,
  durationMs: 1000,
  nextRunAtMs: 1784937200000,
  provider: 'test',
  model: 'hang',
};

export const CRON_TIMEOUT_THIRD = {
  ...CRON_TIMEOUT_FIRST,
  job: failedJob(3, timeoutError, 'timeout'),
  sessionId: 'session-timeout-3',
  sessionKey: 'agent:main:cron:monitor-job-7:run:timeout-3',
  runAtMs: 1784958799000,
};

const authError = 'FailoverError: HTTP 401: Invalid Authentication';

export const CRON_AUTH_FIRST = {
  ...CRON_TIMEOUT_FIRST,
  error: authError,
  job: failedJob(1, authError, 'auth'),
  sessionId: 'session-auth-1',
  sessionKey: 'agent:main:cron:monitor-job-7:run:auth-1',
  runAtMs: 1785001999000,
};

/** The same misconfiguration one scheduled run later: OpenClaw incremented its counter. */
export const CRON_AUTH_SECOND = {
  ...CRON_AUTH_FIRST,
  job: failedJob(2, authError, 'auth'),
  sessionId: 'session-auth-2',
  sessionKey: 'agent:main:cron:monitor-job-7:run:auth-2',
  runAtMs: 1785010199000,
};

/**
 * A fresh failure run after the job had recovered: the successful run in between
 * zeroed consecutiveErrors, so this one is back at 1. The dashboard may never
 * have seen that success — the gateway broadcasts cron events with dropIfSlow,
 * and the dashboard is frequently not even open.
 */
export const CRON_AUTH_NEW_EPISODE = {
  ...CRON_AUTH_FIRST,
  job: failedJob(1, authError, 'auth'),
  sessionId: 'session-auth-relapse',
  sessionKey: 'agent:main:cron:monitor-job-7:run:auth-relapse',
  runAtMs: 1785131999000,
};

const providerPreflightError =
  'Agent cron job uses test/hang but the local provider endpoint is not reachable at http://127.0.0.1:28801/v1. Skipping this cron run; OpenClaw will retry the provider preflight on a later scheduled run. Last error: TimeoutError: request timed out';

function skippedJob(consecutiveSkipped: number) {
  const job = failedJob(0, providerPreflightError, 'timeout');
  return {
    ...job,
    state: {
      ...job.state,
      lastRunStatus: 'skipped',
      lastStatus: 'skipped',
      consecutiveErrors: 0,
      consecutiveSkipped,
    },
  };
}

export const CRON_PREFLIGHT_SKIP_FIRST = {
  ...CRON_TIMEOUT_FIRST,
  status: 'skipped',
  error: providerPreflightError,
  job: skippedJob(1),
  sessionId: 'session-preflight-1',
  sessionKey: 'agent:main:cron:monitor-job-7:run:preflight-1',
  runAtMs: 1785045199000,
};

export const CRON_PREFLIGHT_SKIP_THIRD = {
  ...CRON_PREFLIGHT_SKIP_FIRST,
  job: skippedJob(3),
  sessionId: 'session-preflight-3',
  sessionKey: 'agent:main:cron:monitor-job-7:run:preflight-3',
  runAtMs: 1785088399000,
};

export const CRON_SUCCESS_AFTER_FAILURE = {
  ...CRON_TIMEOUT_FIRST,
  status: 'ok',
  error: undefined,
  summary: 'No new citations found.',
  job: {
    ...failedJob(0, '', 'unknown'),
    state: {
      lastRunAtMs: 1785023599000,
      lastRunStatus: 'ok',
      lastStatus: 'ok',
      consecutiveErrors: 0,
      consecutiveSkipped: 0,
      lastDurationMs: 820,
      nextRunAtMs: 1785045200000,
    },
  },
  sessionId: 'session-success',
  sessionKey: 'agent:main:cron:monitor-job-7:run:success',
  runAtMs: 1785023599000,
  durationMs: 820,
};

export type SessionRunStatus = 'running' | 'done' | 'failed' | 'killed' | 'timeout';

export type SessionRunLifecycle =
  | 'idle'
  | SessionRunStatus
  | 'interrupted'
  | 'unknown';

export interface SessionRunTruth {
  sessionKey: string;
  sessionId?: string;
  status?: SessionRunStatus;
  hasActiveRun?: boolean;
  startedAt?: number;
  endedAt?: number;
  runtimeMs?: number;
  observedAt: number;
}

type SessionRunStateLike = Pick<SessionRunTruth, 'status' | 'hasActiveRun'>;

/**
 * Exact OpenClaw 2026.6.1 active-run precedence.
 *
 * Terminal lifecycle is stronger than the in-memory active registry. When no
 * terminal is present, an explicit registry value is stronger than the legacy
 * persisted `status === "running"` fallback.
 *
 * Source: openclaw/ui/src/ui/session-run-state.ts
 */
export function isSessionRunActive(state: SessionRunStateLike): boolean {
  if (state.status && state.status !== 'running') return false;
  if (typeof state.hasActiveRun === 'boolean') return state.hasActiveRun;
  return state.status === 'running';
}

export function isTerminalSessionRunStatus(
  status: SessionRunStatus | undefined,
): status is Exclude<SessionRunStatus, 'running'> {
  return Boolean(status && status !== 'running');
}


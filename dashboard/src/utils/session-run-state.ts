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

export type ChatTerminalLifecycle = Exclude<SessionRunLifecycle, 'idle' | 'running' | 'unknown'>;

/** Map an OC chat terminal frame without inventing a cause. `aborted` is only a
 * timeout when the gateway says so; a local Stop command is killed, otherwise
 * the cause remains interrupted. */
export function classifyChatTerminalLifecycle(
  event: {
    state?: string;
    stopReason?: string;
    errorKind?: string;
    message?: { isError?: boolean };
  },
  command: 'idle' | 'submitting' | 'ack_unknown' | 'stopping',
): ChatTerminalLifecycle | null {
  if (event.state === 'final') return event.message?.isError ? 'failed' : 'done';
  if (event.state === 'error') return event.errorKind === 'timeout' ? 'timeout' : 'failed';
  if (event.state !== 'aborted') return null;
  if (event.stopReason === 'timeout' || event.errorKind === 'timeout') return 'timeout';
  return command === 'stopping' ? 'killed' : 'interrupted';
}

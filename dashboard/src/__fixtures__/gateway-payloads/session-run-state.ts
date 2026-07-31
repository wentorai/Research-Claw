/**
 * OpenClaw 2026.6.1 session/run lifecycle protocol fixtures.
 *
 * These payload shapes are copied from the locked OpenClaw contracts and tests,
 * not invented from the Research-Claw implementation:
 *
 * - ui/src/ui/session-run-state.test.ts
 * - ui/src/ui/controllers/sessions.test.ts
 * - src/gateway/server.sessions.list-changed.test.ts
 * - src/gateway/server-methods/chat.ts (chat.history result)
 * - src/gateway/chat-abort.ts (inFlightRun projection)
 * - src/gateway/server-chat.ts (sessions.changed lifecycle snapshot)
 *
 * Important wire detail: sessions.list/chat.history include hasActiveRun, while
 * lifecycle sessions.changed snapshots can omit it. The latter is therefore a
 * partial patch, never a complete replacement row.
 */

export const OC_SESSION_ACTIVE_CASES = [
  { name: 'running with active registry entry', row: { status: 'running', hasActiveRun: true }, active: true },
  { name: 'running persisted row after registry cleared', row: { status: 'running', hasActiveRun: false }, active: false },
  { name: 'terminal done wins over stale active registry', row: { status: 'done', hasActiveRun: true }, active: false },
  { name: 'terminal failed wins over stale active registry', row: { status: 'failed', hasActiveRun: true }, active: false },
  { name: 'terminal killed wins over stale active registry', row: { status: 'killed', hasActiveRun: true }, active: false },
  { name: 'terminal timeout wins over stale active registry', row: { status: 'timeout', hasActiveRun: true }, active: false },
  { name: 'legacy running status fallback', row: { status: 'running' }, active: true },
  { name: 'active registry without persisted status', row: { hasActiveRun: true }, active: true },
  { name: 'new empty session', row: {}, active: false },
] as const;

export const SESSION_LIST_ACTIVE_RESPONSE = {
  ts: 1_754_000_010_000,
  path: '/fixture/state/agents/main/sessions/sessions.json',
  count: 1,
  defaults: { modelProvider: 'deepseek', model: 'deepseek-v4-pro', contextTokens: 1_000_000 },
  sessions: [
    {
      key: 'agent:main:project-longrun',
      kind: 'direct',
      updatedAt: 1_754_000_010_000,
      sessionId: 'session-generation-1',
      status: 'running',
      hasActiveRun: true,
      startedAt: 1_754_000_000_000,
    },
  ],
} as const;

export const SESSION_CHANGED_MESSAGE_PARTIAL = {
  sessionKey: 'agent:main:project-longrun',
  sessionId: 'session-generation-1',
  phase: 'message',
  status: 'running',
  updatedAt: 1_754_000_011_000,
  // hasActiveRun is intentionally absent on this real lifecycle fast path.
} as const;

export const SESSION_CHANGED_TERMINAL_PARTIAL = {
  sessionKey: 'agent:main:project-longrun',
  sessionId: 'session-generation-1',
  runId: 'run-generation-1',
  phase: 'end',
  status: 'done',
  startedAt: 1_754_000_000_000,
  endedAt: 1_754_000_020_000,
  runtimeMs: 20_000,
  updatedAt: 1_754_000_020_000,
  // hasActiveRun is intentionally absent; terminal status still wins.
} as const;

export const SESSION_LIST_GATEWAY_RESTART_RESPONSE = {
  ...SESSION_LIST_ACTIVE_RESPONSE,
  sessions: [
    {
      ...SESSION_LIST_ACTIVE_RESPONSE.sessions[0],
      status: 'running',
      hasActiveRun: false,
    },
  ],
} as const;

export const SESSION_LIST_TERMINAL_CONFLICT_RESPONSE = {
  ...SESSION_LIST_ACTIVE_RESPONSE,
  sessions: [
    {
      ...SESSION_LIST_ACTIVE_RESPONSE.sessions[0],
      status: 'timeout',
      hasActiveRun: true,
      endedAt: 1_754_000_020_000,
      runtimeMs: 20_000,
    },
  ],
} as const;

export const CHAT_HISTORY_IN_FLIGHT_RESPONSE = {
  sessionKey: 'agent:main:project-longrun',
  sessionInfo: SESSION_LIST_ACTIVE_RESPONSE.sessions[0],
  messages: [
    {
      role: 'user',
      content: 'Run the long literature review',
      timestamp: 1_754_000_000_000,
      idempotencyKey: 'run-generation-1:user',
    },
  ],
  inFlightRun: {
    runId: 'run-generation-1',
    text: 'I am checking the literature sources',
  },
} as const;

export const CHAT_ABORTED_TIMEOUT_EVENT = {
  runId: 'run-generation-1',
  sessionKey: 'agent:main:project-longrun',
  state: 'aborted',
  stopReason: 'timeout',
  errorKind: 'timeout',
} as const;


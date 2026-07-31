import { create } from 'zustand';

import { normalizeSessionKey } from '../utils/session-key';
import {
  beginSessionRunRequest,
  createSessionRunReconcilerState,
  getSessionRunLifecycle,
  getSessionRunRecord,
  reconcileSessionRun,
  type SessionRunReconcilerState,
  type SessionRunRowLike,
} from '../utils/session-run-reconciler';
import { isSessionRunActive, type SessionRunLifecycle } from '../utils/session-run-state';
import { useGatewayStore } from './gateway';

export type SessionRunCommand = 'idle' | 'submitting' | 'ack_unknown' | 'stopping';

export type RunActivityKind =
  | 'submitting'
  | 'processing'
  | 'tool'
  | 'compacting'
  | 'fallback'
  | 'streaming'
  | 'finalizing'
  | 'unknown';

export interface RunActivityObservation {
  sessionKey: string;
  sessionId?: string;
  runId?: string;
  kind: RunActivityKind;
  label: string;
  observedAt: number;
  source: 'local-ack' | 'agent-event' | 'tool-event' | 'chat-event';
}

export interface SessionRunView {
  sessionKey: string;
  command: SessionRunCommand;
  lifecycle: SessionRunLifecycle;
  activity: RunActivityObservation | null;
  localRunId: string | null;
  serverActive: boolean;
  isBusy: boolean;
  canAbort: boolean;
  isStreaming: boolean;
}

interface ReconcileOptions {
  eventEpoch: number;
  observedAt: number;
}

interface ChatTerminalInput {
  sessionKey: string;
  runId?: string;
  sessionId?: string;
  status: 'done' | 'failed' | 'killed' | 'timeout' | 'interrupted';
  eventEpoch: number;
  seq?: number;
  observedAt: number;
}

interface SessionRunsState {
  reconciler: SessionRunReconcilerState;
  commands: Record<string, SessionRunCommand>;
  localRunIds: Record<string, string>;
  activities: Record<string, RunActivityObservation>;

  ingestSnapshot: (row: SessionRunRowLike, options: ReconcileOptions) => void;
  ingestSessionEvent: (
    payload: unknown,
    options: { eventEpoch: number; seq?: number; observedAt?: number },
  ) => void;
  requestReconcile: (sessionKey: string, reason: string) => Promise<void>;
  applyChatTerminal: (input: ChatTerminalInput) => void;
  setCommand: (sessionKey: string, command: SessionRunCommand) => void;
  setLocalRunId: (sessionKey: string, runId: string | null) => void;
  observeActivity: (observation: RunActivityObservation) => void;
  clearTransient: (sessionKey: string, runId?: string) => void;
  resetForTests: () => void;
}

const POLL_DELAYS_MS = [15_000, 30_000, 60_000] as const;
const reconcileInFlight = new Map<string, Promise<void>>();
const reconcileTimers = new Map<string, ReturnType<typeof setTimeout>>();
const pollAttempts = new Map<string, number>();

function keyOf(value: string | undefined): string {
  return normalizeSessionKey(value) || value || 'main';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function clearPoll(sessionKey: string): void {
  const timer = reconcileTimers.get(sessionKey);
  if (timer) clearTimeout(timer);
  reconcileTimers.delete(sessionKey);
  pollAttempts.delete(sessionKey);
}

function clearAllPolls(): void {
  for (const timer of reconcileTimers.values()) clearTimeout(timer);
  reconcileTimers.clear();
  reconcileInFlight.clear();
  pollAttempts.clear();
}

function schedulePoll(sessionKey: string): void {
  if (reconcileTimers.has(sessionKey) || reconcileInFlight.has(sessionKey)) return;
  const view = selectSessionRunView(useSessionRunsStore.getState(), sessionKey);
  if (!view.serverActive && view.command === 'idle') {
    clearPoll(sessionKey);
    return;
  }
  const attempt = pollAttempts.get(sessionKey) ?? 0;
  const delay = POLL_DELAYS_MS[Math.min(attempt, POLL_DELAYS_MS.length - 1)];
  const timer = setTimeout(() => {
    reconcileTimers.delete(sessionKey);
    pollAttempts.set(sessionKey, attempt + 1);
    void useSessionRunsStore.getState().requestReconcile(sessionKey, 'active-poll');
  }, delay);
  reconcileTimers.set(sessionKey, timer);
}

function terminalOrInactiveCleanup(
  state: SessionRunsState,
  sessionKey: string,
): Pick<SessionRunsState, 'commands' | 'localRunIds' | 'activities'> | null {
  const record = getSessionRunRecord(state.reconciler, sessionKey);
  const lifecycle = getSessionRunLifecycle(record);
  const terminal = ['done', 'failed', 'killed', 'timeout', 'interrupted'].includes(lifecycle);
  const authoritativelyInactive = record?.truth?.hasActiveRun === false
    && state.commands[sessionKey] !== 'ack_unknown';
  if (!terminal && !authoritativelyInactive) return null;
  const commands = { ...state.commands, [sessionKey]: 'idle' as const };
  const localRunIds = { ...state.localRunIds };
  const activities = { ...state.activities };
  delete localRunIds[sessionKey];
  delete activities[sessionKey];
  clearPoll(sessionKey);
  return { commands, localRunIds, activities };
}

export function selectSessionRunView(
  state: Pick<SessionRunsState, 'reconciler' | 'commands' | 'localRunIds' | 'activities'>,
  rawSessionKey: string,
): SessionRunView {
  const sessionKey = keyOf(rawSessionKey);
  const record = getSessionRunRecord(state.reconciler, sessionKey);
  const command = state.commands[sessionKey] ?? 'idle';
  const localRunId = state.localRunIds[sessionKey] ?? null;
  const activity = state.activities[sessionKey] ?? null;
  const serverActive = Boolean(record?.truth && isSessionRunActive(record.truth));
  return {
    sessionKey,
    command,
    lifecycle: getSessionRunLifecycle(record),
    activity,
    localRunId,
    serverActive,
    isBusy: command !== 'idle' || serverActive,
    canAbort: localRunId !== null || serverActive,
    isStreaming: activity?.kind === 'streaming',
  };
}

const initialState = () => ({
  reconciler: createSessionRunReconcilerState(),
  commands: {},
  localRunIds: {},
  activities: {},
});

export const useSessionRunsStore = create<SessionRunsState>()((set, get) => ({
  ...initialState(),

  ingestSnapshot: (row, options) => {
    const sessionKey = keyOf(row.key ?? row.sessionKey);
    set((state) => {
      const request = beginSessionRunRequest(state.reconciler, sessionKey, {
        eventEpoch: options.eventEpoch,
      });
      const reconciler = reconcileSessionRun(request.state, {
        type: 'snapshot',
        sessionKey,
        requestGeneration: request.generation,
        eventEpoch: options.eventEpoch,
        observedAt: options.observedAt,
        row,
      });
      const nextState = { ...state, reconciler };
      return { reconciler, ...(terminalOrInactiveCleanup(nextState, sessionKey) ?? {}) };
    });
    const view = selectSessionRunView(get(), sessionKey);
    if (view.serverActive || view.command !== 'idle') schedulePoll(sessionKey);
    else clearPoll(sessionKey);
  },

  ingestSessionEvent: (payload, options) => {
    if (!isRecord(payload)) return;
    const nested = isRecord(payload.session) ? payload.session : null;
    const source = nested ?? payload;
    const rawKey =
      (typeof source.key === 'string' && source.key) ||
      (typeof payload.sessionKey === 'string' && payload.sessionKey) ||
      (typeof payload.key === 'string' && payload.key) ||
      '';
    if (!rawKey) return;
    const sessionKey = keyOf(rawKey);
    const patch: SessionRunRowLike = {
      ...source,
      ...(typeof payload.phase === 'string' ? { phase: payload.phase } : {}),
    };
    const runId =
      (typeof payload.clientRunId === 'string' && payload.clientRunId) ||
      (typeof payload.runId === 'string' && payload.runId) ||
      undefined;
    set((state) => {
      const reconciler = reconcileSessionRun(state.reconciler, {
        type: 'event',
        sessionKey,
        eventEpoch: options.eventEpoch,
        seq: options.seq,
        observedAt: options.observedAt ?? Date.now(),
        runId,
        patch,
      });
      const nextState = { ...state, reconciler };
      return { reconciler, ...(terminalOrInactiveCleanup(nextState, sessionKey) ?? {}) };
    });
    const view = selectSessionRunView(get(), sessionKey);
    if (view.serverActive || view.command !== 'idle') schedulePoll(sessionKey);
    else clearPoll(sessionKey);
  },

  requestReconcile: (rawSessionKey, reason) => {
    const sessionKey = keyOf(rawSessionKey);
    const existing = reconcileInFlight.get(sessionKey);
    if (existing) return existing;

    const gateway = useGatewayStore.getState();
    const client = gateway.client;
    const eventEpoch = gateway.eventEpoch ?? 0;
    let generation = 0;
    set((state) => {
      const request = beginSessionRunRequest(state.reconciler, sessionKey, { eventEpoch });
      generation = request.generation;
      return { reconciler: request.state };
    });

    const promise = (async () => {
      if (!client?.isConnected) {
        set((state) => ({
          reconciler: reconcileSessionRun(state.reconciler, {
            type: 'query-failed',
            sessionKey,
            requestGeneration: generation,
            eventEpoch,
          }),
        }));
        return;
      }
      try {
        const result = await client.request<{ sessions?: SessionRunRowLike[] }>('sessions.list', {
          includeDerivedTitles: true,
          limit: 1000,
        });
        const row = result?.sessions?.find((candidate) =>
          keyOf(candidate.key ?? candidate.sessionKey) === sessionKey,
        ) ?? { key: sessionKey };
        set((state) => {
          const reconciler = reconcileSessionRun(state.reconciler, {
            type: 'snapshot',
            sessionKey,
            requestGeneration: generation,
            eventEpoch,
            observedAt: Date.now(),
            row,
          });
          const nextState = { ...state, reconciler };
          return { reconciler, ...(terminalOrInactiveCleanup(nextState, sessionKey) ?? {}) };
        });
      } catch (error) {
        console.warn(`[SessionRuns] reconcile failed (${reason}) for ${sessionKey}:`, error);
        set((state) => ({
          reconciler: reconcileSessionRun(state.reconciler, {
            type: 'query-failed',
            sessionKey,
            requestGeneration: generation,
            eventEpoch,
          }),
        }));
      }
    })().finally(() => {
      reconcileInFlight.delete(sessionKey);
      const view = selectSessionRunView(get(), sessionKey);
      if (view.serverActive || view.command !== 'idle') schedulePoll(sessionKey);
      else clearPoll(sessionKey);
    });
    reconcileInFlight.set(sessionKey, promise);
    return promise;
  },

  applyChatTerminal: (input) => {
    const sessionKey = keyOf(input.sessionKey);
    set((state) => {
      const reconciler = reconcileSessionRun(state.reconciler, {
        type: 'chat-terminal',
        sessionKey,
        runId: input.runId,
        sessionId: input.sessionId,
        status: input.status,
        eventEpoch: input.eventEpoch,
        seq: input.seq,
        observedAt: input.observedAt,
      });
      const nextState = { ...state, reconciler };
      return { reconciler, ...(terminalOrInactiveCleanup(nextState, sessionKey) ?? {}) };
    });
  },

  setCommand: (rawSessionKey, command) => {
    const sessionKey = keyOf(rawSessionKey);
    set((state) => ({ commands: { ...state.commands, [sessionKey]: command } }));
    if (command === 'idle') {
      const view = selectSessionRunView(get(), sessionKey);
      if (!view.serverActive) clearPoll(sessionKey);
    } else {
      schedulePoll(sessionKey);
    }
  },

  setLocalRunId: (rawSessionKey, runId) => {
    const sessionKey = keyOf(rawSessionKey);
    set((state) => {
      const localRunIds = { ...state.localRunIds };
      if (runId) localRunIds[sessionKey] = runId;
      else delete localRunIds[sessionKey];
      return { localRunIds };
    });
  },

  observeActivity: (observation) => {
    const sessionKey = keyOf(observation.sessionKey);
    set((state) => ({
      activities: {
        ...state.activities,
        [sessionKey]: { ...observation, sessionKey },
      },
    }));
  },

  clearTransient: (rawSessionKey, runId) => {
    const sessionKey = keyOf(rawSessionKey);
    set((state) => {
      const currentRunId = state.localRunIds[sessionKey];
      if (runId && currentRunId && currentRunId !== runId) return state;
      const commands = { ...state.commands, [sessionKey]: 'idle' as const };
      const localRunIds = { ...state.localRunIds };
      const activities = { ...state.activities };
      delete localRunIds[sessionKey];
      delete activities[sessionKey];
      return { commands, localRunIds, activities };
    });
    clearPoll(sessionKey);
  },

  resetForTests: () => {
    clearAllPolls();
    set(initialState());
  },
}));

export const _testSessionRunPolling = {
  delays: POLL_DELAYS_MS,
  clearAll: clearAllPolls,
};

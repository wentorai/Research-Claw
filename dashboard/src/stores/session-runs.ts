import { create } from 'zustand';

import { normalizeSessionKey, toGatewaySessionKey } from '../utils/session-key';
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
import { recordRunTrace } from '../utils/run-trace';
import {
  projectStoredConfirmedStopCommand,
  rememberConfirmedStopCommand,
} from '../utils/confirmed-stop-command';
import { useGatewayStore } from './gateway';

export type SessionRunCommand =
  | 'idle'
  | 'submitting'
  | 'accepted'
  | 'ack_unknown'
  | 'stopping';

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
  /** OC persisted status says running but the active-run registry says false.
   * The run is not active; history/result reconciliation may still be pending. */
  needsResultConfirmation: boolean;
  /** OC says the run is no longer active but never supplied a terminal result
   * within the bounded confirmation window. */
  resultUnconfirmed: boolean;
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
  pendingAborts: Record<string, { runId?: string }>;
  resultConfirmationExhausted: Record<string, boolean>;

  ingestSnapshot: (row: SessionRunRowLike, options: ReconcileOptions) => void;
  ingestSessionEvent: (
    payload: unknown,
    options: { eventEpoch: number; seq?: number; observedAt?: number },
  ) => void;
  requestReconcile: (sessionKey: string, reason: string) => Promise<void>;
  requestAbort: (sessionKey: string) => Promise<void>;
  flushPendingAborts: () => Promise<void>;
  applyChatTerminal: (input: ChatTerminalInput) => void;
  setCommand: (sessionKey: string, command: SessionRunCommand) => void;
  setLocalRunId: (sessionKey: string, runId: string | null) => void;
  observeActivity: (observation: RunActivityObservation) => void;
  clearTransient: (sessionKey: string, runId?: string) => void;
  resetForTests: () => void;
}

const POLL_DELAYS_MS = [15_000, 30_000, 60_000] as const;
const RESULT_CONFIRMATION_POLL_DELAYS_MS = [1_000, 2_000] as const;
const reconcileInFlight = new Map<string, {
  eventEpoch: number;
  promise: Promise<void>;
}>();
const reconcileTimers = new Map<string, ReturnType<typeof setTimeout>>();
const pollAttempts = new Map<string, number>();
const abortInFlight = new Map<string, Promise<void>>();
const abortAttemptedEpoch = new Map<string, number>();

interface ChatAbortResponse {
  ok?: boolean;
  aborted?: boolean;
  runIds?: unknown[];
}

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
  abortInFlight.clear();
  abortAttemptedEpoch.clear();
  pollAttempts.clear();
}

function schedulePoll(sessionKey: string): void {
  const currentEpoch = useGatewayStore.getState().eventEpoch ?? 0;
  const inFlight = reconcileInFlight.get(sessionKey);
  if (
    reconcileTimers.has(sessionKey)
    || (inFlight && inFlight.eventEpoch === currentEpoch)
  ) return;
  const view = selectSessionRunView(useSessionRunsStore.getState(), sessionKey);
  if (!view.serverActive && view.command === 'idle' && !view.needsResultConfirmation) {
    clearPoll(sessionKey);
    return;
  }
  const attempt = pollAttempts.get(sessionKey) ?? 0;
  const delays = view.needsResultConfirmation
    ? RESULT_CONFIRMATION_POLL_DELAYS_MS
    : POLL_DELAYS_MS;
  const delay = delays[Math.min(attempt, delays.length - 1)];
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
): Pick<
  SessionRunsState,
  'commands' | 'localRunIds' | 'activities' | 'pendingAborts' | 'resultConfirmationExhausted'
> | null {
  const record = getSessionRunRecord(state.reconciler, sessionKey);
  const lifecycle = getSessionRunLifecycle(record);
  const isTerminal = ['done', 'failed', 'killed', 'timeout', 'interrupted'].includes(lifecycle);
  const localRunId = state.localRunIds[sessionKey];
  const terminal = isTerminal && (
    state.commands[sessionKey] !== 'ack_unknown'
    || Boolean(record?.terminal?.runId && record.terminal.runId === localRunId)
  );
  const authoritativelyInactive = record?.truth?.hasActiveRun === false
    && state.commands[sessionKey] !== 'ack_unknown'
    && (
      state.commands[sessionKey] !== 'accepted'
      || state.resultConfirmationExhausted[sessionKey] === true
    );
  if (!terminal && !authoritativelyInactive) return null;
  const commands = { ...state.commands, [sessionKey]: 'idle' as const };
  const localRunIds = { ...state.localRunIds };
  const activities = { ...state.activities };
  const pendingAborts = { ...state.pendingAborts };
  const resultConfirmationExhausted = { ...state.resultConfirmationExhausted };
  delete localRunIds[sessionKey];
  delete activities[sessionKey];
  delete pendingAborts[sessionKey];
  if (terminal) delete resultConfirmationExhausted[sessionKey];
  abortAttemptedEpoch.delete(sessionKey);
  const needsResultConfirmation = record?.truth?.status === 'running'
    && record.truth.hasActiveRun === false;
  // OC clears the active-run registry before it necessarily persists the
  // terminal session status. Keep the read-only poll alive through that short
  // settling window; a terminal snapshot will clear it.
  if (!needsResultConfirmation) clearPoll(sessionKey);
  return {
    commands,
    localRunIds,
    activities,
    pendingAborts,
    resultConfirmationExhausted,
  };
}

function settleCommandAgainstAuthority(
  state: SessionRunsState,
  sessionKey: string,
): Partial<SessionRunsState> | null {
  const cleanup = terminalOrInactiveCleanup(state, sessionKey);
  if (cleanup) return cleanup;

  const record = getSessionRunRecord(state.reconciler, sessionKey);
  const serverActive = Boolean(record?.truth && isSessionRunActive(record.truth));
  const accepted = state.commands[sessionKey] === 'accepted';
  const exhausted = state.resultConfirmationExhausted[sessionKey] === true;
  if (!serverActive || (!accepted && !exhausted)) return null;

  const commands = accepted
    ? { ...state.commands, [sessionKey]: 'idle' as const }
    : state.commands;
  const resultConfirmationExhausted = { ...state.resultConfirmationExhausted };
  delete resultConfirmationExhausted[sessionKey];
  return { commands, resultConfirmationExhausted };
}

export function selectSessionRunView(
  state: Pick<
    SessionRunsState,
    'reconciler'
    | 'commands'
    | 'localRunIds'
    | 'activities'
    | 'resultConfirmationExhausted'
  >,
  rawSessionKey: string,
): SessionRunView {
  const sessionKey = keyOf(rawSessionKey);
  const record = getSessionRunRecord(state.reconciler, sessionKey);
  const command = state.commands[sessionKey] ?? 'idle';
  const localRunId = state.localRunIds[sessionKey] ?? null;
  const activity = state.activities[sessionKey] ?? null;
  const serverActive = Boolean(record?.truth && isSessionRunActive(record.truth));
  const lifecycle = getSessionRunLifecycle(record);
  const confirmationConflict = record?.truth?.hasActiveRun === false
    && (
      record.truth.status === 'running'
      || command === 'accepted'
    );
  const resultUnconfirmed = state.resultConfirmationExhausted[sessionKey] === true;
  const needsResultConfirmation = confirmationConflict && !resultUnconfirmed;
  return {
    sessionKey,
    command,
    lifecycle,
    activity,
    localRunId,
    serverActive,
    needsResultConfirmation,
    resultUnconfirmed,
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
  pendingAborts: {},
  resultConfirmationExhausted: {},
});

export const useSessionRunsStore = create<SessionRunsState>()((set, get) => ({
  ...initialState(),

  ingestSnapshot: (row, options) => {
    const stopProjection = projectStoredConfirmedStopCommand(row, options.observedAt);
    const effectiveRow = stopProjection.row;
    const sessionKey = keyOf(effectiveRow.key ?? effectiveRow.sessionKey);
    const previousView = selectSessionRunView(get(), sessionKey);
    if (stopProjection.fact) {
      recordRunTrace({
        source: 'session-store',
        action: 'confirmed-stop-projected',
        sessionKey,
        sessionId: effectiveRow.sessionId,
        runId: stopProjection.fact.runId,
        status: row.status,
        decision: 'killed',
        reason: 'chat.abort-confirmed',
        startedAt: effectiveRow.startedAt,
        endedAt: effectiveRow.endedAt,
        observedAt: options.observedAt,
      });
    }
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
        row: effectiveRow,
      });
      const nextState = { ...state, reconciler };
      return { reconciler, ...(settleCommandAgainstAuthority(nextState, sessionKey) ?? {}) };
    });
    const view = selectSessionRunView(get(), sessionKey);
    if (view.needsResultConfirmation && !previousView.needsResultConfirmation) {
      // A slow active-run fallback timer must not postpone the short, bounded
      // confirmation cadence after F5/reconnect reveals running + inactive.
      clearPoll(sessionKey);
    }
    if (view.serverActive || view.command !== 'idle' || view.needsResultConfirmation) schedulePoll(sessionKey);
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
    const previousView = selectSessionRunView(get(), sessionKey);
    const rawPatch: SessionRunRowLike = {
      ...source,
      ...(typeof payload.phase === 'string' ? { phase: payload.phase } : {}),
    };
    const runId =
      (typeof payload.clientRunId === 'string' && payload.clientRunId) ||
      (typeof payload.runId === 'string' && payload.runId) ||
      undefined;
    const stopProjection = projectStoredConfirmedStopCommand({
      ...rawPatch,
      ...(runId ? { runId } : {}),
    }, options.observedAt ?? Date.now());
    const patch: SessionRunRowLike = stopProjection.row;
    if (stopProjection.fact) {
      recordRunTrace({
        source: 'session-store',
        action: 'confirmed-stop-projected',
        sessionKey,
        sessionId: patch.sessionId,
        runId: stopProjection.fact.runId,
        status: rawPatch.status,
        decision: 'killed',
        reason: 'chat.abort-confirmed',
        startedAt: patch.startedAt,
        endedAt: patch.endedAt,
        observedAt: options.observedAt ?? Date.now(),
      });
    }
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
      return { reconciler, ...(settleCommandAgainstAuthority(nextState, sessionKey) ?? {}) };
    });
    const view = selectSessionRunView(get(), sessionKey);
    if (view.needsResultConfirmation && !previousView.needsResultConfirmation) {
      clearPoll(sessionKey);
    }
    if (view.serverActive || view.command !== 'idle' || view.needsResultConfirmation) schedulePoll(sessionKey);
    else clearPoll(sessionKey);
  },

  requestReconcile: (rawSessionKey, reason) => {
    const sessionKey = keyOf(rawSessionKey);
    const gateway = useGatewayStore.getState();
    const client = gateway.client;
    const eventEpoch = gateway.eventEpoch ?? 0;
    const existing = reconcileInFlight.get(sessionKey);
    if (existing?.eventEpoch === eventEpoch) return existing.promise;
    let generation = 0;
    set((state) => {
      const request = beginSessionRunRequest(state.reconciler, sessionKey, { eventEpoch });
      generation = request.generation;
      return { reconciler: request.state };
    });
    recordRunTrace({
      source: 'session-store',
      action: 'reconcile-request',
      sessionKey,
      requestGeneration: generation,
      eventEpoch,
      reason,
      observedAt: Date.now(),
    });

    let promise: Promise<void>;
    promise = (async () => {
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
        const rawRow = result?.sessions?.find((candidate) =>
          keyOf(candidate.key ?? candidate.sessionKey) === sessionKey,
        ) ?? { key: sessionKey };
        const stopProjection = projectStoredConfirmedStopCommand(rawRow);
        const row = stopProjection.row;
        recordRunTrace({
          source: 'session-store',
          action: 'reconcile-response',
          sessionKey,
          sessionId: row.sessionId,
          requestGeneration: generation,
          eventEpoch,
          status: row.status,
          hasActiveRun: row.hasActiveRun,
          startedAt: row.startedAt,
          endedAt: row.endedAt,
          fieldsPresent: Object.keys(row),
          observedAt: Date.now(),
        });
        if (stopProjection.fact) {
          recordRunTrace({
            source: 'session-store',
            action: 'confirmed-stop-projected',
            sessionKey,
            sessionId: row.sessionId,
            runId: stopProjection.fact.runId,
            status: rawRow.status,
            decision: 'killed',
            reason: 'chat.abort-confirmed',
            startedAt: row.startedAt,
            endedAt: row.endedAt,
            observedAt: Date.now(),
          });
        }
        set((state) => {
          const reconciler = reconcileSessionRun(state.reconciler, {
            type: 'snapshot',
            sessionKey,
            requestGeneration: generation,
            eventEpoch,
            observedAt: Date.now(),
            row,
          });
          let nextState = { ...state, reconciler };
          let nextView = selectSessionRunView(nextState, sessionKey);
          const attempts = pollAttempts.get(sessionKey) ?? 0;
          if (
            reason === 'active-poll'
            && nextView.needsResultConfirmation
            && attempts >= RESULT_CONFIRMATION_POLL_DELAYS_MS.length
          ) {
            nextState = {
              ...nextState,
              resultConfirmationExhausted: {
                ...nextState.resultConfirmationExhausted,
                [sessionKey]: true,
              },
            };
            nextView = selectSessionRunView(nextState, sessionKey);
          }
          recordRunTrace({
            source: 'session-store',
            action: 'reconcile-applied',
            sessionKey,
            runId: nextView.localRunId ?? undefined,
            requestGeneration: generation,
            eventEpoch,
            lifecycle: nextView.lifecycle,
            command: nextView.command,
            hasActiveRun: nextView.serverActive,
            decision: nextView.needsResultConfirmation
              ? 'confirm-result'
              : nextView.resultUnconfirmed
                ? 'result-unconfirmed'
                : 'settled',
            observedAt: Date.now(),
          });
          return {
            reconciler,
            resultConfirmationExhausted: nextState.resultConfirmationExhausted,
            ...(settleCommandAgainstAuthority(nextState, sessionKey) ?? {}),
          };
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
      // A request from a dead transport epoch may settle after a reconnect.
      // It must neither delete nor suppress the newer epoch's reconciliation.
      if (reconcileInFlight.get(sessionKey)?.promise !== promise) return;
      reconcileInFlight.delete(sessionKey);
      const view = selectSessionRunView(get(), sessionKey);
      if (view.serverActive || view.command !== 'idle' || view.needsResultConfirmation) schedulePoll(sessionKey);
      else clearPoll(sessionKey);
    });
    reconcileInFlight.set(sessionKey, { eventEpoch, promise });
    return promise;
  },

  requestAbort: (rawSessionKey) => {
    const sessionKey = keyOf(rawSessionKey);
    const localRunId = get().localRunIds[sessionKey];
    const requestedAt = Date.now();
    set((state) => ({
      commands: { ...state.commands, [sessionKey]: 'stopping' },
      pendingAborts: {
        ...state.pendingAborts,
        [sessionKey]: state.pendingAborts[sessionKey] ?? (localRunId ? { runId: localRunId } : {}),
      },
    }));

    const existing = abortInFlight.get(sessionKey);
    if (existing) return existing;
    const gateway = useGatewayStore.getState();
    const client = gateway.client;
    if (!client?.isConnected) return Promise.resolve();
    const eventEpoch = gateway.eventEpoch ?? 0;
    if (abortAttemptedEpoch.get(sessionKey) === eventEpoch) return Promise.resolve();
    abortAttemptedEpoch.set(sessionKey, eventEpoch);

    const pending = get().pendingAborts[sessionKey];
    const params = pending?.runId ? { sessionKey, runId: pending.runId } : { sessionKey };
    const promise = (async () => {
      try {
        let result = await client.request<ChatAbortResponse>('chat.abort', params);
        const shouldRetryBySession = (
          result?.aborted === false
          && Boolean(pending?.runId)
          && selectSessionRunView(get(), sessionKey).serverActive
        );
        if (shouldRetryBySession) {
          recordRunTrace({
            source: 'session-store',
            action: 'abort-response',
            sessionKey,
            runId: pending?.runId,
            eventEpoch,
            decision: 'retry-session-scope',
            observedAt: Date.now(),
            fieldsPresent: result && typeof result === 'object' ? Object.keys(result) : [],
          });
          result = await client.request<ChatAbortResponse>('chat.abort', { sessionKey });
        }
        const gatewaySessionKey = toGatewaySessionKey(sessionKey);
        const shouldRetryCanonicalSession = (
          result?.aborted === false
          && selectSessionRunView(get(), sessionKey).serverActive
          && gatewaySessionKey !== sessionKey
        );
        if (shouldRetryCanonicalSession) {
          recordRunTrace({
            source: 'session-store',
            action: 'abort-response',
            sessionKey,
            eventEpoch,
            decision: 'retry-gateway-session-scope',
            observedAt: Date.now(),
            fieldsPresent: result && typeof result === 'object' ? Object.keys(result) : [],
          });
          result = await client.request<ChatAbortResponse>('chat.abort', {
            sessionKey: gatewaySessionKey,
          });
        }

        const confirmedAt = Date.now();
        const confirmedRunIds = result?.aborted === true && Array.isArray(result.runIds)
          ? result.runIds.filter((value): value is string => (
              typeof value === 'string' && Boolean(value.trim())
            ))
          : [];
        const sessionId = getSessionRunRecord(get().reconciler, sessionKey)?.truth?.sessionId;
        for (const runId of confirmedRunIds) {
          rememberConfirmedStopCommand({
            sessionKey,
            ...(sessionId ? { sessionId } : {}),
            runId,
            requestedAt,
            confirmedAt,
          });
        }
        const terminalRunId = (
          pending?.runId && confirmedRunIds.includes(pending.runId)
            ? pending.runId
            : confirmedRunIds[0]
        );
        if (terminalRunId) {
          get().applyChatTerminal({
            sessionKey,
            runId: terminalRunId,
            ...(sessionId ? { sessionId } : {}),
            status: 'killed',
            eventEpoch,
            observedAt: confirmedAt,
          });
        }
        recordRunTrace({
          source: 'session-store',
          action: 'abort-response',
          sessionKey,
          sessionId,
          runId: terminalRunId ?? pending?.runId,
          eventEpoch,
          decision: terminalRunId ? 'confirmed' : 'not-active',
          observedAt: confirmedAt,
          fieldsPresent: result && typeof result === 'object' ? Object.keys(result) : [],
        });
      } catch (error) {
        console.warn(`[SessionRuns] abort result uncertain for ${sessionKey}:`, error);
        recordRunTrace({
          source: 'session-store',
          action: 'abort-response',
          sessionKey,
          runId: pending?.runId,
          eventEpoch,
          decision: 'uncertain',
          observedAt: Date.now(),
        });
      }
      await get().requestReconcile(sessionKey, 'chat.abort');
    })()
      .finally(() => {
        abortInFlight.delete(sessionKey);
      });
    abortInFlight.set(sessionKey, promise);
    return promise;
  },

  flushPendingAborts: async () => {
    await Promise.all(Object.keys(get().pendingAborts).map((sessionKey) =>
      get().requestAbort(sessionKey),
    ));
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
      return { reconciler, ...(settleCommandAgainstAuthority(nextState, sessionKey) ?? {}) };
    });
  },

  setCommand: (rawSessionKey, command) => {
    const sessionKey = keyOf(rawSessionKey);
    set((state) => ({ commands: { ...state.commands, [sessionKey]: command } }));
    if (command === 'idle') {
      const view = selectSessionRunView(get(), sessionKey);
      if (!view.serverActive && !view.needsResultConfirmation) clearPoll(sessionKey);
    } else {
      schedulePoll(sessionKey);
    }
  },

  setLocalRunId: (rawSessionKey, runId) => {
    const sessionKey = keyOf(rawSessionKey);
    set((state) => {
      const localRunIds = { ...state.localRunIds };
      const currentRunId = state.localRunIds[sessionKey];
      const resultConfirmationExhausted = { ...state.resultConfirmationExhausted };
      let reconciler = state.reconciler;
      if (runId) {
        delete resultConfirmationExhausted[sessionKey];
        localRunIds[sessionKey] = runId;
        const record = getSessionRunRecord(state.reconciler, sessionKey);
        if (!record?.truth || !isSessionRunActive(record.truth)) {
          reconciler = reconcileSessionRun(state.reconciler, {
            type: 'local-start',
            sessionKey,
            runId,
            observedAt: Date.now(),
          });
        }
      }
      else delete localRunIds[sessionKey];
      recordRunTrace({
        source: 'session-store',
        action: runId ? 'local-run-set' : 'local-run-cleared',
        sessionKey,
        runId: runId ?? currentRunId,
        observedAt: Date.now(),
      });
      return { localRunIds, reconciler, resultConfirmationExhausted };
    });
  },

  observeActivity: (observation) => {
    const sessionKey = keyOf(observation.sessionKey);
    set((state) => {
      const record = getSessionRunRecord(state.reconciler, sessionKey);
      if (
        record?.terminal
        && (!observation.runId || observation.runId === record.terminal.runId)
      ) return state;
      return {
        activities: {
          ...state.activities,
          [sessionKey]: { ...observation, sessionKey },
        },
      };
    });
  },

  clearTransient: (rawSessionKey, runId) => {
    const sessionKey = keyOf(rawSessionKey);
    set((state) => {
      const currentRunId = state.localRunIds[sessionKey];
      if (runId && currentRunId && currentRunId !== runId) return state;
      const commands = { ...state.commands, [sessionKey]: 'idle' as const };
      const localRunIds = { ...state.localRunIds };
      const activities = { ...state.activities };
      const pendingAborts = { ...state.pendingAborts };
      const resultConfirmationExhausted = { ...state.resultConfirmationExhausted };
      delete localRunIds[sessionKey];
      delete activities[sessionKey];
      delete pendingAborts[sessionKey];
      delete resultConfirmationExhausted[sessionKey];
      return {
        commands,
        localRunIds,
        activities,
        pendingAborts,
        resultConfirmationExhausted,
      };
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

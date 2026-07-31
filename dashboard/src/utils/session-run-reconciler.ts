import { normalizeSessionKey } from './session-key';
import {
  isSessionRunActive,
  isTerminalSessionRunStatus,
  type SessionRunLifecycle,
  type SessionRunStatus,
  type SessionRunTruth,
} from './session-run-state';

export interface SessionRunTerminalFence {
  status: Exclude<SessionRunLifecycle, 'idle' | 'running' | 'unknown'>;
  occurredAt: number;
  sessionId?: string;
  runId?: string;
  startedAt?: number;
}

export interface SessionRunRecord {
  sessionKey: string;
  truth?: SessionRunTruth;
  queryState: 'unqueried' | 'known' | 'failed';
  requestGeneration: number;
  requestEventEpoch: number;
  lastEventEpoch: number;
  lastEventSeq?: number;
  runId?: string;
  terminal?: SessionRunTerminalFence;
}

export interface SessionRunReconcilerState {
  records: Record<string, SessionRunRecord>;
}

export interface SessionRunRowLike {
  key?: string;
  sessionKey?: string;
  sessionId?: string;
  status?: SessionRunStatus;
  hasActiveRun?: boolean;
  startedAt?: number;
  endedAt?: number;
  runtimeMs?: number;
  phase?: string;
  [key: string]: unknown;
}

interface SnapshotAction {
  type: 'snapshot';
  sessionKey: string;
  requestGeneration: number;
  eventEpoch: number;
  observedAt: number;
  row: SessionRunRowLike;
}

interface EventAction {
  type: 'event';
  sessionKey: string;
  eventEpoch: number;
  seq?: number;
  observedAt: number;
  runId?: string;
  patch: SessionRunRowLike;
}

interface ChatTerminalAction {
  type: 'chat-terminal';
  sessionKey: string;
  eventEpoch: number;
  seq?: number;
  observedAt: number;
  runId?: string;
  sessionId?: string;
  status: 'done' | 'failed' | 'killed' | 'timeout' | 'interrupted';
}

interface QueryFailedAction {
  type: 'query-failed';
  sessionKey: string;
  requestGeneration: number;
  eventEpoch: number;
}

export type SessionRunReconcileAction =
  | SnapshotAction
  | EventAction
  | ChatTerminalAction
  | QueryFailedAction;

function normalizedKey(key: string): string {
  return normalizeSessionKey(key) || key;
}

function createRecord(sessionKey: string): SessionRunRecord {
  return {
    sessionKey,
    queryState: 'unqueried',
    requestGeneration: 0,
    requestEventEpoch: 0,
    lastEventEpoch: 0,
  };
}

function readRecord(
  state: SessionRunReconcilerState,
  sessionKey: string,
): SessionRunRecord {
  return state.records[sessionKey] ?? createRecord(sessionKey);
}

function writeRecord(
  state: SessionRunReconcilerState,
  record: SessionRunRecord,
): SessionRunReconcilerState {
  return {
    ...state,
    records: {
      ...state.records,
      [record.sessionKey]: record,
    },
  };
}

function own<T extends object>(value: T, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function toTruth(
  sessionKey: string,
  row: SessionRunRowLike,
  observedAt: number,
): SessionRunTruth {
  const truth: SessionRunTruth = { sessionKey, observedAt };
  if (typeof row.sessionId === 'string') truth.sessionId = row.sessionId;
  if (row.status) truth.status = row.status;
  if (typeof row.hasActiveRun === 'boolean') truth.hasActiveRun = row.hasActiveRun;
  if (typeof row.startedAt === 'number') truth.startedAt = row.startedAt;
  if (typeof row.endedAt === 'number') truth.endedAt = row.endedAt;
  if (typeof row.runtimeMs === 'number') truth.runtimeMs = row.runtimeMs;
  return truth;
}

function mergeTruth(
  previous: SessionRunTruth | undefined,
  sessionKey: string,
  patch: SessionRunRowLike,
  observedAt: number,
): SessionRunTruth {
  const next: SessionRunTruth = {
    ...(previous ?? { sessionKey, observedAt }),
    sessionKey,
    observedAt,
  };
  for (const field of [
    'sessionId',
    'status',
    'hasActiveRun',
    'startedAt',
    'endedAt',
    'runtimeMs',
  ] as const) {
    if (!own(patch, field)) continue;
    const value = patch[field];
    if (value === undefined) {
      delete next[field];
    } else {
      // The field list fixes the value type for this protocol-only assignment.
      (next as unknown as Record<string, unknown>)[field] = value;
    }
  }
  return next;
}

function isCursorNewer(
  record: SessionRunRecord,
  eventEpoch: number,
  seq: number | undefined,
): boolean {
  if (eventEpoch < record.lastEventEpoch) return false;
  if (
    eventEpoch === record.lastEventEpoch &&
    seq !== undefined &&
    record.lastEventSeq !== undefined &&
    seq <= record.lastEventSeq
  ) {
    return false;
  }
  return true;
}

function withCursor(
  record: SessionRunRecord,
  eventEpoch: number,
  seq: number | undefined,
): SessionRunRecord {
  return {
    ...record,
    lastEventEpoch: Math.max(record.lastEventEpoch, eventEpoch),
    ...(seq === undefined ? {} : { lastEventSeq: seq }),
  };
}

function terminalFromTruth(
  truth: SessionRunTruth,
  occurredAt: number,
  runId?: string,
): SessionRunTerminalFence | undefined {
  if (!isTerminalSessionRunStatus(truth.status)) return undefined;
  return {
    status: truth.status,
    occurredAt,
    ...(truth.sessionId ? { sessionId: truth.sessionId } : {}),
    ...(runId ? { runId } : {}),
    ...(typeof truth.startedAt === 'number' ? { startedAt: truth.startedAt } : {}),
  };
}

function isNewGeneration(
  record: SessionRunRecord,
  next: SessionRunTruth,
  runId?: string,
): boolean {
  const terminal = record.terminal;
  if (!terminal) return false;
  if (runId && terminal.runId && runId !== terminal.runId) return true;
  if (next.sessionId && terminal.sessionId && next.sessionId !== terminal.sessionId) return true;
  return typeof next.startedAt === 'number' && next.startedAt > terminal.occurredAt;
}

function shouldIgnoreMismatchedGeneration(
  record: SessionRunRecord,
  patch: SessionRunRowLike,
  runId?: string,
): boolean {
  const currentSessionId = record.truth?.sessionId;
  const incomingSessionId = patch.sessionId;
  const currentRunId = record.runId;
  const sessionMismatch = Boolean(
    currentSessionId && incomingSessionId && currentSessionId !== incomingSessionId,
  );
  const runMismatch = Boolean(currentRunId && runId && currentRunId !== runId);
  if (!sessionMismatch && !runMismatch) return false;

  const explicitStart = patch.phase === 'start' || patch.status === 'running';
  const newerStart =
    typeof patch.startedAt === 'number' &&
    patch.startedAt > (record.truth?.startedAt ?? record.terminal?.occurredAt ?? 0);
  return !(explicitStart && newerStart);
}

export function createSessionRunReconcilerState(): SessionRunReconcilerState {
  return { records: {} };
}

export function beginSessionRunRequest(
  state: SessionRunReconcilerState,
  rawSessionKey: string,
  options: { eventEpoch: number },
): { state: SessionRunReconcilerState; generation: number } {
  const sessionKey = normalizedKey(rawSessionKey);
  const current = readRecord(state, sessionKey);
  const generation = current.requestGeneration + 1;
  return {
    generation,
    state: writeRecord(state, {
      ...current,
      requestGeneration: generation,
      requestEventEpoch: options.eventEpoch,
    }),
  };
}

export function getSessionRunRecord(
  state: SessionRunReconcilerState,
  rawSessionKey: string,
): SessionRunRecord | undefined {
  return state.records[normalizedKey(rawSessionKey)];
}

export function getSessionRunLifecycle(
  record: SessionRunRecord | undefined,
): SessionRunLifecycle {
  if (!record) return 'unknown';
  if (isTerminalSessionRunStatus(record.truth?.status)) return record.truth.status;
  if (record.terminal) return record.terminal.status;
  if (record.truth && isSessionRunActive(record.truth)) return 'running';
  if (record.truth?.status === 'running' && record.truth.hasActiveRun === false) return 'unknown';
  if (record.queryState === 'known') return 'idle';
  return 'unknown';
}

export function reconcileSessionRun(
  state: SessionRunReconcilerState,
  action: SessionRunReconcileAction,
): SessionRunReconcilerState {
  const sessionKey = normalizedKey(action.sessionKey);
  const current = readRecord(state, sessionKey);

  if (action.type === 'snapshot') {
    if (
      action.requestGeneration !== current.requestGeneration ||
      action.eventEpoch < current.requestEventEpoch ||
      action.eventEpoch < current.lastEventEpoch
    ) {
      return state;
    }
    const truth = toTruth(sessionKey, action.row, action.observedAt);
    if (current.terminal && isSessionRunActive(truth) && !isNewGeneration(current, truth)) {
      return writeRecord(state, { ...current, queryState: 'known' });
    }
    const terminal = terminalFromTruth(truth, action.observedAt, current.runId);
    return writeRecord(state, {
      ...current,
      truth,
      queryState: 'known',
      ...(terminal ? { terminal } : { terminal: undefined }),
    });
  }

  if (action.type === 'query-failed') {
    if (
      action.requestGeneration !== current.requestGeneration ||
      action.eventEpoch < current.requestEventEpoch
    ) {
      return state;
    }
    return writeRecord(state, { ...current, queryState: 'failed' });
  }

  if (!isCursorNewer(current, action.eventEpoch, action.seq)) return state;
  const cursorRecord = withCursor(current, action.eventEpoch, action.seq);

  if (action.type === 'chat-terminal') {
    if (cursorRecord.runId && action.runId && cursorRecord.runId !== action.runId) {
      return writeRecord(state, cursorRecord);
    }
    const truth = mergeTruth(
      cursorRecord.truth,
      sessionKey,
      {
        ...(action.sessionId ? { sessionId: action.sessionId } : {}),
        ...(action.status === 'interrupted' ? {} : { status: action.status }),
        hasActiveRun: false,
        endedAt: action.observedAt,
      },
      action.observedAt,
    );
    return writeRecord(state, {
      ...cursorRecord,
      truth,
      queryState: 'known',
      runId: action.runId ?? cursorRecord.runId,
      terminal: {
        status: action.status,
        occurredAt: action.observedAt,
        ...(action.sessionId ? { sessionId: action.sessionId } : {}),
        ...(action.runId ? { runId: action.runId } : {}),
        ...(typeof truth.startedAt === 'number' ? { startedAt: truth.startedAt } : {}),
      },
    });
  }

  if (shouldIgnoreMismatchedGeneration(cursorRecord, action.patch, action.runId)) {
    return writeRecord(state, cursorRecord);
  }

  const generationChanged = Boolean(
    (cursorRecord.truth?.sessionId &&
      action.patch.sessionId &&
      cursorRecord.truth.sessionId !== action.patch.sessionId) ||
      (cursorRecord.runId && action.runId && cursorRecord.runId !== action.runId),
  );
  let truth = mergeTruth(
    generationChanged ? undefined : cursorRecord.truth,
    sessionKey,
    action.patch,
    action.observedAt,
  );
  if (isTerminalSessionRunStatus(truth.status) && !own(action.patch, 'hasActiveRun')) {
    truth = { ...truth, hasActiveRun: false };
  } else if (action.patch.phase === 'start' && !own(action.patch, 'hasActiveRun')) {
    truth = { ...truth, hasActiveRun: true };
  }

  if (cursorRecord.terminal && isSessionRunActive(truth)) {
    if (!isNewGeneration(cursorRecord, truth, action.runId)) {
      return writeRecord(state, cursorRecord);
    }
  }

  const terminal = terminalFromTruth(truth, action.observedAt, action.runId);
  return writeRecord(state, {
    ...cursorRecord,
    truth,
    queryState: 'known',
    runId: action.runId ?? (generationChanged ? undefined : cursorRecord.runId),
    ...(terminal ? { terminal } : { terminal: undefined }),
  });
}


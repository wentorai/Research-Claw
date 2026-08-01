/**
 * Opt-in, metadata-only trace for RC run-state reconciliation.
 *
 * Enable for a manual acceptance session with either:
 *   - `?rc-run-trace=1`, or
 *   - localStorage.setItem('rc-run-trace-enabled', '1')
 *
 * The trace intentionally has no generic payload field. Message text, tool
 * arguments, file paths, provider errors, and secrets must never enter it.
 */

export const RUN_TRACE_QUERY_PARAM = 'rc-run-trace';
export const RUN_TRACE_STORAGE_KEY = 'rc-run-trace-enabled';
export const RUN_TRACE_MAX_ENTRIES = 2_000;
export const RUN_TRACE_DOM_ID = 'rc-run-trace-snapshot';

export type RunTraceSource =
  | 'chat'
  | 'gateway'
  | 'history'
  | 'session-reconciler'
  | 'session-store'
  | 'tool-stream'
  | 'jobs';

export interface RunTraceInput {
  source: RunTraceSource;
  action: string;
  sessionKey?: string;
  sessionId?: string;
  runId?: string;
  requestGeneration?: number;
  eventEpoch?: number;
  seq?: number;
  status?: string;
  hasActiveRun?: boolean;
  lifecycle?: string;
  command?: string;
  decision?: string;
  reason?: string;
  startedAt?: number;
  endedAt?: number;
  observedAt?: number;
  fieldsPresent?: string[];
}

export interface RunTraceEntry extends RunTraceInput {
  traceSeq: number;
  capturedAt: number;
}

export interface RunTraceProbeApi {
  snapshot: () => RunTraceEntry[];
  clear: () => void;
  enabled: () => boolean;
}

declare global {
  interface Window {
    __RC_RUN_TRACE__?: RunTraceProbeApi;
  }
}

let entries: RunTraceEntry[] = [];
let nextTraceSeq = 1;
let forcedEnabledForTests: boolean | null = null;

function safeWindow(): Window | null {
  return typeof window === 'undefined' ? null : window;
}

function browserConfigured(): boolean {
  const current = safeWindow();
  if (!current) return false;
  try {
    if (new URLSearchParams(current.location.search).get(RUN_TRACE_QUERY_PARAM) === '1') {
      return true;
    }
    return current.localStorage.getItem(RUN_TRACE_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function isRunTraceEnabled(): boolean {
  return forcedEnabledForTests ?? browserConfigured();
}

function boundedText(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.slice(0, 240);
}

function finiteNumber(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function sanitize(input: RunTraceInput): RunTraceInput {
  return {
    source: input.source,
    action: boundedText(input.action) ?? 'unknown',
    ...(boundedText(input.sessionKey) ? { sessionKey: boundedText(input.sessionKey) } : {}),
    ...(boundedText(input.sessionId) ? { sessionId: boundedText(input.sessionId) } : {}),
    ...(boundedText(input.runId) ? { runId: boundedText(input.runId) } : {}),
    ...(finiteNumber(input.requestGeneration) !== undefined
      ? { requestGeneration: finiteNumber(input.requestGeneration) }
      : {}),
    ...(finiteNumber(input.eventEpoch) !== undefined ? { eventEpoch: finiteNumber(input.eventEpoch) } : {}),
    ...(finiteNumber(input.seq) !== undefined ? { seq: finiteNumber(input.seq) } : {}),
    ...(boundedText(input.status) ? { status: boundedText(input.status) } : {}),
    ...(typeof input.hasActiveRun === 'boolean' ? { hasActiveRun: input.hasActiveRun } : {}),
    ...(boundedText(input.lifecycle) ? { lifecycle: boundedText(input.lifecycle) } : {}),
    ...(boundedText(input.command) ? { command: boundedText(input.command) } : {}),
    ...(boundedText(input.decision) ? { decision: boundedText(input.decision) } : {}),
    ...(boundedText(input.reason) ? { reason: boundedText(input.reason) } : {}),
    ...(finiteNumber(input.startedAt) !== undefined ? { startedAt: finiteNumber(input.startedAt) } : {}),
    ...(finiteNumber(input.endedAt) !== undefined ? { endedAt: finiteNumber(input.endedAt) } : {}),
    ...(finiteNumber(input.observedAt) !== undefined ? { observedAt: finiteNumber(input.observedAt) } : {}),
    ...(input.fieldsPresent
      ? {
          fieldsPresent: input.fieldsPresent
            .filter((field): field is string => typeof field === 'string')
            .map((field) => field.slice(0, 80))
            .slice(0, 40),
        }
      : {}),
  };
}

/**
 * Browser-control automation evaluates in an isolated world, so it cannot see
 * the main-world Window API below. When (and only when) the trace is explicitly
 * enabled, mirror the same metadata-only snapshot into a hidden JSON element.
 * This is an acceptance probe, not an application state source.
 */
function publishDomSnapshot(): void {
  const current = safeWindow();
  if (!current || !isRunTraceEnabled()) return;
  const document = current.document;
  let element = document.getElementById(RUN_TRACE_DOM_ID);
  if (!element) {
    element = document.createElement('script');
    element.id = RUN_TRACE_DOM_ID;
    element.setAttribute('type', 'application/json');
    element.setAttribute('data-rc-acceptance-probe', 'run-trace');
    document.head.appendChild(element);
  }
  element.textContent = JSON.stringify(entries);
}

export function recordRunTrace(input: RunTraceInput): void {
  if (!isRunTraceEnabled()) return;
  const entry: RunTraceEntry = {
    ...sanitize(input),
    traceSeq: nextTraceSeq++,
    capturedAt: Date.now(),
  };
  entries = [...entries.slice(-(RUN_TRACE_MAX_ENTRIES - 1)), entry];
  publishDomSnapshot();
}

export function getRunTraceSnapshot(): RunTraceEntry[] {
  return entries.map((entry) => ({
    ...entry,
    ...(entry.fieldsPresent ? { fieldsPresent: [...entry.fieldsPresent] } : {}),
  }));
}

export function clearRunTrace(): void {
  entries = [];
  nextTraceSeq = 1;
  publishDomSnapshot();
}

export function installRunTraceProbe(): void {
  const current = safeWindow();
  if (!current || current.__RC_RUN_TRACE__) return;
  current.__RC_RUN_TRACE__ = {
    snapshot: getRunTraceSnapshot,
    clear: clearRunTrace,
    enabled: isRunTraceEnabled,
  };
  publishDomSnapshot();
}

/** Test-only switch; null restores the real query/localStorage gate. */
export function _setRunTraceEnabledForTests(value: boolean | null): void {
  forcedEnabledForTests = value;
}

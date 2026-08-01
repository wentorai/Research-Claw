import type { SessionRunRowLike } from './session-run-reconciler';
import { normalizeSessionKey } from './session-key';

/**
 * A successful `chat.abort` receipt is command-channel evidence, not a second
 * lifecycle store. OC 2026.6.1 can emit killed/stopReason:"rpc" and then
 * persist the same run as timeout; neither chat.history nor sessions.list
 * retains that stop reason after F5. Keeping the small confirmed receipt lets
 * RC preserve the causal classification while OC remains authoritative for
 * whether a run is active.
 */
export interface ConfirmedStopCommand {
  sessionKey: string;
  sessionId?: string;
  runId: string;
  requestedAt: number;
  confirmedAt: number;
}

type StopProjectableRow = SessionRunRowLike & { runId?: string };

const STORAGE_KEY = 'rc-confirmed-stop-commands-v1';
const MAX_FACTS = 64;
const FACT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CLOCK_SKEW_MS = 2_000;

function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function parseFact(value: unknown): ConfirmedStopCommand | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Partial<ConfirmedStopCommand>;
  if (
    typeof item.sessionKey !== 'string'
    || typeof item.runId !== 'string'
    || !item.sessionKey.trim()
    || !item.runId.trim()
    || !isFiniteTimestamp(item.requestedAt)
    || !isFiniteTimestamp(item.confirmedAt)
    || item.confirmedAt + CLOCK_SKEW_MS < item.requestedAt
    || (item.sessionId !== undefined && typeof item.sessionId !== 'string')
  ) return null;
  return {
    sessionKey: normalizeSessionKey(item.sessionKey) || item.sessionKey,
    ...(item.sessionId ? { sessionId: item.sessionId } : {}),
    runId: item.runId,
    requestedAt: item.requestedAt,
    confirmedAt: item.confirmedAt,
  };
}

function readFacts(now = Date.now()): ConfirmedStopCommand[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(parseFact)
      .filter((fact): fact is ConfirmedStopCommand => Boolean(
        fact && now - fact.confirmedAt <= FACT_TTL_MS,
      ))
      .slice(-MAX_FACTS);
  } catch {
    return [];
  }
}

function writeFacts(facts: ConfirmedStopCommand[]): void {
  if (typeof localStorage === 'undefined') return;
  try {
    if (facts.length === 0) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(facts.slice(-MAX_FACTS)));
  } catch {
    // Command evidence improves F5 recovery; storage denial must not break Stop.
  }
}

export function rememberConfirmedStopCommand(fact: ConfirmedStopCommand): void {
  const normalized = parseFact(fact);
  if (!normalized) return;
  const facts = readFacts(normalized.confirmedAt).filter((candidate) => !(
    candidate.sessionKey === normalized.sessionKey
    && candidate.runId === normalized.runId
  ));
  facts.push(normalized);
  writeFacts(facts);
}

export function clearConfirmedStopCommands(rawSessionKey: string): void {
  const sessionKey = normalizeSessionKey(rawSessionKey) || rawSessionKey;
  writeFacts(readFacts().filter((fact) => fact.sessionKey !== sessionKey));
}

function factMatchesSnapshot(
  row: StopProjectableRow,
  fact: ConfirmedStopCommand,
): boolean {
  const rowKey = normalizeSessionKey(row.key ?? row.sessionKey) || row.key || row.sessionKey;
  if (!rowKey || rowKey !== normalizeSessionKey(fact.sessionKey)) return false;
  if (row.status !== 'timeout' || row.hasActiveRun === true) return false;
  // Complete snapshots must explicitly confirm inactivity. The live
  // `sessions.changed` terminal payload omits hasActiveRun but includes the
  // exact runId, which is equally strong generation evidence for this narrow
  // command-cause projection.
  if (row.hasActiveRun !== false && !row.runId) return false;
  if (!isFiniteTimestamp(row.startedAt) || !isFiniteTimestamp(row.endedAt)) return false;
  if (row.runId && row.runId !== fact.runId) return false;
  if (row.sessionId && fact.sessionId && row.sessionId !== fact.sessionId) return false;

  // The confirmed Stop must fall inside this exact OC lifecycle interval.
  // This rejects stale prior terminals and later same-session generations.
  return (
    row.startedAt <= fact.requestedAt
    && row.endedAt + CLOCK_SKEW_MS >= fact.requestedAt
  );
}

export function projectConfirmedStopCommand<T extends StopProjectableRow>(
  row: T,
  fact: ConfirmedStopCommand,
): T {
  if (!factMatchesSnapshot(row, fact)) return row;
  return { ...row, status: 'killed' };
}

export function projectStoredConfirmedStopCommand<T extends StopProjectableRow>(
  row: T,
  now = Date.now(),
): { row: T; fact?: ConfirmedStopCommand } {
  const facts = readFacts(now);
  for (let index = facts.length - 1; index >= 0; index -= 1) {
    const fact = facts[index];
    const projected = projectConfirmedStopCommand(row, fact);
    if (projected !== row) return { row: projected, fact };
  }
  return { row };
}

/** Test-only storage reset. */
export function resetConfirmedStopCommandsForTests(): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.removeItem(STORAGE_KEY);
}

/**
 * Mirrors OpenClaw session reset freshness (reset-policy.ts / evaluateSessionFreshness).
 * Used to warn before chat.send rolls over a stale transcript.
 */

export type SessionResetMode = 'daily' | 'idle';

export interface SessionResetPolicy {
  mode: SessionResetMode;
  atHour: number;
  idleMinutes?: number;
}

export interface SessionFreshnessInput {
  updatedAt?: number;
  sessionStartedAt?: number;
  lastInteractionAt?: number;
  now?: number;
}

export interface SessionFreshnessResult {
  fresh: boolean;
  staleReason?: 'daily' | 'idle';
  idleExpiresAt?: number;
}

const DEFAULT_AT_HOUR = 4;

export function readSessionResetPolicy(
  config: Record<string, unknown> | null | undefined,
): SessionResetPolicy {
  const session = config?.session as Record<string, unknown> | undefined;
  const reset = session?.reset as Record<string, unknown> | undefined;
  const legacyIdle = session?.idleMinutes;

  const modeRaw = reset?.mode;
  const mode: SessionResetMode =
    modeRaw === 'idle' || modeRaw === 'daily'
      ? modeRaw
      : typeof legacyIdle === 'number'
        ? 'idle'
        : 'daily';

  const atHour = normalizeResetAtHour(reset?.atHour);

  let idleMinutes: number | undefined;
  const idleRaw = reset?.idleMinutes ?? (mode === 'idle' && typeof legacyIdle === 'number' ? legacyIdle : undefined);
  if (typeof idleRaw === 'number' && Number.isFinite(idleRaw)) {
    idleMinutes = Math.max(0, Math.floor(idleRaw));
  } else if (mode === 'idle') {
    idleMinutes = 0;
  }

  return { mode, atHour, idleMinutes };
}

export function evaluateSessionFreshness(
  input: SessionFreshnessInput,
  policy: SessionResetPolicy,
): SessionFreshnessResult {
  const now = input.now ?? Date.now();
  const updatedAt = resolveTimestamp(input.updatedAt, now) ?? 0;
  const sessionStartedAt = resolveTimestamp(input.sessionStartedAt, now) ?? updatedAt;
  const lastInteractionAt = resolveTimestamp(input.lastInteractionAt, now) ?? sessionStartedAt;

  const dailyResetAt =
    policy.mode === 'daily' ? resolveDailyResetAtMs(now, policy.atHour) : undefined;
  const idleExpiresAt =
    policy.idleMinutes != null && policy.idleMinutes > 0
      ? lastInteractionAt + policy.idleMinutes * 60_000
      : undefined;

  const staleDaily = dailyResetAt != null && sessionStartedAt < dailyResetAt;
  const staleIdle = idleExpiresAt != null && now > idleExpiresAt;

  const staleReason =
    staleDaily && staleIdle
      ? (dailyResetAt ?? Number.POSITIVE_INFINITY) <= (idleExpiresAt ?? Number.POSITIVE_INFINITY)
        ? 'daily'
        : 'idle'
      : staleIdle
        ? 'idle'
        : staleDaily
          ? 'daily'
          : undefined;

  return {
    fresh: !(staleDaily || staleIdle),
    staleReason,
    idleExpiresAt,
  };
}

export function isSessionRowStale(
  row: { updatedAt?: number; sessionStartedAt?: number; lastInteractionAt?: number },
  policy: SessionResetPolicy,
  now?: number,
): boolean {
  return !evaluateSessionFreshness(
    {
      updatedAt: row.updatedAt,
      sessionStartedAt: row.sessionStartedAt,
      lastInteractionAt: row.lastInteractionAt,
      now,
    },
    policy,
  ).fresh;
}

function resolveDailyResetAtMs(now: number, atHour: number): number {
  const resetAt = new Date(now);
  resetAt.setHours(atHour, 0, 0, 0);
  if (now < resetAt.getTime()) {
    resetAt.setDate(resetAt.getDate() - 1);
  }
  return resetAt.getTime();
}

function resolveTimestamp(value: number | undefined, now: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  if (value > now) return undefined;
  return value;
}

function normalizeResetAtHour(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_AT_HOUR;
  const normalized = Math.floor(value);
  if (normalized < 0) return 0;
  if (normalized > 23) return 23;
  return normalized;
}

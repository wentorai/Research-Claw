/**
 * Chat error event fixtures.
 *
 * errorMessage texts are REAL payloads captured from a production gateway log
 * (/tmp/openclaw/openclaw-2026-07-23.log) — do not "clean them up": the
 * classifier must work against exactly what providers/relays emit.
 *
 * Schema reference: openclaw/packages/gateway-protocol/src/schema/logs-chat.ts
 * (ChatErrorEventSchema: errorMessage?: string, errorKind?: "refusal" |
 * "timeout" | "rate_limit" | "context_length" | "unknown").
 */
import type { ChatStreamEvent } from '../../gateway/types';

const base = { sessionKey: 'main', state: 'error' as const };

/** Relay auth failure — user-fixable (wrong key / base URL). No errorKind:
 *  OC detectErrorKind() does not recognize 401 and omits/sends "unknown". */
export const ERROR_AUTH_401: ChatStreamEvent = {
  ...base,
  runId: 'run-err-auth',
  errorMessage: 'Embedded agent failed before reply: HTTP 401: Invalid Authentication',
};

/** Same auth failure in its FailoverError wrapper form. */
export const ERROR_AUTH_401_FAILOVER: ChatStreamEvent = {
  ...base,
  runId: 'run-err-auth-2',
  errorMessage: 'FailoverError: HTTP 401: Invalid Authentication',
  errorKind: 'unknown',
};

/** Provider rate limit — classified upstream by detectErrorKind(). */
export const ERROR_RATE_LIMIT: ChatStreamEvent = {
  ...base,
  runId: 'run-err-rate',
  errorMessage: '⚠️ API rate limit reached. Please try again later.',
  errorKind: 'rate_limit',
};

/** Model call timeout with upstream classification. */
export const ERROR_TIMEOUT_KIND: ChatStreamEvent = {
  ...base,
  runId: 'run-err-timeout',
  errorMessage: 'Chat run timed out',
  errorKind: 'timeout',
};

/** Local network failure (gateway cannot reach the API at all). */
export const ERROR_NETWORK: ChatStreamEvent = {
  ...base,
  runId: 'run-err-net',
  errorMessage: 'fetch failed: connect ECONNREFUSED 127.0.0.1:8443',
};

/** Context overflow with upstream classification. */
export const ERROR_CONTEXT_OVERFLOW: ChatStreamEvent = {
  ...base,
  runId: 'run-err-ctx',
  errorMessage: 'context overflow: prompt too large for the model',
  errorKind: 'context_length',
};

/** errorKind must win over text sniffing when both are present. */
export const ERROR_KIND_PRECEDENCE: ChatStreamEvent = {
  ...base,
  runId: 'run-err-precedence',
  errorMessage: 'HTTP 401: Invalid Authentication',
  errorKind: 'timeout',
};

/** Unclassifiable error — raw text must be preserved verbatim. */
export const ERROR_UNKNOWN: ChatStreamEvent = {
  ...base,
  runId: 'run-err-unknown',
  errorMessage: 'Something exploded in a novel way',
};

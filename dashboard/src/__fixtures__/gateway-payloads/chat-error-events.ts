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

/** Real gateway text emitted when the provider times out before producing a reply. */
export const ERROR_TIMEOUT_TEXT: ChatStreamEvent = {
  ...base,
  runId: 'run-err-timeout-text',
  errorMessage: 'LLM request failed. | Request timed out before a response was generated.',
};

/**
 * Captured from an isolated OpenClaw 2026.6.1 gateway against a deliberately
 * hanging OpenAI-compatible endpoint. The gateway emitted an empty `final`
 * event first, then this lower-sequence `error` event without `errorKind`.
 */
export const FINAL_BEFORE_TIMEOUT_ERROR: ChatStreamEvent & { seq: number } = {
  sessionKey: 'main',
  runId: 'run-idle-timeout-real',
  seq: 2,
  state: 'final',
};

export const ERROR_TIMEOUT_IDLE_REAL: ChatStreamEvent & { seq: number } = {
  sessionKey: 'main',
  runId: 'run-idle-timeout-real',
  seq: 1,
  state: 'error',
  errorMessage:
    'LLM request timed out. | The model did not produce a response before the model idle timeout. Please try again, or increase `models.providers.<id>.timeoutSeconds` for slow local or self-hosted providers. If `agents.defaults.timeoutSeconds` or a run-specific timeout is lower, raise that ceiling too; provider timeouts cannot extend the whole agent run.',
  message: {
    role: 'assistant',
    content: [{
      type: 'text',
      text:
        'Error: LLM request timed out. | The model did not produce a response before the model idle timeout. Please try again, or increase `models.providers.<id>.timeoutSeconds` for slow local or self-hosted providers. If `agents.defaults.timeoutSeconds` or a run-specific timeout is lower, raise that ceiling too; provider timeouts cannot extend the whole agent run.',
    }],
    timestamp: 1784915466738,
  },
};

/** Undici/provider abort text. OpenClaw currently sends no errorKind for this shape. */
export const ERROR_ABORTED_TEXT: ChatStreamEvent = {
  ...base,
  runId: 'run-err-aborted-text',
  errorMessage: 'This operation was aborted',
};

/** Relay rate-limit response without OpenClaw's optional errorKind. */
export const ERROR_RATE_LIMIT_TEXT: ChatStreamEvent = {
  ...base,
  runId: 'run-err-rate-text',
  errorMessage: 'HTTP 429: API rate limit reached. Please try again later.',
};

/** Relay authorization response without errorKind. */
export const ERROR_AUTH_403_TEXT: ChatStreamEvent = {
  ...base,
  runId: 'run-err-auth-403-text',
  errorMessage: 'HTTP 403: Forbidden',
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

/** Upstream refusal classification (the text itself is intentionally generic). */
export const ERROR_REFUSAL: ChatStreamEvent = {
  ...base,
  runId: 'run-err-refusal',
  errorMessage: 'The model declined to answer',
  errorKind: 'refusal',
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

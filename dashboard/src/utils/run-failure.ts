/**
 * Chat run failure classification.
 *
 * Turns a gateway error (errorKind + errorMessage) into a user-facing
 * diagnosis: what likely went wrong, what to do next, and whether a
 * plain resend is a sensible recovery.
 *
 * Precedence: the gateway's own errorKind (ChatErrorEventSchema) wins;
 * text sniffing is the fallback because OC's detectErrorKind() maps
 * auth (401/403) and local network failures to "unknown" — and those
 * are exactly the cases the user can fix themselves.
 *
 * Regexes are anchored on REAL error texts observed in production logs
 * (see __fixtures__/gateway-payloads/chat-error-events.ts).
 */
import i18n from '../i18n';

export type RunFailureKind =
  | 'auth'
  | 'network'
  | 'timeout'
  | 'rate_limit'
  | 'context_overflow'
  | 'refusal'
  | 'unknown';

export interface RunFailureInfo {
  kind: RunFailureKind;
  /** User-facing summary (translated). */
  message: string;
  /** Actionable next step (translated); null when there is none. */
  suggestion: string | null;
  /** Whether resending the same message is a sensible recovery action. */
  retryable: boolean;
  /** Raw gateway error text, shown in the collapsible details block. */
  raw: string;
}

export const CONTEXT_OVERFLOW_RE = /context overflow|prompt too large|too large for the model/i;
const AUTH_RE =
  /http\s*40[13]\b|invalid\s+authentication|unauthorized|invalid\s*api[\s_-]?key|incorrect\s*api\s*key|missing\s*api\s*key|forbidden/i;
const RATE_LIMIT_RE = /\b429\b|rate.?limit|too many requests|quota exceeded/i;
const NETWORK_RE =
  /econnrefused|enotfound|econnreset|eai_again|epipe|fetch failed|socket hang up|network error|self.?signed certificate|certificate has expired|getaddrinfo/i;
const TIMEOUT_RE = /\btimed?\s*out\b|timeout|etimedout/i;

function kindFromErrorKind(errorKind?: string): RunFailureKind | null {
  switch (errorKind) {
    case 'timeout':
      return 'timeout';
    case 'rate_limit':
      return 'rate_limit';
    case 'context_length':
      return 'context_overflow';
    case 'refusal':
      return 'refusal';
    default:
      // "unknown" (and absence) intentionally falls through to text sniffing.
      return null;
  }
}

function kindFromText(raw: string): RunFailureKind {
  if (CONTEXT_OVERFLOW_RE.test(raw)) return 'context_overflow';
  if (AUTH_RE.test(raw)) return 'auth';
  if (RATE_LIMIT_RE.test(raw)) return 'rate_limit';
  if (NETWORK_RE.test(raw)) return 'network';
  if (TIMEOUT_RE.test(raw)) return 'timeout';
  return 'unknown';
}

export function classifyRunFailure(rawInput: string, errorKind?: string): RunFailureInfo {
  const raw = (rawInput ?? '').trim();
  if (!raw) {
    return {
      kind: 'unknown',
      message: i18n.t('chat.runEndedNoOutput'),
      suggestion: null,
      retryable: true,
      raw: '',
    };
  }
  const kind = kindFromErrorKind(errorKind) ?? kindFromText(raw);
  switch (kind) {
    case 'auth':
      return {
        kind,
        message: i18n.t('chat.failAuth'),
        suggestion: i18n.t('chat.failAuthSuggestion'),
        retryable: true,
        raw,
      };
    case 'network':
      return {
        kind,
        message: i18n.t('chat.failNetwork'),
        suggestion: i18n.t('chat.failNetworkSuggestion'),
        retryable: true,
        raw,
      };
    case 'rate_limit':
      return {
        kind,
        message: i18n.t('chat.failRateLimit'),
        suggestion: i18n.t('chat.failRateLimitSuggestion'),
        retryable: true,
        raw,
      };
    case 'timeout':
      return {
        kind,
        message: i18n.t('chat.failTimeout'),
        suggestion: i18n.t('chat.failTimeoutSuggestion'),
        retryable: true,
        raw,
      };
    case 'context_overflow':
      // chat.contextOverflow already carries the /new + switch-model advice.
      return {
        kind,
        message: i18n.t('chat.contextOverflow'),
        suggestion: null,
        retryable: false,
        raw,
      };
    case 'refusal':
      return {
        kind,
        message: i18n.t('chat.failRefusal'),
        suggestion: i18n.t('chat.failRefusalSuggestion'),
        retryable: false,
        raw,
      };
    default:
      // Preserve legacy behavior: unknown errors surface verbatim.
      return { kind: 'unknown', message: raw, suggestion: null, retryable: true, raw };
  }
}

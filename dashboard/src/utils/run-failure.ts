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
  | 'billing'
  | 'model_not_found'
  | 'network'
  | 'timeout'
  | 'rate_limit'
  | 'aborted'
  | 'context_overflow'
  | 'refusal'
  | 'unknown';

/**
 * Recovery category — a route, not a synonym for failure kind.
 *
 * The same timeout is "transient-self-healing" while a background scheduler is
 * still retrying, "foreground-resend" after a foreground run exhausts failover
 * without output, or "foreground-continue" when partial output survived.
 */
export type RecoveryCategory =
  | 'transient-self-healing'
  | 'config-fixable'
  | 'foreground-resend'
  | 'foreground-continue'
  | 'unrecoverable';

export interface RecoveryContext {
  origin?: 'foreground' | 'background';
  hasPartialOutput?: boolean;
}

export function recoveryCategory(
  kind: RunFailureKind,
  context: RecoveryContext = {},
): RecoveryCategory {
  switch (kind) {
    case 'auth':
    case 'billing':
    case 'model_not_found':
      return 'config-fixable';
    case 'context_overflow':
    case 'refusal':
      return 'unrecoverable';
  }
  if (context.origin === 'background') return 'transient-self-healing';
  return context.hasPartialOutput ? 'foreground-continue' : 'foreground-resend';
}

export interface RunFailureInfo {
  kind: RunFailureKind;
  /** Recovery category — the Alert routes buttons by this, not by a flat retryable flag. */
  category: RecoveryCategory;
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
const BILLING_RE =
  /payment required|insufficient (?:balance|credit|credits)|credit balance|billing|account (?:balance|quota)|quota exceeded/i;
const MODEL_NOT_FOUND_RE =
  /model[_\s-]?not[_\s-]?found|unknown model|model (?:does not exist|is unavailable|is not available)|invalid model/i;
const RATE_LIMIT_RE = /\b429\b|rate.?limit|too many requests|quota exceeded/i;
const NETWORK_RE =
  /http\s*5\d\d\b|bad gateway|service unavailable|internal server error|econnrefused|enotfound|econnreset|eai_again|epipe|fetch failed|socket hang up|network error|self.?signed certificate|certificate has expired|getaddrinfo|cloudflare/i;
const TIMEOUT_RE = /\btimed?\s*out\b|timeout|etimedout/i;
// Provider/undici abort text ("This operation was aborted", "request aborted").
// Distinct from a user-cancel — at classification level an aborted run with no
// output is transient and should be resendable, not left to the default branch.
const ABORT_RE = /\b(aborted|operation was aborted|request aborted)\b/i;

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
  if (MODEL_NOT_FOUND_RE.test(raw)) return 'model_not_found';
  if (BILLING_RE.test(raw)) return 'billing';
  if (RATE_LIMIT_RE.test(raw)) return 'rate_limit';
  if (NETWORK_RE.test(raw)) return 'network';
  if (TIMEOUT_RE.test(raw)) return 'timeout';
  if (ABORT_RE.test(raw)) return 'aborted';
  return 'unknown';
}

/** kind → {message, suggestion, retryable}. category is injected by classifyRunFailure. */
function infoForKind(kind: RunFailureKind, raw: string): Omit<RunFailureInfo, 'category' | 'raw'> {
  switch (kind) {
    case 'auth':
      return { kind, message: i18n.t('chat.failAuth'), suggestion: i18n.t('chat.failAuthSuggestion'), retryable: false };
    case 'billing':
      return { kind, message: i18n.t('chat.failBilling'), suggestion: i18n.t('chat.failBillingSuggestion'), retryable: false };
    case 'model_not_found':
      return { kind, message: i18n.t('chat.failModelNotFound'), suggestion: i18n.t('chat.failModelNotFoundSuggestion'), retryable: false };
    case 'network':
      return { kind, message: i18n.t('chat.failNetwork'), suggestion: i18n.t('chat.failNetworkSuggestion'), retryable: true };
    case 'rate_limit':
      return { kind, message: i18n.t('chat.failRateLimit'), suggestion: i18n.t('chat.failRateLimitSuggestion'), retryable: true };
    case 'timeout':
      return { kind, message: i18n.t('chat.failTimeout'), suggestion: i18n.t('chat.failTimeoutSuggestion'), retryable: true };
    case 'aborted':
      return { kind, message: i18n.t('chat.failAborted'), suggestion: i18n.t('chat.failAbortedSuggestion'), retryable: true };
    case 'context_overflow':
      // chat.contextOverflow already carries the /new + switch-model advice.
      return { kind, message: i18n.t('chat.contextOverflow'), suggestion: null, retryable: false };
    case 'refusal':
      return { kind, message: i18n.t('chat.failRefusal'), suggestion: i18n.t('chat.failRefusalSuggestion'), retryable: false };
    default:
      // Preserve legacy behavior: unknown errors surface verbatim.
      return { kind: 'unknown', message: raw, suggestion: null, retryable: true };
  }
}

export function classifyRunFailure(
  rawInput: string,
  errorKind?: string,
  recoveryContext: RecoveryContext = {},
): RunFailureInfo {
  const raw = (rawInput ?? '').trim();
  if (!raw) {
    return {
      kind: 'unknown',
      category: recoveryCategory('unknown', recoveryContext),
      message: i18n.t('chat.runEndedNoOutput'),
      suggestion: null,
      retryable: true,
      raw: '',
    };
  }
  const kind = kindFromErrorKind(errorKind) ?? kindFromText(raw);
  const info = infoForKind(kind, raw);
  return { ...info, category: recoveryCategory(info.kind, recoveryContext), raw };
}

export function isConfigPermanentFailure(kind: RunFailureKind): boolean {
  return kind === 'auth' || kind === 'billing' || kind === 'model_not_found';
}

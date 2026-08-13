/**
 * RPC bridge error handling.
 *
 * Every rc.* gateway method funnels its failures through index.ts's
 * registerMethod bridge. Historically that bridge flattened ALL errors to
 * `{ code: 'PLUGIN_ERROR', message }` and logged nothing — so a genuine bug
 * (unexpected throw) and an expected domain error (e.g. PAPER_NOT_FOUND) were
 * indistinguishable, and neither left a trace in the log file.
 *
 * This module turns a thrown value into:
 *  - the response `{ code, message }` the client receives, preserving the
 *    domain classification (classifyError → { code, … }) instead of erasing it;
 *  - a log line + level, so unexpected bugs land in ~/.research-claw logs with
 *    a stack, while expected domain errors get a terse one-liner.
 *
 * Secret safety: only param KEY NAMES are ever logged, never values — some RPC
 * params carry secrets (provider.upsert / setApiKey → apiKey).
 */

export interface RpcErrorOutcome {
  /** Response code sent to the client. Domain code when present, else PLUGIN_ERROR. */
  code: string;
  /** Human-readable message, with sensitive credential text redacted. */
  message: string;
  /** Log severity: debug for recoverable control flow, warn for other domain errors, error for bugs. */
  level: 'debug' | 'warn' | 'error';
  /** Fully-formatted log line — includes stack for unexpected errors, never param values. */
  line: string;
}

function normalizeCode(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value) && value !== 0) {
    return String(value);
  }
  return null;
}

function extractCode(err: unknown): string | null {
  if (typeof err === 'object' && err !== null) {
    const coded = err as { code?: unknown; errorCode?: unknown };
    return normalizeCode(coded.code) ?? normalizeCode(coded.errorCode);
  }
  return null;
}

function extractMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'object' && err !== null && 'message' in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}

/**
 * RPC failures can originate in provider SDKs that include credentials in
 * their error text. Keep this utility dependency-free: importing OpenClaw's
 * aggregate plugin SDK here initializes unrelated runtime/config state during
 * core unit tests.
 */
function redactSensitiveText(text: string): string {
  return text
    .replace(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z ]*PRIVATE KEY-----/g,
      '[REDACTED PRIVATE KEY]',
    )
    .replace(
      /(["'](?:api[-_]?key|token|secret|password|passwd|access[-_]?token|refresh[-_]?token|client[-_]?secret)["']\s*:\s*["'])[^"'\r\n]+(["'])/gi,
      '$1[REDACTED]$2',
    )
    .replace(
      /(\b(?:api[-_]?key|token|secret|password|passwd|access[-_]?token|refresh[-_]?token|client[-_]?secret)\b\s*[:=]\s*["']?)[^\s"',;]+/gi,
      '$1[REDACTED]',
    )
    .replace(
      /(Authorization\s*[:=]\s*(?:Bearer|Basic)\s+)[A-Za-z0-9._~+\/-]{8,}={0,2}/gi,
      '$1[REDACTED]',
    )
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g,
      '[REDACTED]',
    );
}

/**
 * Classify a thrown RPC value into a client response + a log directive.
 *
 * @param method     the rc.* method name that threw
 * @param err        the thrown value (Error, ErrorShape {code,message}, or anything)
 * @param paramKeys  the KEYS of the request params (never the values)
 */
export function buildRpcErrorOutcome(
  method: string,
  err: unknown,
  paramKeys: string[],
): RpcErrorOutcome {
  const domainCode = extractCode(err);
  const message = redactSensitiveText(extractMessage(err));
  const keysLabel = paramKeys.length > 0 ? paramKeys.join(', ') : '(none)';

  // A workspace image/reference can be temporarily unavailable while a device
  // remounts, a network volume reconnects, or an agent is still producing it.
  // The caller keeps the reference and may retry, so this is routine control
  // flow rather than an operator-facing warning. Scope the exception to read:
  // -32002 has unrelated meanings in other RPC domains.
  if (method === 'rc.ws.read' && domainCode === '-32002') {
    return {
      code: domainCode,
      message,
      level: 'debug',
      line: `RPC ${method} deferred [${domainCode}]: ${message} (params: [${keysLabel}])`,
    };
  }

  // A classified domain error (carries a code) is expected control flow — a
  // terse warn is enough. An uncoded plain Error is an unexpected bug — log at
  // error with its stack so it can actually be traced.
  if (domainCode) {
    return {
      code: domainCode,
      message,
      level: 'warn',
      line: `RPC ${method} failed [${domainCode}]: ${message} (params: [${keysLabel}])`,
    };
  }

  const stack =
    err instanceof Error && err.stack ? redactSensitiveText(err.stack) : '(no stack)';
  return {
    code: 'PLUGIN_ERROR',
    message,
    level: 'error',
    line: `RPC ${method} failed [PLUGIN_ERROR]: ${message} (params: [${keysLabel}])\n${stack}`,
  };
}

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
  /** Human-readable message (unchanged from the thrown value). */
  message: string;
  /** Log severity: 'error' for unexpected bugs (with stack), 'warn' for classified domain errors. */
  level: 'warn' | 'error';
  /** Fully-formatted log line — includes stack for unexpected errors, never param values. */
  line: string;
}

function extractCode(err: unknown): string | null {
  if (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    typeof (err as { code: unknown }).code === 'string' &&
    (err as { code: string }).code.length > 0
  ) {
    return (err as { code: string }).code;
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
  const message = extractMessage(err);
  const keysLabel = paramKeys.length > 0 ? paramKeys.join(', ') : '(none)';

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

  const stack = err instanceof Error && err.stack ? err.stack : '(no stack)';
  return {
    code: 'PLUGIN_ERROR',
    message,
    level: 'error',
    line: `RPC ${method} failed [PLUGIN_ERROR]: ${message} (params: [${keysLabel}])\n${stack}`,
  };
}

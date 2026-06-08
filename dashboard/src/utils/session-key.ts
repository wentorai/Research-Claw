/**
 * Session key normalization utility.
 *
 * The gateway canonicalizes bare keys: "project-xxx" → "agent:main:project-xxx".
 * The dashboard stores bare keys, but events arrive with canonical form.
 * This module provides a single, shared normalization function.
 *
 * Source: openclaw/src/sessions/session-key-utils.ts (parseAgentSessionKey)
 * Source: openclaw/src/routing/session-key.ts (toAgentRequestSessionKey)
 */

/**
 * Strip the "agent:<agentId>:" prefix to get the bare session key.
 *
 * Examples:
 *   "agent:main:project-abc"  → "project-abc"
 *   "agent:main:main"         → "main"
 *   "agent:custom:foo"        → "foo"
 *   "project-abc"             → "project-abc"  (no-op)
 *   "main"                    → "main"          (no-op)
 */
const CANONICAL_PREFIX_RE = /^agent:[^:]+:/i;

export function normalizeSessionKey(key: string | undefined): string {
  if (!key) return '';
  return key.replace(CANONICAL_PREFIX_RE, '');
}

/** Check if a key refers to the main session (handles both bare and canonical forms). */
export function isMainSessionKey(key: string): boolean {
  const k = normalizeSessionKey(key).toLowerCase();
  return k === 'main';
}

/** Bare dashboard key → gateway session store key (agent:main:…). */
export function toGatewaySessionKey(key: string): string {
  if (!key) return 'agent:main:main';
  if (CANONICAL_PREFIX_RE.test(key)) return key;
  return `agent:main:${key}`;
}

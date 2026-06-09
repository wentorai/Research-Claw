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

/**
 * Check if a key refers to a synthetic heartbeat session (e.g. "main:heartbeat").
 * Heartbeat runs in an isolated "<base>:heartbeat" session that must never appear
 * in the user-facing session list.
 *
 * Mirrors OC isSyntheticSessionMaintenanceKey (openclaw/src/config/sessions/store-maintenance.ts).
 */
export function isHeartbeatSessionKey(key: string): boolean {
  const rest = normalizeSessionKey(key);
  return rest === 'heartbeat' || rest.endsWith(':heartbeat') || rest.includes(':heartbeat:');
}

/** Bare dashboard key → gateway session store key (agent:main:…). */
export function toGatewaySessionKey(key: string): string {
  if (!key) return 'agent:main:main';
  if (CANONICAL_PREFIX_RE.test(key)) return key;
  return `agent:main:${key}`;
}

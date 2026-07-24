/**
 * Real OpenClaw hook contracts (single source of truth for hook wiring).
 *
 * These are re-exported from OpenClaw's published plugin SDK, NOT hand-mirrored,
 * so that an OC upgrade that changes a hook's event/ctx shape breaks THIS plugin
 * at compile time — instead of the plugin silently reading `undefined` and
 * degrading (the exact class of failure that produced cross-session leakage:
 * hooks were registered single-arg and read a non-existent `sessionId` off the
 * event, falling back to a global "last active session").
 *
 * Authoritative facts (OC 2026.6.1 PluginHookHandlerMap, hook-types.d.ts:944-963):
 *   - Every conversation/message hook is invoked as `handler(event, ctx)`.
 *   - The canonical session key is `ctx.sessionKey` (PluginHookMessageContext /
 *     PluginHookAgentContext) — the SAME value llm_input/llm_output/agent_end
 *     fire with; for outbound (message_sending) it mirrors OutboundSessionContext.key.
 *   - `runId` is per-TURN, NOT plumbed through the outbound (message_sending)
 *     path; it cannot disambiguate concurrent turns. Use sessionKey for
 *     outbound↔inbound correlation.
 */

export type {
  PluginHookHandlerMap,
  PluginHookName,
  PluginHookMessageContext,
  PluginHookAgentContext,
  PluginHookToolContext,
  PluginHookMessageReceivedEvent,
  PluginHookMessageSendingEvent,
  PluginHookMessageSendingResult,
  PluginHookLlmOutputEvent,
  PluginHookBeforePromptBuildEvent,
  PluginHookBeforePromptBuildResult,
  PluginHookBeforeMessageWriteEvent,
  PluginHookBeforeToolCallEvent,
  PluginHookBeforeToolCallResult,
  PluginHookSessionStartEvent,
  PluginHookSessionEndEvent,
} from 'openclaw/plugin-sdk/types';

import type {
  PluginHookMessageContext,
  PluginHookAgentContext,
} from 'openclaw/plugin-sdk/types';

/**
 * Canonical session key for a hook ctx. Both message-hook ctx and agent-hook ctx
 * carry `sessionKey`; it may be omitted only when OC has no resolvable session
 * (internal smoke runs) — callers must handle undefined (never fall back to a
 * process-global "last active session", which is what leaked B's output to A).
 */
export function hookSessionKey(
  ctx: PluginHookMessageContext | PluginHookAgentContext | undefined,
): string | undefined {
  const key = ctx?.sessionKey;
  return typeof key === 'string' && key.length > 0 ? key : undefined;
}

/**
 * Real OpenClaw hook contracts (single source of truth for hook wiring).
 *
 * OpenClaw 2026.9.2 ships no public hook-type subpath: `openclaw/plugin-sdk/types`
 * is an empty stub and its `exports` map declares no `types` condition, while no
 * other plugin-sdk entry re-exports the hook event/result types. The shapes below
 * mirror `dist/hook-runner-global-*.d.ts` from the installed 2026.9.2 package
 * (the same declarations the gateway runs) so an upgrade that changes a hook's
 * event/ctx shape still breaks THIS plugin at compile time — instead of the
 * plugin silently reading `undefined` and degrading (the exact class of failure
 * that produced cross-session leakage: hooks were registered single-arg and read
 * a non-existent `sessionId` off the event, falling back to a global "last
 * active session").
 *
 * Authoritative facts (OC 2026.9.2 PluginHookHandlerMap):
 *   - Every conversation/message hook is invoked as `handler(event, ctx)`.
 *   - The canonical session key is `ctx.sessionKey` (PluginHookMessageContext /
 *     PluginHookAgentContext) — the SAME value llm_input/llm_output/agent_end
 *     fire with; for outbound (message_sending) it mirrors OutboundSessionContext.key.
 *   - `runId` is per-TURN, NOT plumbed through the outbound (message_sending)
 *     path; it cannot disambiguate concurrent turns. Use sessionKey for
 *     outbound↔inbound correlation.
 */

export type PluginHookSessionEndReason = string;

export interface PluginHookMessageContext {
  channelId: string;
  accountId?: string;
  conversationId?: string;
  sessionKey?: string;
  runId?: string;
  messageId?: string;
  senderId?: string;
  traceId?: string;
}

export interface PluginHookAgentContext {
  runId?: string;
  jobId?: string;
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  workspaceDir?: string;
  modelProviderId?: string;
  modelId?: string;
  messageProvider?: string;
  channel?: string;
  accountId?: string;
  chatId?: string;
  senderId?: string;
  trigger?: string;
  channelId?: string;
  contextTokenBudget?: number;
}

export interface PluginHookToolContext {
  runId?: string;
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  toolName?: string;
}

export interface PluginHookBeforePromptBuildEvent {
  prompt: string;
  messages: unknown[];
}

export interface PluginHookBeforePromptBuildResult {
  systemPrompt?: string;
  prependContext?: string;
  appendContext?: string;
  toolsAllow?: string[];
  prependSystemContext?: string;
  appendSystemContext?: string;
}

export interface PluginHookBeforeToolCallEvent {
  toolName: string;
  params?: Record<string, unknown>;
}

export type PluginApprovalResolution = 'allow-once' | 'allow-always' | 'deny' | 'timeout' | 'cancelled';

export interface PluginApprovalRequest {
  title: string;
  description: string;
  scope?: string;
  severity?: 'info' | 'warning' | 'critical';
  timeoutMs?: number;
  /** @deprecated Unresolved approvals always deny; retained for API compatibility. */
  timeoutBehavior?: 'allow' | 'deny';
  timeoutReason?: string;
  allowedDecisions?: PluginApprovalResolution[];
  pluginId?: string;
  onResolution?: (decision: PluginApprovalResolution) => Promise<void> | void;
}

export interface PluginHookBeforeToolCallResult {
  params?: Record<string, unknown>;
  block?: boolean;
  blockReason?: string;
  requireApproval?: PluginApprovalRequest;
}

export interface PluginHookMessageReceivedEvent {
  from: string;
  content: string;
  timestamp?: number;
  threadId?: string | number;
  messageId?: string;
  senderId?: string;
  replyToId?: string;
  replyToIdFull?: string;
  replyToBody?: string;
  replyToSender?: string;
  replyToIsQuote?: boolean;
  sessionKey?: string;
  runId?: string;
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  metadata?: Record<string, unknown>;
  media?: unknown[];
  originalMedia?: unknown[];
  mediaStagingPending?: boolean;
}

export interface PluginHookMessageSendingEvent {
  to: string;
  content: string;
  metadata?: Record<string, unknown>;
}

export interface PluginHookMessageSendingResult {
  content?: string;
  cancel?: boolean;
  metadata?: Record<string, unknown>;
}

export interface PluginHookLlmInputEvent {
  runId: string;
  sessionId: string;
  provider: string;
  model: string;
  systemPrompt?: string;
  prompt: string;
  historyMessages: unknown[];
  imagesCount: number;
  tools?: unknown[];
}

export interface PluginHookLlmOutputEvent {
  runId: string;
  sessionId: string;
  provider: string;
  model: string;
  contextTokenBudget?: number;
  contextWindowSource?: unknown;
  contextWindowReferenceTokens?: number;
  resolvedRef?: string;
  harnessId?: string;
  prompt?: string;
  assistantTexts: string[];
  lastAssistant?: unknown;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
}

export interface PluginHookBeforeCompactionEvent {
  messageCount: number;
  tokenCount?: number;
  sessionFile?: string;
}

export interface PluginHookAfterCompactionEvent {
  messageCount: number;
  tokenCount?: number;
  compactedCount: number;
  sessionFile?: string;
  previousSessionId?: string;
}

export interface PluginHookBeforeMessageWriteEvent {
  message: unknown;
  sessionKey?: string;
  agentId?: string;
}

export interface PluginHookBeforeMessageWriteResult {
  block?: boolean;
}

export interface PluginHookSessionStartEvent {
  sessionId: string;
  sessionKey?: string;
  messageCount?: number;
  sessionFile?: string;
}

export interface PluginHookSessionEndEvent {
  sessionId: string;
  sessionKey?: string;
  messageCount: number;
  durationMs?: number;
  reason?: PluginHookSessionEndReason;
  sessionFile?: string;
  transcriptArchived?: boolean;
  nextSessionId?: string;
  nextSessionKey?: string;
}

export type PluginHookName = keyof PluginHookHandlerMap;

export interface PluginHookHandlerMap {
  before_prompt_build: (
    event: PluginHookBeforePromptBuildEvent,
    ctx: PluginHookAgentContext,
  ) => Promise<PluginHookBeforePromptBuildResult | void> | PluginHookBeforePromptBuildResult | void;
  llm_input: (event: PluginHookLlmInputEvent, ctx: PluginHookAgentContext) => Promise<void> | void;
  llm_output: (event: PluginHookLlmOutputEvent, ctx: PluginHookAgentContext) => Promise<void> | void;
  message_received: (event: PluginHookMessageReceivedEvent, ctx: PluginHookMessageContext) => Promise<void> | void;
  message_sending: (
    event: PluginHookMessageSendingEvent,
    ctx: PluginHookMessageContext,
  ) => Promise<PluginHookMessageSendingResult | void> | PluginHookMessageSendingResult | void;
  before_compaction: (event: PluginHookBeforeCompactionEvent, ctx: PluginHookAgentContext) => Promise<void> | void;
  after_compaction: (event: PluginHookAfterCompactionEvent, ctx: PluginHookAgentContext) => Promise<void> | void;
  before_tool_call: (
    event: PluginHookBeforeToolCallEvent,
    ctx: PluginHookToolContext,
  ) => Promise<PluginHookBeforeToolCallResult | void> | PluginHookBeforeToolCallResult | void;
  before_message_write: (
    event: PluginHookBeforeMessageWriteEvent,
    ctx: { agentId?: string; sessionKey?: string },
  ) => PluginHookBeforeMessageWriteResult | void;
  session_start: (event: PluginHookSessionStartEvent, ctx: { sessionKey?: string }) => Promise<void> | void;
  session_end: (event: PluginHookSessionEndEvent, ctx: { sessionKey?: string }) => Promise<void> | void;
}

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

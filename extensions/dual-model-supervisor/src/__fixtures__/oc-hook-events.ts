/**
 * Real OpenClaw hook event fixtures — typed with the ACTUAL OC types.
 *
 * Provenance: OpenClaw 2026.6.1, constructed against the installed
 *   node_modules/openclaw/dist/plugin-sdk/hook-types-BwOyYpy9.d.ts
 * (the same types the gateway ships). Because each fixture is annotated with its
 * real OC event type, TypeScript REJECTS any phantom field (e.g. a `sessionId`
 * on a message_sending event, which does not exist) and rejects removing a
 * required field — so each fixture is constrained to a contract-valid shape.
 * Runtime provenance is stated separately where a fixture comes from a capture.
 *
 * Cross-checked against a live gateway capture (message_received keys observed:
 * from, content, timestamp, threadId, messageId, senderId, sessionKey, runId,
 * metadata — 2026-07-24 probe run).
 */

import type {
  PluginHookMessageReceivedEvent,
  PluginHookLlmOutputEvent,
  PluginHookLlmInputEvent,
  PluginHookBeforeToolCallEvent,
  PluginHookAfterCompactionEvent,
  PluginHookSessionEndEvent,
  PluginHookMessageContext,
  PluginHookAgentContext,
} from '../oc/hook-types.js';

// message_received (hook-types.d.ts: PluginHookMessageReceivedEvent) — inbound
// text is `content`; canonical session key is `sessionKey` (NO top-level sessionId).
export const MESSAGE_RECEIVED_EVENT: PluginHookMessageReceivedEvent = {
  from: 'user',
  content: 'Please survey equivariant network architectures.',
  timestamp: 1_784_800_000_000,
  threadId: 'thread-1',
  messageId: 'msg-1',
  senderId: 'sender-1',
  sessionKey: 'agent:main:conv-1',
  runId: 'run-abc',
  metadata: { channel: 'telegram', accountId: 'acct-1' },
};
export const MESSAGE_CONTEXT: PluginHookMessageContext = { channelId: 'telegram', sessionKey: 'agent:main:conv-1' };

// llm_output (PluginHookLlmOutputEvent) — assistant text is `assistantTexts: string[]`.
export const LLM_OUTPUT_EVENT: PluginHookLlmOutputEvent = {
  runId: 'run-abc',
  sessionId: 'sess-1',
  provider: 'deepseek',
  model: 'deepseek-v4-pro',
  assistantTexts: ['Our method extends BERT (10.18653/v1/N19-1423).'],
  lastAssistant: { role: 'assistant', content: 'Our method extends BERT (10.18653/v1/N19-1423).' },
};
export const AGENT_CONTEXT: PluginHookAgentContext = { runId: 'run-abc', sessionKey: 'agent:main:conv-1', sessionId: 'sess-1' };

// llm_input (PluginHookLlmInputEvent) — prior messages under `historyMessages`.
export const LLM_INPUT_EVENT: PluginHookLlmInputEvent = {
  runId: 'run-abc',
  sessionId: 'sess-1',
  provider: 'deepseek',
  model: 'deepseek-v4-pro',
  prompt: 'continue',
  historyMessages: [{ role: 'user', content: 'hi' }],
  imagesCount: 0,
};

// before_tool_call (PluginHookBeforeToolCallEvent) — toolName + params on the EVENT.
export const BEFORE_TOOL_CALL_EVENT: PluginHookBeforeToolCallEvent = {
  toolName: 'exec',
  params: { command: 'ls -la' },
};

// after_compaction (PluginHookAfterCompactionEvent) — counts + sessionFile ONLY.
export const AFTER_COMPACTION_EVENT: PluginHookAfterCompactionEvent = {
  messageCount: 40,
  tokenCount: 8000,
  compactedCount: 12,
  sessionFile: '/tmp/session.jsonl',
};

// session_end — normalized subset of the 2026-07-26 isolated gateway capture.
// Opaque IDs are scrubbed and undefined optional fields are omitted.
// The public OC contract has no "completed" reason.
export const SESSION_END_EVENT: PluginHookSessionEndEvent = {
  sessionId: 'native-session-before-compaction',
  sessionKey: 'agent:main:conv-1',
  messageCount: 0,
  reason: 'compaction',
  transcriptArchived: false,
  nextSessionId: 'native-session-after-compaction',
};

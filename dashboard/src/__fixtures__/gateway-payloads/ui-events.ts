/**
 * Realistic gateway event frames and messages for App-level event wiring,
 * ChatView filtering, and notification extraction tests.
 *
 * Sources:
 *   - openclaw/ui/src/ui/app-gateway.ts (event routing: lines 324-403)
 *   - openclaw/ui/src/ui/controllers/chat.ts (handleChatEvent: lines 262-336)
 *   - openclaw/ui/src/ui/chat/grouped-render.ts (message visibility: lines 225-288)
 *   - openclaw/ui/src/ui/chat/message-normalizer.ts (role normalization: lines 72-94)
 *
 * Update these when OpenClaw protocol changes.
 */

import type { ChatStreamEvent, ChatMessage, EventFrame } from '../../gateway/types';

// ─── Gateway Event Frames ────────────────────────────────────────────
// These match the structure from app-gateway.ts handleGatewayEventUnsafe

export const CHAT_EVENT_FRAME: EventFrame = {
  type: 'event',
  event: 'chat',
  payload: {
    runId: 'run-evt-001',
    sessionKey: 'main',
    state: 'delta',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'Processing...' }],
    },
  },
  seq: 1,
};

export const AGENT_EVENT_FRAME: EventFrame = {
  type: 'event',
  event: 'agent',
  payload: {
    stream: 'tool',
    data: {
      phase: 'running',
      toolName: 'rc.lit.search',
    },
    state: 'tool_running',
  },
  seq: 2,
};

export const PRESENCE_EVENT_FRAME: EventFrame = {
  type: 'event',
  event: 'presence',
  payload: {
    presence: [
      { name: 'web-ui', role: 'controller', connectedAt: '2026-03-14T00:00:00Z' },
    ],
  },
  seq: 3,
};

export const CRON_EVENT_FRAME: EventFrame = {
  type: 'event',
  event: 'cron',
  payload: { cronId: 'daily-monitor' },
  seq: 4,
};

export const DEVICE_PAIR_FRAME: EventFrame = {
  type: 'event',
  event: 'device.pair.requested',
  payload: { deviceId: 'dev-xyz' },
  seq: 5,
};

// ─── Messages with Different Roles ──────────────────────────────────
// Based on message-normalizer.ts normalizeRoleForGrouping (lines 72-94)

export const USER_MSG: ChatMessage = {
  role: 'user',
  text: 'Search for papers on quantum computing',
  timestamp: 1710400000000,
};

export const ASSISTANT_MSG: ChatMessage = {
  role: 'assistant',
  text: 'I found 12 papers on quantum computing. Here are the top results.',
  content: [{ type: 'text', text: 'I found 12 papers on quantum computing. Here are the top results.' }],
  timestamp: 1710400001000,
};

export const ASSISTANT_EMPTY_TEXT_MSG: ChatMessage = {
  role: 'assistant',
  text: '',
  content: [{ type: 'text', text: '' }],
  timestamp: 1710400002000,
};

export const ASSISTANT_WHITESPACE_ONLY_MSG: ChatMessage = {
  role: 'assistant',
  text: '   ',
  content: [{ type: 'text', text: '   ' }],
  timestamp: 1710400002500,
};

// Tiny valid PNG (1x1 transparent pixel)
const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

export const ASSISTANT_IMAGE_ONLY_MSG: ChatMessage = {
  role: 'assistant',
  text: '',
  content: [
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: TINY_PNG_B64 } },
  ],
  timestamp: 1710400003000,
};

export const TOOL_RESULT_MSG: ChatMessage = {
  role: 'toolResult',
  content: [{ type: 'text', text: '{"results": [{"title": "Quantum Paper"}]}' }],
  toolCallId: 'call-qc-001',
  toolName: 'rc.lit.search',
  timestamp: 1710400000500,
};

export const TOOL_CALL_MSG: ChatMessage = {
  role: 'assistant',
  content: [
    { type: 'tool_use', text: undefined, name: 'rc.lit.search', args: { query: 'quantum' } },
  ],
  timestamp: 1710400000300,
};

// Mixed message history (visible + hidden roles)
export const MIXED_HISTORY: ChatMessage[] = [
  USER_MSG,
  TOOL_RESULT_MSG,
  ASSISTANT_MSG,
  ASSISTANT_EMPTY_TEXT_MSG,
  ASSISTANT_IMAGE_ONLY_MSG,
  TOOL_CALL_MSG,
  ASSISTANT_WHITESPACE_ONLY_MSG,
];

// ─── Card-type Code Block Messages (Notification Extraction) ─────────
// Based on our chat.ts extractCardNotifications pattern

export const PROGRESS_CARD_TEXT = `Here is the heartbeat update:

\`\`\`progress_card
{
  "period": "daily",
  "highlights": ["3 papers processed", "1 task completed", "Radar scan finished"],
  "summary": "Good progress today"
}
\`\`\`

Let me know if you need more details.`;

export const MONITOR_DIGEST_TEXT = `New papers found:

\`\`\`monitor_digest
{
  "total_found": 5,
  "monitor_name": "attention mechanisms transformer",
  "papers": [{"title": "New attention paper"}]
}
\`\`\``;

export const APPROVAL_CARD_TEXT = `Action requires approval:

\`\`\`approval_card
{
  "action": "delete_collection",
  "context": "Remove all papers from 'archive' collection",
  "approval_id": "appr-789"
}
\`\`\``;

export const NO_CARD_TEXT = 'This is a regular assistant message with no card blocks.';

export const MULTI_CARD_TEXT = `Multiple updates:

\`\`\`progress_card
{
  "period": "weekly",
  "highlights": ["10 papers reviewed"]
}
\`\`\`

And new papers:

\`\`\`monitor_digest
{
  "total_found": 3,
  "monitor_name": "deep learning",
  "papers": []
}
\`\`\``;

// Card event as a full ChatStreamEvent (final state)
export const FINAL_WITH_PROGRESS_CARD: ChatStreamEvent = {
  runId: 'run-card-001',
  sessionKey: 'main',
  state: 'final',
  message: {
    role: 'assistant',
    content: [{ type: 'text', text: PROGRESS_CARD_TEXT }],
    timestamp: 1710400010000,
  },
};

export const FINAL_WITH_MONITOR_DIGEST: ChatStreamEvent = {
  runId: 'run-card-002',
  sessionKey: 'main',
  state: 'final',
  message: {
    role: 'assistant',
    content: [{ type: 'text', text: MONITOR_DIGEST_TEXT }],
    timestamp: 1710400011000,
  },
};

// ─── Streaming Display Fixtures ─────────────────────────────────────

export const STREAMING_DELTA: ChatStreamEvent = {
  runId: 'run-stream-001',
  sessionKey: 'main',
  state: 'delta',
  message: {
    role: 'assistant',
    content: [{ type: 'text', text: 'I am currently searching for...' }],
  },
};

export const STREAMING_FINAL: ChatStreamEvent = {
  runId: 'run-stream-001',
  sessionKey: 'main',
  state: 'final',
  message: {
    role: 'assistant',
    content: [{ type: 'text', text: 'I found 5 relevant papers on the topic.' }],
    timestamp: 1710400020000,
  },
};

export { TINY_PNG_B64 };

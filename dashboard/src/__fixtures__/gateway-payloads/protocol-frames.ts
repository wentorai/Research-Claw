/**
 * Realistic gateway WebSocket protocol frames extracted from OpenClaw source code.
 *
 * These fixtures represent the ACTUAL data format the gateway sends/receives
 * during the WS handshake, event routing, and error handling.
 *
 * Sources:
 *   - openclaw/src/gateway/server/ws-connection.ts:174-179 (connect.challenge emission)
 *   - openclaw/src/gateway/server/ws-connection/message-handler.ts:1058-1081 (hello-ok response)
 *   - openclaw/src/gateway/protocol/schema/frames.ts (frame schemas)
 *   - openclaw/src/gateway/server-constants.ts:33 (TICK_INTERVAL_MS = 30_000)
 *   - openclaw/src/gateway/server-maintenance.ts:59-63 (tick event broadcast)
 *   - openclaw/src/gateway/protocol/schema/error-codes.ts (error shapes)
 *   - openclaw/ui/src/ui/gateway.ts:307-324 (connect params format)
 *
 * Update these when OpenClaw protocol changes.
 */

import type { EventFrame, ResponseFrame, HelloOk, GatewayErrorInfo } from '../../gateway/types';

// ─── Connect Challenge ──────────────────────────────────────────────
// Server sends this immediately upon WS open.
// See: openclaw/src/gateway/server/ws-connection.ts:174-179

export const CONNECT_CHALLENGE: EventFrame = {
  type: 'event',
  event: 'connect.challenge',
  payload: { nonce: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', ts: 1710403200000 },
};

export const CONNECT_CHALLENGE_EMPTY_NONCE: EventFrame = {
  type: 'event',
  event: 'connect.challenge',
  payload: { nonce: '', ts: 1710403200000 },
};

// ─── Hello-OK Response ──────────────────────────────────────────────
// Server responds to 'connect' request with this payload.
// See: openclaw/src/gateway/server/ws-connection/message-handler.ts:1058-1081

export const HELLO_OK_PAYLOAD: HelloOk = {
  type: 'hello-ok',
  protocol: 3,
  server: {
    version: '2026.3.14',
    connId: 'conn-uuid-abcdef',
  },
  features: {
    methods: [
      'connect', 'chat.send', 'chat.abort', 'chat.history', 'config.get',
      'config.set', 'sessions.list', 'agents.list', 'skills.status',
    ],
    events: [
      'connect.challenge', 'tick', 'shutdown', 'chat', 'agent',
      'health', 'presence', 'config.changed',
    ],
  },
  snapshot: {
    presence: [
      {
        host: 'research-claw-dev',
        version: '2026.3.14',
        platform: 'darwin',
        mode: 'ui',
        ts: 1710403200000,
      },
    ],
    health: { status: 'ok' },
    stateVersion: { presence: 1, health: 1 },
    uptimeMs: 86400000,
  },
  auth: {
    deviceToken: 'dt_abc123def456',
    role: 'operator',
    scopes: ['operator.read', 'operator.write', 'operator.admin'],
    issuedAtMs: 1710403200000,
  },
  policy: {
    tickIntervalMs: 30_000,
  },
};

export const HELLO_OK_RESPONSE: ResponseFrame = {
  type: 'res',
  id: 'connect-req-id-001',
  ok: true,
  payload: HELLO_OK_PAYLOAD,
};

// Minimal hello-ok (no auth, no snapshot details)
export const HELLO_OK_MINIMAL: HelloOk = {
  type: 'hello-ok',
  protocol: 3,
  server: { version: '2026.3.14', connId: 'conn-minimal' },
  features: { methods: ['connect'], events: ['tick'] },
  policy: { tickIntervalMs: 30_000 },
};

// ─── Error Response Frames ──────────────────────────────────────────
// See: openclaw/src/gateway/protocol/schema/frames.ts:114-123
// See: openclaw/src/gateway/protocol/schema/error-codes.ts

export const ERROR_UNAUTHORIZED: GatewayErrorInfo = {
  code: 'UNAUTHORIZED',
  message: 'Authentication required',
  details: { code: 'AUTH_TOKEN_MISSING' },
};

export const ERROR_FORBIDDEN: GatewayErrorInfo = {
  code: 'FORBIDDEN',
  message: 'Access denied',
};

export const ERROR_INVALID_REQUEST: GatewayErrorInfo = {
  code: 'INVALID_REQUEST',
  message: 'Missing required field: sessionKey',
};

export const ERROR_UNAVAILABLE: GatewayErrorInfo = {
  code: 'UNAVAILABLE',
  message: 'Service temporarily unavailable',
};

export const CONNECT_ERROR_RESPONSE: ResponseFrame = {
  type: 'res',
  id: 'connect-req-id-002',
  ok: false,
  error: ERROR_UNAUTHORIZED,
};

export const RPC_ERROR_RESPONSE: ResponseFrame = {
  type: 'res',
  id: 'rpc-req-id-001',
  ok: false,
  error: ERROR_INVALID_REQUEST,
};

// ─── Event Frames with Sequence Numbers ─────────────────────────────
// See: openclaw/src/gateway/protocol/schema/frames.ts:146-155
// See: openclaw/ui/src/ui/gateway.ts:409-416 (seq gap detection)

export const TICK_EVENT_SEQ_1: EventFrame = {
  type: 'event',
  event: 'tick',
  payload: { ts: 1710403230000 },
  seq: 1,
  stateVersion: { presence: 1, health: 1 },
};

export const TICK_EVENT_SEQ_2: EventFrame = {
  type: 'event',
  event: 'tick',
  payload: { ts: 1710403260000 },
  seq: 2,
  stateVersion: { presence: 1, health: 1 },
};

// Seq gap: jumps from 2 to 5 (3 and 4 missing)
export const TICK_EVENT_SEQ_5_GAP: EventFrame = {
  type: 'event',
  event: 'tick',
  payload: { ts: 1710403350000 },
  seq: 5,
  stateVersion: { presence: 2, health: 1 },
};

export const CHAT_EVENT_SEQ_3: EventFrame = {
  type: 'event',
  event: 'chat',
  payload: {
    runId: 'run-xyz-789',
    sessionKey: 'main',
    seq: 0,
    state: 'delta',
    message: { role: 'assistant', content: [{ type: 'text', text: 'Working on it...' }] },
  },
  seq: 3,
};

export const AGENT_EVENT_SEQ_4: EventFrame = {
  type: 'event',
  event: 'agent',
  payload: {
    type: 'tool_use',
    agentId: 'default',
    toolName: 'web_search',
    input: { query: 'arXiv papers 2026' },
  },
  seq: 4,
};

// Event without seq (non-sequenced events like presence)
export const PRESENCE_EVENT_NO_SEQ: EventFrame = {
  type: 'event',
  event: 'presence',
  payload: {
    presence: [
      { host: 'dev-machine', version: '2026.3.14', platform: 'darwin', mode: 'ui', ts: 1710403200000 },
    ],
  },
  stateVersion: { presence: 2, health: 1 },
};

export const HEALTH_EVENT: EventFrame = {
  type: 'event',
  event: 'health',
  payload: { status: 'ok', channels: {}, uptime: 86400 },
  stateVersion: { presence: 1, health: 2 },
};

// ─── Request Frame Format ───────────────────────────────────────────
// See: openclaw/src/gateway/protocol/schema/frames.ts:125-133
// See: openclaw/ui/src/ui/gateway.ts:446-457

export const SAMPLE_REQUEST_FRAME = {
  type: 'req' as const,
  id: 'req-uuid-001',
  method: 'config.get',
  params: { scope: 'resolved' },
};

export const SAMPLE_CONNECT_PARAMS = {
  minProtocol: 3,
  maxProtocol: 3,
  client: {
    id: 'openclaw-control-ui',
    version: '0.4.0',
    platform: 'browser',
    mode: 'ui',
    displayName: 'Research-Claw Dashboard',
  },
  role: 'operator',
  scopes: ['operator.read', 'operator.write', 'operator.admin'],
  device: {
    id: 'device-sha256-hex-64chars-placeholder',
    publicKey: 'base64url-ed25519-pubkey-placeholder',
    signature: 'base64url-ed25519-signature-placeholder',
    signedAt: 1710403200000,
    nonce: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  },
};

// ─── Shutdown Event ─────────────────────────────────────────────────
// See: openclaw/src/gateway/protocol/schema/frames.ts:12-18

export const SHUTDOWN_EVENT: EventFrame = {
  type: 'event',
  event: 'shutdown',
  payload: { reason: 'Gateway restart', restartExpectedMs: 5000 },
};

// ─── Response frame for a normal RPC call ───────────────────────────
export const CONFIG_GET_RESPONSE: ResponseFrame = {
  type: 'res',
  id: 'req-config-001',
  ok: true,
  payload: {
    resolved: { ai: { provider: 'anthropic' } },
    raw: '{ ai: { provider: "anthropic" } }',
  },
};

/**
 * Gateway WS RPC v3 frame types.
 * Based on OpenClaw gateway protocol v4 (OC 2026.6.1+).
 *
 * OpenClaw requires minProtocol/maxProtocol (a version range), not a single
 * "protocol" field.
 */

export const PROTOCOL_VERSION = 4;

/** Minimum protocol version we support. */
export const MIN_PROTOCOL = 4;
/** Maximum protocol version we support. */
export const MAX_PROTOCOL = 4;

// --- Frame Types ---

export interface RequestFrame {
  type: 'req';
  id: string;
  method: string;
  params?: unknown;
}

export interface ResponseFrame {
  type: 'res';
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: GatewayErrorInfo;
}

export interface EventFrame {
  type: 'event';
  event: string;
  payload?: unknown;
  seq?: number;
  stateVersion?: { presence: number; health: number };
}

export type GatewayFrame = ResponseFrame | EventFrame;

export interface GatewayErrorInfo {
  code: string;
  message: string;
  details?: unknown;
}

// --- Hello/Auth ---

/** Session defaults from gateway hello snapshot (OC schema: SessionDefaultsSchema). */
export interface SessionDefaults {
  defaultAgentId: string;
  mainKey: string;
  mainSessionKey: string;
  scope?: string;
}

export interface HelloSnapshot {
  sessionDefaults?: SessionDefaults;
  authMode?: string;
  configPath?: string;
  stateDir?: string;
  uptimeMs?: number;
  presence?: unknown[];
  health?: unknown;
  stateVersion?: { presence: number; health: number };
  updateAvailable?: { currentVersion?: string; latestVersion?: string; channel?: string };
  /** Allow forward-compatible extra fields from future OC versions. */
  [key: string]: unknown;
}

export interface HelloOk {
  type: 'hello-ok';
  protocol: number;
  server?: { version?: string; connId?: string };
  features?: { methods?: string[]; events?: string[] };
  snapshot?: HelloSnapshot;
  auth?: { deviceToken?: string; role?: string; scopes?: string[]; issuedAtMs?: number };
  policy?: { tickIntervalMs?: number };
}

// --- Chat Types ---

export interface ChatStreamEvent {
  runId: string;
  sessionKey: string;
  state: 'delta' | 'final' | 'aborted' | 'error';
  message?: ChatMessage;
  errorMessage?: string;
  /** Gateway-side failure classification for state:'error' events.
   *  Source: openclaw/packages/gateway-protocol/src/schema/logs-chat.ts
   *  (ChatEventErrorKindSchema), populated at src/gateway/server-chat.ts:480. */
  errorKind?: 'refusal' | 'timeout' | 'rate_limit' | 'context_length' | 'unknown';
  usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number };
}

export interface ChatMessage {
  role: string; // 'user' | 'assistant' | 'toolResult' (gateway may send any role)
  content?: string | Array<{ type: string; text?: string; source?: unknown; [key: string]: unknown }>;
  text?: string;
  timestamp?: number;
  idempotencyKey?: string;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  stopReason?: string;
  /** Non-image workspace files referenced by this user turn (rendered as chips). */
  references?: string[];
  /**
   * Dashboard-local marker (e.g. 'welcome') — only set by appendLocalMessage,
   * never sent by the gateway. Survives the localStorage JSON round-trip.
   */
  localKind?: string;
  /** Dashboard-local binding to the server-persisted execution trace for this reply. */
  executionRunId?: string;
}

export interface ChatAttachment {
  id: string;
  dataUrl: string;
  mimeType: string;
  /**
   * When the image already exists in the workspace (dragged from the workspace
   * panel, or ingested from an external drop), this is its workspace-relative
   * path. The send pipeline reuses it instead of re-saving a duplicate copy.
   */
  wsPath?: string;
}

/**
 * A file reference attached to a composer message. Always resolves to a
 * workspace-relative path the agent can read via workspace_read (paths are
 * workspace-scoped by the application layer, not an OS sandbox).
 * External files are ingested into the workspace first (status 'uploading'),
 * then referenced once ready.
 */
export interface ChatReference {
  id: string;
  path: string;
  name: string;
  source: 'workspace' | 'external';
  status: 'ready' | 'uploading' | 'error';
  size?: number;
  mimeType?: string;
  errorMsg?: string;
  /** Retained ONLY while status is 'error' so retry can re-upload without a
   *  re-drop; released on 'ready' (chips are cleared on send, bounding memory). */
  file?: File;
}

// --- Bootstrap Config ---

export interface BootstrapConfig {
  basePath: string;
  assistantName: string;
  assistantAvatar: string | null;
  assistantAgentId: string;
  serverVersion: string;
}

// --- Connection State ---

export type ConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'authenticating'
  | 'connected'
  | 'reconnecting';

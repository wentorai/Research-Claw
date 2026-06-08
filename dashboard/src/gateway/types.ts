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
}

export interface ChatAttachment {
  id: string;
  dataUrl: string;
  mimeType: string;
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

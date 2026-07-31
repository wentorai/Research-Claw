import { create } from 'zustand';
import { useGatewayStore } from './gateway';
import { useChatStore } from './chat';

const SESSION_KEY_STORAGE = 'rc_active_session';

/**
 * OpenClaw main session key.
 * The gateway canonicalizes "main" → "agent:main:main".
 * This is the primary/default session that cannot be deleted.
 */
export const MAIN_SESSION_KEY = 'main';

/** Session row returned by OpenClaw `sessions.list`. */
export interface Session {
  key: string;
  label?: string;
  displayName?: string;
  derivedTitle?: string;
  updatedAt?: number;
  sessionStartedAt?: number;
  lastInteractionAt?: number;
  sessionId?: string;
  kind?: string;
  /**
   * Runtime-merged model provider for this session (OC session-utils.ts:2186-2187).
   * Present when the session has an active model override; null/undefined otherwise.
   */
  modelProvider?: string | null;
  /**
   * Runtime-merged model id for this session (OC session-utils.ts:2186-2187).
   * Present when the session has an active model override; null/undefined otherwise.
   */
  model?: string | null;
}

/** Fields supported by OC sessions.patch RPC (aligned with OC controllers/sessions.ts). */
export interface SessionPatchFields {
  label?: string | null;
  thinkingLevel?: string | null;
  fastMode?: boolean | null;
  verboseLevel?: string | null;
  reasoningLevel?: string | null;
  /**
   * Session model override. `model: null` clears the /model override and falls
   * back to the config default (OC sessions-patch.ts:517-534 → applyModelOverride
   * with isDefault:true). Used by the vision hint's "clear override" action (P1-V2).
   */
  model?: string | null;
}

interface SessionsState {
  sessions: Session[];
  activeSessionKey: string;
  loading: boolean;
  /** True when active session will roll over on next chat.send (idle/daily expiry). */
  activeSessionStale: boolean;
  /** Session key for which the user confirmed continuing a stale session. */
  staleSendAcknowledgedKey: string | null;

  loadSessions: () => Promise<void>;
  switchSession: (key: string) => void;
  createSession: () => Promise<string>;
  deleteSession: (key: string) => Promise<void>;
  /** Reset a session in place (fresh transcript, same key) — the only safe "clear" for main. */
  clearSession: (key: string) => Promise<void>;
  /** Auto-name a default-labelled session from its first exchange (at most once). */
  autoNameSession: (key: string) => Promise<void>;
  renameSession: (key: string, label: string) => Promise<void>;
  /**
   * General-purpose session patch (aligned with OC sessions.patch — supports all fields).
   *
   * Resolves `true` only when the gateway accepted the patch; `false` when the
   * gateway is not connected or sessions.patch was rejected. Callers surface the
   * outcome to the user, so a swallowed failure must not be indistinguishable
   * from success.
   */
  patchSession: (key: string, fields: SessionPatchFields) => Promise<boolean>;
  isMainSession: (key: string) => boolean;
  refreshActiveSessionStale: () => void;
  acknowledgeStaleSessionSend: (key: string) => void;
}

function getPersistedKey(): string {
  try {
    return localStorage.getItem(SESSION_KEY_STORAGE) || MAIN_SESSION_KEY;
  } catch {
    return MAIN_SESSION_KEY;
  }
}

function persistKey(key: string) {
  try {
    localStorage.setItem(SESSION_KEY_STORAGE, key);
  } catch {
    // localStorage unavailable
  }
}

import {
  isHeartbeatSessionKey,
  isMainSessionKey,
  isSubagentSessionKey,
  normalizeSessionKey,
  toGatewaySessionKey,
} from '../utils/session-key';
import { isSessionRowStale } from '../utils/session-freshness';
import { isAutoNameCandidate, extractFirstExchange, type HistoryMessage } from '../utils/auto-name';
import { useConfigStore } from './config';

/**
 * Sessions already auto-named (or naming in-flight) this dashboard lifetime.
 * Added before the await chain to dedupe concurrent triggers; removed on
 * failure / incomplete exchange so a later run can retry. Kept on success —
 * a session is named at most once (user rename then wins forever).
 */
const autoNameGuard = new Set<string>();

/** Test-only: reset the auto-name guard between test cases. */
export function _resetAutoNameGuard(): void {
  autoNameGuard.clear();
}

/** Check if a key refers to the main session (handles both bare and canonical forms). */
function isMain(key: string): boolean {
  return isMainSessionKey(key);
}

function findSessionRow(sessions: Session[], key: string): Session | undefined {
  const bare = normalizeSessionKey(key);
  return sessions.find((s) => normalizeSessionKey(s.key) === bare);
}

function computeActiveSessionStale(sessions: Session[], activeKey: string): boolean {
  const row = findSessionRow(sessions, activeKey);
  if (!row?.updatedAt) return false;
  const policy = useConfigStore.getState().sessionResetPolicy;
  return isSessionRowStale(row, policy);
}

export const useSessionsStore = create<SessionsState>()((set, get) => ({
  sessions: [],
  activeSessionKey: getPersistedKey(),
  loading: false,
  activeSessionStale: false,
  staleSendAcknowledgedKey: null,

  loadSessions: async () => {
    const client = useGatewayStore.getState().client;
    if (!client?.isConnected) return;
    set({ loading: true });
    try {
      const result = await client.request<{ sessions: Session[] }>('sessions.list', {
        includeDerivedTitles: true,
        limit: 1000,
      });
      // Drop synthetic sessions: heartbeat (isolatedSession runs in "<base>:heartbeat")
      // and subagent runs ("agent:main:subagent:<uuid>").
      const serverSessions = (result.sessions ?? []).filter(
        (s) => !isHeartbeatSessionKey(s.key) && !isSubagentSessionKey(s.key),
      );
      // Ensure the main session is always present in the list
      const sessions = serverSessions.some((s) => isMain(s.key))
        ? serverSessions
        : [{ key: MAIN_SESSION_KEY }, ...serverSessions];
      set({
        sessions,
        loading: false,
        activeSessionStale: computeActiveSessionStale(sessions, get().activeSessionKey),
      });
    } catch {
      set({ loading: false });
    }
  },

  refreshActiveSessionStale: () => {
    const { sessions, activeSessionKey } = get();
    set({ activeSessionStale: computeActiveSessionStale(sessions, activeSessionKey) });
  },

  acknowledgeStaleSessionSend: (key: string) => {
    set({ staleSendAcknowledgedKey: key, activeSessionStale: false });
  },

  switchSession: (key: string) => {
    const safeKey = key || MAIN_SESSION_KEY;
    const prev = get().activeSessionKey;
    if (safeKey === prev) return;
    set({
      activeSessionKey: safeKey,
      staleSendAcknowledgedKey: null,
      activeSessionStale: computeActiveSessionStale(get().sessions, safeKey),
    });
    persistKey(safeKey);
    // Switch chat store and reload history + usage for the new session
    useChatStore.getState().setSessionKey(safeKey);
    useChatStore.getState().loadHistory();
    useChatStore.getState().loadSessionUsage();
  },

  createSession: async () => {
    // OpenClaw sessions are implicit — created on first chat.send with a new sessionKey.
    // Use a short readable key (not UUID) since OpenClaw prepends "agent:main:".
    const key = `project-${crypto.randomUUID().slice(0, 8)}`;

    // Generate a meaningful default label: "Session N" with auto-incrementing number
    const existing = get().sessions;
    const usedNumbers = existing
      .filter((s) => !isMain(s.key))
      .map((s) => {
        const m = (s.label || s.key).match(/(?:Session|项目)\s*(\d+)/);
        return m ? parseInt(m[1], 10) : 0;
      });
    const nextNumber = Math.max(0, ...usedNumbers) + 1;
    const label = `Session ${nextNumber}`;

    // Add placeholder to local list so it appears in the dropdown immediately
    const placeholder: Session = { key, label };
    set((s) => ({
      sessions: [placeholder, ...s.sessions],
      activeSessionKey: key,
      staleSendAcknowledgedKey: null,
      activeSessionStale: false,
    }));
    persistKey(key);
    // Persist the label to the gateway so it survives refresh
    const client = useGatewayStore.getState().client;
    if (client?.isConnected) {
      client.request('sessions.patch', { key, label })?.catch(() => {});
    }
    // Switch chat store to new empty session
    useChatStore.getState().setSessionKey(key);
    return key;
  },

  deleteSession: async (key: string) => {
    if (isMain(key)) return; // Main session cannot be deleted
    const client = useGatewayStore.getState().client;
    if (!client?.isConnected) return;
    let deletionConfirmed = false;
    try {
      await client.request('sessions.delete', { key, deleteTranscript: true });
      deletionConfirmed = true;
    } catch {
      // Deletion failed — session may already be gone
    }
    if (deletionConfirmed) {
      try {
        // Best-effort compatibility: old gateways do not expose this RPC. The
        // canonical key matches the hook-side session scope stored by RC Core.
        await client.request('rc.execution.cleanupSession', {
          sessionKey: toGatewaySessionKey(key),
        });
      } catch {
        // Session deletion remains available on pre-v23 gateways.
      }
    }
    const wasActive = get().activeSessionKey === key;
    set((s) => ({
      sessions: s.sessions.filter((sess) => sess.key !== key),
      activeSessionKey: wasActive ? MAIN_SESSION_KEY : s.activeSessionKey,
    }));
    if (wasActive) {
      persistKey(MAIN_SESSION_KEY);
      useChatStore.getState().setSessionKey(MAIN_SESSION_KEY);
      useChatStore.getState().loadHistory();
      useChatStore.getState().loadSessionUsage();
    }
  },

  clearSession: async (key: string) => {
    const client = useGatewayStore.getState().client;
    if (!client?.isConnected) return;
    try {
      // SessionsResetParamsSchema is { key, agentId?, reason? } with
      // additionalProperties: false — send exactly { key }.
      await client.request('sessions.reset', { key });
    } catch {
      return; // Reset failed — keep local state untouched
    }
    try {
      await client.request('rc.execution.cleanupSession', {
        sessionKey: toGatewaySessionKey(key),
      });
    } catch {
      // Old gateway: reset still succeeds; only v23 enrichment cleanup is absent.
    }
    const isActive = normalizeSessionKey(get().activeSessionKey) === normalizeSessionKey(key);
    if (isActive) {
      useChatStore.getState().loadHistory();
      useChatStore.getState().loadSessionUsage();
    }
    // Re-fetch the list: reset changes sessionId/updatedAt and clears the derived title.
    await get().loadSessions();
  },

  autoNameSession: async (key: string) => {
    const client = useGatewayStore.getState().client;
    if (!client?.isConnected) return;
    const row = findSessionRow(get().sessions, key);
    if (!isAutoNameCandidate({ key, label: row?.label })) return;
    const guardKey = normalizeSessionKey(key);
    if (autoNameGuard.has(guardKey)) return;
    autoNameGuard.add(guardKey);
    try {
      const history = await client.request<{ messages: HistoryMessage[] }>('chat.history', {
        sessionKey: key,
        limit: 12,
      });
      const exchange = extractFirstExchange(history.messages ?? []);
      if (!exchange) {
        autoNameGuard.delete(guardKey); // exchange incomplete — retry on a later run
        return;
      }
      const result = await client.request<{ ok?: boolean; title?: string }>('rc.session.autoName', {
        key,
        userText: exchange.userText,
        assistantText: exchange.assistantText,
      });
      const title = typeof result?.title === 'string' ? result.title.trim() : '';
      if (!result?.ok || !title) {
        autoNameGuard.delete(guardKey);
        return;
      }
      await client.request('sessions.patch', { key, label: title });
      set((s) => ({
        sessions: s.sessions.map((sess) =>
          normalizeSessionKey(sess.key) === guardKey ? { ...sess, label: title } : sess,
        ),
      }));
    } catch {
      autoNameGuard.delete(guardKey); // naming failed — allow retry
    }
  },

  renameSession: async (key: string, label: string) => {
    const client = useGatewayStore.getState().client;
    if (!client?.isConnected) return;
    try {
      await client.request('sessions.patch', { key, label: label || null });
      // Update local state
      set((s) => ({
        sessions: s.sessions.map((sess) =>
          sess.key === key ? { ...sess, label: label || undefined } : sess,
        ),
      }));
    } catch {
      // Rename failed
    }
  },

  patchSession: async (key: string, fields: SessionPatchFields): Promise<boolean> => {
    const client = useGatewayStore.getState().client;
    // Not connected → nothing was sent. Report it as a failure rather than
    // resolving like a successful patch.
    if (!client?.isConnected) return false;
    try {
      await client.request('sessions.patch', { key, ...fields });
      // Update local label if changed
      if ('label' in fields) {
        set((s) => ({
          sessions: s.sessions.map((sess) =>
            sess.key === key ? { ...sess, label: fields.label || undefined } : sess,
          ),
        }));
      }
      return true;
    } catch {
      // Gateway rejected the patch (validation error / METHOD_NOT_FOUND /
      // transport timeout). The caller must be able to tell the user.
      return false;
    }
  },

  isMainSession: (key: string) => isMain(key),
}));

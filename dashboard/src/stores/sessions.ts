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
  /** OpenClaw Session lifecycle projection. These fields come from the
   * sessions.list authority and must not be inferred from chat deltas. */
  status?: 'running' | 'done' | 'failed' | 'killed' | 'timeout';
  hasActiveRun?: boolean;
  startedAt?: number;
  endedAt?: number;
  runtimeMs?: number;
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
  /** Schedule naming for this exact session key; active-session changes cannot retarget it. */
  scheduleAutoNameSession: (key: string, delayMs?: number) => void;
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
} from '../utils/session-key';
import { isSessionRowStale } from '../utils/session-freshness';
import { isAutoNameCandidate, extractFirstExchange, type HistoryMessage } from '../utils/auto-name';
import { useConfigStore } from './config';
import { useSessionRunsStore } from './session-runs';

/**
 * Sessions already auto-named (or naming in-flight) this dashboard lifetime.
 * Added before the await chain to dedupe concurrent triggers; removed on
 * failure / incomplete exchange so a later run can retry. Kept on success —
 * a session is named at most once (user rename then wins forever).
 */
const autoNameGuard = new Set<string>();
const autoNameTimers = new Map<string, ReturnType<typeof setTimeout>>();
let sessionsLoadGeneration = 0;
let sessionsLoadInFlight: Promise<void> | null = null;

/** Test-only: reset the auto-name guard between test cases. */
export function _resetAutoNameGuard(): void {
  autoNameGuard.clear();
  for (const timer of autoNameTimers.values()) clearTimeout(timer);
  autoNameTimers.clear();
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

  loadSessions: () => {
    if (sessionsLoadInFlight) return sessionsLoadInFlight;
    const request = (async () => {
      const client = useGatewayStore.getState().client;
      if (!client?.isConnected) return;
      const generation = ++sessionsLoadGeneration;
      const eventEpoch = useGatewayStore.getState().eventEpoch;
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
        if (generation !== sessionsLoadGeneration) return;
        const observedAt = Date.now();
        for (const session of serverSessions) {
          useSessionRunsStore.getState().ingestSnapshot(session, { eventEpoch, observedAt });
        }
        // Ensure the main session is always present in the list
        const sessions = serverSessions.some((s) => isMain(s.key))
          ? serverSessions
          : [{ key: MAIN_SESSION_KEY }, ...serverSessions];
        set({
          sessions,
          loading: false,
          activeSessionStale: computeActiveSessionStale(sessions, get().activeSessionKey),
        });
        // F5/reconnect recovery: only probe the persisted active session. This
        // is intentionally bounded, rather than firing model calls for every
        // historical default-labelled session in the list.
        get().scheduleAutoNameSession(get().activeSessionKey, 750);
      } catch {
        if (generation === sessionsLoadGeneration) set({ loading: false });
      }
    })();
    sessionsLoadInFlight = request;
    void request.finally(() => {
      if (sessionsLoadInFlight === request) sessionsLoadInFlight = null;
    });
    return request;
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
    const historyLoad = useChatStore.getState().loadHistory();
    useChatStore.getState().loadSessionUsage();
    void useSessionRunsStore.getState().requestReconcile(safeKey, 'session-switch');
    // A default-labelled session may have completed while another session was
    // visible or while this dashboard was closed. Bind the retry to safeKey.
    void Promise.resolve(historyLoad).then(() => {
      get().scheduleAutoNameSession(safeKey, 0);
    });
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
    try {
      await client.request('sessions.delete', { key, deleteTranscript: true });
    } catch {
      // Deletion failed — session may already be gone
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
      // The model call is asynchronous. A user may have renamed (or deleted)
      // the session while it was in flight; that newer explicit state wins.
      const latestRow = findSessionRow(get().sessions, key);
      if (!latestRow || !isAutoNameCandidate({ key, label: latestRow.label })) return;
      await client.request('sessions.patch', { key, label: title });
      set((s) => ({
        sessions: s.sessions.map((sess) =>
          normalizeSessionKey(sess.key) === guardKey ? { ...sess, label: title } : sess,
        ),
      }));
    } catch (error) {
      autoNameGuard.delete(guardKey); // naming failed — allow retry
      console.warn('[Sessions] Auto-name failed', {
        sessionKey: key,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },

  scheduleAutoNameSession: (key: string, delayMs = 500) => {
    const row = findSessionRow(get().sessions, key);
    if (!isAutoNameCandidate({ key, label: row?.label })) return;
    const guardKey = normalizeSessionKey(key);
    const pending = autoNameTimers.get(guardKey);
    if (pending) clearTimeout(pending);
    const timer = setTimeout(() => {
      autoNameTimers.delete(guardKey);
      void get().autoNameSession(key);
    }, Math.max(0, delayMs));
    autoNameTimers.set(guardKey, timer);
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

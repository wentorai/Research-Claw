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
  sessionId?: string;
  kind?: string;
}

interface SessionsState {
  sessions: Session[];
  activeSessionKey: string;
  loading: boolean;

  loadSessions: () => Promise<void>;
  switchSession: (key: string) => void;
  createSession: () => Promise<string>;
  deleteSession: (key: string) => Promise<void>;
  renameSession: (key: string, label: string) => Promise<void>;
  isMainSession: (key: string) => boolean;
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

import { isMainSessionKey } from '../utils/session-key';

/** Check if a key refers to the main session (handles both bare and canonical forms). */
function isMain(key: string): boolean {
  return isMainSessionKey(key);
}

export const useSessionsStore = create<SessionsState>()((set, get) => ({
  sessions: [],
  activeSessionKey: getPersistedKey(),
  loading: false,

  loadSessions: async () => {
    const client = useGatewayStore.getState().client;
    if (!client?.isConnected) return;
    set({ loading: true });
    try {
      const result = await client.request<{ sessions: Session[] }>('sessions.list', {
        includeDerivedTitles: true,
        limit: 1000,
      });
      const serverSessions = result.sessions ?? [];
      // Ensure the main session is always present in the list
      const sessions = serverSessions.some((s) => isMain(s.key))
        ? serverSessions
        : [{ key: MAIN_SESSION_KEY }, ...serverSessions];
      set({ sessions, loading: false });
    } catch {
      set({ loading: false });
    }
  },

  switchSession: (key: string) => {
    const safeKey = key || MAIN_SESSION_KEY;
    const prev = get().activeSessionKey;
    if (safeKey === prev) return;
    set({ activeSessionKey: safeKey });
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

  isMainSession: (key: string) => isMain(key),
}));

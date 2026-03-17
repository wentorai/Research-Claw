import { create } from 'zustand';
import { useGatewayStore } from './gateway';

export type PanelTab = 'library' | 'workspace' | 'tasks' | 'radar' | 'settings';

export type AgentStatus = 'idle' | 'thinking' | 'tool_running' | 'streaming' | 'error' | 'disconnected';

export interface Notification {
  id: string;
  type: 'deadline' | 'heartbeat' | 'system' | 'error';
  title: string;
  body?: string;
  timestamp: string;
  read: boolean;
  chatMessageId?: string;
  /** Stable key for deduplication — same dedupKey won't create a second notification. */
  dedupKey?: string;
}

// ── Persist read state across refreshes via localStorage ──────────────

const READ_KEYS_STORAGE = 'rc-read-dedup-keys';
const MAX_READ_KEYS = 200;
const PANEL_TAB_STORAGE = 'rc-right-panel-tab';
const PANEL_OPEN_STORAGE = 'rc-right-panel-open';
const LEFT_NAV_COLLAPSED_STORAGE = 'rc-left-nav-collapsed';
const SHOW_SYSTEM_FILES_STORAGE = 'rc-show-system-files';

const VALID_TABS = new Set<PanelTab>(['library', 'workspace', 'tasks', 'radar', 'settings']);

function loadPanelTab(): PanelTab {
  try {
    const raw = localStorage.getItem(PANEL_TAB_STORAGE);
    if (raw && VALID_TABS.has(raw as PanelTab)) return raw as PanelTab;
  } catch { /* ignore */ }
  return 'library';
}

function loadBoolean(key: string, fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(key);
    if (raw === 'true') return true;
    if (raw === 'false') return false;
  } catch { /* ignore */ }
  return fallback;
}

function loadReadKeys(): Set<string> {
  try {
    const raw = localStorage.getItem(READ_KEYS_STORAGE);
    if (raw) return new Set(JSON.parse(raw) as string[]);
  } catch { /* ignore corrupt data */ }
  return new Set();
}

function saveReadKeys(keys: Set<string>): void {
  try {
    // Cap to prevent localStorage bloat
    const arr = [...keys].slice(-MAX_READ_KEYS);
    localStorage.setItem(READ_KEYS_STORAGE, JSON.stringify(arr));
  } catch { /* storage full — non-fatal */ }
}

interface UiState {
  rightPanelTab: PanelTab;
  rightPanelOpen: boolean;
  rightPanelWidth: number;
  leftNavCollapsed: boolean;
  notifications: Notification[];
  unreadCount: number;
  agentStatus: AgentStatus;

  /** Monotonically increasing counter — WorkspacePanel watches this to trigger refresh. */
  workspaceRefreshKey: number;
  /** Set by FileCard to request WorkspacePanel to open a file preview. */
  pendingPreviewPath: string | null;

  /** Whether to show system files (.ResearchClaw/, MEMORY.md, etc.) in workspace tree. */
  showSystemFiles: boolean;

  setRightPanelTab: (tab: PanelTab) => void;
  toggleRightPanel: () => void;
  setRightPanelOpen: (open: boolean) => void;
  setRightPanelWidth: (width: number) => void;
  toggleLeftNav: () => void;
  setLeftNavCollapsed: (collapsed: boolean) => void;
  setAgentStatus: (status: AgentStatus) => void;
  addNotification: (n: Omit<Notification, 'id' | 'timestamp' | 'read'>) => void;
  markNotificationRead: (id: string) => void;
  markAllNotificationsRead: () => void;
  clearNotifications: () => void;
  /** Poll rc.notifications.pending for overdue/upcoming tasks. */
  checkNotifications: () => Promise<void>;
  triggerWorkspaceRefresh: () => void;
  requestWorkspacePreview: (path: string) => void;
  clearPendingPreview: () => void;
  setShowSystemFiles: (show: boolean) => void;
}

export const useUiStore = create<UiState>()((set, get) => ({
  rightPanelTab: loadPanelTab(),
  rightPanelOpen: loadBoolean(PANEL_OPEN_STORAGE, true),
  rightPanelWidth: 360,
  leftNavCollapsed: loadBoolean(LEFT_NAV_COLLAPSED_STORAGE, false),
  notifications: [],
  unreadCount: 0,
  agentStatus: 'disconnected',
  workspaceRefreshKey: 0,
  pendingPreviewPath: null,
  showSystemFiles: loadBoolean(SHOW_SYSTEM_FILES_STORAGE, false),

  setRightPanelTab: (tab: PanelTab) => {
    try { localStorage.setItem(PANEL_TAB_STORAGE, tab); } catch { /* non-fatal */ }
    try { localStorage.setItem(PANEL_OPEN_STORAGE, 'true'); } catch { /* non-fatal */ }
    set({ rightPanelTab: tab, rightPanelOpen: true });
  },

  toggleRightPanel: () => {
    const next = !get().rightPanelOpen;
    try { localStorage.setItem(PANEL_OPEN_STORAGE, String(next)); } catch { /* non-fatal */ }
    set({ rightPanelOpen: next });
  },

  setRightPanelOpen: (open: boolean) => {
    try { localStorage.setItem(PANEL_OPEN_STORAGE, String(open)); } catch { /* non-fatal */ }
    set({ rightPanelOpen: open });
  },

  setRightPanelWidth: (width: number) => {
    set({ rightPanelWidth: Math.min(480, Math.max(320, width)) });
  },

  toggleLeftNav: () => {
    const next = !get().leftNavCollapsed;
    try { localStorage.setItem(LEFT_NAV_COLLAPSED_STORAGE, String(next)); } catch { /* non-fatal */ }
    set({ leftNavCollapsed: next });
  },

  setLeftNavCollapsed: (collapsed: boolean) => {
    try { localStorage.setItem(LEFT_NAV_COLLAPSED_STORAGE, String(collapsed)); } catch { /* non-fatal */ }
    set({ leftNavCollapsed: collapsed });
  },

  setAgentStatus: (status: AgentStatus) => {
    set({ agentStatus: status });
  },

  addNotification: (n) => {
    // Dedup: skip if a notification with the same dedupKey already exists
    if (n.dedupKey) {
      const existing = get().notifications;
      if (existing.some((x) => x.dedupKey === n.dedupKey)) return;
    }

    // Check if this dedupKey was previously read (persisted across refreshes)
    const alreadyRead = n.dedupKey ? loadReadKeys().has(n.dedupKey) : false;

    const notification: Notification = {
      ...n,
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      read: alreadyRead,
    };
    set((s) => ({
      notifications: [notification, ...s.notifications].slice(0, 50),
      unreadCount: alreadyRead ? s.unreadCount : s.unreadCount + 1,
    }));
  },

  markNotificationRead: (id: string) => {
    set((s) => {
      const found = s.notifications.find((n) => n.id === id && !n.read);
      if (found?.dedupKey) {
        const keys = loadReadKeys();
        keys.add(found.dedupKey);
        saveReadKeys(keys);
      }
      return {
        notifications: s.notifications.map((n) => (n.id === id ? { ...n, read: true } : n)),
        unreadCount: found ? s.unreadCount - 1 : s.unreadCount,
      };
    });
  },

  markAllNotificationsRead: () => {
    const keys = loadReadKeys();
    for (const n of get().notifications) {
      if (n.dedupKey && !n.read) keys.add(n.dedupKey);
    }
    saveReadKeys(keys);
    set((s) => ({
      notifications: s.notifications.map((n) => ({ ...n, read: true })),
      unreadCount: 0,
    }));
  },

  clearNotifications: () => {
    set({ notifications: [], unreadCount: 0 });
  },

  triggerWorkspaceRefresh: () => {
    set((s) => ({ workspaceRefreshKey: s.workspaceRefreshKey + 1 }));
  },

  requestWorkspacePreview: (path: string) => {
    set({ pendingPreviewPath: path, rightPanelTab: 'workspace', rightPanelOpen: true });
  },

  clearPendingPreview: () => {
    set({ pendingPreviewPath: null });
  },

  setShowSystemFiles: (show: boolean) => {
    try { localStorage.setItem(SHOW_SYSTEM_FILES_STORAGE, String(show)); } catch { /* non-fatal */ }
    set({ showSystemFiles: show });
  },

  checkNotifications: async () => {
    const client = useGatewayStore.getState().client;
    if (!client || !client.isConnected) return;

    try {
      const result = await client.request<{
        overdue: Array<{ id: string; title: string; deadline: string; priority: string }>;
        upcoming: Array<{ id: string; title: string; deadline: string; priority: string }>;
        custom?: Array<{ id: string; type: string; title: string; body: string | null; created_at: string }>;
      }>('rc.notifications.pending', { hours: 48 });

      const { addNotification } = get();

      for (const task of result.overdue) {
        addNotification({
          type: 'deadline',
          title: task.title,
          body: `Overdue: ${task.deadline}`,
          dedupKey: `overdue:${task.id}`,
        });
      }

      for (const task of result.upcoming) {
        addNotification({
          type: 'deadline',
          title: task.title,
          body: `Due: ${task.deadline}`,
          dedupKey: `upcoming:${task.id}`,
        });
      }

      // Custom agent-sent notifications
      if (result.custom) {
        for (const n of result.custom) {
          addNotification({
            type: (n.type as Notification['type']) || 'system',
            title: n.title,
            body: n.body ?? undefined,
            dedupKey: `custom:${n.id}`,
          });
        }
      }
    } catch {
      // Non-fatal — notification check failure should not disrupt the UI
    }
  },
}));

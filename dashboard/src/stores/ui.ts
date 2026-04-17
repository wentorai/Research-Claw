import { create } from 'zustand';
import i18n from '../i18n';
import type { CheckUpdatesPayload } from '../types/app-updates';
import { useGatewayStore } from './gateway';

export type PanelTab = 'library' | 'workspace' | 'tasks' | 'monitor' | 'supervisor' | 'extensions' | 'settings';

export type AgentStatus = 'idle' | 'thinking' | 'tool_running' | 'streaming' | 'error' | 'disconnected';

const NOTIFICATION_TYPES = new Set<string>(['deadline', 'heartbeat', 'system', 'error', 'update']);

export interface Notification {
  id: string;
  type: 'deadline' | 'heartbeat' | 'system' | 'error' | 'update';
  title: string;
  body?: string;
  timestamp: string;
  read: boolean;
  chatMessageId?: string;
  /** Stable key for deduplication — same dedupKey won't create a second notification. */
  dedupKey?: string;
  /** Session key to navigate to when the notification is clicked (Layer 2, #33). */
  targetSessionKey?: string;
  /** When type is `update` — persisted for actions in the notification dropdown. */
  updateMeta?: {
    current: string;
    latest: string;
    releaseUrl: string | null;
    shellHint?: string;
  };
}

// ── Persist notification + read state across refreshes via localStorage ──

const NOTIFICATIONS_STORAGE = 'rc-notifications';
const MAX_NOTIFICATIONS = 50;
const READ_KEYS_STORAGE = 'rc-read-dedup-keys';
const MAX_READ_KEYS = 200;
const PANEL_TAB_STORAGE = 'rc-right-panel-tab';
const PANEL_OPEN_STORAGE = 'rc-right-panel-open';
const LEFT_NAV_COLLAPSED_STORAGE = 'rc-left-nav-collapsed';
const SHOW_SYSTEM_FILES_STORAGE = 'rc-show-system-files';
const CRON_FOLD_STORAGE = 'rc-cron-sessions-folded';
const APP_UPDATE_LAST_CHECK_STORAGE = 'rc-app-update-last-check-at';
const APP_UPDATE_CHECK_INTERVAL_MS = 15 * 60 * 1000;

const VALID_TABS = new Set<PanelTab>(['library', 'workspace', 'tasks', 'monitor', 'supervisor', 'extensions', 'settings']);

function loadPanelTab(): PanelTab {
  try {
    const raw = localStorage.getItem(PANEL_TAB_STORAGE);
    // Migrate legacy 'radar' → 'monitor'
    if (raw === 'radar') {
      localStorage.setItem(PANEL_TAB_STORAGE, 'monitor');
      return 'monitor';
    }
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

function normalizeLoadedNotification(n: Notification): Notification {
  const type = NOTIFICATION_TYPES.has(n.type) ? n.type : 'system';
  if (type !== 'update') {
    const { updateMeta: _u, ...rest } = n;
    return { ...rest, type };
  }
  return { ...n, type };
}

function loadNotifications(): Notification[] {
  try {
    const raw = localStorage.getItem(NOTIFICATIONS_STORAGE);
    if (raw) {
      const arr = JSON.parse(raw) as Notification[];
      // Validate: must be array of objects with required fields
      if (Array.isArray(arr) && arr.every((n) => n && typeof n === 'object' && n.id && n.timestamp && n.title)) {
        return arr.slice(0, MAX_NOTIFICATIONS).map((n) => normalizeLoadedNotification(n as Notification));
      }
    }
  } catch { /* ignore corrupt data */ }
  return [];
}

function saveNotifications(notifications: Notification[]): void {
  try {
    localStorage.setItem(
      NOTIFICATIONS_STORAGE,
      JSON.stringify(notifications.slice(0, MAX_NOTIFICATIONS)),
    );
  } catch { /* storage full — non-fatal */ }
}

function loadLastAppUpdateCheckAt(): number | null {
  try {
    const raw = sessionStorage.getItem(APP_UPDATE_LAST_CHECK_STORAGE);
    if (!raw) return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function saveLastAppUpdateCheckAt(timestamp: number): void {
  try {
    sessionStorage.setItem(APP_UPDATE_LAST_CHECK_STORAGE, String(timestamp));
  } catch {
    /* storage unavailable — non-fatal */
  }
}

/** Sort notifications by timestamp descending (newest first). Direct string comparison — ISO 8601 is lexicographically sortable. */
function sortByTimestampDesc(a: Notification, b: Notification): number {
  return b.timestamp > a.timestamp ? 1 : b.timestamp < a.timestamp ? -1 : 0;
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

  /** Whether cron sessions are folded in the session list (Layer 3, #33). */
  cronSessionsFolded: boolean;

  /** Last check_updates result — shared between gateway auto-check and Settings → About. */
  appUpdateInfo: CheckUpdatesPayload | null;

  /** True while rc.app.apply_update is in progress — locks the update button across components. */
  appUpdateRunning: boolean;

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
  /**
   * Compare local version to GitHub; enqueue a notification when an update exists.
   * Called after gateway hello. Pass `preloaded` from Settings → About to avoid a second RPC.
   */
  maybeNotifyAppUpdate: (preloaded?: CheckUpdatesPayload | null) => Promise<void>;
  setAppUpdateInfo: (info: CheckUpdatesPayload | null) => void;
  setAppUpdateRunning: (running: boolean) => void;
  triggerWorkspaceRefresh: () => void;
  requestWorkspacePreview: (path: string) => void;
  clearPendingPreview: () => void;
  setShowSystemFiles: (show: boolean) => void;
  setCronSessionsFolded: (folded: boolean) => void;
}

const _initNotifications = loadNotifications();

export const useUiStore = create<UiState>()((set, get) => ({
  rightPanelTab: loadPanelTab(),
  rightPanelOpen: loadBoolean(PANEL_OPEN_STORAGE, true),
  rightPanelWidth: 360,
  leftNavCollapsed: loadBoolean(LEFT_NAV_COLLAPSED_STORAGE, false),
  notifications: _initNotifications,
  unreadCount: _initNotifications.filter((n) => !n.read).length,
  agentStatus: 'disconnected',
  workspaceRefreshKey: 0,
  pendingPreviewPath: null,
  showSystemFiles: loadBoolean(SHOW_SYSTEM_FILES_STORAGE, false),
  cronSessionsFolded: loadBoolean(CRON_FOLD_STORAGE, true),
  appUpdateInfo: null,
  appUpdateRunning: false,

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
    set((s) => {
      const next = [notification, ...s.notifications]
        .sort(sortByTimestampDesc)
        .slice(0, MAX_NOTIFICATIONS);
      saveNotifications(next);
      return {
        notifications: next,
        unreadCount: alreadyRead ? s.unreadCount : s.unreadCount + 1,
      };
    });
  },

  markNotificationRead: (id: string) => {
    set((s) => {
      const found = s.notifications.find((n) => n.id === id && !n.read);
      if (found?.dedupKey) {
        const keys = loadReadKeys();
        keys.add(found.dedupKey);
        saveReadKeys(keys);
      }
      const next = s.notifications.map((n) => (n.id === id ? { ...n, read: true } : n));
      saveNotifications(next);
      return {
        notifications: next,
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
    set((s) => {
      const next = s.notifications.map((n) => ({ ...n, read: true }));
      saveNotifications(next);
      return { notifications: next, unreadCount: 0 };
    });
  },

  clearNotifications: () => {
    saveNotifications([]);
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

  setCronSessionsFolded: (folded: boolean) => {
    try { localStorage.setItem(CRON_FOLD_STORAGE, String(folded)); } catch { /* non-fatal */ }
    set({ cronSessionsFolded: folded });
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

  setAppUpdateInfo: (info: CheckUpdatesPayload | null) => {
    set({ appUpdateInfo: info });
  },

  setAppUpdateRunning: (running: boolean) => {
    set({ appUpdateRunning: running });
  },

  maybeNotifyAppUpdate: async (preloaded?: CheckUpdatesPayload | null) => {
    try {
      let r: CheckUpdatesPayload | undefined | null = preloaded;
      if (r === undefined) {
        const client = useGatewayStore.getState().client;
        if (!client?.isConnected) return;
        const now = Date.now();
        const lastCheckedAt = loadLastAppUpdateCheckAt();
        if (lastCheckedAt && now - lastCheckedAt < APP_UPDATE_CHECK_INTERVAL_MS) {
          return;
        }
        saveLastAppUpdateCheckAt(now);
        r = await client.request<CheckUpdatesPayload>('rc.app.check_updates', {});
      }
      if (!r || typeof r.current !== 'string') return;

      // Share result with Settings → About section
      set({ appUpdateInfo: r });

      if (r.upToDate) {
        set((s) => {
          const next = s.notifications.filter(
            (n) => !(n.type === 'update' && n.dedupKey?.startsWith('app-update:')),
          );
          saveNotifications(next);
          const unreadCount = next.filter((n) => !n.read).length;
          return { notifications: next, unreadCount };
        });
        return;
      }

      if (r.error) return;

      const latest = r.latest?.trim() ?? '';
      if (!latest) return;

      get().addNotification({
        type: 'update',
        title: i18n.t('notification.updateTitle', { latest }),
        body: i18n.t('notification.updateBody', {
          current: r.current,
          latest,
          link: r.releaseUrl || 'https://github.com/wentorai/Research-Claw/releases',
        }),
        dedupKey: `app-update:${latest}`,
        updateMeta: {
          current: r.current,
          latest,
          releaseUrl: r.releaseUrl,
          shellHint: r.shellUpdateHint,
        },
      });
    } catch {
      /* non-fatal */
    }
  },
}));

// Dev-only: expose store on window for console debugging
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__RC_UI__ = useUiStore;
}

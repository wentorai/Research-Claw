/**
 * Supervisor Store — Dashboard state management for dual-model supervision
 *
 * Communicates with the plugin via rc.supervisor.* RPC methods.
 */

import { create } from 'zustand';
import { useGatewayStore } from './gateway';

export interface SupervisorStats {
  total: number;
  blocked: number;
  corrected: number;
  warnings: number;
}

export interface SessionInfo {
  sessionId: string;
  researchGoal?: string;
  targetConclusions: string[];
  goalConfirmed: boolean;
}

export interface SupervisorStatus {
  enabled: boolean;
  reviewMode: string;
  /** Stored marker: '' means "inherit the main model", never a resolved model name. */
  supervisorModel: string;
  /** Where the reviewer model comes from. Reported separately from `enabled`: the
   *  deterministic safety gate needs no model, so 'unavailable' means deep review is
   *  degraded — it never means supervision is off. */
  modelSource?: 'explicit' | 'inherited' | 'unavailable';
  /** The model a deep review would actually call right now (resolved, not stored). */
  effectiveSupervisorModel?: string;
  reviewerReady?: boolean;
  /** Why a deep-review call cannot be made — the same reason the call path would hit. */
  reviewerUnavailableReason?: string;
  /** How long a high-risk tool call waits for deep review before failing open. */
  toolReviewGateMs?: number;
  dangerousToolPolicy?: 'block' | 'approve';
  courseCorrectionEnabled: boolean;
  deviationThreshold: number;
  forceRegenerate: boolean;
  maxRegenerateAttempts: number;
  highRiskTools: string[];
  stats: SupervisorStats;
  activeSessions: number;
  sessionsInfo: SessionInfo[];
}

export interface SupervisorConfig {
  enabled: boolean;
  supervisorModel: string;
  reviewMode: 'off' | 'filter-only' | 'correct';
  courseCorrection: {
    enabled: boolean;
    deviationThreshold: number;
    forceRegenerate: boolean;
    maxRegenerateAttempts: number;
  };
  highRiskTools: string[];
  dangerousToolPolicy?: 'block' | 'approve';
  grounding?: {
    networkPolicy: 'off' | 'metadata-only' | 'verify';
    verdictMode: 'flag' | 'block';
  };
  /**
   * Absent = whatever the plugin's own default is. The number lives in
   * openclaw.plugin.json, mirrored by SUPERVISOR_GATE_DEFAULT_MS (which a test pins to
   * the manifest). Quoting it here would be a third copy with nothing enforcing it —
   * the same setup that let the plugin's own JSDoc claim 10s long after it became 4s.
   */
  toolReviewGateMs?: number;
}

export interface AuditLogEntry {
  id: number;
  sessionId: string;
  type: string;
  action: string;
  details: string;
  metadata?: string;
  timestamp: number;
}

interface SupervisorState {
  status: SupervisorStatus | null;
  config: SupervisorConfig | null;
  auditLog: AuditLogEntry[];
  auditLogTotal: number;
  statusLoading: boolean;
  configLoading: boolean;
  auditLogClearing: boolean;
  error: string | null;
  pollingTimer: ReturnType<typeof setInterval> | null;

  loadStatus: () => Promise<void>;
  loadConfig: () => Promise<void>;
  updateConfig: (partial: Partial<SupervisorConfig>) => Promise<void>;
  restoreDefaults: () => Promise<SupervisorConfig>;
  toggleSupervisor: (enabled?: boolean) => Promise<void>;
  loadAuditLog: (params?: { limit?: number; offset?: number; type?: string; action?: string; sessionId?: string }) => Promise<void>;
  clearAuditLog: () => Promise<number>;
  clearError: () => void;
  startPolling: (intervalMs?: number) => void;
  stopPolling: () => void;
}

export const useSupervisorStore = create<SupervisorState>()((set, get) => ({
  status: null,
  config: null,
  auditLog: [],
  auditLogTotal: 0,
  statusLoading: false,
  configLoading: false,
  auditLogClearing: false,
  error: null,
  pollingTimer: null,

  loadStatus: async () => {
    const client = useGatewayStore.getState().client;
    if (!client?.isConnected) return;
    set({ statusLoading: true, error: null });
    try {
      const result = await client.request<SupervisorStatus>('rc.supervisor.status', {});
      set({ status: result, statusLoading: false });
    } catch {
      set({ statusLoading: false, status: null });
    }
  },

  loadConfig: async () => {
    const client = useGatewayStore.getState().client;
    if (!client?.isConnected) return;
    set({ configLoading: true, error: null });
    try {
      const result = await client.request<{ ok: boolean; config?: SupervisorConfig }>('rc.supervisor.config', {});
      set({ config: result?.config ?? null, configLoading: false });
    } catch {
      set({ configLoading: false, config: null });
    }
  },

  updateConfig: async (partial) => {
    const client = useGatewayStore.getState().client;
    if (!client?.isConnected) return;
    try {
      const result = await client.request<{ ok: boolean; config: SupervisorConfig }>(
        'rc.supervisor.config',
        partial as Record<string, unknown>,
      );
      set({ config: result.config });
      await get().loadStatus();
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Failed to update supervisor config' });
    }
  },

  restoreDefaults: async () => {
    const client = useGatewayStore.getState().client;
    if (!client?.isConnected) throw new Error('Gateway is not connected');
    set({ configLoading: true, error: null });
    try {
      // The Supervisor owns its defaults. Fetch them at click time so the UI
      // cannot silently drift when the plugin adds or changes a policy field.
      const defaultsResult = await client.request<{ defaults: SupervisorConfig }>(
        'rc.supervisor.defaults',
        {},
      );
      const result = await client.request<{ ok: boolean; config: SupervisorConfig }>(
        'rc.supervisor.config',
        defaultsResult.defaults as unknown as Record<string, unknown>,
      );
      set({ config: result.config, configLoading: false });
      await get().loadStatus();
      return result.config;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to restore review defaults';
      set({ configLoading: false, error: message });
      throw err;
    }
  },

  toggleSupervisor: async (enabled) => {
    const client = useGatewayStore.getState().client;
    if (!client?.isConnected) return;
    try {
      await client.request<{ ok: boolean }>('rc.supervisor.toggle', { enabled });
      await Promise.all([get().loadStatus(), get().loadConfig()]);
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Failed to toggle supervisor' });
    }
  },

  loadAuditLog: async (params) => {
    const client = useGatewayStore.getState().client;
    if (!client?.isConnected) return;
    try {
      const result = await client.request<{ entries: AuditLogEntry[]; total: number }>(
        'rc.supervisor.log',
        params ?? { limit: 200 },
      );
      set({ auditLog: result.entries, auditLogTotal: result.total });
    } catch {
      // silently ignore
    }
  },

  clearAuditLog: async () => {
    const client = useGatewayStore.getState().client;
    if (!client?.isConnected) throw new Error('Gateway is not connected');
    set({ auditLogClearing: true, error: null });
    try {
      const result = await client.request<{ ok: boolean; deleted: number }>(
        'rc.supervisor.log.clear',
        { scope: 'all' },
      );
      set({ auditLog: [], auditLogTotal: 0, auditLogClearing: false });
      await Promise.all([get().loadStatus(), get().loadAuditLog({ limit: 200 })]);
      return result.deleted;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to clear review history';
      set({ auditLogClearing: false, error: message });
      throw err;
    }
  },

  clearError: () => set({ error: null }),

  startPolling: (intervalMs = 3000) => {
    get().stopPolling();
    get().loadStatus();
    get().loadAuditLog({ limit: 200 });
    const timer = setInterval(() => {
      const client = useGatewayStore.getState().client;
      if (!client?.isConnected) {
        get().stopPolling();
        return;
      }
      get().loadStatus();
      get().loadAuditLog({ limit: 200 });
    }, intervalMs);
    set({ pollingTimer: timer });
  },

  stopPolling: () => {
    const timer = get().pollingTimer;
    if (timer) {
      clearInterval(timer);
      set({ pollingTimer: null });
    }
  },
}));

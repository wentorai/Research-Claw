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
  supervisorModel: string;
  appendReviewToChannelOutput: boolean;
  memoryGuardEnabled: boolean;
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
  reviewMode: 'off' | 'filter-only' | 'correct' | 'full';
  appendReviewToChannelOutput: boolean;
  memoryGuard: {
    enabled: boolean;
    keyCategories: string[];
  };
  courseCorrection: {
    enabled: boolean;
    deviationThreshold: number;
    forceRegenerate: boolean;
    maxRegenerateAttempts: number;
  };
  highRiskTools: string[];
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
  error: string | null;
  pollingTimer: ReturnType<typeof setInterval> | null;

  loadStatus: () => Promise<void>;
  loadConfig: () => Promise<void>;
  updateConfig: (partial: Partial<SupervisorConfig>) => Promise<void>;
  toggleSupervisor: (enabled?: boolean) => Promise<void>;
  loadAuditLog: (params?: { limit?: number; offset?: number; type?: string; action?: string; sessionId?: string }) => Promise<void>;
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
      const result = await client.request<{ ok: boolean; config: SupervisorConfig }>('rc.supervisor.config', {});
      set({ config: result.config, configLoading: false });
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

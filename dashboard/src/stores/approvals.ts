import { create } from 'zustand';

export type NativeApprovalDecision = 'allow-once' | 'allow-always' | 'deny';

export interface PluginApprovalRequest {
  id: string;
  request: {
    pluginId?: string | null;
    title: string;
    description?: string | null;
    severity?: 'info' | 'warning' | 'critical' | null;
    toolName?: string | null;
    toolCallId?: string | null;
    sessionKey?: string | null;
    allowedDecisions?: readonly NativeApprovalDecision[] | null;
  };
  createdAtMs: number;
  expiresAtMs: number;
}

interface ApprovalsState {
  pending: PluginApprovalRequest[];
  add: (approval: PluginApprovalRequest) => void;
  remove: (id: string) => void;
  clear: () => void;
}

export const useApprovalsStore = create<ApprovalsState>()((set) => ({
  pending: [],
  add: (approval) => set((state) => ({
    pending: [
      approval,
      ...state.pending.filter((item) => item.id !== approval.id),
    ],
  })),
  remove: (id) => set((state) => ({
    pending: state.pending.filter((item) => item.id !== id),
  })),
  clear: () => set({ pending: [] }),
}));

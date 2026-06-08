/**
 * Skill Workshop store — governed skill create/update via OpenClaw gateway.
 *
 * RPCs: skills.proposals.list | inspect | create | update | revise | apply | reject | quarantine
 */

import { create } from 'zustand';
import { useGatewayStore } from './gateway';
import type {
  SkillProposalManifestEntry,
  SkillProposalRecord,
  SkillProposalSupportFileInput,
  SkillsProposalApplyResult,
  SkillsProposalInspectResult,
  SkillsProposalsListResult,
} from '../gateway/skill-workshop-types';

const _inflight = new Set<string>();

interface SkillWorkshopState {
  proposals: SkillProposalManifestEntry[];
  manifestUpdatedAt: string | null;
  loading: boolean;
  loaded: boolean;
  lastError: string | null;

  selectedId: string | null;
  inspect: SkillsProposalInspectResult | null;
  inspectLoading: boolean;

  loadProposals: () => Promise<void>;
  inspectProposal: (proposalId: string) => Promise<SkillsProposalInspectResult | null>;
  clearSelection: () => void;

  applyProposal: (proposalId: string) => Promise<SkillsProposalApplyResult | null>;
  rejectProposal: (proposalId: string, reason?: string) => Promise<boolean>;
  quarantineProposal: (proposalId: string, reason?: string) => Promise<boolean>;
  reviseProposal: (
    proposalId: string,
    content: string,
    opts?: { description?: string; goal?: string; evidence?: string },
  ) => Promise<boolean>;

  createProposal: (params: {
    name: string;
    description: string;
    content: string;
    goal?: string;
    evidence?: string;
  }) => Promise<SkillProposalRecord | null>;

  updateProposal: (params: {
    skillName: string;
    description?: string;
    content: string;
    goal?: string;
    evidence?: string;
  }) => Promise<SkillProposalRecord | null>;
}

export const useSkillWorkshopStore = create<SkillWorkshopState>()((set, get) => ({
  proposals: [],
  manifestUpdatedAt: null,
  loading: false,
  loaded: false,
  lastError: null,
  selectedId: null,
  inspect: null,
  inspectLoading: false,

  loadProposals: async () => {
    const client = useGatewayStore.getState().client;
    if (!client?.isConnected || get().loading) return;

    set({ loading: true, lastError: null });
    try {
      const result = await client.request<SkillsProposalsListResult>('skills.proposals.list', {});
      set({
        proposals: result.proposals ?? [],
        manifestUpdatedAt: result.updatedAt ?? null,
        loaded: true,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn('[SkillWorkshop] loadProposals failed:', msg);
      set({ lastError: msg });
    } finally {
      set({ loading: false });
    }
  },

  inspectProposal: async (proposalId) => {
    const client = useGatewayStore.getState().client;
    if (!client?.isConnected) return null;

    set({ selectedId: proposalId, inspectLoading: true, lastError: null });
    try {
      const result = await client.request<SkillsProposalInspectResult>('skills.proposals.inspect', {
        proposalId,
      });
      set({ inspect: result });
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      set({ lastError: msg, inspect: null });
      return null;
    } finally {
      set({ inspectLoading: false });
    }
  },

  clearSelection: () => set({ selectedId: null, inspect: null }),

  applyProposal: async (proposalId) => {
    if (_inflight.has(`apply:${proposalId}`)) return null;
    const client = useGatewayStore.getState().client;
    if (!client?.isConnected) return null;

    _inflight.add(`apply:${proposalId}`);
    try {
      const result = await client.request<SkillsProposalApplyResult>('skills.proposals.apply', {
        proposalId,
      });
      await get().loadProposals();
      if (get().selectedId === proposalId) {
        await get().inspectProposal(proposalId);
      }
      return result;
    } catch (err) {
      set({ lastError: err instanceof Error ? err.message : String(err) });
      return null;
    } finally {
      _inflight.delete(`apply:${proposalId}`);
    }
  },

  rejectProposal: async (proposalId, reason) => {
    if (_inflight.has(`reject:${proposalId}`)) return false;
    const client = useGatewayStore.getState().client;
    if (!client?.isConnected) return false;

    _inflight.add(`reject:${proposalId}`);
    try {
      await client.request('skills.proposals.reject', { proposalId, ...(reason ? { reason } : {}) });
      await get().loadProposals();
      if (get().selectedId === proposalId) await get().inspectProposal(proposalId);
      return true;
    } catch (err) {
      set({ lastError: err instanceof Error ? err.message : String(err) });
      return false;
    } finally {
      _inflight.delete(`reject:${proposalId}`);
    }
  },

  quarantineProposal: async (proposalId, reason) => {
    if (_inflight.has(`quarantine:${proposalId}`)) return false;
    const client = useGatewayStore.getState().client;
    if (!client?.isConnected) return false;

    _inflight.add(`quarantine:${proposalId}`);
    try {
      await client.request('skills.proposals.quarantine', { proposalId, ...(reason ? { reason } : {}) });
      await get().loadProposals();
      if (get().selectedId === proposalId) await get().inspectProposal(proposalId);
      return true;
    } catch (err) {
      set({ lastError: err instanceof Error ? err.message : String(err) });
      return false;
    } finally {
      _inflight.delete(`quarantine:${proposalId}`);
    }
  },

  reviseProposal: async (proposalId, content, opts) => {
    if (_inflight.has(`revise:${proposalId}`)) return false;
    const client = useGatewayStore.getState().client;
    if (!client?.isConnected) return false;

    _inflight.add(`revise:${proposalId}`);
    try {
      await client.request('skills.proposals.revise', {
        proposalId,
        content,
        ...(opts?.description ? { description: opts.description } : {}),
        ...(opts?.goal ? { goal: opts.goal } : {}),
        ...(opts?.evidence ? { evidence: opts.evidence } : {}),
      });
      await get().loadProposals();
      await get().inspectProposal(proposalId);
      return true;
    } catch (err) {
      set({ lastError: err instanceof Error ? err.message : String(err) });
      return false;
    } finally {
      _inflight.delete(`revise:${proposalId}`);
    }
  },

  createProposal: async ({ name, description, content, goal, evidence }) => {
    const client = useGatewayStore.getState().client;
    if (!client?.isConnected) return null;

    try {
      const record = await client.request<SkillProposalRecord>('skills.proposals.create', {
        name,
        description,
        content,
        ...(goal ? { goal } : {}),
        ...(evidence ? { evidence } : {}),
      });
      await get().loadProposals();
      return record;
    } catch (err) {
      set({ lastError: err instanceof Error ? err.message : String(err) });
      return null;
    }
  },

  updateProposal: async ({ skillName, description, content, goal, evidence }) => {
    const client = useGatewayStore.getState().client;
    if (!client?.isConnected) return null;

    try {
      const record = await client.request<SkillProposalRecord>('skills.proposals.update', {
        skillName,
        content,
        ...(description ? { description } : {}),
        ...(goal ? { goal } : {}),
        ...(evidence ? { evidence } : {}),
      });
      await get().loadProposals();
      return record;
    } catch (err) {
      set({ lastError: err instanceof Error ? err.message : String(err) });
      return null;
    }
  },
}));

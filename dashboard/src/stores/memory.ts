/**
 * Memory Store
 *
 * Zustand store for managing memory state in the dashboard.
 */

import { create } from 'zustand';
import { useGatewayStore } from './gateway.js';

export type MemoryType = 'user' | 'feedback' | 'project' | 'reference' | 'agent';

export interface Memory {
  id: string;
  type: MemoryType;
  name: string;
  description: string | null;
  content: string;
  metadata: string;
  related_paper_id: string | null;
  related_task_id: string | null;
  created_at: string;
  updated_at: string;
  accessed_at: string | null;
  access_count: number;
  is_active: number;
  is_private: number;
  tags: MemoryTag[];
  links?: MemoryLink[];
}

export interface MemoryTag {
  id: string;
  name: string;
  color: string | null;
  created_at: string;
}

export interface MemoryLink {
  id: string;
  from_memory_id: string;
  to_memory_id: string;
  context: string | null;
  created_at: string;
}

export interface MemoryStats {
  total: number;
  by_type: Record<MemoryType, number>;
  active: number;
  private: number;
  most_accessed: Memory[];
  recently_accessed: Memory[];
  unused: Memory[];
}

export interface MemoryHookLog {
  ts: string;
  source: 'claude-mem' | 'research-claw-core';
  line: string;
}

interface MemoryState {
  memories: Memory[];
  selectedMemory: Memory | null;
  stats: MemoryStats | null;
  loading: boolean;
  error: string | null;
  searchQuery: string;
  selectedType: MemoryType | null;
  hookLogs: MemoryHookLog[];
  hookLogsLoading: boolean;

  // Actions
  setMemories: (memories: Memory[]) => void;
  setSelectedMemory: (memory: Memory | null) => void;
  setStats: (stats: MemoryStats) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  setSearchQuery: (query: string) => void;
  setSelectedType: (type: MemoryType | null) => void;
  setHookLogs: (logs: MemoryHookLog[]) => void;
  setHookLogsLoading: (loading: boolean) => void;

  // Async actions
  fetchMemories: (filters?: { type?: MemoryType; limit?: number; is_active?: boolean }) => Promise<void>;
  fetchMemory: (id: string) => Promise<void>;
  createMemory: (data: {
    type: MemoryType;
    name: string;
    content: string;
    description?: string;
    is_private?: boolean;
  }) => Promise<Memory | null>;
  updateMemory: (id: string, data: Partial<Memory>) => Promise<void>;
  deleteMemory: (id: string) => Promise<void>;
  searchMemories: (query: string, type?: MemoryType) => Promise<Memory[]>;
  fetchStats: () => Promise<void>;
  addTag: (memoryId: string, tagName: string) => Promise<void>;
  removeTag: (memoryId: string, tagName: string) => Promise<void>;
  fetchHookLogs: (source?: 'all' | 'claude-mem' | 'research-claw-core') => Promise<void>;
  syncHookLogs: (
    source?: 'all' | 'claude-mem' | 'research-claw-core',
    limit?: number,
  ) => Promise<{
    success: boolean;
    synced: number;
    scanned: number;
    source: 'all' | 'claude-mem' | 'research-claw-core';
  } | null>;
}

export const useMemoryStore = create<MemoryState>((set, get) => ({
  memories: [],
  selectedMemory: null,
  stats: null,
  loading: false,
  error: null,
  searchQuery: '',
  selectedType: null,
  hookLogs: [],
  hookLogsLoading: false,

  setMemories: (memories) => set({ memories }),
  setSelectedMemory: (memory) => set({ selectedMemory: memory }),
  setStats: (stats) => set({ stats }),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),
  setSearchQuery: (query) => set({ searchQuery: query }),
  setSelectedType: (type) => set({ selectedType: type }),
  setHookLogs: (logs) => set({ hookLogs: logs }),
  setHookLogsLoading: (loading) => set({ hookLogsLoading: loading }),

  fetchMemories: async (filters) => {
    const client = useGatewayStore.getState().client;
    if (!client?.isConnected) {
      console.log('[MemoryStore] fetchMemories skipped: not connected');
      return;
    }

    set({ loading: true, error: null });
    try {
      const params: Record<string, unknown> = {};
      if (filters?.type) {
        params.type = filters.type;
      }
      if (typeof filters?.limit === 'number') {
        params.limit = filters.limit;
      }
      if (typeof filters?.is_active === 'boolean') {
        params.is_active = filters.is_active;
      }

      const response = await client.request<{ items: Memory[]; total: number }>('rc.memory.list', params);
      set({ memories: response.items });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : 'Unknown error' });
    } finally {
      set({ loading: false });
    }
  },

  fetchMemory: async (id) => {
    const client = useGatewayStore.getState().client;
    if (!client?.isConnected) return;

    set({ loading: true, error: null });
    try {
      const response = await client.request<Memory>('rc.memory.get', { id });
      set({ selectedMemory: response });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : 'Unknown error' });
    } finally {
      set({ loading: false });
    }
  },

  createMemory: async (data) => {
    const client = useGatewayStore.getState().client;
    if (!client?.isConnected) return null;

    set({ loading: true, error: null });
    try {
      const response = await client.request<Memory>('rc.memory.create', data);
      const { memories } = get();
      set({ memories: [response, ...memories] });
      return response;
    } catch (error) {
      set({ error: error instanceof Error ? error.message : 'Unknown error' });
      return null;
    } finally {
      set({ loading: false });
    }
  },

  updateMemory: async (id, data) => {
    const client = useGatewayStore.getState().client;
    if (!client?.isConnected) return;

    set({ loading: true, error: null });
    try {
      const response = await client.request<Memory>('rc.memory.update', { id, ...data });
      const { memories, selectedMemory } = get();
      set({
        memories: memories.map((m) => (m.id === id ? response : m)),
        selectedMemory: selectedMemory?.id === id ? response : selectedMemory,
      });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : 'Unknown error' });
    } finally {
      set({ loading: false });
    }
  },

  deleteMemory: async (id) => {
    const client = useGatewayStore.getState().client;
    if (!client?.isConnected) return;

    set({ loading: true, error: null });
    try {
      await client.request<{ id: string }>('rc.memory.delete', { id });
      const { memories, selectedMemory } = get();
      set({
        memories: memories.filter((m) => m.id !== id),
        selectedMemory: selectedMemory?.id === id ? null : selectedMemory,
      });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : 'Unknown error' });
    } finally {
      set({ loading: false });
    }
  },

  searchMemories: async (query, type) => {
    const client = useGatewayStore.getState().client;
    if (!client?.isConnected) return [];

    set({ loading: true, error: null });
    try {
      const params: Record<string, unknown> = { query };
      if (type) {
        params.type = type;
      }

      const response = await client.request<{ results: Array<{ id: string }> }>('rc.memory.search', params);
      // Convert search results to full memories
      const memoryIds = response.results.map((r) => r.id);
      const fullMemories = await Promise.all(
        memoryIds.map((id) => client.request<Memory>('rc.memory.get', { id }))
      );
      return fullMemories;
    } catch (error) {
      set({ error: error instanceof Error ? error.message : 'Unknown error' });
      return [];
    } finally {
      set({ loading: false });
    }
  },

  fetchStats: async () => {
    const client = useGatewayStore.getState().client;
    if (!client?.isConnected) return;

    set({ loading: true, error: null });
    try {
      const response = await client.request<{ success?: boolean; stats?: MemoryStats }>('rc.memory.stats.get', {});
      if (response?.stats) {
        set({ stats: response.stats });
      } else {
        set({ stats: null });
      }
    } catch (error) {
      set({ error: error instanceof Error ? error.message : 'Unknown error' });
    } finally {
      set({ loading: false });
    }
  },

  addTag: async (memoryId, tagName) => {
    const client = useGatewayStore.getState().client;
    if (!client?.isConnected) return;

    set({ loading: true, error: null });
    try {
      await client.request<{ memory_id: string; tag: MemoryTag }>('rc.memory.tags.add', { id: memoryId, tag_name: tagName });
      // Refresh the memory to get updated tags
      await get().fetchMemory(memoryId);
    } catch (error) {
      set({ error: error instanceof Error ? error.message : 'Unknown error' });
    } finally {
      set({ loading: false });
    }
  },

  removeTag: async (memoryId, tagName) => {
    const client = useGatewayStore.getState().client;
    if (!client?.isConnected) return;

    set({ loading: true, error: null });
    try {
      await client.request<{ memory_id: string; tag_name: string }>('rc.memory.tags.remove', { id: memoryId, tag_name: tagName });
      // Refresh the memory to get updated tags
      await get().fetchMemory(memoryId);
    } catch (error) {
      set({ error: error instanceof Error ? error.message : 'Unknown error' });
    } finally {
      set({ loading: false });
    }
  },

  fetchHookLogs: async (source = 'all') => {
    const client = useGatewayStore.getState().client;
    if (!client?.isConnected) return;
    set({ hookLogsLoading: true, error: null });
    try {
      const response = await client.request<{ items: MemoryHookLog[] }>('rc.memory.hookLogs', { source, limit: 160 });
      set({ hookLogs: response.items || [] });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : 'Unknown error' });
    } finally {
      set({ hookLogsLoading: false });
    }
  },

  // ── Claude-mem sync actions ─────────────────────────────────────────

  syncClaudeMem: async (limit?: number) => {
    const client = useGatewayStore.getState().client;
    if (!client?.isConnected) {
      set({ error: 'Not connected to gateway' });
      return null;
    }

    set({ loading: true, error: null });
    try {
      const response = await client.request<{
        success: boolean;
        synced: number;
        updated: number;
        skipped: number;
        errors: string[];
        agent_memory_count: number;
      }>('rc.memory.syncClaudeMem', { limit: limit ?? 100 });

      // Refresh memories list after sync
      await get().fetchMemories();
      return response;
    } catch (error) {
      set({ error: error instanceof Error ? error.message : 'Unknown error' });
      return null;
    } finally {
      set({ loading: false });
    }
  },

  getClaudeMemStatus: async () => {
    const client = useGatewayStore.getState().client;
    if (!client?.isConnected) return null;

    try {
      const response = await client.request<{
        success: boolean;
        workerTotal: number;
        rcSynced: number;
        workerUrl: string;
        rc_agent_memories: number;
      }>('rc.memory.getClaudeMemStatus', {});
      return response;
    } catch (error) {
      set({ error: error instanceof Error ? error.message : 'Unknown error' });
      return null;
    }
  },

  syncHookLogs: async (source = 'all', limit = 220) => {
    const client = useGatewayStore.getState().client;
    if (!client?.isConnected) return null;
    set({ loading: true, error: null });
    try {
      const response = await client.request<{
        success: boolean;
        synced: number;
        scanned: number;
        source: 'all' | 'claude-mem' | 'research-claw-core';
      }>('rc.memory.syncHookLogs', { source, limit });
      // Keep list dataset consistent with panel expectations: full active set.
      // Avoid default limit=50 refresh that can hide user/feedback/reference cards.
      await get().fetchMemories({ limit: 5000, is_active: true });
      return response;
    } catch (error) {
      set({ error: error instanceof Error ? error.message : 'Unknown error' });
      return null;
    } finally {
      set({ loading: false });
    }
  },
}));

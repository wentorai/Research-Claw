import { create } from 'zustand';
import { useGatewayStore } from './gateway';

// --- Type definitions aligned with 03a §3 ---

export type ReadStatus = 'unread' | 'reading' | 'read' | 'reviewed';

/**
 * Paper interface — aligned with Research-Claw Core plugin.
 * Source: extensions/research-claw-core/src/literature/service.ts (lines 50-71)
 *
 * The gateway sends `null` for empty nullable fields (NOT undefined).
 * Every `T | null` field below matches the plugin's Paper interface exactly.
 */
export interface Paper {
  id: string;
  title: string;
  authors: string[];
  abstract: string | null;
  doi: string | null;
  url: string | null;
  arxiv_id: string | null;
  pdf_path: string | null;
  source: string | null;
  source_id: string | null;
  venue: string | null;
  year: number | null;
  added_at: string;
  updated_at: string;
  read_status: ReadStatus;
  rating: number | null;
  notes: string | null;
  bibtex_key: string | null;
  metadata: Record<string, unknown>;
  keywords?: string[];
  language?: string | null;
  paper_type?: string | null;
  volume?: string | null;
  issue?: string | null;
  pages?: string | null;
  publisher?: string | null;
  issn?: string | null;
  isbn?: string | null;
  discipline?: string | null;
  citation_count?: number | null;
  tags?: string[];
  /** Dashboard-only field — not present in plugin response */
  is_own?: boolean;
}

/**
 * Tag interface — aligned with Research-Claw Core plugin.
 * Source: extensions/research-claw-core/src/literature/service.ts (lines 82-88)
 */
export interface Tag {
  id: string;
  name: string;
  color: string | null;
  paper_count?: number;
  created_at: string;
}

export interface PaperFilter {
  read_status?: ReadStatus;
  tags?: string[];
  year?: number;
  sort?: 'added_at' | 'year' | 'title';
}

interface LibraryState {
  papers: Paper[];
  tags: Tag[];
  loading: boolean;
  total: number;
  searchQuery: string;
  activeTab: 'inbox' | 'archive' | 'starred';
  filters: PaperFilter;

  loadPapers: (filter?: PaperFilter) => Promise<void>;
  loadTags: () => Promise<void>;
  setSearchQuery: (q: string) => void;
  setActiveTab: (tab: 'inbox' | 'archive' | 'starred') => void;
  updatePaperStatus: (id: string, status: ReadStatus) => Promise<void>;
  ratePaper: (id: string, rating: number) => Promise<void>;
  setFilters: (filters: Partial<PaperFilter>) => void;
  searchPapers: (query: string) => Promise<void>;
  deletePaper: (id: string) => Promise<void>;
}

export const useLibraryStore = create<LibraryState>()((set, get) => ({
  papers: [],
  tags: [],
  loading: false,
  total: 0,
  searchQuery: '',
  activeTab: 'inbox',
  filters: {},

  loadPapers: async (filter?: PaperFilter) => {
    const client = useGatewayStore.getState().client;
    if (!client?.isConnected) {
      console.log('[LibraryStore] loadPapers skipped: not connected');
      return;
    }
    set({ loading: true });
    try {
      const query = get().searchQuery.trim();
      if (query) {
        // rc.lit.list does NOT support text search — use rc.lit.search (FTS5)
        console.log('[LibraryStore] loadPapers → rc.lit.search (query=%s)', query);
        const result = await client.request<{ items: Paper[]; total: number }>('rc.lit.search', { query });
        set({ papers: result.items, total: result.total, loading: false });
      } else {
        // No search query — use rc.lit.list with structured filters
        console.log('[LibraryStore] loadPapers → rc.lit.list');
        const params: Record<string, unknown> = {};
        const effectiveFilter = filter ?? get().filters;
        if (effectiveFilter.read_status) params.read_status = effectiveFilter.read_status;
        if (effectiveFilter.tags?.length) params.tags = effectiveFilter.tags;
        if (effectiveFilter.year) params.year = effectiveFilter.year;
        if (effectiveFilter.sort) {
          // Backend defaults to DESC; title should be ascending (A→Z)
          params.sort = effectiveFilter.sort === 'title' ? '+title' : effectiveFilter.sort;
        }
        const result = await client.request<{ items: Paper[]; total: number }>('rc.lit.list', params);
        set({ papers: result.items, total: result.total, loading: false });
      }
    } catch {
      set({ loading: false });
    }
  },

  loadTags: async () => {
    const client = useGatewayStore.getState().client;
    if (!client?.isConnected) return;
    try {
      const result = await client.request<Tag[]>('rc.lit.tags');
      set({ tags: Array.isArray(result) ? result : [] });
    } catch {
      /* non-fatal */
    }
  },

  setSearchQuery: (q: string) => {
    set({ searchQuery: q });
  },

  setActiveTab: (tab: 'inbox' | 'archive' | 'starred') => {
    set({ activeTab: tab });
  },

  setFilters: (filters: Partial<PaperFilter>) => {
    set((s) => ({ filters: { ...s.filters, ...filters } }));
  },

  updatePaperStatus: async (id: string, status: ReadStatus) => {
    const client = useGatewayStore.getState().client;
    if (!client?.isConnected) return;
    // Optimistic update
    set((s) => ({
      papers: s.papers.map((p) => (p.id === id ? { ...p, read_status: status } : p)),
    }));
    try {
      await client.request('rc.lit.status', { id, status });
    } catch {
      // Revert on failure — reload
      get().loadPapers();
    }
  },

  ratePaper: async (id: string, rating: number) => {
    const client = useGatewayStore.getState().client;
    if (!client?.isConnected) return;
    // Optimistic update
    set((s) => ({
      papers: s.papers.map((p) => (p.id === id ? { ...p, rating } : p)),
    }));
    try {
      await client.request('rc.lit.rate', { id, rating });
    } catch {
      get().loadPapers();
    }
  },

  searchPapers: async (query: string) => {
    const client = useGatewayStore.getState().client;
    if (!client?.isConnected) return;
    set({ loading: true, searchQuery: query });
    try {
      const result = await client.request<{ items: Paper[]; total: number }>('rc.lit.search', { query });
      set({ papers: result.items, total: result.total, loading: false });
    } catch {
      set({ loading: false });
    }
  },

  deletePaper: async (id: string) => {
    const client = useGatewayStore.getState().client;
    if (!client?.isConnected) return;
    try {
      await client.request('rc.lit.delete', { id });
      set((s) => ({
        papers: s.papers.filter((p) => p.id !== id),
        total: s.total - 1,
      }));
      // Refresh tags so counts and visibility stay in sync
      get().loadTags();
    } catch {
      // Reload to restore consistent state
      get().loadPapers();
    }
  },
}));

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
  /**
   * On the Starred tab: when set, list all papers in that collection (not only starred).
   * When unset, list starred papers only (rating > 0).
   */
  collection_id?: string;
}

/** Named paper collection from `rc.lit.collections.list` */
export interface LibraryCollection {
  id: string;
  name: string;
  description: string | null;
  color: string | null;
  created_at: string;
  updated_at: string;
  paper_count?: number;
}

// --- Pagination & tab-filtering constants ---

const PAGE_SIZE = 30;

/** Maps each tab to the read_status values the server should return. */
const TAB_STATUS_MAP: Record<'inbox' | 'archive', ReadStatus[]> = {
  inbox: ['unread', 'reading'],
  archive: ['read', 'reviewed'],
};

type TabKey = 'inbox' | 'archive' | 'starred';

export interface TabCounts {
  inbox: number;
  archive: number;
  starred: number;
}

interface LibraryState {
  papers: Paper[];
  tags: Tag[];
  collections: LibraryCollection[];
  loading: boolean;
  loadingMore: boolean;
  total: number;
  offset: number;
  hasMore: boolean;
  searchQuery: string;
  activeTab: TabKey;
  filters: PaperFilter;
  tabCounts: TabCounts | null;

  loadPapers: (filter?: PaperFilter) => Promise<void>;
  loadMorePapers: () => Promise<void>;
  loadTags: () => Promise<void>;
  loadCollections: () => Promise<void>;
  loadStats: () => Promise<void>;
  setSearchQuery: (q: string) => void;
  setActiveTab: (tab: TabKey) => void;
  updatePaperStatus: (id: string, status: ReadStatus) => Promise<void>;
  ratePaper: (id: string, rating: number) => Promise<void>;
  setFilters: (filters: Partial<PaperFilter>) => void;
  searchPapers: (query: string) => Promise<void>;
  deletePaper: (id: string) => Promise<void>;
  addPaperToCollection: (paperId: string, collectionId: string) => Promise<void>;
}

// --- Helpers ---

/**
 * Build the params object for `rc.lit.list` based on the current tab,
 * user filters, and pagination offset/limit.
 */
function buildListParams(
  tab: TabKey,
  filters: PaperFilter,
  offset: number,
): Record<string, unknown> {
  const params: Record<string, unknown> = {
    limit: PAGE_SIZE,
    offset,
  };

  if (tab === 'starred') {
    if (filters.collection_id) {
      // Browse one collection: show every paper in it (sort still prefers higher rating first)
      params.collection_id = filters.collection_id;
      params.sort = '-rating';
    } else {
      // Default: all starred papers, rating first
      params.sort = '-rating';
    }
  } else {
    params.read_status = TAB_STATUS_MAP[tab];
  }

  // User-level filters
  if (filters.read_status) params.read_status = filters.read_status;
  if (filters.tags?.length) params.tags = filters.tags;
  if (filters.year) params.year = filters.year;
  if (filters.sort) {
    // Backend defaults to DESC; title should be ascending (A→Z)
    params.sort = filters.sort === 'title' ? '+title' : filters.sort;
  }

  return params;
}

export const useLibraryStore = create<LibraryState>()((set, get) => ({
  papers: [],
  tags: [],
  collections: [],
  loading: false,
  loadingMore: false,
  total: 0,
  offset: 0,
  hasMore: false,
  searchQuery: '',
  activeTab: 'inbox',
  filters: {},
  tabCounts: null,

  loadPapers: async (filter?: PaperFilter) => {
    const client = useGatewayStore.getState().client;
    if (!client?.isConnected) {
      console.log('[LibraryStore] loadPapers skipped: not connected');
      return;
    }
    set({ loading: true });
    try {
      const { activeTab, filters } = get();

      const query = get().searchQuery.trim();
      if (query) {
        // rc.lit.list does NOT support text search — use rc.lit.search (FTS5)
        console.log('[LibraryStore] loadPapers → rc.lit.search (query=%s)', query);
        const searchParams: Record<string, unknown> = { query, limit: PAGE_SIZE, offset: 0 };
        if (activeTab === 'starred' && filters.collection_id) {
          searchParams.collection_id = filters.collection_id;
        }
        const result = await client.request<{ items: Paper[]; total: number }>(
          'rc.lit.search',
          searchParams,
        );
        set({
          papers: result.items,
          total: result.total,
          offset: result.items.length,
          hasMore: result.items.length < result.total,
          loading: false,
        });
      } else {
        // No search query — use rc.lit.list with structured filters
        const effectiveFilter = filter ?? get().filters;
        const params = buildListParams(activeTab, effectiveFilter, 0);
        console.log('[LibraryStore] loadPapers → rc.lit.list', params);

        const result = await client.request<{ items: Paper[]; total: number }>(
          'rc.lit.list',
          params,
        );

        let items = result.items;
        let total = result.total;
        let hasMore = items.length >= PAGE_SIZE;

        // Starred tab, no collection: only show starred papers (intersection was wrong UX)
        if (activeTab === 'starred' && !effectiveFilter.collection_id) {
          items = items.filter((p) => (p.rating ?? 0) > 0);
          const cachedStarred = get().tabCounts?.starred;
          total = cachedStarred ?? (items.length < PAGE_SIZE ? items.length : result.total);
          hasMore = items.length >= PAGE_SIZE;
        } else if (activeTab === 'starred' && effectiveFilter.collection_id) {
          hasMore = items.length < result.total;
        }

        set({
          papers: items,
          total,
          offset: items.length,
          hasMore,
          loading: false,
        });
      }
    } catch {
      set({ loading: false });
    }
  },

  loadMorePapers: async () => {
    const { hasMore, loadingMore, loading } = get();
    if (!hasMore || loadingMore || loading) return;

    const client = useGatewayStore.getState().client;
    if (!client?.isConnected) return;

    const { activeTab, filters } = get();

    set({ loadingMore: true });
    try {
      const { searchQuery, offset, papers } = get();
      const query = searchQuery.trim();

      if (query) {
        const searchParams: Record<string, unknown> = { query, limit: PAGE_SIZE, offset };
        if (activeTab === 'starred' && filters.collection_id) {
          searchParams.collection_id = filters.collection_id;
        }
        const result = await client.request<{ items: Paper[]; total: number }>(
          'rc.lit.search',
          searchParams,
        );
        const merged = [...papers, ...result.items];
        set({
          papers: merged,
          total: result.total,
          offset: merged.length,
          hasMore: merged.length < result.total,
          loadingMore: false,
        });
      } else {
        const params = buildListParams(activeTab, filters, offset);
        const result = await client.request<{ items: Paper[]; total: number }>(
          'rc.lit.list',
          params,
        );

        let newItems = result.items;
        if (activeTab === 'starred' && !filters.collection_id) {
          newItems = newItems.filter((p) => (p.rating ?? 0) > 0);
        }

        const merged = [...papers, ...newItems];
        const hasMore =
          activeTab === 'starred' && filters.collection_id
            ? merged.length < result.total
            : newItems.length >= PAGE_SIZE;

        set({
          papers: merged,
          total: result.total,
          offset: merged.length,
          hasMore,
          loadingMore: false,
        });
      }
    } catch {
      set({ loadingMore: false });
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

  loadCollections: async () => {
    const client = useGatewayStore.getState().client;
    if (!client?.isConnected) return;
    try {
      const result = await client.request<LibraryCollection[]>('rc.lit.collections.list');
      set({ collections: Array.isArray(result) ? result : [] });
    } catch {
      /* non-fatal */
    }
  },

  loadStats: async () => {
    const client = useGatewayStore.getState().client;
    if (!client?.isConnected) return;
    try {
      const stats = await client.request<{
        total: number;
        by_status: Record<string, number>;
        starred_count?: number;
      }>('rc.lit.stats', {});
      const bs = stats.by_status ?? {};
      const inbox = (bs.unread ?? 0) + (bs.reading ?? 0);
      const archive = (bs.read ?? 0) + (bs.reviewed ?? 0);
      const starred = stats.starred_count ?? 0;
      set({ tabCounts: { inbox, archive, starred } });
    } catch {
      /* non-fatal — tabs just won't show counts */
    }
  },

  setSearchQuery: (q: string) => {
    set({ searchQuery: q });
  },

  setActiveTab: (tab: TabKey) => {
    set((s) => {
      const nextFilters = { ...s.filters };
      if (tab !== 'starred') {
        delete nextFilters.collection_id;
      }
      return {
        activeTab: tab,
        papers: [],
        total: 0,
        offset: 0,
        hasMore: false,
        filters: nextFilters,
      };
    });
    setTimeout(() => {
      get().loadPapers();
    }, 0);
  },

  setFilters: (filters: Partial<PaperFilter>) => {
    set((s) => {
      const next = { ...s.filters, ...filters };
      for (const key of Object.keys(filters) as (keyof PaperFilter)[]) {
        if (filters[key] === undefined) {
          delete next[key];
        }
      }
      return { filters: next };
    });
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
      get().loadStats();
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
      get().loadStats();
    } catch {
      get().loadPapers();
    }
  },

  searchPapers: async (query: string) => {
    const client = useGatewayStore.getState().client;
    if (!client?.isConnected) return;
    const { activeTab, filters } = get();
    set({ loading: true, searchQuery: query });
    try {
      const searchParams: Record<string, unknown> = { query, limit: PAGE_SIZE, offset: 0 };
      if (activeTab === 'starred' && filters.collection_id) {
        searchParams.collection_id = filters.collection_id;
      }
      const result = await client.request<{ items: Paper[]; total: number }>(
        'rc.lit.search',
        searchParams,
      );
      set({
        papers: result.items,
        total: result.total,
        offset: result.items.length,
        hasMore: result.items.length < result.total,
        loading: false,
      });
    } catch {
      set({ loading: false });
    }
  },

  addPaperToCollection: async (paperId: string, collectionId: string) => {
    const client = useGatewayStore.getState().client;
    if (!client?.isConnected) throw new Error('Gateway not connected');
    await client.request('rc.lit.collections.manage', {
      action: 'add_paper',
      id: collectionId,
      paper_ids: [paperId],
    });
    await get().loadCollections();
    get().loadPapers();
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
      // Refresh tags, collections, and stats so counts stay in sync
      get().loadTags();
      get().loadCollections();
      get().loadStats();
    } catch {
      // Reload to restore consistent state
      get().loadPapers();
    }
  },
}));

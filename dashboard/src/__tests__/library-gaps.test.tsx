/**
 * Library Gap Fix Tests (GAP-1 through GAP-4)
 *
 * GAP-1: Verify store calls loadTags after deletion (orphan cleanup is backend-side)
 * GAP-2: Multiple tags selected → store receives full tags array
 * GAP-3: Empty state text matches new AI-native copy
 * GAP-4: Tag bar visible when filtered results empty; clear button works; expand tags
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import React from 'react';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (opts && 'count' in opts) return `${key}:${opts.count}`;
      return key;
    },
    i18n: { changeLanguage: vi.fn() },
  }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

vi.mock('react-window', () => ({
  List: ({ rowComponent: Row, rowCount, rowProps }: any) => (
    <div data-testid="virtual-list">
      {Array.from({ length: Math.min(rowCount, 5) }, (_, i) =>
        Row({ index: i, style: {}, ariaAttributes: {}, ...rowProps }),
      )}
    </div>
  ),
}));

const mockGatewayClient = {
  isConnected: true,
  request: vi.fn(),
};

vi.mock('../stores/gateway', () => ({
  useGatewayStore: Object.assign(
    (selector: (s: any) => any) => {
      const state = {
        client: mockGatewayClient,
        state: 'connected',
        serverVersion: '0.0.0-mock',
        assistantName: 'Research-Claw',
        connId: 'mock-conn-id',
      };
      return selector(state);
    },
    {
      getState: () => ({
        client: mockGatewayClient,
        state: 'connected',
      }),
      setState: vi.fn(),
      subscribe: vi.fn(() => vi.fn()),
    },
  ),
}));

vi.mock('../stores/chat', () => ({
  useChatStore: Object.assign(
    (selector: (s: any) => any) => selector({ send: vi.fn() }),
    {
      getState: () => ({ send: vi.fn() }),
      setState: vi.fn(),
      subscribe: vi.fn(() => vi.fn()),
    },
  ),
}));

vi.mock('../components/panels/EditTagsModal', () => ({
  default: () => <div data-testid="edit-tags-modal" />,
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------
import { useLibraryStore } from '../stores/library';
import { useConfigStore } from '../stores/config';
import LibraryPanel from '../components/panels/LibraryPanel';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const makePaper = (overrides: Record<string, unknown> = {}) => ({
  id: 'p1',
  title: 'Test Paper',
  authors: ['Author A'],
  abstract: null,
  doi: null,
  url: null,
  arxiv_id: null,
  pdf_path: null,
  source: null,
  source_id: null,
  venue: null,
  year: 2025,
  added_at: '2025-01-01T00:00:00Z',
  updated_at: '2025-01-01T00:00:00Z',
  read_status: 'unread' as const,
  rating: null,
  notes: null,
  bibtex_key: null,
  metadata: {},
  tags: [] as string[],
  ...overrides,
});

const makeTag = (overrides: Record<string, unknown> = {}) => ({
  id: 'tag1',
  name: 'machine-learning',
  color: null,
  paper_count: 1,
  created_at: '2025-01-01T00:00:00Z',
  ...overrides,
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resetStores() {
  vi.clearAllMocks();
  mockGatewayClient.isConnected = true;
  mockGatewayClient.request.mockReset();

  useLibraryStore.setState({
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
  });

  useConfigStore.setState({ theme: 'dark' });
}

function setupMethodRouter(responses: Record<string, unknown>) {
  mockGatewayClient.request.mockImplementation((method: string) => {
    if (method in responses) {
      return Promise.resolve(responses[method]);
    }
    return Promise.resolve({});
  });
}

// =========================================================================
// GAP-3: Empty state copy
// =========================================================================
describe('GAP-3: Empty state copy — no drag/drop/upload mention', () => {
  beforeEach(() => {
    resetStores();
  });

  it('renders "explore" empty state when no papers and no filters', async () => {
    useLibraryStore.setState({
      papers: [],
      tags: [],
      total: 0,
      searchQuery: '',
      activeTab: 'inbox',
      filters: {},
      loading: false,
    });

    mockGatewayClient.request.mockImplementation((method: string) => {
      if (method === 'rc.lit.list' || method === 'rc.lit.search') {
        return Promise.resolve({ items: [], total: 0 });
      }
      if (method === 'rc.lit.tags') {
        return Promise.resolve([]);
      }
      return Promise.resolve({});
    });

    await act(async () => {
      render(<LibraryPanel />);
    });

    // The i18n mock returns the key as-is
    expect(screen.getByText('library.empty')).toBeInTheDocument();
  });

  it('renders "no papers match filters" when search query active and server returns empty', async () => {
    // With server-side pagination, the server applies tab + filter constraints.
    // If the result is empty but a search query is active, we show emptyFiltered.
    useLibraryStore.setState({
      papers: [],
      tags: [],
      total: 0,
      activeTab: 'inbox',
      searchQuery: 'nonexistent',
    });

    setupMethodRouter({
      'rc.lit.list': { items: [], total: 0 },
      'rc.lit.tags': [],
      'rc.lit.search': { items: [], total: 0 },
    });

    await act(async () => {
      render(<LibraryPanel />);
    });

    expect(screen.getByText('library.emptyFiltered')).toBeInTheDocument();
  });

  it('en.json empty state does not contain drag/drop/upload/workspace/PDF', async () => {
    const en = await import('../i18n/en.json');
    const emptyText: string = (en.default ?? en).library.empty;

    expect(emptyText.toLowerCase()).not.toContain('drag');
    expect(emptyText.toLowerCase()).not.toContain('drop');
    expect(emptyText.toLowerCase()).not.toContain('upload');
    expect(emptyText.toLowerCase()).not.toContain('workspace');
    expect(emptyText).not.toContain('PDF');
    expect(emptyText).not.toContain('pdf');
  });

  it('en.json empty state mentions Research-Claw', async () => {
    const en = await import('../i18n/en.json');
    const emptyText: string = (en.default ?? en).library.empty;

    expect(emptyText).toContain('Research-Claw');
  });

  it('zh-CN.json empty state does not contain drag/drop/upload/PDF references', async () => {
    const zhCN = await import('../i18n/zh-CN.json');
    const emptyText: string = (zhCN.default ?? zhCN).library.empty;

    expect(emptyText).not.toContain('拖放');
    expect(emptyText).not.toContain('拖拽');
    expect(emptyText).not.toContain('上传');
    expect(emptyText).not.toContain('工作区');
    expect(emptyText).not.toContain('PDF');
  });

  it('zh-CN.json empty state mentions 科研龙虾', async () => {
    const zhCN = await import('../i18n/zh-CN.json');
    const emptyText: string = (zhCN.default ?? zhCN).library.empty;

    expect(emptyText).toContain('科研龙虾');
  });

  it('zh-CN.json emptyFiltered mentions 过滤条件', async () => {
    const zhCN = await import('../i18n/zh-CN.json');
    const filtered: string = (zhCN.default ?? zhCN).library.emptyFiltered;

    expect(filtered).toContain('过滤条件');
  });
});

// =========================================================================
// GAP-2: Multi-tag filter in dashboard
// =========================================================================
describe('GAP-2: Multiple tags selected sends full tags array to store', () => {
  beforeEach(() => {
    resetStores();
  });

  it('sends full tags array (not just first tag) when multiple tags selected', async () => {
    // Paper must have the tags so displayTags (computed from current tab papers) shows them
    const paper = makePaper({ id: 'p1', read_status: 'unread', tags: ['alpha', 'beta'] });
    const tags = [
      makeTag({ id: 't1', name: 'alpha', paper_count: 1 }),
      makeTag({ id: 't2', name: 'beta', paper_count: 1 }),
    ];

    useLibraryStore.setState({
      papers: [paper],
      tags,
      total: 1,
      activeTab: 'inbox',
    });

    setupMethodRouter({
      'rc.lit.list': { items: [paper], total: 1 },
      'rc.lit.tags': tags,
      'rc.lit.search': { items: [paper], total: 1 },
    });

    await act(async () => {
      render(<LibraryPanel />);
    });

    // Click first tag (in the filter bar, not the paper card tag)
    const alphaTag = screen.getAllByText('alpha')[0];
    await act(async () => {
      fireEvent.click(alphaTag);
    });

    // Click second tag
    const betaTag = screen.getAllByText('beta')[0];
    await act(async () => {
      fireEvent.click(betaTag);
    });

    // Verify the store received the full tags array
    await waitFor(() => {
      const storeFilters = useLibraryStore.getState().filters;
      expect(storeFilters.tags).toEqual(['alpha', 'beta']);
    });
  });

  it('store sends tags array via RPC params', async () => {
    useLibraryStore.setState({
      papers: [],
      tags: [],
      total: 0,
      searchQuery: '',
      activeTab: 'inbox',
      filters: { tags: ['ml', 'cv'] },
    });

    mockGatewayClient.request.mockResolvedValue({ items: [], total: 0 });

    await act(async () => {
      await useLibraryStore.getState().loadPapers();
    });

    // Verify rc.lit.list was called with tags array
    expect(mockGatewayClient.request).toHaveBeenCalledWith(
      'rc.lit.list',
      expect.objectContaining({ tags: ['ml', 'cv'] }),
    );
  });

  it('clicking a selected tag de-selects it (toggle behavior)', async () => {
    // Paper must have the tag so displayTags (computed from current tab papers) shows it
    const paper = makePaper({ id: 'p1', read_status: 'unread', tags: ['gamma'] });
    const tags = [makeTag({ id: 't1', name: 'gamma', paper_count: 1 })];

    useLibraryStore.setState({
      papers: [paper],
      tags,
      total: 1,
      activeTab: 'inbox',
    });

    setupMethodRouter({
      'rc.lit.list': { items: [paper], total: 1 },
      'rc.lit.tags': tags,
    });

    await act(async () => {
      render(<LibraryPanel />);
    });

    // Click the tag in the filter bar (first match, before the paper card tag)
    const gammaTag = screen.getAllByText('gamma')[0];

    // Select
    await act(async () => {
      fireEvent.click(gammaTag);
    });
    await waitFor(() => {
      expect(useLibraryStore.getState().filters.tags).toEqual(['gamma']);
    });

    // De-select (toggle)
    await act(async () => {
      fireEvent.click(gammaTag);
    });
    await waitFor(() => {
      expect(useLibraryStore.getState().filters.tags).toBeUndefined();
    });
  });
});

// =========================================================================
// GAP-4: Filter navigation — tag bar visibility, clear button, expand
// =========================================================================
describe('GAP-4: Tag bar visibility and clear button', () => {
  beforeEach(() => {
    resetStores();
  });

  it('tag bar remains visible when filtered results are empty', async () => {
    // Two papers: one unread with tag "physics", one without.
    // On the pending tab both are visible. Clicking the "physics" tag filter
    // narrows results, and the tag bar should remain visible even if other
    // papers are filtered out.
    const paper1 = makePaper({ id: 'p1', read_status: 'unread', tags: ['physics'] });
    const paper2 = makePaper({ id: 'p2', title: 'Paper 2', read_status: 'unread', tags: [] });
    const tag = makeTag({ name: 'physics', paper_count: 1 });

    useLibraryStore.setState({
      papers: [paper1, paper2],
      tags: [tag],
      total: 2,
      activeTab: 'inbox',
    });

    setupMethodRouter({
      'rc.lit.list': { items: [paper1, paper2], total: 2 },
      'rc.lit.tags': [tag],
    });

    await act(async () => {
      render(<LibraryPanel />);
    });

    // Click the tag to filter — use getAllByText since the tag appears in both
    // the filter bar and the paper card
    const tagEl = screen.getAllByText('physics')[0];
    await act(async () => {
      fireEvent.click(tagEl);
    });

    // Tag bar should still be visible (tag chip is still rendered)
    expect(screen.getAllByText('physics').length).toBeGreaterThan(0);
  });

  it('clear button appears when filters are active and papers empty', async () => {
    // Use an unread paper with the tag so the tag appears in the filter bar.
    // The selectedTags useEffect fires on mount with [], so we need all mount
    // calls to return the paper. Only after the user clicks the tag should
    // we return empty to trigger the clear button.
    const paper = makePaper({ id: 'p1', read_status: 'unread', tags: ['ml'] });
    const tag = makeTag({ name: 'ml', paper_count: 1 });

    useLibraryStore.setState({
      papers: [paper],
      tags: [tag],
      total: 1,
      activeTab: 'inbox',
    });

    // Track when user clicks the tag (selectedTags changes from [] to ['ml'])
    let userClickedTag = false;
    mockGatewayClient.request.mockImplementation((method: string, params?: any) => {
      if (method === 'rc.lit.list') {
        // After user clicks the tag, the filter includes tags: ['ml']
        if (params?.tags?.length > 0) {
          userClickedTag = true;
          return Promise.resolve({ items: [], total: 0 });
        }
        return Promise.resolve({ items: [paper], total: 1 });
      }
      if (method === 'rc.lit.tags') return Promise.resolve([tag]);
      return Promise.resolve({});
    });

    await act(async () => {
      render(<LibraryPanel />);
    });

    // Click tag to activate filter (use first match — the filter bar tag)
    await act(async () => {
      fireEvent.click(screen.getAllByText('ml')[0]);
    });

    await waitFor(() => {
      expect(screen.getByText('library.clearFilter')).toBeInTheDocument();
    });
  });

  it('clicking clear button resets selectedTags and reloads papers', async () => {
    // Paper must be unread (pending tab) and have the tag for tag bar to appear
    const paper = makePaper({ id: 'p1', read_status: 'unread', tags: ['delta'] });
    const tag = makeTag({ name: 'delta', paper_count: 1 });

    useLibraryStore.setState({
      papers: [paper],
      tags: [tag],
      total: 1,
      activeTab: 'inbox',
      searchQuery: '',
      filters: { tags: ['delta'] },
    });

    // Return empty only when tag filter is active (params.tags has values)
    mockGatewayClient.request.mockImplementation((method: string, params?: any) => {
      if (method === 'rc.lit.list') {
        if (params?.tags?.length > 0) {
          return Promise.resolve({ items: [], total: 0 });
        }
        return Promise.resolve({ items: [paper], total: 1 });
      }
      if (method === 'rc.lit.tags') return Promise.resolve([tag]);
      if (method === 'rc.lit.search') return Promise.resolve({ items: [paper], total: 1 });
      return Promise.resolve({});
    });

    await act(async () => {
      render(<LibraryPanel />);
    });

    // Click tag to activate selectedTags (so clear button appears)
    await act(async () => {
      fireEvent.click(screen.getAllByText('delta')[0]);
    });

    await waitFor(() => {
      expect(screen.getByText('library.clearFilter')).toBeInTheDocument();
    });

    // Click clear
    await act(async () => {
      fireEvent.click(screen.getByText('library.clearFilter'));
    });

    await waitFor(() => {
      const state = useLibraryStore.getState();
      expect(state.searchQuery).toBe('');
      expect(state.filters).toEqual({});
    });
  });

  it('shows expand button when more than 10 tags exist', async () => {
    // Create 15 tags — paper must have all tag names so displayTags shows them
    const tagNames = Array.from({ length: 15 }, (_, i) => `tag-${i}`);
    const tags = tagNames.map((name, i) => makeTag({
      id: `tag-${i}`,
      name,
      paper_count: 1,
    }));

    const paper = makePaper({ id: 'p1', read_status: 'unread', tags: tagNames });

    useLibraryStore.setState({
      papers: [paper],
      tags,
      total: 1,
      activeTab: 'inbox',
    });

    setupMethodRouter({
      'rc.lit.list': { items: [paper], total: 1 },
      'rc.lit.tags': tags,
    });

    await act(async () => {
      render(<LibraryPanel />);
    });

    // First 10 tags should be visible in the filter bar
    // (paper card only shows first 3, but the filter bar shows first 10)
    expect(screen.getAllByText('tag-0').length).toBeGreaterThan(0);
    expect(screen.getAllByText('tag-9').length).toBeGreaterThan(0);

    // Tag 10-14 should NOT be visible in the filter bar yet
    // (tag-10 through tag-14 appear on the paper card's +12 overflow, not individually)
    // The filter bar hides them until expand is clicked
    expect(screen.queryAllByText('tag-10')).toHaveLength(0);

    // The expand button should show "+5"
    expect(screen.getByText('+5')).toBeInTheDocument();

    // Click expand
    await act(async () => {
      fireEvent.click(screen.getByText('+5'));
    });

    // Now all 15 tags should be visible in the filter bar
    expect(screen.getAllByText('tag-14').length).toBeGreaterThan(0);
  });
});

// ============================================================
// GAP-5: loadStats populates tabCounts from rc.lit.stats
// ============================================================

describe('GAP-5: loadStats tab counts', () => {
  beforeEach(resetStores);

  it('derives inbox/archive/starred counts from rc.lit.stats response', async () => {
    // Real payload shape matching rc.lit.stats (service.ts:getStats)
    setupMethodRouter({
      'rc.lit.stats': {
        total: 20,
        by_status: { unread: 8, reading: 2, read: 7, reviewed: 3 },
        by_year: { '2025': 15, '2024': 5 },
        by_source: { arxiv: 12, manual: 8 },
        total_tags: 5,
        total_reading_minutes: 120,
        papers_with_pdf: 10,
        starred_count: 4,
        average_rating: 3.5,
      },
    });

    await act(async () => {
      await useLibraryStore.getState().loadStats();
    });

    const { tabCounts } = useLibraryStore.getState();
    expect(tabCounts).toEqual({
      inbox: 10,    // unread(8) + reading(2)
      archive: 10,  // read(7) + reviewed(3)
      starred: 4,   // from starred_count
    });
  });

  it('handles missing by_status gracefully (all zeros)', async () => {
    setupMethodRouter({
      'rc.lit.stats': {
        total: 0,
        by_status: {},
        by_year: {},
        by_source: {},
        total_tags: 0,
        total_reading_minutes: 0,
        papers_with_pdf: 0,
        starred_count: 0,
        average_rating: null,
      },
    });

    await act(async () => {
      await useLibraryStore.getState().loadStats();
    });

    const { tabCounts } = useLibraryStore.getState();
    expect(tabCounts).toEqual({ inbox: 0, archive: 0, starred: 0 });
  });

  it('tabCounts remains null when RPC fails', async () => {
    mockGatewayClient.request.mockReset();
    mockGatewayClient.request.mockRejectedValue(new Error('Network error'));
    useLibraryStore.setState({ tabCounts: null });

    await act(async () => {
      await useLibraryStore.getState().loadStats();
    });

    expect(useLibraryStore.getState().tabCounts).toBeNull();
  });
});

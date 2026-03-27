/**
 * Integration Tests: Library Panel (Issues 1–3)
 *
 * Issue 1: deletePaper triggers loadTags to refresh tag counts
 * Issue 2: Filtered empty state shows "Clear filter" button (not full empty state)
 * Issue 3: Empty state text no longer mentions PDF drag-and-drop
 *
 * These tests verify end-to-end flows with a mocked gateway RPC client,
 * matching the pattern in stores-integration.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import React from 'react';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock i18next — returns the key as-is (with count interpolation if provided)
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

// Mock react-window — renders first N rows as plain divs
vi.mock('react-window', () => ({
  List: ({ rowComponent: Row, rowCount, rowProps }: any) => (
    <div data-testid="virtual-list">
      {Array.from({ length: Math.min(rowCount, 5) }, (_, i) =>
        Row({ index: i, style: {}, ariaAttributes: {}, ...rowProps }),
      )}
    </div>
  ),
}));

// Gateway client mock — tracks all RPC calls
const mockGatewayClient = {
  isConnected: true,
  request: vi.fn(),
};

vi.mock('../stores/gateway', () => ({
  useGatewayStore: Object.assign(
    // Selector function (component usage: useGatewayStore(s => s.state))
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

// Mock chat store (LibraryPanel imports useChatStore for the "cite" action)
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

// Mock EditTagsModal — it has its own gateway interactions we don't test here
vi.mock('../components/panels/EditTagsModal', () => ({
  default: () => <div data-testid="edit-tags-modal" />,
}));

// ---------------------------------------------------------------------------
// Imports (after mocks are established)
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

/** Reset all stores + mocks to a clean baseline */
function resetStores() {
  vi.clearAllMocks();
  mockGatewayClient.isConnected = true;
  mockGatewayClient.request.mockReset();

  useLibraryStore.setState({
    papers: [],
    tags: [],
    loading: false,
    loadingMore: false,
    total: 0,
    offset: 0,
    hasMore: false,
    searchQuery: '',
    activeTab: 'inbox',
    filters: {},
  });

  // Ensure config store has a theme so getThemeTokens works
  useConfigStore.setState({ theme: 'dark' });
}

// =========================================================================
// Issue 1: deletePaper triggers loadTags
// =========================================================================
describe('Issue 1: deletePaper triggers loadTags after successful delete', () => {
  beforeEach(() => {
    resetStores();
  });

  it('calls rc.lit.tags after rc.lit.delete succeeds', async () => {
    const paper = makePaper({ id: 'p1', tags: ['ml'] });
    const tag = makeTag({ name: 'ml', paper_count: 1 });

    useLibraryStore.setState({
      papers: [paper],
      tags: [tag],
      total: 1,
    });

    // First call: rc.lit.delete resolves OK
    mockGatewayClient.request.mockResolvedValueOnce({});
    // Second call: rc.lit.tags (triggered by loadTags after delete)
    mockGatewayClient.request.mockResolvedValueOnce([]);

    await act(async () => {
      await useLibraryStore.getState().deletePaper('p1');
    });

    // Verify rc.lit.delete was called
    expect(mockGatewayClient.request).toHaveBeenCalledWith('rc.lit.delete', { id: 'p1' });

    // Verify rc.lit.tags was called (loadTags triggered after delete)
    await waitFor(() => {
      expect(mockGatewayClient.request).toHaveBeenCalledWith('rc.lit.tags');
    });

    // Paper should be removed from store
    expect(useLibraryStore.getState().papers).toHaveLength(0);
    expect(useLibraryStore.getState().total).toBe(0);
  });

  it('updates tags in store after delete refreshes them', async () => {
    const paper = makePaper({ id: 'p1', tags: ['ml'] });
    const tagBefore = makeTag({ name: 'ml', paper_count: 1 });

    useLibraryStore.setState({
      papers: [paper],
      tags: [tagBefore],
      total: 1,
    });

    // rc.lit.delete succeeds
    mockGatewayClient.request.mockResolvedValueOnce({});
    // rc.lit.tags returns empty (last paper with that tag was deleted)
    mockGatewayClient.request.mockResolvedValueOnce([]);

    await act(async () => {
      await useLibraryStore.getState().deletePaper('p1');
    });

    // Wait for the async loadTags to complete
    await waitFor(() => {
      expect(useLibraryStore.getState().tags).toEqual([]);
    });
  });

  it('calls loadTags with updated counts when other papers still have the tag', async () => {
    const paper1 = makePaper({ id: 'p1', tags: ['ml'] });
    const paper2 = makePaper({ id: 'p2', title: 'Paper 2', tags: ['ml'] });
    const tag = makeTag({ name: 'ml', paper_count: 2 });

    useLibraryStore.setState({
      papers: [paper1, paper2],
      tags: [tag],
      total: 2,
    });

    // rc.lit.delete succeeds
    mockGatewayClient.request.mockResolvedValueOnce({});
    // rc.lit.tags returns updated tag with count=1
    const updatedTag = makeTag({ name: 'ml', paper_count: 1 });
    mockGatewayClient.request.mockResolvedValueOnce([updatedTag]);

    await act(async () => {
      await useLibraryStore.getState().deletePaper('p1');
    });

    await waitFor(() => {
      const tags = useLibraryStore.getState().tags;
      expect(tags).toHaveLength(1);
      expect(tags[0].paper_count).toBe(1);
    });
  });

  it('does NOT call loadTags when delete fails (calls loadPapers to revert instead)', async () => {
    const paper = makePaper({ id: 'p1', tags: ['ml'] });

    useLibraryStore.setState({
      papers: [paper],
      tags: [makeTag({ name: 'ml', paper_count: 1 })],
      total: 1,
    });

    // rc.lit.delete fails
    mockGatewayClient.request.mockRejectedValueOnce(new Error('Delete failed'));
    // loadPapers revert call
    mockGatewayClient.request.mockResolvedValueOnce({
      items: [paper],
      total: 1,
    });

    await act(async () => {
      await useLibraryStore.getState().deletePaper('p1');
    });

    // Should have called rc.lit.delete, then rc.lit.list (revert), but NOT rc.lit.tags
    const calls = mockGatewayClient.request.mock.calls.map((c: unknown[]) => c[0]);
    expect(calls).toContain('rc.lit.delete');
    expect(calls).toContain('rc.lit.list');
    expect(calls).not.toContain('rc.lit.tags');
  });

  it('tracks the exact sequence of RPC calls: delete then tags then stats', async () => {
    useLibraryStore.setState({
      papers: [makePaper()],
      tags: [makeTag()],
      total: 1,
    });

    mockGatewayClient.request.mockResolvedValueOnce({}); // delete
    mockGatewayClient.request.mockResolvedValueOnce([]); // tags
    mockGatewayClient.request.mockResolvedValueOnce({ total: 0, by_status: {}, starred_count: 0 }); // stats

    await act(async () => {
      await useLibraryStore.getState().deletePaper('p1');
    });

    await waitFor(() => {
      expect(mockGatewayClient.request).toHaveBeenCalledTimes(3);
    });

    const callOrder = mockGatewayClient.request.mock.calls.map((c: unknown[]) => c[0]);
    expect(callOrder[0]).toBe('rc.lit.delete');
    expect(callOrder[1]).toBe('rc.lit.tags');
    expect(callOrder[2]).toBe('rc.lit.stats');
  });
});

// =========================================================================
// Issue 2: Filtered empty state shows clear button
// =========================================================================
describe('Issue 2: Filtered empty state shows clear filter button', () => {
  beforeEach(() => {
    resetStores();
  });

  /**
   * Helper: set up mockGatewayClient.request to respond based on RPC method name.
   * LibraryPanel's useEffect fires loadPapers() + loadTags() on mount when
   * connState === 'connected', so we must handle these automatic calls properly.
   */
  function setupMethodRouter(responses: Record<string, unknown>) {
    mockGatewayClient.request.mockImplementation((method: string) => {
      if (method in responses) {
        return Promise.resolve(responses[method]);
      }
      return Promise.resolve({});
    });
  }

  it('shows emptyFiltered text when search query returns no papers', async () => {
    // With server-side pagination, if a search returns 0 results we show the
    // filtered empty state (not the global empty state).
    useLibraryStore.setState({
      papers: [],
      tags: [],
      total: 0,
      activeTab: 'inbox',
      searchQuery: 'nonexistent',
    });

    // Server returns empty for the search request
    mockGatewayClient.request.mockImplementation((method: string) => {
      if (method === 'rc.lit.list') return Promise.resolve({ items: [], total: 0 });
      if (method === 'rc.lit.tags') return Promise.resolve([]);
      if (method === 'rc.lit.search') return Promise.resolve({ items: [], total: 0 });
      return Promise.resolve({});
    });

    await act(async () => {
      render(<LibraryPanel />);
    });

    // papers is empty with active search → emptyFiltered state
    expect(screen.getByText('library.emptyFiltered')).toBeInTheDocument();
  });

  it('shows clearFilter button when selectedTags is active and no papers match', async () => {
    // Paper is unread (visible on pending tab) with the tag, so tag bar appears.
    // After clicking the tag filter, loadPapers returns empty to trigger clear button.
    const paper = makePaper({ id: 'p1', read_status: 'unread', tags: ['ml'] });
    const tag = makeTag({ name: 'ml', paper_count: 1 });

    useLibraryStore.setState({
      papers: [paper],
      tags: [tag],
      total: 1,
      activeTab: 'inbox',
      searchQuery: '',
      filters: { tags: ['ml'] },
    });

    // Return empty only when tag filter is active in RPC params
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

    // Click the tag to set selectedTags (use first match — the filter bar tag)
    const tagElement = screen.getAllByText('ml')[0];
    await act(async () => {
      fireEvent.click(tagElement);
    });

    // After clicking tag, selectedTags = ['ml'], so the clear button should appear
    await waitFor(() => {
      expect(screen.getByText('library.clearFilter')).toBeInTheDocument();
    });
  });

  it('clicking clearFilter button clears selectedTags, searchQuery, and filters', async () => {
    // Paper must be unread (pending tab) with the tag for tag bar to appear.
    // Use a "read" paper that won't appear on the pending tab, combined with
    // selectedTags and searchQuery to trigger the clear button.
    const paper = makePaper({ id: 'p1', read_status: 'unread', tags: ['nlp'] });
    const tag = makeTag({ name: 'nlp', paper_count: 1 });

    useLibraryStore.setState({
      papers: [paper],
      tags: [tag],
      total: 1,
      activeTab: 'inbox',
      searchQuery: '',
      filters: {},
    });

    // Return empty only when tag filter is active in RPC params
    mockGatewayClient.request.mockImplementation((method: string, params?: any) => {
      if (method === 'rc.lit.list') {
        if (params?.tags?.length > 0) {
          return Promise.resolve({ items: [], total: 0 });
        }
        return Promise.resolve({ items: [paper], total: 1 });
      }
      if (method === 'rc.lit.tags') return Promise.resolve([tag]);
      if (method === 'rc.lit.search') return Promise.resolve({ items: [], total: 0 });
      return Promise.resolve({});
    });

    await act(async () => {
      render(<LibraryPanel />);
    });

    // Click the tag to activate selectedTags state so Clear filter button appears
    const tagEl = screen.getAllByText('nlp')[0];
    await act(async () => {
      fireEvent.click(tagEl);
    });

    await waitFor(() => {
      expect(screen.getByText('library.clearFilter')).toBeInTheDocument();
    });

    // Click the clear filter button
    const clearBtn = screen.getByText('library.clearFilter');
    await act(async () => {
      fireEvent.click(clearBtn);
    });

    // After clearing, store should have empty searchQuery and filters
    await waitFor(() => {
      const state = useLibraryStore.getState();
      expect(state.searchQuery).toBe('');
      expect(state.filters).toEqual({});
    });
  });

  it('does NOT show clearFilter button when there are matching papers', async () => {
    // Paper is unread on pending tab → filteredPapers = 1
    const paper = makePaper({ id: 'p1', read_status: 'unread', tags: ['ml'] });
    const tag = makeTag({ name: 'ml', paper_count: 1 });

    useLibraryStore.setState({
      papers: [paper],
      tags: [tag],
      total: 1,
      activeTab: 'inbox',
    });

    setupMethodRouter({
      'rc.lit.list': { items: [paper], total: 1 },
      'rc.lit.tags': [tag],
      'rc.lit.search': { items: [paper], total: 1 },
    });

    await act(async () => {
      render(<LibraryPanel />);
    });

    // Paper is visible (unread on pending tab), so no empty state
    expect(screen.queryByText('library.emptyFiltered')).not.toBeInTheDocument();
    expect(screen.queryByText('library.clearFilter')).not.toBeInTheDocument();
  });
});

// =========================================================================
// Issue 3: Empty state text does not mention PDF drag
// =========================================================================
describe('Issue 3: Empty state text does not mention PDF drag-and-drop', () => {
  beforeEach(() => {
    resetStores();
  });

  it('shows library.empty text when no papers and no filters', async () => {
    useLibraryStore.setState({
      papers: [],
      tags: [],
      total: 0,
      searchQuery: '',
      activeTab: 'inbox',
      filters: {},
      loading: false,
    });

    // Mount effects call loadPapers + loadTags; return empty results
    // so the empty state stays visible.
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

    // The i18n mock returns the key as-is; the true empty state should use library.empty
    expect(screen.getByText('library.empty')).toBeInTheDocument();
  });

  it('en.json library.empty does not contain "drag" or "drop" or "PDF"', async () => {
    // Directly import and verify the actual i18n content
    const en = await import('../i18n/en.json');
    const emptyText: string = (en.default ?? en).library.empty;

    expect(emptyText.toLowerCase()).not.toContain('drag');
    expect(emptyText.toLowerCase()).not.toContain('drop');
    expect(emptyText).not.toContain('PDF');
    expect(emptyText).not.toContain('pdf');
  });

  it('zh-CN.json library.empty does not contain "拖放" or "PDF"', async () => {
    const zhCN = await import('../i18n/zh-CN.json');
    const emptyText: string = (zhCN.default ?? zhCN).library.empty;

    expect(emptyText).not.toContain('拖放');
    expect(emptyText).not.toContain('拖拽');
    expect(emptyText).not.toContain('PDF');
    expect(emptyText).not.toContain('pdf');
  });

  it('en.json library.empty mentions Research-Claw and finding papers', async () => {
    const en = await import('../i18n/en.json');
    const emptyText: string = (en.default ?? en).library.empty;

    // Should reference the AI agent and paper discovery
    expect(emptyText.toLowerCase()).toContain('research-claw');
    expect(emptyText.toLowerCase()).toContain('find');
  });

  it('en.json has emptyFiltered and clearFilter keys', async () => {
    const en = await import('../i18n/en.json');
    const lib = (en.default ?? en).library;

    expect(lib.emptyFiltered).toBeDefined();
    expect(typeof lib.emptyFiltered).toBe('string');
    expect(lib.clearFilter).toBeDefined();
    expect(typeof lib.clearFilter).toBe('string');
  });

  it('zh-CN.json has emptyFiltered and clearFilter keys', async () => {
    const zhCN = await import('../i18n/zh-CN.json');
    const lib = (zhCN.default ?? zhCN).library;

    expect(lib.emptyFiltered).toBeDefined();
    expect(typeof lib.emptyFiltered).toBe('string');
    expect(lib.clearFilter).toBeDefined();
    expect(typeof lib.clearFilter).toBe('string');
  });
});

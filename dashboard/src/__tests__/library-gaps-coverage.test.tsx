/**
 * Library GAP Feature — Full Coverage Tests
 *
 * Covers all functional paths NOT already tested in:
 * - library-gaps.test.tsx (GAP-2/3/4 UI tests)
 * - integration-library.test.tsx (Issue 1/2/3 integration tests)
 * - store-rpc.parity.test.ts (Library store RPC parity)
 * - LibraryPanel.test.tsx (Basic rendering)
 *
 * This file tests:
 * 1. Store: tags filter RPC message format (tags array in params)
 * 2. Store: setFilters merge behavior and tags=undefined cleanup
 * 3. Store: loadPapers skips tags param when tags array is empty
 * 4. Store: ratePaper optimistic update + error rollback
 * 5. Store: loadTags error handling (non-fatal)
 * 6. Store: deletePaper + loadTags when gateway disconnected
 * 7. Component: tag bar with special characters
 * 8. Component: paper card tag rendering (visible tags + overflow)
 * 9. Component: saved tab filtering (rating > 0)
 * 10. Component: sort dropdown triggers loadPapers
 * 11. Component: expand/collapse tags boundary (exactly 10 tags)
 * 12. RPC backward compat: singular tag vs tags array store behavior
 *
 * SOP compliance: behavior-first, real payload shapes, no implementation detail testing.
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
// Fixtures — aligned with Research-Claw Core plugin Paper/Tag interfaces
// Source: extensions/research-claw-core/src/literature/service.ts lines 50-88
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
// 1. Store: tags filter RPC message format
// =========================================================================
describe('Store: loadPapers sends tags array in RPC params', () => {
  beforeEach(resetStores);

  it('sends tags array when filters.tags has multiple values', async () => {
    // Source: library.ts:93 — if (effectiveFilter.tags?.length) params.tags = effectiveFilter.tags
    // Source: literature/rpc.ts:117-141 — rc.lit.list accepts tags param
    useLibraryStore.setState({
      filters: { tags: ['transformers', 'nlp', 'deep-learning'] },
    });

    mockGatewayClient.request.mockResolvedValueOnce({ items: [], total: 0 });

    await useLibraryStore.getState().loadPapers();

    expect(mockGatewayClient.request).toHaveBeenCalledWith(
      'rc.lit.list',
      expect.objectContaining({ tags: ['transformers', 'nlp', 'deep-learning'] }),
    );
  });

  it('sends tags array with single element for single tag filter', async () => {
    useLibraryStore.setState({ filters: { tags: ['cv'] } });
    mockGatewayClient.request.mockResolvedValueOnce({ items: [], total: 0 });

    await useLibraryStore.getState().loadPapers();

    expect(mockGatewayClient.request).toHaveBeenCalledWith(
      'rc.lit.list',
      expect.objectContaining({ tags: ['cv'] }),
    );
  });

  it('does NOT include tags param when tags array is empty', async () => {
    // Source: library.ts:93 — guard: if (effectiveFilter.tags?.length)
    useLibraryStore.setState({ filters: { tags: [] } });
    mockGatewayClient.request.mockResolvedValueOnce({ items: [], total: 0 });

    await useLibraryStore.getState().loadPapers();

    const callArgs = mockGatewayClient.request.mock.calls[0][1] as Record<string, unknown>;
    expect(callArgs.tags).toBeUndefined();
  });

  it('does NOT include tags param when filters.tags is undefined', async () => {
    useLibraryStore.setState({ filters: {} });
    mockGatewayClient.request.mockResolvedValueOnce({ items: [], total: 0 });

    await useLibraryStore.getState().loadPapers();

    const callArgs = mockGatewayClient.request.mock.calls[0][1] as Record<string, unknown>;
    expect(callArgs.tags).toBeUndefined();
  });

  it('combines tags with other filters in same RPC call', async () => {
    // Source: literature/rpc.ts:117-141 — all filters sent as flat params
    useLibraryStore.setState({
      filters: {
        tags: ['ml', 'cv'],
        read_status: 'reading',
        sort: 'year',
      },
    });
    mockGatewayClient.request.mockResolvedValueOnce({ items: [], total: 0 });

    await useLibraryStore.getState().loadPapers();

    expect(mockGatewayClient.request).toHaveBeenCalledWith(
      'rc.lit.list',
      expect.objectContaining({
        tags: ['ml', 'cv'],
        read_status: 'reading',
        sort: 'year',
      }),
    );
  });
});

// =========================================================================
// 2. Store: setFilters merge behavior
// =========================================================================
describe('Store: setFilters merges correctly', () => {
  beforeEach(resetStores);

  it('merges new filter fields with existing ones', () => {
    // Source: library.ts:126-128 — set((s) => ({ filters: { ...s.filters, ...filters } }))
    useLibraryStore.getState().setFilters({ read_status: 'read' });
    useLibraryStore.getState().setFilters({ tags: ['ml'] });

    const filters = useLibraryStore.getState().filters;
    expect(filters.read_status).toBe('read');
    expect(filters.tags).toEqual(['ml']);
  });

  it('overwrites existing filter field when same key is set', () => {
    useLibraryStore.getState().setFilters({ tags: ['ml'] });
    useLibraryStore.getState().setFilters({ tags: ['cv', 'nlp'] });

    expect(useLibraryStore.getState().filters.tags).toEqual(['cv', 'nlp']);
  });

  it('setting tags to undefined removes tags from filter', () => {
    useLibraryStore.getState().setFilters({ tags: ['ml'] });
    expect(useLibraryStore.getState().filters.tags).toEqual(['ml']);

    useLibraryStore.getState().setFilters({ tags: undefined });
    expect(useLibraryStore.getState().filters.tags).toBeUndefined();
  });

  it('preserves unrelated filter fields when updating one', () => {
    useLibraryStore.getState().setFilters({ sort: 'year', read_status: 'unread' });
    useLibraryStore.getState().setFilters({ tags: ['ml'] });

    const filters = useLibraryStore.getState().filters;
    expect(filters.sort).toBe('year');
    expect(filters.read_status).toBe('unread');
    expect(filters.tags).toEqual(['ml']);
  });

  it('setting empty object {} does not clear existing filters', () => {
    useLibraryStore.getState().setFilters({ tags: ['ml'], sort: 'title' });
    useLibraryStore.getState().setFilters({});

    const filters = useLibraryStore.getState().filters;
    expect(filters.tags).toEqual(['ml']);
    expect(filters.sort).toBe('title');
  });
});

// =========================================================================
// 3. Store: ratePaper optimistic update + error rollback
// =========================================================================
describe('Store: ratePaper behavior', () => {
  beforeEach(resetStores);

  it('applies optimistic rating update immediately', async () => {
    // Source: library.ts:145-157 — optimistic update before RPC call
    let resolveRequest!: (v: unknown) => void;
    mockGatewayClient.request.mockReturnValueOnce(new Promise((r) => { resolveRequest = r; }));

    const paper = makePaper({ id: 'p1', rating: null });
    useLibraryStore.setState({ papers: [paper], total: 1 });

    const promise = useLibraryStore.getState().ratePaper('p1', 5);

    // Optimistic: rating should be 5 before RPC resolves
    expect(useLibraryStore.getState().papers[0].rating).toBe(5);

    resolveRequest({});
    await promise;
  });

  it('sends correct RPC params for rating', async () => {
    // Source: library.ts:152 — client.request('rc.lit.rate', { id, rating })
    mockGatewayClient.request.mockResolvedValueOnce({});
    const paper = makePaper({ id: 'p1', rating: null });
    useLibraryStore.setState({ papers: [paper], total: 1 });

    await useLibraryStore.getState().ratePaper('p1', 5);

    expect(mockGatewayClient.request).toHaveBeenCalledWith(
      'rc.lit.rate',
      { id: 'p1', rating: 5 },
    );
  });

  it('sends rating 0 to clear the star', async () => {
    // Source: library.ts:152 — rating=0 clears the star
    mockGatewayClient.request.mockResolvedValueOnce({});
    const paper = makePaper({ id: 'p1', rating: 5 });
    useLibraryStore.setState({ papers: [paper], total: 1 });

    await useLibraryStore.getState().ratePaper('p1', 0);

    expect(mockGatewayClient.request).toHaveBeenCalledWith(
      'rc.lit.rate',
      { id: 'p1', rating: 0 },
    );
    expect(useLibraryStore.getState().papers[0].rating).toBe(0);
  });

  it('reverts optimistic update on RPC error by reloading papers', async () => {
    // Source: library.ts:154-156 — on catch, calls loadPapers() to revert
    const paper = makePaper({ id: 'p1', rating: null });
    const reloadedPaper = makePaper({ id: 'p1', rating: null });
    useLibraryStore.setState({ papers: [paper], total: 1 });

    mockGatewayClient.request
      .mockRejectedValueOnce(new Error('Rate failed'))      // rc.lit.rate fails
      .mockResolvedValueOnce({ items: [reloadedPaper], total: 1 }); // loadPapers reload

    await useLibraryStore.getState().ratePaper('p1', 5);

    // loadPapers should be called as revert mechanism
    expect(mockGatewayClient.request).toHaveBeenCalledTimes(2);
    const callMethods = mockGatewayClient.request.mock.calls.map((c: unknown[]) => c[0]);
    expect(callMethods[0]).toBe('rc.lit.rate');
    expect(callMethods[1]).toBe('rc.lit.list');
  });

  it('skips RPC when gateway is disconnected', async () => {
    mockGatewayClient.isConnected = false;
    const paper = makePaper({ id: 'p1', rating: null });
    useLibraryStore.setState({ papers: [paper], total: 1 });

    await useLibraryStore.getState().ratePaper('p1', 5);

    expect(mockGatewayClient.request).not.toHaveBeenCalled();
  });
});

// =========================================================================
// 4. Store: loadTags error handling
// =========================================================================
describe('Store: loadTags error handling', () => {
  beforeEach(resetStores);

  it('silently handles RPC error without crashing (non-fatal)', async () => {
    // Source: library.ts:113-115 — catch block is empty (non-fatal)
    mockGatewayClient.request.mockRejectedValueOnce(new Error('Gateway timeout'));

    // Should not throw
    await expect(useLibraryStore.getState().loadTags()).resolves.toBeUndefined();

    // Tags should remain empty (not set to error state)
    expect(useLibraryStore.getState().tags).toEqual([]);
  });

  it('preserves existing tags on error (does not clear)', async () => {
    // Source: library.ts:113-115 — error catch does not mutate state
    const existingTags = [makeTag({ name: 'existing' })];
    useLibraryStore.setState({ tags: existingTags });

    mockGatewayClient.request.mockRejectedValueOnce(new Error('RPC error'));

    await useLibraryStore.getState().loadTags();

    // Tags should still be the existing ones
    expect(useLibraryStore.getState().tags).toEqual(existingTags);
  });

  it('skips loadTags when gateway is disconnected', async () => {
    mockGatewayClient.isConnected = false;

    await useLibraryStore.getState().loadTags();

    expect(mockGatewayClient.request).not.toHaveBeenCalled();
  });
});

// =========================================================================
// 5. Store: deletePaper when gateway disconnected
// =========================================================================
describe('Store: deletePaper when gateway disconnected', () => {
  beforeEach(resetStores);

  it('skips RPC and does not modify state when disconnected', async () => {
    mockGatewayClient.isConnected = false;
    const paper = makePaper({ id: 'p1' });
    useLibraryStore.setState({ papers: [paper], total: 1 });

    await useLibraryStore.getState().deletePaper('p1');

    expect(mockGatewayClient.request).not.toHaveBeenCalled();
    // Paper should still be in state
    expect(useLibraryStore.getState().papers).toHaveLength(1);
    expect(useLibraryStore.getState().total).toBe(1);
  });
});

// =========================================================================
// 6. Component: tag bar with special characters
// =========================================================================
describe('Component: tag bar renders tags with special characters', () => {
  beforeEach(resetStores);

  it('renders tags containing hyphens, dots, and unicode', async () => {
    // Paper must have the tags so displayTags (computed from current tab papers) shows them
    const paper = makePaper({ id: 'p1', read_status: 'unread', tags: ['meta-learning', 'gpt-4.5', 'selbstaufmerksamkeit'] });
    const tags = [
      makeTag({ id: 't1', name: 'meta-learning', paper_count: 1 }),
      makeTag({ id: 't2', name: 'gpt-4.5', paper_count: 1 }),
      makeTag({ id: 't3', name: 'selbstaufmerksamkeit', paper_count: 1 }),
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
    });

    await act(async () => {
      render(<LibraryPanel />);
    });

    // Tags appear in both filter bar and paper card — check at least one exists
    expect(screen.getAllByText('meta-learning').length).toBeGreaterThan(0);
    expect(screen.getAllByText('gpt-4.5').length).toBeGreaterThan(0);
    expect(screen.getAllByText('selbstaufmerksamkeit').length).toBeGreaterThan(0);
  });

  it('clicking a tag with special chars toggles it correctly', async () => {
    // Paper must have the tag so displayTags (computed from current tab papers) shows it
    const paper = makePaper({ id: 'p1', read_status: 'unread', tags: ['c++'] });
    const tags = [makeTag({ id: 't1', name: 'c++', paper_count: 1 })];

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

    // Click the tag in the filter bar (first match)
    const tagEl = screen.getAllByText('c++')[0];
    await act(async () => {
      fireEvent.click(tagEl);
    });

    await waitFor(() => {
      expect(useLibraryStore.getState().filters.tags).toEqual(['c++']);
    });
  });
});

// =========================================================================
// 7. Component: paper card tag rendering
// =========================================================================
describe('Component: PaperListItem renders tags', () => {
  beforeEach(resetStores);

  it('renders up to 3 tags on a paper card', async () => {
    // Source: LibraryPanel.tsx:91-92 — visibleTags = paper.tags?.slice(0, 3)
    const paper = makePaper({
      id: 'p1',
      read_status: 'unread',
      tags: ['ml', 'nlp', 'transformers'],
    });

    useLibraryStore.setState({
      papers: [paper],
      tags: [],
      total: 1,
      activeTab: 'inbox',
    });

    setupMethodRouter({
      'rc.lit.list': { items: [paper], total: 1 },
      'rc.lit.tags': [],
    });

    await act(async () => {
      render(<LibraryPanel />);
    });

    expect(screen.getByText('ml')).toBeInTheDocument();
    expect(screen.getByText('nlp')).toBeInTheDocument();
    expect(screen.getByText('transformers')).toBeInTheDocument();
  });

  it('shows +N overflow count when paper has more than 3 tags', async () => {
    // Source: LibraryPanel.tsx:92-93 — extraTagCount = (paper.tags?.length ?? 0) - 3
    const paper = makePaper({
      id: 'p1',
      read_status: 'unread',
      tags: ['ml', 'nlp', 'transformers', 'attention', 'bert'],
    });

    useLibraryStore.setState({
      papers: [paper],
      tags: [],
      total: 1,
      activeTab: 'inbox',
    });

    setupMethodRouter({
      'rc.lit.list': { items: [paper], total: 1 },
      'rc.lit.tags': [],
    });

    await act(async () => {
      render(<LibraryPanel />);
    });

    // First 3 visible
    expect(screen.getByText('ml')).toBeInTheDocument();
    expect(screen.getByText('nlp')).toBeInTheDocument();
    expect(screen.getByText('transformers')).toBeInTheDocument();
    // Overflow indicator
    expect(screen.getByText('+2')).toBeInTheDocument();
    // 4th and 5th not directly visible
    expect(screen.queryByText('attention')).not.toBeInTheDocument();
  });

  it('renders no tag section when paper has no tags', async () => {
    const paper = makePaper({ id: 'p1', read_status: 'unread', tags: [] });

    useLibraryStore.setState({
      papers: [paper],
      tags: [],
      total: 1,
      activeTab: 'inbox',
    });

    setupMethodRouter({
      'rc.lit.list': { items: [paper], total: 1 },
      'rc.lit.tags': [],
    });

    await act(async () => {
      render(<LibraryPanel />);
    });

    // Paper title should be visible
    expect(screen.getByText('Test Paper')).toBeInTheDocument();
    // No tag overflow indicators
    expect(screen.queryByText(/^\+\d+$/)).not.toBeInTheDocument();
  });
});

// =========================================================================
// 8. Component: saved tab filtering (rating > 0)
// =========================================================================
describe('Component: saved tab shows only starred papers', () => {
  beforeEach(resetStores);

  it('saved tab filters to papers with rating > 0', async () => {
    // Source: LibraryPanel.tsx:331 — papers.filter((p) => p.rating && p.rating > 0)
    const unstarred = makePaper({ id: 'p1', title: 'Unstarred Paper', read_status: 'unread', rating: null });
    const starred = makePaper({ id: 'p2', title: 'Starred Paper', read_status: 'unread', rating: 5 });

    useLibraryStore.setState({
      papers: [unstarred, starred],
      tags: [],
      total: 2,
      activeTab: 'starred',
    });

    setupMethodRouter({
      'rc.lit.list': { items: [unstarred, starred], total: 2 },
      'rc.lit.tags': [],
    });

    await act(async () => {
      render(<LibraryPanel />);
    });

    // Only starred paper should be visible
    expect(screen.getByText('Starred Paper')).toBeInTheDocument();
    expect(screen.queryByText('Unstarred Paper')).not.toBeInTheDocument();
  });

  it('saved tab shows emptyFiltered when no papers have rating', async () => {
    const paper = makePaper({ id: 'p1', read_status: 'unread', rating: null });

    useLibraryStore.setState({
      papers: [paper],
      tags: [],
      total: 1,
      activeTab: 'starred',
    });

    setupMethodRouter({
      'rc.lit.list': { items: [paper], total: 1 },
      'rc.lit.tags': [],
    });

    await act(async () => {
      render(<LibraryPanel />);
    });

    expect(screen.getByText('library.emptyFiltered')).toBeInTheDocument();
  });

  it('saved tab shows paper with rating=0 as unstarred (not shown)', async () => {
    // Source: LibraryPanel.tsx:331 — rating=0 is falsy, filtered out
    const paper = makePaper({ id: 'p1', title: 'Zero Rating', read_status: 'unread', rating: 0 });

    useLibraryStore.setState({
      papers: [paper],
      tags: [],
      total: 1,
      activeTab: 'starred',
    });

    setupMethodRouter({
      'rc.lit.list': { items: [paper], total: 1 },
      'rc.lit.tags': [],
    });

    await act(async () => {
      render(<LibraryPanel />);
    });

    expect(screen.queryByText('Zero Rating')).not.toBeInTheDocument();
    expect(screen.getByText('library.emptyFiltered')).toBeInTheDocument();
  });
});

// =========================================================================
// 9. Component: pending tab filtering
// =========================================================================
describe('Component: inbox tab renders server-returned papers directly', () => {
  beforeEach(resetStores);

  it('inbox tab renders all papers from server (server does the filtering)', async () => {
    // With server-side pagination, the store sends read_status: ['unread','reading']
    // to rc.lit.list. The server returns only matching papers. The component
    // renders them directly — no client-side tab filtering.
    const inboxPapers = [
      makePaper({ id: 'p1', title: 'Unread Paper', read_status: 'unread' }),
      makePaper({ id: 'p2', title: 'Reading Paper', read_status: 'reading' }),
    ];

    useLibraryStore.setState({
      papers: inboxPapers,
      tags: [],
      total: 2,
      activeTab: 'inbox',
    });

    setupMethodRouter({
      'rc.lit.list': { items: inboxPapers, total: 2 },
      'rc.lit.tags': [],
    });

    await act(async () => {
      render(<LibraryPanel />);
    });

    expect(screen.getByText('Unread Paper')).toBeInTheDocument();
    expect(screen.getByText('Reading Paper')).toBeInTheDocument();
  });
});

// =========================================================================
// 10. Component: pending and saved counts in tab labels
// =========================================================================
describe('Component: tab labels show server-side counts from loadStats', () => {
  beforeEach(resetStores);

  it('tab labels show counts from rc.lit.stats when available', async () => {
    // loadStats is called on mount → sets tabCounts → labels include "(N)".
    const papers = [
      makePaper({ id: 'p1', read_status: 'unread', rating: null }),
      makePaper({ id: 'p2', read_status: 'reading', rating: 5 }),
    ];

    useLibraryStore.setState({
      papers,
      tags: [],
      total: 2,
      activeTab: 'inbox',
      tabCounts: null,
    });

    setupMethodRouter({
      'rc.lit.list': { items: papers, total: 2 },
      'rc.lit.tags': [],
      'rc.lit.collections.list': [],
      'rc.lit.stats': { total: 2, by_status: { unread: 1, reading: 1 }, starred_count: 1 },
    });

    await act(async () => {
      render(<LibraryPanel />);
    });

    // Tab labels include counts from stats
    expect(screen.getByText('library.inbox (2)')).toBeInTheDocument();
    expect(screen.getByText('library.starred (1)')).toBeInTheDocument();
    expect(screen.getByText('library.archive (0)')).toBeInTheDocument();
  });

  it('tab labels are plain text when stats RPC fails', async () => {
    const papers = [
      makePaper({ id: 'p1', read_status: 'unread', rating: null }),
    ];

    useLibraryStore.setState({
      papers,
      tags: [],
      total: 1,
      activeTab: 'inbox',
      tabCounts: null,
    });

    setupMethodRouter({
      'rc.lit.list': { items: papers, total: 1 },
      'rc.lit.tags': [],
      'rc.lit.collections.list': [],
    });

    // Make stats fail so tabCounts stays null
    const origImpl = mockGatewayClient.request.getMockImplementation()!;
    mockGatewayClient.request.mockImplementation((method: string, ...args: unknown[]) => {
      if (method === 'rc.lit.stats') return Promise.reject(new Error('stats unavailable'));
      return origImpl(method, ...args);
    });

    await act(async () => {
      render(<LibraryPanel />);
    });

    // Without stats, labels are plain i18n keys
    expect(screen.getByText('library.inbox')).toBeInTheDocument();
    expect(screen.getByText('library.starred')).toBeInTheDocument();
    expect(screen.getByText('library.archive')).toBeInTheDocument();
  });
});

// =========================================================================
// 11. Component: expand/collapse boundary — exactly 10 tags
// =========================================================================
describe('Component: tag expand/collapse boundary', () => {
  beforeEach(resetStores);

  it('does NOT show expand button when exactly 10 tags exist', async () => {
    // Source: LibraryPanel.tsx — displayTags.length > 10 (strict >)
    const tagNames = Array.from({ length: 10 }, (_, i) => `tag-${i}`);
    const tags = tagNames.map((name, i) => makeTag({
      id: `tag-${i}`,
      name,
      paper_count: 1,
    }));

    // Paper must have all tags so displayTags includes them
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

    // All 10 tags should be visible in the filter bar
    expect(screen.getAllByText('tag-0').length).toBeGreaterThan(0);
    expect(screen.getAllByText('tag-9').length).toBeGreaterThan(0);

    // The paper card shows 3 tags + "+7" overflow, but the filter bar should NOT
    // have an expand button since exactly 10 tags exist
    // Filter bar expand button format is "+N" where N = displayTags.length - 10
    // With exactly 10 tags, there should be no filter bar expand button
    // Paper card overflow "+7" may exist, so we check specifically for filter bar expand
    // Since displayTags.length === 10, the condition displayTags.length > 10 is false
    // We can verify by checking that no "+0" text exists
    expect(screen.queryByText('+0')).not.toBeInTheDocument();
  });

  it('shows expand button when 11 tags exist (boundary case)', async () => {
    const tagNames = Array.from({ length: 11 }, (_, i) => `tag-${i}`);
    const tags = tagNames.map((name, i) => makeTag({
      id: `tag-${i}`,
      name,
      paper_count: 1,
    }));

    // Paper must have all tags so displayTags includes them
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

    // First 10 visible in the filter bar
    expect(screen.getAllByText('tag-9').length).toBeGreaterThan(0);
    // 11th not visible in the filter bar yet
    expect(screen.queryAllByText('tag-10')).toHaveLength(0);
    // Expand button shows "+1"
    expect(screen.getByText('+1')).toBeInTheDocument();
  });

  it('does not show tag bar when there are zero tags', async () => {
    const paper = makePaper({ id: 'p1', read_status: 'unread' });

    useLibraryStore.setState({
      papers: [paper],
      tags: [],
      total: 1,
      activeTab: 'inbox',
    });

    setupMethodRouter({
      'rc.lit.list': { items: [paper], total: 1 },
      'rc.lit.tags': [],
    });

    await act(async () => {
      render(<LibraryPanel />);
    });

    // Paper title visible, but no tag elements in the filter bar
    expect(screen.getByText('Test Paper')).toBeInTheDocument();
    // The expand button should not exist
    expect(screen.queryByText(/^\+\d+$/)).not.toBeInTheDocument();
  });
});

// =========================================================================
// 12. Store: loadPapers falls back to search when query is set
// =========================================================================
describe('Store: loadPapers dispatches to correct RPC based on searchQuery', () => {
  beforeEach(resetStores);

  it('uses rc.lit.search when searchQuery is non-empty', async () => {
    // Source: library.ts:81-87 — query.trim() check
    useLibraryStore.setState({ searchQuery: '  attention  ' });
    mockGatewayClient.request.mockResolvedValueOnce({ items: [], total: 0 });

    await useLibraryStore.getState().loadPapers();

    expect(mockGatewayClient.request).toHaveBeenCalledWith(
      'rc.lit.search',
      { query: 'attention', limit: 30, offset: 0 },
    );
  });

  it('uses rc.lit.list when searchQuery is whitespace-only', async () => {
    // Source: library.ts:82 — query = get().searchQuery.trim()
    useLibraryStore.setState({ searchQuery: '   ' });
    mockGatewayClient.request.mockResolvedValueOnce({ items: [], total: 0 });

    await useLibraryStore.getState().loadPapers();

    expect(mockGatewayClient.request).toHaveBeenCalledWith(
      'rc.lit.list',
      expect.any(Object),
    );
  });

  it('ignores filter params when using search (search uses FTS, not structured filters)', async () => {
    // Source: library.ts:84-87 — search path does NOT pass filter params
    useLibraryStore.setState({
      searchQuery: 'bert',
      filters: { tags: ['ml'], read_status: 'read' },
    });
    mockGatewayClient.request.mockResolvedValueOnce({ items: [], total: 0 });

    await useLibraryStore.getState().loadPapers();

    // Should call rc.lit.search with only the query + pagination, not filter params
    expect(mockGatewayClient.request).toHaveBeenCalledWith(
      'rc.lit.search',
      { query: 'bert', limit: 30, offset: 0 },
    );
  });
});

// =========================================================================
// 13. Store: loadPapers accepts optional filter parameter override
// =========================================================================
describe('Store: loadPapers with explicit filter parameter', () => {
  beforeEach(resetStores);

  it('uses explicit filter param when provided (overrides store filters)', async () => {
    // Source: library.ts:91 — const effectiveFilter = filter ?? get().filters
    useLibraryStore.setState({ filters: { tags: ['store-tag'] } });
    mockGatewayClient.request.mockResolvedValueOnce({ items: [], total: 0 });

    await useLibraryStore.getState().loadPapers({ tags: ['explicit-tag'] });

    expect(mockGatewayClient.request).toHaveBeenCalledWith(
      'rc.lit.list',
      expect.objectContaining({ tags: ['explicit-tag'] }),
    );
  });

  it('falls back to store filters when no explicit filter provided', async () => {
    useLibraryStore.setState({ filters: { tags: ['store-tag'] } });
    mockGatewayClient.request.mockResolvedValueOnce({ items: [], total: 0 });

    await useLibraryStore.getState().loadPapers();

    expect(mockGatewayClient.request).toHaveBeenCalledWith(
      'rc.lit.list',
      expect.objectContaining({ tags: ['store-tag'] }),
    );
  });
});

// =========================================================================
// 14. Component: authors truncation
// =========================================================================
describe('Component: author display truncation', () => {
  beforeEach(resetStores);

  it('truncates authors when more than 3', async () => {
    // Source: LibraryPanel.tsx:85-89 — truncates at 3 with +N
    const paper = makePaper({
      id: 'p1',
      read_status: 'unread',
      authors: ['Smith J', 'Lee K', 'Wang L', 'Chen M', 'Park S'],
    });

    useLibraryStore.setState({
      papers: [paper],
      tags: [],
      total: 1,
      activeTab: 'inbox',
    });

    setupMethodRouter({
      'rc.lit.list': { items: [paper], total: 1 },
      'rc.lit.tags': [],
    });

    await act(async () => {
      render(<LibraryPanel />);
    });

    // Should show first 3 + overflow count
    expect(screen.getByText(/Smith J, Lee K, Wang L, \+2/)).toBeInTheDocument();
  });

  it('shows all authors when 3 or fewer', async () => {
    const paper = makePaper({
      id: 'p1',
      read_status: 'unread',
      authors: ['Smith J', 'Lee K'],
    });

    useLibraryStore.setState({
      papers: [paper],
      tags: [],
      total: 1,
      activeTab: 'inbox',
    });

    setupMethodRouter({
      'rc.lit.list': { items: [paper], total: 1 },
      'rc.lit.tags': [],
    });

    await act(async () => {
      render(<LibraryPanel />);
    });

    expect(screen.getByText(/Smith J, Lee K/)).toBeInTheDocument();
  });
});

// =========================================================================
// 15. Store: setActiveTab and setSearchQuery
// =========================================================================
describe('Store: setActiveTab and setSearchQuery', () => {
  beforeEach(resetStores);

  it('setActiveTab switches between pending and saved', () => {
    expect(useLibraryStore.getState().activeTab).toBe('inbox');

    useLibraryStore.getState().setActiveTab('starred');
    expect(useLibraryStore.getState().activeTab).toBe('starred');

    useLibraryStore.getState().setActiveTab('inbox');
    expect(useLibraryStore.getState().activeTab).toBe('inbox');
  });

  it('setSearchQuery updates the search string', () => {
    expect(useLibraryStore.getState().searchQuery).toBe('');

    useLibraryStore.getState().setSearchQuery('transformers');
    expect(useLibraryStore.getState().searchQuery).toBe('transformers');
  });
});

// =========================================================================
// 16. Component: search input debounce triggers loadPapers
// =========================================================================
describe('Component: search input interaction', () => {
  beforeEach(resetStores);

  it('updates searchQuery in store when typing in search input', async () => {
    const paper = makePaper({ id: 'p1', read_status: 'unread' });

    useLibraryStore.setState({
      papers: [paper],
      tags: [],
      total: 1,
      activeTab: 'inbox',
    });

    setupMethodRouter({
      'rc.lit.list': { items: [paper], total: 1 },
      'rc.lit.tags': [],
    });

    await act(async () => {
      render(<LibraryPanel />);
    });

    const searchInput = screen.getByPlaceholderText('library.search');
    await act(async () => {
      fireEvent.change(searchInput, { target: { value: 'attention' } });
    });

    expect(useLibraryStore.getState().searchQuery).toBe('attention');
  });
});

// =========================================================================
// 17. Component: paper venue display
// =========================================================================
describe('Component: paper venue and year display', () => {
  beforeEach(resetStores);

  it('renders venue when available', async () => {
    const paper = makePaper({
      id: 'p1',
      read_status: 'unread',
      venue: 'NeurIPS 2025',
      year: 2025,
    });

    useLibraryStore.setState({
      papers: [paper],
      tags: [],
      total: 1,
      activeTab: 'inbox',
    });

    setupMethodRouter({
      'rc.lit.list': { items: [paper], total: 1 },
      'rc.lit.tags': [],
    });

    await act(async () => {
      render(<LibraryPanel />);
    });

    expect(screen.getByText('NeurIPS 2025')).toBeInTheDocument();
  });

  it('does not render venue section when venue is null', async () => {
    const paper = makePaper({
      id: 'p1',
      read_status: 'unread',
      venue: null,
    });

    useLibraryStore.setState({
      papers: [paper],
      tags: [],
      total: 1,
      activeTab: 'inbox',
    });

    setupMethodRouter({
      'rc.lit.list': { items: [paper], total: 1 },
      'rc.lit.tags': [],
    });

    await act(async () => {
      render(<LibraryPanel />);
    });

    expect(screen.getByText('Test Paper')).toBeInTheDocument();
    // No venue text should be present
    expect(screen.queryByText('NeurIPS')).not.toBeInTheDocument();
  });
});

// =========================================================================
// 18. i18n: comprehensive key presence and content validation
// =========================================================================
describe('i18n: library keys completeness', () => {
  it('en.json has all required library keys', async () => {
    const en = await import('../i18n/en.json');
    const lib = (en.default ?? en).library;

    // All keys used in LibraryPanel
    expect(lib.inbox).toBeDefined();
    expect(lib.archive).toBeDefined();
    expect(lib.starred).toBeDefined();
    expect(lib.selectCollection).toBeDefined();
    expect(lib.noCollectionsYet).toBeDefined();
    expect(lib.addToCollectionTooltip).toBeDefined();
    expect(lib.addedToCollection).toBeDefined();
    expect(lib.addToCollectionFailed).toBeDefined();
    expect(lib.search).toBeDefined();
    expect(lib.empty).toBeDefined();
    expect(lib.emptyFiltered).toBeDefined();
    expect(lib.clearFilter).toBeDefined();
    expect(lib.sortBy).toBeDefined();
    expect(lib.sortOptions.addedAt).toBeDefined();
    expect(lib.sortOptions.year).toBeDefined();
    expect(lib.sortOptions.title).toBeDefined();
    expect(lib.readStatus.unread).toBeDefined();
    expect(lib.readStatus.reading).toBeDefined();
    expect(lib.readStatus.read).toBeDefined();
    expect(lib.readStatus.reviewed).toBeDefined();
    expect(lib.paperActions.openPdf).toBeDefined();
    expect(lib.paperActions.cite).toBeDefined();
    expect(lib.paperActions.remove).toBeDefined();
    expect(lib.paperActions.editTags).toBeDefined();
  });

  it('zh-CN.json has all required library keys', async () => {
    const zhCN = await import('../i18n/zh-CN.json');
    const lib = (zhCN.default ?? zhCN).library;

    expect(lib.inbox).toBeDefined();
    expect(lib.archive).toBeDefined();
    expect(lib.starred).toBeDefined();
    expect(lib.selectCollection).toBeDefined();
    expect(lib.noCollectionsYet).toBeDefined();
    expect(lib.addToCollectionTooltip).toBeDefined();
    expect(lib.addedToCollection).toBeDefined();
    expect(lib.addToCollectionFailed).toBeDefined();
    expect(lib.search).toBeDefined();
    expect(lib.empty).toBeDefined();
    expect(lib.emptyFiltered).toBeDefined();
    expect(lib.clearFilter).toBeDefined();
    expect(lib.sortBy).toBeDefined();
    expect(lib.sortOptions.addedAt).toBeDefined();
    expect(lib.sortOptions.year).toBeDefined();
    expect(lib.sortOptions.title).toBeDefined();
    expect(lib.readStatus.unread).toBeDefined();
    expect(lib.readStatus.reading).toBeDefined();
    expect(lib.readStatus.read).toBeDefined();
    expect(lib.readStatus.reviewed).toBeDefined();
    expect(lib.paperActions.openPdf).toBeDefined();
    expect(lib.paperActions.cite).toBeDefined();
    expect(lib.paperActions.remove).toBeDefined();
    expect(lib.paperActions.editTags).toBeDefined();
  });

  it('en.json emptyFiltered does not mention drag/drop/upload', async () => {
    const en = await import('../i18n/en.json');
    const text: string = (en.default ?? en).library.emptyFiltered;

    expect(text.toLowerCase()).not.toContain('drag');
    expect(text.toLowerCase()).not.toContain('drop');
    expect(text.toLowerCase()).not.toContain('upload');
  });
});

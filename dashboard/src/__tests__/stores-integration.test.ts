/**
 * Store integration tests
 * Tests that stores correctly interact with the gateway client mock.
 * Covers: library, tasks, sessions stores.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the gateway module so stores can import it
const mockGatewayClient = {
  isConnected: true,
  request: vi.fn(),
};

vi.mock('../stores/gateway', () => ({
  useGatewayStore: {
    getState: () => ({
      client: mockGatewayClient,
    }),
    setState: vi.fn(),
    subscribe: vi.fn(),
  },
}));

describe('Library store integration', () => {
  beforeEach(async () => {
    vi.resetAllMocks();
    mockGatewayClient.isConnected = true;
    const { useLibraryStore } = await import('../stores/library');
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
  });

  it('loadPapers with no filter uses default empty filter', async () => {
    const { useLibraryStore } = await import('../stores/library');
    mockGatewayClient.request.mockResolvedValueOnce({
      items: [
        {
          id: '1',
          title: 'Paper A',
          authors: ['Auth'],
          year: 2025,
          tags: [],
          read_status: 'unread',
          added_at: '2025-01-01T00:00:00Z',
          updated_at: '2025-01-01T00:00:00Z',
        },
      ],
      total: 1,
    });

    await useLibraryStore.getState().loadPapers();

    expect(mockGatewayClient.request).toHaveBeenCalledWith(
      'rc.lit.list',
      expect.objectContaining({ limit: 30, offset: 0 }),
    );
    expect(useLibraryStore.getState().papers).toHaveLength(1);
    expect(useLibraryStore.getState().total).toBe(1);
    expect(useLibraryStore.getState().loading).toBe(false);
  });

  it('loadPapers with status filter sends read_status param', async () => {
    const { useLibraryStore } = await import('../stores/library');
    mockGatewayClient.request.mockResolvedValueOnce({ items: [], total: 0 });

    await useLibraryStore.getState().loadPapers({ read_status: 'reading' });

    expect(mockGatewayClient.request).toHaveBeenCalledWith(
      'rc.lit.list',
      expect.objectContaining({ read_status: 'reading' }),
    );
  });

  it('loadPapers with tags filter sends tags param', async () => {
    const { useLibraryStore } = await import('../stores/library');
    mockGatewayClient.request.mockResolvedValueOnce({ items: [], total: 0 });

    await useLibraryStore.getState().loadPapers({ tags: ['ml'] });

    expect(mockGatewayClient.request).toHaveBeenCalledWith(
      'rc.lit.list',
      expect.objectContaining({ tags: ['ml'] }),
    );
  });

  it('loadPapers with year filter sends year param', async () => {
    const { useLibraryStore } = await import('../stores/library');
    mockGatewayClient.request.mockResolvedValueOnce({ items: [], total: 0 });

    await useLibraryStore.getState().loadPapers({ year: 2024 });

    expect(mockGatewayClient.request).toHaveBeenCalledWith(
      'rc.lit.list',
      expect.objectContaining({ year: 2024 }),
    );
  });

  it('loadPapers uses rc.lit.search when searchQuery is set', async () => {
    const { useLibraryStore } = await import('../stores/library');
    useLibraryStore.setState({ searchQuery: 'attention' });
    mockGatewayClient.request.mockResolvedValueOnce({ items: [], total: 0 });

    await useLibraryStore.getState().loadPapers();

    expect(mockGatewayClient.request).toHaveBeenCalledWith(
      'rc.lit.search',
      expect.objectContaining({ query: 'attention', limit: 30, offset: 0 }),
    );
  });

  it('loadPapers sets loading=false on error', async () => {
    const { useLibraryStore } = await import('../stores/library');
    mockGatewayClient.request.mockRejectedValueOnce(new Error('Network error'));

    await useLibraryStore.getState().loadPapers();

    expect(useLibraryStore.getState().loading).toBe(false);
  });

  it('loadPapers is a no-op when client is disconnected', async () => {
    const { useLibraryStore } = await import('../stores/library');
    mockGatewayClient.isConnected = false;

    await useLibraryStore.getState().loadPapers();

    expect(mockGatewayClient.request).not.toHaveBeenCalled();
  });

  it('updatePaperStatus optimistic update then reverts on error', async () => {
    const { useLibraryStore } = await import('../stores/library');
    useLibraryStore.setState({
      papers: [
        {
          id: 'p1',
          title: 'Test',
          authors: [],
          year: 2025,
          tags: [],
          read_status: 'unread',
          added_at: '2025-01-01T00:00:00Z',
          updated_at: '2025-01-01T00:00:00Z',
          abstract: null, doi: null, url: null, arxiv_id: null, pdf_path: null,
          source: null, source_id: null, venue: null, rating: null, notes: null,
          bibtex_key: null, metadata: {},
        },
      ],
      total: 1,
    });

    // First call (updatePaperStatus) rejects
    mockGatewayClient.request.mockRejectedValueOnce(new Error('Server error'));
    // Second call (loadPapers revert) resolves with original
    mockGatewayClient.request.mockResolvedValueOnce({
      items: [
        {
          id: 'p1',
          title: 'Test',
          authors: [],
          year: 2025,
          tags: [],
          read_status: 'unread',
          added_at: '2025-01-01T00:00:00Z',
          updated_at: '2025-01-01T00:00:00Z',
          abstract: null, doi: null, url: null, arxiv_id: null, pdf_path: null,
          source: null, source_id: null, venue: null, rating: null, notes: null,
          bibtex_key: null, metadata: {},
        },
      ],
      total: 1,
    });

    // Optimistic update should change status immediately
    const promise = useLibraryStore.getState().updatePaperStatus('p1', 'read');
    expect(useLibraryStore.getState().papers[0].read_status).toBe('read');

    await promise;

    // After error, loadPapers is called to revert
    expect(mockGatewayClient.request).toHaveBeenCalledWith('rc.lit.status', {
      id: 'p1',
      status: 'read',
    });
  });

  it('searchPapers sets searchQuery and calls rc.lit.search', async () => {
    const { useLibraryStore } = await import('../stores/library');
    mockGatewayClient.request.mockResolvedValueOnce({
      items: [
        {
          id: 'p2',
          title: 'Found Paper',
          authors: ['A'],
          year: 2025,
          tags: [],
          read_status: 'unread',
          added_at: '2025-01-01T00:00:00Z',
          updated_at: '2025-01-01T00:00:00Z',
        },
      ],
      total: 1,
    });

    await useLibraryStore.getState().searchPapers('transformers');

    expect(useLibraryStore.getState().searchQuery).toBe('transformers');
    expect(mockGatewayClient.request).toHaveBeenCalledWith(
      'rc.lit.search',
      expect.objectContaining({ query: 'transformers', limit: 30, offset: 0 }),
    );
    expect(useLibraryStore.getState().papers).toHaveLength(1);
  });
});

describe('Tasks store integration', () => {
  beforeEach(async () => {
    vi.resetAllMocks();
    mockGatewayClient.isConnected = true;
    const { useTasksStore } = await import('../stores/tasks');
    useTasksStore.setState({
      tasks: [],
      loading: false,
      total: 0,
      offset: 0,
      hasMore: false,
      loadingMore: false,
      perspective: 'all',
      showCompleted: false,
      sortBy: 'deadline',
    });
  });

  it('loadTasks with default perspective sends no task_type filter', async () => {
    const { useTasksStore } = await import('../stores/tasks');
    mockGatewayClient.request.mockResolvedValueOnce({ items: [], total: 0 });

    await useTasksStore.getState().loadTasks();

    expect(mockGatewayClient.request).toHaveBeenCalledWith('rc.task.list', {
      sort: 'deadline',
      include_completed: false,
      limit: 50,
      offset: 0,
    });
  });

  it('loadTasks with human perspective sends task_type=human', async () => {
    const { useTasksStore } = await import('../stores/tasks');
    useTasksStore.setState({ perspective: 'human' });
    mockGatewayClient.request.mockResolvedValueOnce({ items: [], total: 0 });

    await useTasksStore.getState().loadTasks();

    expect(mockGatewayClient.request).toHaveBeenCalledWith(
      'rc.task.list',
      expect.objectContaining({ task_type: 'human' }),
    );
  });

  it('loadTasks with agent perspective sends task_type=agent', async () => {
    const { useTasksStore } = await import('../stores/tasks');
    useTasksStore.setState({ perspective: 'agent' });
    mockGatewayClient.request.mockResolvedValueOnce({ items: [], total: 0 });

    await useTasksStore.getState().loadTasks();

    expect(mockGatewayClient.request).toHaveBeenCalledWith(
      'rc.task.list',
      expect.objectContaining({ task_type: 'agent' }),
    );
  });

  it('completeTask optimistic update sets status=done', async () => {
    const { useTasksStore } = await import('../stores/tasks');
    useTasksStore.setState({
      tasks: [
        {
          id: 't1',
          title: 'Task 1',
          description: null,
          task_type: 'human',
          status: 'todo',
          priority: 'high',
          deadline: null,
          completed_at: null,
          created_at: '2025-01-01T00:00:00Z',
          updated_at: '2025-01-01T00:00:00Z',
          parent_task_id: null,
          related_paper_id: null,
    related_file_path: null,
          agent_session_id: null,
          tags: [],
          notes: null,
        },
      ],
      total: 1,
    });

    mockGatewayClient.request.mockResolvedValueOnce({});

    const promise = useTasksStore.getState().completeTask('t1');

    // Optimistic: status should be 'done' immediately
    expect(useTasksStore.getState().tasks[0].status).toBe('done');
    expect(useTasksStore.getState().tasks[0].completed_at).toBeTruthy();

    await promise;

    expect(mockGatewayClient.request).toHaveBeenCalledWith('rc.task.complete', {
      id: 't1',
    });
  });

  it('completeTask reverts on error by calling loadTasks', async () => {
    const { useTasksStore } = await import('../stores/tasks');
    useTasksStore.setState({
      tasks: [
        {
          id: 't1',
          title: 'Task 1',
          description: null,
          task_type: 'human',
          status: 'todo',
          priority: 'high',
          deadline: null,
          completed_at: null,
          created_at: '2025-01-01T00:00:00Z',
          updated_at: '2025-01-01T00:00:00Z',
          parent_task_id: null,
          related_paper_id: null,
    related_file_path: null,
          agent_session_id: null,
          tags: [],
          notes: null,
        },
      ],
      total: 1,
    });

    // First call (completeTask) rejects
    mockGatewayClient.request.mockRejectedValueOnce(new Error('Fail'));
    // Second call (loadTasks revert) resolves
    mockGatewayClient.request.mockResolvedValueOnce({
      items: [
        {
          id: 't1',
          title: 'Task 1',
          description: null,
          task_type: 'human',
          status: 'todo',
          priority: 'high',
          deadline: null,
          completed_at: null,
          created_at: '2025-01-01T00:00:00Z',
          updated_at: '2025-01-01T00:00:00Z',
          parent_task_id: null,
          related_paper_id: null,
    related_file_path: null,
          agent_session_id: null,
          tags: [],
          notes: null,
        },
      ],
      total: 1,
    });

    await useTasksStore.getState().completeTask('t1');

    // Should have called rc.task.complete then rc.task.list (revert)
    expect(mockGatewayClient.request).toHaveBeenCalledWith('rc.task.complete', { id: 't1' });
    expect(mockGatewayClient.request).toHaveBeenCalledWith('rc.task.list', expect.any(Object));
  });

  it('priority values are strictly typed (urgent|high|medium|low)', async () => {
    const { useTasksStore } = await import('../stores/tasks');
    const task = {
      id: 't1',
      title: 'Test',
      description: null,
      task_type: 'human' as const,
      status: 'todo' as const,
      priority: 'urgent' as const,
      deadline: null,
      completed_at: null,
      created_at: '2025-01-01T00:00:00Z',
      updated_at: '2025-01-01T00:00:00Z',
      parent_task_id: null,
      related_paper_id: null,
    related_file_path: null,
      agent_session_id: null,
      tags: [],
      notes: null,
    };
    useTasksStore.setState({ tasks: [task] });
    const stored = useTasksStore.getState().tasks[0];
    expect(['urgent', 'high', 'medium', 'low']).toContain(stored.priority);
  });

  it('loadTasks is no-op when disconnected', async () => {
    const { useTasksStore } = await import('../stores/tasks');
    mockGatewayClient.isConnected = false;

    await useTasksStore.getState().loadTasks();

    expect(mockGatewayClient.request).not.toHaveBeenCalled();
  });
});

describe('Sessions store integration', () => {
  beforeEach(async () => {
    vi.resetAllMocks();
    mockGatewayClient.isConnected = true;
    const { useSessionsStore } = await import('../stores/sessions');
    useSessionsStore.setState({
      sessions: [],
      activeSessionKey: 'main',
      loading: false,
    });
  });

  it('loadSessions with empty response injects main session', async () => {
    const { useSessionsStore } = await import('../stores/sessions');
    mockGatewayClient.request.mockResolvedValueOnce({ sessions: [] });

    await useSessionsStore.getState().loadSessions();

    // Main session is always guaranteed to be present
    expect(useSessionsStore.getState().sessions).toEqual([{ key: 'main' }]);
    expect(useSessionsStore.getState().loading).toBe(false);
  });

  it('loadSessions handles null sessions field gracefully', async () => {
    const { useSessionsStore } = await import('../stores/sessions');
    // Gateway might return { sessions: null } or similar
    mockGatewayClient.request.mockResolvedValueOnce({ sessions: null });

    await useSessionsStore.getState().loadSessions();

    // The store uses `result.sessions ?? []` so null becomes [], then main is injected
    expect(useSessionsStore.getState().sessions).toEqual([{ key: 'main' }]);
  });

  it('createSession generates a valid UUID and sets it as active', async () => {
    const { useSessionsStore } = await import('../stores/sessions');

    const key = await useSessionsStore.getState().createSession();

    // createSession generates a readable key like "project-{8hex}"
    expect(key).toMatch(/^project-[0-9a-f]{8}$/);
    expect(useSessionsStore.getState().activeSessionKey).toBe(key);
  });

  it('deleteSession removes session and clears active if it was active', async () => {
    const { useSessionsStore } = await import('../stores/sessions');
    useSessionsStore.setState({
      sessions: [
        { key: 'sess-1' },
        { key: 'sess-2' },
      ],
      activeSessionKey: 'sess-1',
    });

    mockGatewayClient.request.mockResolvedValueOnce({});

    await useSessionsStore.getState().deleteSession('sess-1');

    const state = useSessionsStore.getState();
    expect(state.sessions).toHaveLength(1);
    expect(state.sessions[0].key).toBe('sess-2');
    // Active key was sess-1 which was deleted, should reset to main
    expect(state.activeSessionKey).toBe('main');
  });

  it('deleteSession keeps active key if different session deleted', async () => {
    const { useSessionsStore } = await import('../stores/sessions');
    useSessionsStore.setState({
      sessions: [
        { key: 'sess-1' },
        { key: 'sess-2' },
      ],
      activeSessionKey: 'sess-1',
    });

    mockGatewayClient.request.mockResolvedValueOnce({});

    await useSessionsStore.getState().deleteSession('sess-2');

    expect(useSessionsStore.getState().activeSessionKey).toBe('sess-1');
  });

  it('loadSessions is no-op when disconnected', async () => {
    const { useSessionsStore } = await import('../stores/sessions');
    mockGatewayClient.isConnected = false;

    await useSessionsStore.getState().loadSessions();

    expect(mockGatewayClient.request).not.toHaveBeenCalled();
  });

  it('switchSession updates activeSessionKey', async () => {
    const { useSessionsStore } = await import('../stores/sessions');
    useSessionsStore.getState().switchSession('new-session');
    expect(useSessionsStore.getState().activeSessionKey).toBe('new-session');
  });
});

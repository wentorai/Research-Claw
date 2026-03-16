/**
 * Store edge case / integration tests
 * Covers: filter combinations, error handling, state reset,
 * optimistic update rollback, concurrent operations, boundary values
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the gateway module
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

// ---- Library Store: Filter Combinations ----

describe('Library store filter combinations', () => {
  beforeEach(async () => {
    vi.resetAllMocks();
    mockGatewayClient.isConnected = true;
    const { useLibraryStore } = await import('../stores/library');
    useLibraryStore.setState({
      papers: [],
      tags: [],
      loading: false,
      total: 0,
      searchQuery: '',
      activeTab: 'pending',
      filters: {},
    });
  });

  it('combines status + tags + year + sort in one request', async () => {
    const { useLibraryStore } = await import('../stores/library');
    mockGatewayClient.request.mockResolvedValueOnce({ items: [], total: 0 });

    await useLibraryStore.getState().loadPapers({
      read_status: 'read',
      tags: ['ml'],
      year: 2024,
      sort: 'year',
    });

    expect(mockGatewayClient.request).toHaveBeenCalledWith('rc.lit.list', {
      read_status: 'read',
      tags: ['ml'],
      year: 2024,
      sort: 'year',
    });
  });

  it('undefined tags is NOT sent to gateway', async () => {
    const { useLibraryStore } = await import('../stores/library');
    mockGatewayClient.request.mockResolvedValueOnce({ items: [], total: 0 });

    await useLibraryStore.getState().loadPapers({});

    const callArgs = mockGatewayClient.request.mock.calls[0][1];
    expect(callArgs).not.toHaveProperty('tags');
    expect(callArgs).not.toHaveProperty('tag');
  });

  it('uses stored filters when no filter argument is provided', async () => {
    const { useLibraryStore } = await import('../stores/library');
    useLibraryStore.setState({ filters: { read_status: 'unread', sort: 'title' } });
    mockGatewayClient.request.mockResolvedValueOnce({ items: [], total: 0 });

    await useLibraryStore.getState().loadPapers();

    // Title sort sends '+title' for ascending A→Z
    expect(mockGatewayClient.request).toHaveBeenCalledWith(
      'rc.lit.list',
      expect.objectContaining({ read_status: 'unread', sort: '+title' }),
    );
  });

  it('year=0 is treated as falsy and not sent', async () => {
    const { useLibraryStore } = await import('../stores/library');
    mockGatewayClient.request.mockResolvedValueOnce({ items: [], total: 0 });

    await useLibraryStore.getState().loadPapers({ year: 0 });

    const callArgs = mockGatewayClient.request.mock.calls[0][1];
    expect(callArgs).not.toHaveProperty('year');
  });

  it('loadTags sets tags array from gateway response', async () => {
    const { useLibraryStore } = await import('../stores/library');
    // rc.lit.tags returns Tag[] directly, not { tags: [...] }
    mockGatewayClient.request.mockResolvedValueOnce([
      { id: 'tag-1', name: 'ml', paper_count: 10, color: '#3B82F6', created_at: '2025-01-01T00:00:00Z' },
      { id: 'tag-2', name: 'nlp', paper_count: 5, created_at: '2025-01-01T00:00:00Z' },
    ]);

    await useLibraryStore.getState().loadTags();

    expect(useLibraryStore.getState().tags).toHaveLength(2);
    expect(useLibraryStore.getState().tags[0].name).toBe('ml');
  });

  it('loadTags silently fails on error (non-fatal)', async () => {
    const { useLibraryStore } = await import('../stores/library');
    mockGatewayClient.request.mockRejectedValueOnce(new Error('timeout'));

    await useLibraryStore.getState().loadTags();

    // Should not crash and tags remain empty
    expect(useLibraryStore.getState().tags).toEqual([]);
  });

  it('ratePaper optimistic update then reverts on error', async () => {
    const { useLibraryStore } = await import('../stores/library');
    useLibraryStore.setState({
      papers: [{
        id: 'p1', title: 'T', authors: [], year: 2025, tags: [],
        read_status: 'unread', rating: 3, added_at: '', updated_at: '',
        abstract: null, doi: null, url: null, arxiv_id: null, pdf_path: null,
        source: null, source_id: null, venue: null, notes: null,
        bibtex_key: null, metadata: {},
      }],
      total: 1,
    });

    // First call (ratePaper) rejects
    mockGatewayClient.request.mockRejectedValueOnce(new Error('Server error'));
    // Second call (loadPapers revert) resolves
    mockGatewayClient.request.mockResolvedValueOnce({
      items: [{
        id: 'p1', title: 'T', authors: [], year: 2025, tags: [],
        read_status: 'unread', rating: 3, added_at: '', updated_at: '',
        abstract: null, doi: null, url: null, arxiv_id: null, pdf_path: null,
        source: null, source_id: null, venue: null, notes: null,
        bibtex_key: null, metadata: {},
      }],
      total: 1,
    });

    const promise = useLibraryStore.getState().ratePaper('p1', 5);
    // Optimistic: rating changed immediately
    expect(useLibraryStore.getState().papers[0].rating).toBe(5);

    await promise;
    // After error, loadPapers called to revert
    expect(mockGatewayClient.request).toHaveBeenCalledWith('rc.lit.rate', { id: 'p1', rating: 5 });
  });

  it('deletePaper removes paper and decrements total', async () => {
    const { useLibraryStore } = await import('../stores/library');
    useLibraryStore.setState({
      papers: [
        { id: 'p1', title: 'A', authors: [], year: 2025, tags: [], read_status: 'unread', added_at: '', updated_at: '', abstract: null, doi: null, url: null, arxiv_id: null, pdf_path: null, source: null, source_id: null, venue: null, rating: null, notes: null, bibtex_key: null, metadata: {} },
        { id: 'p2', title: 'B', authors: [], year: 2025, tags: [], read_status: 'unread', added_at: '', updated_at: '', abstract: null, doi: null, url: null, arxiv_id: null, pdf_path: null, source: null, source_id: null, venue: null, rating: null, notes: null, bibtex_key: null, metadata: {} },
      ],
      total: 2,
    });
    mockGatewayClient.request.mockResolvedValueOnce({});

    await useLibraryStore.getState().deletePaper('p1');

    expect(useLibraryStore.getState().papers).toHaveLength(1);
    expect(useLibraryStore.getState().papers[0].id).toBe('p2');
    expect(useLibraryStore.getState().total).toBe(1);
  });

  it('setActiveTab updates tab state', async () => {
    const { useLibraryStore } = await import('../stores/library');
    expect(useLibraryStore.getState().activeTab).toBe('pending');
    useLibraryStore.getState().setActiveTab('saved');
    expect(useLibraryStore.getState().activeTab).toBe('saved');
  });
});

// ---- Tasks Store: Error Handling ----

describe('Tasks store error handling and edge cases', () => {
  beforeEach(async () => {
    vi.resetAllMocks();
    mockGatewayClient.isConnected = true;
    const { useTasksStore } = await import('../stores/tasks');
    useTasksStore.setState({
      tasks: [],
      loading: false,
      total: 0,
      perspective: 'all',
      showCompleted: false,
      sortBy: 'deadline',
    });
  });

  it('loadTasks sets loading=false on RPC failure', async () => {
    const { useTasksStore } = await import('../stores/tasks');
    mockGatewayClient.request.mockRejectedValueOnce(new Error('timeout'));

    await useTasksStore.getState().loadTasks();

    expect(useTasksStore.getState().loading).toBe(false);
    expect(useTasksStore.getState().tasks).toEqual([]);
  });

  it('toggleCompleted flips showCompleted state', async () => {
    const { useTasksStore } = await import('../stores/tasks');
    expect(useTasksStore.getState().showCompleted).toBe(false);
    useTasksStore.getState().toggleCompleted();
    expect(useTasksStore.getState().showCompleted).toBe(true);
    useTasksStore.getState().toggleCompleted();
    expect(useTasksStore.getState().showCompleted).toBe(false);
  });

  it('createTask appends to tasks array and increments total', async () => {
    const { useTasksStore } = await import('../stores/tasks');
    const newTask = {
      id: 't-new', title: 'New', description: null, task_type: 'human' as const,
      status: 'todo' as const, priority: 'medium' as const, deadline: null,
      completed_at: null, created_at: '', updated_at: '', parent_task_id: null,
      related_paper_id: null, agent_session_id: null, tags: [], notes: null,
    related_file_path: null,
    };
    mockGatewayClient.request.mockResolvedValueOnce(newTask);

    await useTasksStore.getState().createTask({
      title: 'New', task_type: 'human',
    });

    expect(useTasksStore.getState().tasks).toHaveLength(1);
    expect(useTasksStore.getState().total).toBe(1);
  });

  it('createTask is no-op when disconnected', async () => {
    const { useTasksStore } = await import('../stores/tasks');
    mockGatewayClient.isConnected = false;

    await useTasksStore.getState().createTask({
      title: 'New', task_type: 'human',
    });

    expect(mockGatewayClient.request).not.toHaveBeenCalled();
    expect(useTasksStore.getState().tasks).toHaveLength(0);
  });

  it('updateTask replaces task in array with gateway response', async () => {
    const { useTasksStore } = await import('../stores/tasks');
    const original = {
      id: 't1', title: 'Original', description: null, task_type: 'human' as const,
      status: 'todo' as const, priority: 'low' as const, deadline: null,
      completed_at: null, created_at: '', updated_at: '', parent_task_id: null,
      related_paper_id: null, agent_session_id: null, tags: [], notes: null,
    related_file_path: null,
    };
    useTasksStore.setState({ tasks: [original], total: 1 });

    const updated = { ...original, title: 'Updated', priority: 'high' as const };
    mockGatewayClient.request.mockResolvedValueOnce(updated);

    await useTasksStore.getState().updateTask('t1', { title: 'Updated', priority: 'high' });

    expect(useTasksStore.getState().tasks[0].title).toBe('Updated');
    expect(useTasksStore.getState().tasks[0].priority).toBe('high');
  });

  it('deleteTask removes task and decrements total', async () => {
    const { useTasksStore } = await import('../stores/tasks');
    const task = {
      id: 't1', title: 'Delete me', description: null, task_type: 'human' as const,
      status: 'todo' as const, priority: 'low' as const, deadline: null,
      completed_at: null, created_at: '', updated_at: '', parent_task_id: null,
      related_paper_id: null, agent_session_id: null, tags: [], notes: null,
    related_file_path: null,
    };
    useTasksStore.setState({ tasks: [task], total: 1 });
    mockGatewayClient.request.mockResolvedValueOnce({});

    await useTasksStore.getState().deleteTask('t1');

    expect(useTasksStore.getState().tasks).toHaveLength(0);
    expect(useTasksStore.getState().total).toBe(0);
  });

  it('deleteTask is no-op when disconnected', async () => {
    const { useTasksStore } = await import('../stores/tasks');
    mockGatewayClient.isConnected = false;

    await useTasksStore.getState().deleteTask('t1');

    expect(mockGatewayClient.request).not.toHaveBeenCalled();
  });

  it('loadTasks with showCompleted=true sends include_completed=true', async () => {
    const { useTasksStore } = await import('../stores/tasks');
    useTasksStore.setState({ showCompleted: true });
    mockGatewayClient.request.mockResolvedValueOnce({ items: [], total: 0 });

    await useTasksStore.getState().loadTasks();

    expect(mockGatewayClient.request).toHaveBeenCalledWith(
      'rc.task.list',
      expect.objectContaining({ include_completed: true }),
    );
  });

  it('setPerspective updates state', async () => {
    const { useTasksStore } = await import('../stores/tasks');
    useTasksStore.getState().setPerspective('agent');
    expect(useTasksStore.getState().perspective).toBe('agent');
    useTasksStore.getState().setPerspective('all');
    expect(useTasksStore.getState().perspective).toBe('all');
  });
});

// ---- Sessions Store: Edge Cases ----

describe('Sessions store edge cases', () => {
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

  it('loadSessions sets loading=false on RPC failure', async () => {
    const { useSessionsStore } = await import('../stores/sessions');
    mockGatewayClient.request.mockRejectedValueOnce(new Error('timeout'));

    await useSessionsStore.getState().loadSessions();

    expect(useSessionsStore.getState().loading).toBe(false);
    expect(useSessionsStore.getState().sessions).toEqual([]);
  });

  it('loadSessions with multiple sessions populates list and injects main', async () => {
    const { useSessionsStore } = await import('../stores/sessions');
    const sessions = [
      { key: 's1', updatedAt: 1704067200 },
      { key: 's2', updatedAt: 1704153600 },
      { key: 's3', updatedAt: 1704240000 },
    ];
    mockGatewayClient.request.mockResolvedValueOnce({ sessions });

    await useSessionsStore.getState().loadSessions();

    // 3 server sessions + 1 injected main session
    expect(useSessionsStore.getState().sessions).toHaveLength(4);
    expect(useSessionsStore.getState().sessions[0].key).toBe('main');
    expect(useSessionsStore.getState().loading).toBe(false);
  });

  it('createSession generates unique keys for multiple sessions', async () => {
    const { useSessionsStore } = await import('../stores/sessions');

    const key1 = await useSessionsStore.getState().createSession();
    const key2 = await useSessionsStore.getState().createSession();

    expect(key1).not.toBe(key2);
    // Most recent session is active
    expect(useSessionsStore.getState().activeSessionKey).toBe(key2);
  });

  it('switchSession to non-existent key still sets it as active', async () => {
    const { useSessionsStore } = await import('../stores/sessions');
    useSessionsStore.setState({
      sessions: [{ key: 'existing' }],
      activeSessionKey: 'existing',
    });

    useSessionsStore.getState().switchSession('non-existent');

    // switchSession just sets the key, does not validate against session list
    expect(useSessionsStore.getState().activeSessionKey).toBe('non-existent');
  });

  it('deleteSession when no sessions exist does not crash', async () => {
    const { useSessionsStore } = await import('../stores/sessions');
    mockGatewayClient.request.mockResolvedValueOnce({});

    // Deleting from empty list should not throw
    await useSessionsStore.getState().deleteSession('non-existent');

    expect(useSessionsStore.getState().sessions).toEqual([]);
  });

  it('deleteSession is no-op when disconnected', async () => {
    const { useSessionsStore } = await import('../stores/sessions');
    mockGatewayClient.isConnected = false;

    await useSessionsStore.getState().deleteSession('s1');

    expect(mockGatewayClient.request).not.toHaveBeenCalled();
  });
});

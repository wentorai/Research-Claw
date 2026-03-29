/**
 * Behavioral Parity Tests: Store RPC Handling
 *
 * These tests verify that our dashboard Zustand stores (library, tasks, sessions)
 * correctly handle REAL gateway RPC responses from the Research-Claw Core plugin.
 *
 * Source references:
 *   - Literature RPC: extensions/research-claw-core/src/literature/rpc.ts
 *   - Literature Service: extensions/research-claw-core/src/literature/service.ts (Paper interface, lines 50-71)
 *   - Task RPC: extensions/research-claw-core/src/tasks/rpc.ts
 *   - Task Service: extensions/research-claw-core/src/tasks/service.ts (Task interface, lines 25-41)
 *   - Sessions: OpenClaw gateway src/gateway/session-utils.types.ts
 *
 * Each test cites the OpenClaw source and verifies field-by-field parity.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useLibraryStore } from '../../stores/library';
import { useTasksStore } from '../../stores/tasks';
import { useSessionsStore } from '../../stores/sessions';

import {
  RC_LIT_LIST_RESPONSE,
  RC_LIT_SEARCH_RESPONSE,
  RC_LIT_TAGS_RESPONSE,
  RC_LIT_LIST_EMPTY_RESPONSE,
  RC_TASK_LIST_RESPONSE,
  RC_TASK_CREATE_RESPONSE,
  RC_TASK_COMPLETE_RESPONSE,
  RC_TASK_LIST_EMPTY_RESPONSE,
  SESSIONS_LIST_RESPONSE,
  SESSIONS_LIST_EMPTY_RESPONSE,
  SESSIONS_DELETE_RESPONSE,
  SESSIONS_PATCH_RESPONSE,
} from '../../__fixtures__/gateway-payloads/rpc-responses';

// ── Mock gateway store ──────────────────────────────────────────────────
const mockGatewayClient = {
  isConnected: true,
  request: vi.fn(),
};

vi.mock('../../stores/gateway', () => ({
  useGatewayStore: {
    getState: () => ({ client: mockGatewayClient, state: 'connected' }),
    setState: vi.fn(),
    subscribe: vi.fn(),
  },
}));

// ── Mock chat store (used by sessions store) ────────────────────────────
const mockSetSessionKey = vi.fn();
const mockLoadHistory = vi.fn();
const mockLoadSessionUsage = vi.fn();

vi.mock('../../stores/chat', () => ({
  useChatStore: {
    getState: () => ({
      setSessionKey: mockSetSessionKey,
      loadHistory: mockLoadHistory,
      loadSessionUsage: mockLoadSessionUsage,
    }),
    setState: vi.fn(),
    subscribe: vi.fn(),
  },
}));

// ══════════════════════════════════════════════════════════════════════════
// Library Store — rc.lit.* RPC parity
// ══════════════════════════════════════════════════════════════════════════

describe('Library store RPC parity (rc.lit.*)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockGatewayClient.isConnected = true;
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

  describe('loadPapers → rc.lit.list', () => {
    it('correctly parses rc.lit.list response with all Paper fields', async () => {
      // Source: literature/rpc.ts:117-141 → returns { items: Paper[], total, offset, limit }
      // Paper shape: literature/service.ts:50-71
      mockGatewayClient.request.mockResolvedValueOnce(RC_LIT_LIST_RESPONSE);

      await useLibraryStore.getState().loadPapers();

      const state = useLibraryStore.getState();
      expect(state.papers).toHaveLength(3);
      expect(state.total).toBe(3);
      expect(state.loading).toBe(false);

      // Field-by-field parity check on first paper
      // Ref: literature/service.ts:50-71 (Paper interface)
      const paper = state.papers[0];
      expect(paper.id).toBe('019523a4-7b2c-7e00-8d3f-1a2b3c4d5e6f');
      expect(paper.title).toBe('Attention Is All You Need');
      expect(paper.authors).toEqual(['Ashish Vaswani', 'Noam Shazeer', 'Niki Parmar', 'Jakob Uszkoreit']);
      expect(paper.year).toBe(2017);
      expect(paper.doi).toBe('10.48550/arXiv.1706.03762');
      expect(paper.url).toBe('https://arxiv.org/abs/1706.03762');
      expect(paper.arxiv_id).toBe('1706.03762');
      expect(paper.venue).toBe('NeurIPS 2017');
      expect(paper.read_status).toBe('read');
      expect(paper.rating).toBe(5);
      expect(paper.tags).toEqual(['transformers', 'NLP', 'deep-learning']);
      expect(paper.added_at).toBe('2026-03-10T08:30:00.000Z');
      expect(paper.updated_at).toBe('2026-03-12T14:22:00.000Z');
    });

    it('handles Paper with null fields (no abstract, no pdf, no rating)', async () => {
      // Source: literature/service.ts:54-68 — many fields are nullable
      // PARITY NOTE: The plugin returns `null` for empty nullable fields.
      // The dashboard Paper interface declares these as optional (string | undefined),
      // but the store does NOT transform null→undefined. The raw gateway JSON
      // with `null` values flows through as-is. This is acceptable because
      // TypeScript optional fields accept both null and undefined at runtime.
      mockGatewayClient.request.mockResolvedValueOnce(RC_LIT_LIST_RESPONSE);

      await useLibraryStore.getState().loadPapers();

      const scalingPaper = useLibraryStore.getState().papers[2];
      expect(scalingPaper.title).toBe('Scaling Laws for Neural Language Models');
      // Nullable fields from db/schema.ts: abstract, doi, pdf_path, venue, rating, notes, bibtex_key
      // The plugin sends null; the store passes them through as null (not undefined)
      expect(scalingPaper.abstract).toBeNull();
      expect(scalingPaper.doi).toBeNull();
      expect(scalingPaper.rating).toBeNull();
      expect(scalingPaper.tags).toEqual([]);
      expect(scalingPaper.read_status).toBe('unread');
    });

    it('sends correct RPC method and filter params', async () => {
      // Source: literature/rpc.ts:117-141 — params: read_status, year, tag, sort, offset, limit
      mockGatewayClient.request.mockResolvedValueOnce(RC_LIT_LIST_RESPONSE);

      useLibraryStore.setState({ filters: { read_status: 'reading', year: 2019 } });
      await useLibraryStore.getState().loadPapers();

      expect(mockGatewayClient.request).toHaveBeenCalledWith(
        'rc.lit.list',
        expect.objectContaining({
          read_status: 'reading',
          year: 2019,
        }),
      );
    });

    it('uses rc.lit.search when searchQuery is set', async () => {
      // Source: literature/rpc.ts:366-375 — rc.lit.search takes { query, limit?, offset? }
      mockGatewayClient.request.mockResolvedValueOnce(RC_LIT_SEARCH_RESPONSE);

      useLibraryStore.setState({ searchQuery: 'attention' });
      await useLibraryStore.getState().loadPapers();

      expect(mockGatewayClient.request).toHaveBeenCalledWith(
        'rc.lit.search',
        expect.objectContaining({ query: 'attention', limit: 30, offset: 0 }),
      );
      expect(useLibraryStore.getState().papers).toHaveLength(1);
      expect(useLibraryStore.getState().total).toBe(1);
    });

    it('passes sort direction prefix for title sort', async () => {
      // Source: literature/service.ts:610-620 — "+title" for ASC, "-field" for DESC
      // Dashboard: library.ts:97 — title sort sends "+title"
      mockGatewayClient.request.mockResolvedValueOnce(RC_LIT_LIST_RESPONSE);

      useLibraryStore.setState({ filters: { sort: 'title' } });
      await useLibraryStore.getState().loadPapers();

      expect(mockGatewayClient.request).toHaveBeenCalledWith(
        'rc.lit.list',
        expect.objectContaining({ sort: '+title' }),
      );
    });

    it('handles empty response', async () => {
      mockGatewayClient.request.mockResolvedValueOnce(RC_LIT_LIST_EMPTY_RESPONSE);

      await useLibraryStore.getState().loadPapers();

      expect(useLibraryStore.getState().papers).toEqual([]);
      expect(useLibraryStore.getState().total).toBe(0);
      expect(useLibraryStore.getState().loading).toBe(false);
    });
  });

  describe('loadTags → rc.lit.tags', () => {
    it('correctly parses rc.lit.tags response', async () => {
      // Source: literature/rpc.ts:266-272 → service.getTags() returns Tag[]
      // Tag shape: literature/service.ts:82-88
      mockGatewayClient.request.mockResolvedValueOnce(RC_LIT_TAGS_RESPONSE);

      await useLibraryStore.getState().loadTags();

      const tags = useLibraryStore.getState().tags;
      expect(tags).toHaveLength(4);
      expect(tags[0].id).toBe('tag-001');
      expect(tags[0].name).toBe('transformers');
      expect(tags[0].color).toBe('#8B5CF6');
      expect(tags[0].paper_count).toBe(1);
      expect(tags[0].created_at).toBe('2026-03-10T08:30:00.000Z');
    });

    it('handles non-array response gracefully', async () => {
      // Source: library.ts:112 — wraps in Array.isArray check
      mockGatewayClient.request.mockResolvedValueOnce(null);

      await useLibraryStore.getState().loadTags();

      expect(useLibraryStore.getState().tags).toEqual([]);
    });
  });

  describe('searchPapers → rc.lit.search', () => {
    it('sends correct RPC method and query param', async () => {
      // Source: literature/rpc.ts:366-375 — rc.lit.search({ query, limit?, offset? })
      mockGatewayClient.request.mockResolvedValueOnce(RC_LIT_SEARCH_RESPONSE);

      await useLibraryStore.getState().searchPapers('transformer efficiency');

      expect(mockGatewayClient.request).toHaveBeenCalledWith(
        'rc.lit.search',
        expect.objectContaining({ query: 'transformer efficiency', limit: 30, offset: 0 }),
      );
    });

    it('updates store with search results', async () => {
      mockGatewayClient.request.mockResolvedValueOnce(RC_LIT_SEARCH_RESPONSE);

      await useLibraryStore.getState().searchPapers('attention');

      const state = useLibraryStore.getState();
      expect(state.papers).toHaveLength(1);
      expect(state.total).toBe(1);
      expect(state.searchQuery).toBe('attention');
      expect(state.loading).toBe(false);
    });
  });

  describe('updatePaperStatus → rc.lit.status', () => {
    it('sends correct RPC params', async () => {
      // Source: literature/rpc.ts:239-247 — rc.lit.status({ id, status })
      mockGatewayClient.request.mockResolvedValueOnce({});
      useLibraryStore.setState({ papers: [RC_LIT_LIST_RESPONSE.items[0]] });

      await useLibraryStore.getState().updatePaperStatus(
        '019523a4-7b2c-7e00-8d3f-1a2b3c4d5e6f',
        'reviewed',
      );

      expect(mockGatewayClient.request).toHaveBeenCalledWith(
        'rc.lit.status',
        { id: '019523a4-7b2c-7e00-8d3f-1a2b3c4d5e6f', status: 'reviewed' },
      );
    });

    it('applies optimistic update immediately', async () => {
      // Source: library.ts:130-143 — optimistic update before RPC call
      let resolveRequest!: (v: unknown) => void;
      mockGatewayClient.request.mockReturnValueOnce(new Promise((r) => { resolveRequest = r; }));
      useLibraryStore.setState({ papers: [RC_LIT_LIST_RESPONSE.items[1]] });

      const promise = useLibraryStore.getState().updatePaperStatus(
        '019523a4-8c3d-7e00-9e4f-2b3c4d5e6f7a',
        'read',
      );

      // Optimistic update should apply before the RPC resolves
      expect(useLibraryStore.getState().papers[0].read_status).toBe('read');

      resolveRequest({});
      await promise;
    });
  });

  describe('deletePaper → rc.lit.delete', () => {
    it('removes paper from local state after successful RPC', async () => {
      // Source: literature/rpc.ts:227-235 → returns { ok: true }
      mockGatewayClient.request
        .mockResolvedValueOnce({ ok: true })
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce({ by_status: {}, starred_count: 0 });
      useLibraryStore.setState({
        papers: RC_LIT_LIST_RESPONSE.items,
        total: 3,
      });

      await useLibraryStore.getState().deletePaper('019523a4-8c3d-7e00-9e4f-2b3c4d5e6f7a');

      expect(mockGatewayClient.request).toHaveBeenCalledWith(
        'rc.lit.delete',
        { id: '019523a4-8c3d-7e00-9e4f-2b3c4d5e6f7a' },
      );
      expect(useLibraryStore.getState().papers).toHaveLength(2);
      expect(useLibraryStore.getState().total).toBe(2);
    });
  });

  describe('Gateway disconnection handling', () => {
    it('skips loadPapers when gateway is disconnected', async () => {
      // Source: library.ts:74-78 — early return if !client?.isConnected
      mockGatewayClient.isConnected = false;

      await useLibraryStore.getState().loadPapers();

      expect(mockGatewayClient.request).not.toHaveBeenCalled();
      expect(useLibraryStore.getState().loading).toBe(false);
    });

    it('skips searchPapers when gateway is disconnected', async () => {
      mockGatewayClient.isConnected = false;

      await useLibraryStore.getState().searchPapers('test');

      expect(mockGatewayClient.request).not.toHaveBeenCalled();
    });

    it('skips updatePaperStatus when gateway is disconnected', async () => {
      mockGatewayClient.isConnected = false;
      useLibraryStore.setState({ papers: [RC_LIT_LIST_RESPONSE.items[0]] });

      await useLibraryStore.getState().updatePaperStatus(
        '019523a4-7b2c-7e00-8d3f-1a2b3c4d5e6f',
        'reviewed',
      );

      expect(mockGatewayClient.request).not.toHaveBeenCalled();
    });
  });

  describe('RPC error handling', () => {
    it('clears loading on RPC error for loadPapers', async () => {
      mockGatewayClient.request.mockRejectedValueOnce(new Error('RPC error: -32001'));

      await useLibraryStore.getState().loadPapers();

      expect(useLibraryStore.getState().loading).toBe(false);
      expect(useLibraryStore.getState().papers).toEqual([]);
    });

    it('clears loading on RPC error for searchPapers', async () => {
      mockGatewayClient.request.mockRejectedValueOnce(new Error('FTS query error'));

      await useLibraryStore.getState().searchPapers('bad query [');

      expect(useLibraryStore.getState().loading).toBe(false);
    });

    it('reverts optimistic update on RPC error for updatePaperStatus', async () => {
      // Source: library.ts:139-142 — on catch, calls loadPapers() to revert
      mockGatewayClient.request
        .mockRejectedValueOnce(new Error('Paper not found'))  // status call fails
        .mockResolvedValueOnce(RC_LIT_LIST_RESPONSE);          // loadPapers reload
      useLibraryStore.setState({ papers: [RC_LIT_LIST_RESPONSE.items[0]] });

      await useLibraryStore.getState().updatePaperStatus(
        '019523a4-7b2c-7e00-8d3f-1a2b3c4d5e6f',
        'unread',
      );

      // loadPapers should be called as revert mechanism
      expect(mockGatewayClient.request).toHaveBeenCalledTimes(2);
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Tasks Store — rc.task.* RPC parity
// ══════════════════════════════════════════════════════════════════════════

describe('Tasks store RPC parity (rc.task.*)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockGatewayClient.isConnected = true;
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

  describe('loadTasks → rc.task.list', () => {
    it('correctly parses rc.task.list response with all Task fields', async () => {
      // Source: tasks/rpc.ts:169-189 → service.list() returns { items: Task[], total: number }
      // Task shape: tasks/service.ts:25-41
      mockGatewayClient.request.mockResolvedValueOnce(RC_TASK_LIST_RESPONSE);

      await useTasksStore.getState().loadTasks();

      const state = useTasksStore.getState();
      expect(state.tasks).toHaveLength(3);
      expect(state.total).toBe(3);
      expect(state.loading).toBe(false);

      // Field-by-field parity on first task
      // Ref: tasks/service.ts:25-41 (Task interface)
      const task = state.tasks[0];
      expect(task.id).toBe('task-001-uuid-placeholder');
      expect(task.title).toBe('Read Vaswani et al. 2017 — Attention Is All You Need');
      expect(task.description).toBe('Read the full paper and write a 2-page summary of key contributions.');
      expect(task.task_type).toBe('human');
      expect(task.status).toBe('in_progress');
      expect(task.priority).toBe('high');
      expect(task.deadline).toBe('2026-03-15T23:59:00.000Z');
      expect(task.completed_at).toBeNull();
      expect(task.created_at).toBe('2026-03-10T09:00:00.000Z');
      expect(task.updated_at).toBe('2026-03-12T14:30:00.000Z');
      expect(task.parent_task_id).toBeNull();
      expect(task.related_paper_id).toBe('019523a4-7b2c-7e00-8d3f-1a2b3c4d5e6f');
      expect(task.agent_session_id).toBeNull();
      expect(task.tags).toEqual(['reading', 'literature-review']);
      expect(task.notes).toBeNull();
    });

    it('preserves all task_type variants from plugin', async () => {
      // Source: tasks/service.ts:20 — TaskType = 'human' | 'agent' | 'mixed'
      mockGatewayClient.request.mockResolvedValueOnce(RC_TASK_LIST_RESPONSE);

      await useTasksStore.getState().loadTasks();

      const types = useTasksStore.getState().tasks.map((t) => t.task_type);
      expect(types).toEqual(['human', 'agent', 'mixed']);
    });

    it('preserves all status variants from plugin', async () => {
      // Source: tasks/service.ts:21 — TaskStatus = 'todo' | 'in_progress' | 'blocked' | 'done' | 'cancelled'
      mockGatewayClient.request.mockResolvedValueOnce(RC_TASK_LIST_RESPONSE);

      await useTasksStore.getState().loadTasks();

      const statuses = useTasksStore.getState().tasks.map((t) => t.status);
      expect(statuses).toEqual(['in_progress', 'todo', 'blocked']);
    });

    it('preserves all priority variants from plugin', async () => {
      // Source: tasks/service.ts:22 — TaskPriority = 'urgent' | 'high' | 'medium' | 'low'
      mockGatewayClient.request.mockResolvedValueOnce(RC_TASK_LIST_RESPONSE);

      await useTasksStore.getState().loadTasks();

      const priorities = useTasksStore.getState().tasks.map((t) => t.priority);
      expect(priorities).toEqual(['high', 'medium', 'urgent']);
    });

    it('sends correct params based on store state', async () => {
      // Source: tasks/rpc.ts:169-189 — params: sort, include_completed, task_type, limit, offset, etc.
      mockGatewayClient.request.mockResolvedValueOnce(RC_TASK_LIST_RESPONSE);

      useTasksStore.setState({ perspective: 'human', showCompleted: true, sortBy: 'priority' });
      await useTasksStore.getState().loadTasks();

      expect(mockGatewayClient.request).toHaveBeenCalledWith(
        'rc.task.list',
        {
          sort: 'priority',
          include_completed: true,
          task_type: 'human',
          limit: 50,
          offset: 0,
        },
      );
    });

    it('omits task_type param when perspective is "all"', async () => {
      // Source: tasks.ts:94-95 — only adds task_type for 'human' or 'agent'
      mockGatewayClient.request.mockResolvedValueOnce(RC_TASK_LIST_RESPONSE);

      useTasksStore.setState({ perspective: 'all' });
      await useTasksStore.getState().loadTasks();

      const callArgs = mockGatewayClient.request.mock.calls[0][1] as Record<string, unknown>;
      expect(callArgs.task_type).toBeUndefined();
    });

    it('handles empty response', async () => {
      mockGatewayClient.request.mockResolvedValueOnce(RC_TASK_LIST_EMPTY_RESPONSE);

      await useTasksStore.getState().loadTasks();

      expect(useTasksStore.getState().tasks).toEqual([]);
      expect(useTasksStore.getState().total).toBe(0);
      expect(useTasksStore.getState().loading).toBe(false);
    });
  });

  describe('completeTask → rc.task.complete', () => {
    it('sends correct RPC method and params', async () => {
      // Source: tasks/rpc.ts:295-304 — rc.task.complete({ id, notes? })
      mockGatewayClient.request.mockResolvedValueOnce(RC_TASK_COMPLETE_RESPONSE);
      useTasksStore.setState({ tasks: [RC_TASK_LIST_RESPONSE.items[0]] });

      await useTasksStore.getState().completeTask('task-001-uuid-placeholder');

      expect(mockGatewayClient.request).toHaveBeenCalledWith(
        'rc.task.complete',
        { id: 'task-001-uuid-placeholder' },
      );
    });

    it('applies optimistic update (status=done, completed_at set)', async () => {
      // Source: tasks.ts:111-128 — optimistic: status → 'done', completed_at → now
      let resolveRequest!: (v: unknown) => void;
      mockGatewayClient.request.mockReturnValueOnce(new Promise((r) => { resolveRequest = r; }));
      useTasksStore.setState({ tasks: [RC_TASK_LIST_RESPONSE.items[0]] });

      const promise = useTasksStore.getState().completeTask('task-001-uuid-placeholder');

      // Check optimistic state before RPC resolves
      const task = useTasksStore.getState().tasks[0];
      expect(task.status).toBe('done');
      expect(task.completed_at).toBeTruthy(); // should be an ISO string

      resolveRequest(RC_TASK_COMPLETE_RESPONSE);
      await promise;
    });

    it('reverts optimistic update on RPC failure', async () => {
      // Source: tasks.ts:124-127 — calls loadTasks() on error
      mockGatewayClient.request
        .mockRejectedValueOnce(new Error('Invalid status transition'))
        .mockResolvedValueOnce(RC_TASK_LIST_RESPONSE); // reload
      useTasksStore.setState({ tasks: [RC_TASK_LIST_RESPONSE.items[0]] });

      await useTasksStore.getState().completeTask('task-001-uuid-placeholder');

      // loadTasks should be called as fallback
      expect(mockGatewayClient.request).toHaveBeenCalledTimes(2);
    });
  });

  describe('createTask → rc.task.create', () => {
    it('sends task input wrapped in { task: input }', async () => {
      // Source: tasks/rpc.ts:210-230 — rc.task.create({ task: TaskInput })
      mockGatewayClient.request.mockResolvedValueOnce(RC_TASK_CREATE_RESPONSE);

      const input = {
        title: 'Review BERT fine-tuning approaches',
        task_type: 'human' as const,
        priority: 'medium' as const,
        deadline: '2026-03-25T23:59:00.000Z',
      };

      await useTasksStore.getState().createTask(input);

      expect(mockGatewayClient.request).toHaveBeenCalledWith(
        'rc.task.create',
        { task: input },
      );
    });

    it('appends created task to local state', async () => {
      // Source: tasks.ts:148-156 — appends result to tasks array, increments total
      mockGatewayClient.request.mockResolvedValueOnce(RC_TASK_CREATE_RESPONSE);
      useTasksStore.setState({ tasks: [], total: 0 });

      await useTasksStore.getState().createTask({
        title: 'Review BERT fine-tuning approaches',
        task_type: 'human',
      });

      const state = useTasksStore.getState();
      expect(state.tasks).toHaveLength(1);
      expect(state.tasks[0].id).toBe('task-004-new-uuid');
      expect(state.tasks[0].status).toBe('todo');
      expect(state.total).toBe(1);
    });
  });

  describe('updateTask → rc.task.update', () => {
    it('sends correct RPC params with id and patch', async () => {
      // Source: tasks/rpc.ts:234-291 — rc.task.update({ id, patch })
      const updatedTask = {
        ...RC_TASK_LIST_RESPONSE.items[0],
        priority: 'urgent' as const,
        updated_at: '2026-03-14T16:00:00.000Z',
      };
      mockGatewayClient.request.mockResolvedValueOnce(updatedTask);
      useTasksStore.setState({ tasks: [RC_TASK_LIST_RESPONSE.items[0]] });

      await useTasksStore.getState().updateTask('task-001-uuid-placeholder', { priority: 'urgent' });

      expect(mockGatewayClient.request).toHaveBeenCalledWith(
        'rc.task.update',
        { id: 'task-001-uuid-placeholder', patch: { priority: 'urgent' } },
      );
    });

    it('replaces task in local state with server response', async () => {
      // Source: tasks.ts:158-165 — maps updated task into array
      const updatedTask = {
        ...RC_TASK_LIST_RESPONSE.items[0],
        priority: 'urgent' as const,
      };
      mockGatewayClient.request.mockResolvedValueOnce(updatedTask);
      useTasksStore.setState({ tasks: RC_TASK_LIST_RESPONSE.items });

      await useTasksStore.getState().updateTask('task-001-uuid-placeholder', { priority: 'urgent' });

      expect(useTasksStore.getState().tasks[0].priority).toBe('urgent');
      // Other tasks remain unchanged
      expect(useTasksStore.getState().tasks[1].id).toBe('task-002-uuid-placeholder');
    });
  });

  describe('deleteTask → rc.task.delete', () => {
    it('sends correct RPC method and removes from local state', async () => {
      // Source: tasks/rpc.ts:308-316 → returns { ok: true, deleted: true, id }
      mockGatewayClient.request.mockResolvedValueOnce({ ok: true, deleted: true, id: 'task-002-uuid-placeholder' });
      useTasksStore.setState({ tasks: RC_TASK_LIST_RESPONSE.items, total: 3 });

      await useTasksStore.getState().deleteTask('task-002-uuid-placeholder');

      expect(mockGatewayClient.request).toHaveBeenCalledWith(
        'rc.task.delete',
        { id: 'task-002-uuid-placeholder' },
      );
      expect(useTasksStore.getState().tasks).toHaveLength(2);
      expect(useTasksStore.getState().total).toBe(2);
      expect(useTasksStore.getState().tasks.find((t) => t.id === 'task-002-uuid-placeholder')).toBeUndefined();
    });
  });

  describe('reopenTask → rc.task.update', () => {
    it('sends status: todo via rc.task.update', async () => {
      // Source: tasks.ts:130-146 — sends { id, patch: { status: 'todo' } }
      const reopenedTask = { ...RC_TASK_COMPLETE_RESPONSE, status: 'todo' as const, completed_at: null };
      mockGatewayClient.request.mockResolvedValueOnce(reopenedTask);
      useTasksStore.setState({ tasks: [RC_TASK_COMPLETE_RESPONSE] });

      await useTasksStore.getState().reopenTask('task-001-uuid-placeholder');

      expect(mockGatewayClient.request).toHaveBeenCalledWith(
        'rc.task.update',
        { id: 'task-001-uuid-placeholder', patch: { status: 'todo' } },
      );
    });

    it('applies optimistic update (status=todo, completed_at=null)', async () => {
      let resolveRequest!: (v: unknown) => void;
      mockGatewayClient.request.mockReturnValueOnce(new Promise((r) => { resolveRequest = r; }));
      useTasksStore.setState({ tasks: [RC_TASK_COMPLETE_RESPONSE] });

      const promise = useTasksStore.getState().reopenTask('task-001-uuid-placeholder');

      const task = useTasksStore.getState().tasks[0];
      expect(task.status).toBe('todo');
      expect(task.completed_at).toBeNull();

      resolveRequest({ ...RC_TASK_COMPLETE_RESPONSE, status: 'todo', completed_at: null });
      await promise;
    });
  });

  describe('Gateway disconnection handling', () => {
    it('skips loadTasks when gateway is disconnected', async () => {
      mockGatewayClient.isConnected = false;

      await useTasksStore.getState().loadTasks();

      expect(mockGatewayClient.request).not.toHaveBeenCalled();
      expect(useTasksStore.getState().loading).toBe(false);
    });

    it('skips completeTask when gateway is disconnected', async () => {
      mockGatewayClient.isConnected = false;
      useTasksStore.setState({ tasks: [RC_TASK_LIST_RESPONSE.items[0]] });

      await useTasksStore.getState().completeTask('task-001-uuid-placeholder');

      expect(mockGatewayClient.request).not.toHaveBeenCalled();
    });

    it('skips createTask when gateway is disconnected', async () => {
      mockGatewayClient.isConnected = false;

      await useTasksStore.getState().createTask({ title: 'Test', task_type: 'human' });

      expect(mockGatewayClient.request).not.toHaveBeenCalled();
    });
  });

  describe('RPC error handling', () => {
    it('clears loading on RPC error for loadTasks', async () => {
      mockGatewayClient.request.mockRejectedValueOnce(new Error('SERVICE_ERROR'));

      await useTasksStore.getState().loadTasks();

      expect(useTasksStore.getState().loading).toBe(false);
      expect(useTasksStore.getState().tasks).toEqual([]);
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Sessions Store — sessions.* RPC parity
// ══════════════════════════════════════════════════════════════════════════

describe('Sessions store RPC parity (sessions.*)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockGatewayClient.isConnected = true;
    useSessionsStore.setState({
      sessions: [],
      activeSessionKey: 'main',
      loading: false,
    });
  });

  describe('loadSessions → sessions.list', () => {
    it('sends correct RPC method with includeDerivedTitles', async () => {
      // Source: sessions.ts:70-72 — sessions.list({ includeDerivedTitles: true })
      // OpenClaw gateway: src/gateway/protocol/schema/sessions.ts:14
      mockGatewayClient.request.mockResolvedValueOnce(SESSIONS_LIST_RESPONSE);

      await useSessionsStore.getState().loadSessions();

      expect(mockGatewayClient.request).toHaveBeenCalledWith(
        'sessions.list',
        { includeDerivedTitles: true, limit: 1000 },
      );
    });

    it('correctly parses sessions.list response', async () => {
      // Source: OpenClaw session-utils.types.ts:21 — GatewaySessionRow
      // Fields: key, label?, displayName?, derivedTitle?, updatedAt?, sessionId?, kind?
      mockGatewayClient.request.mockResolvedValueOnce(SESSIONS_LIST_RESPONSE);

      await useSessionsStore.getState().loadSessions();

      const state = useSessionsStore.getState();
      expect(state.sessions).toHaveLength(3);
      expect(state.loading).toBe(false);

      // Field-by-field check on first session (main)
      const mainSession = state.sessions[0];
      expect(mainSession.key).toBe('agent:main:main');
      expect(mainSession.displayName).toBe('Main');
      expect(mainSession.derivedTitle).toBe('Research discussion about transformers');
      expect(mainSession.updatedAt).toBe(1710417600000);
      expect(mainSession.sessionId).toBe('sess-main-001');
      expect(mainSession.kind).toBe('agent');

      // Second session (labeled)
      const labeledSession = state.sessions[1];
      expect(labeledSession.key).toBe('agent:main:project-a1b2c3d4');
      expect(labeledSession.label).toBe('Literature Review Sprint');
      expect(labeledSession.displayName).toBe('Literature Review Sprint');
    });

    it('handles empty sessions response by injecting main session', async () => {
      // Even when gateway returns no sessions, the main session is always injected
      mockGatewayClient.request.mockResolvedValueOnce(SESSIONS_LIST_EMPTY_RESPONSE);

      await useSessionsStore.getState().loadSessions();

      expect(useSessionsStore.getState().sessions).toEqual([{ key: 'main' }]);
      expect(useSessionsStore.getState().loading).toBe(false);
    });

    it('handles missing sessions key by injecting main session', async () => {
      // Source: sessions.ts — result.sessions ?? [] + main session guarantee
      mockGatewayClient.request.mockResolvedValueOnce({});

      await useSessionsStore.getState().loadSessions();

      expect(useSessionsStore.getState().sessions).toEqual([{ key: 'main' }]);
    });
  });

  describe('createSession', () => {
    it('generates a project-prefixed key with meaningful label and adds placeholder', async () => {
      // Source: sessions.ts — key = `project-${uuid.slice(0,8)}`, label = "Session N"
      // OpenClaw sessions are implicit — created on first chat.send with a new sessionKey.
      // Label is persisted via sessions.patch so it survives refresh.
      mockGatewayClient.request.mockResolvedValueOnce({});

      const key = await useSessionsStore.getState().createSession();

      expect(key).toMatch(/^project-[a-f0-9]{8}$/);
      expect(useSessionsStore.getState().sessions).toHaveLength(1);
      expect(useSessionsStore.getState().sessions[0].key).toBe(key);
      expect(useSessionsStore.getState().sessions[0].label).toBe('Session 1');
      expect(useSessionsStore.getState().activeSessionKey).toBe(key);

      // Should switch chat store to new session
      expect(mockSetSessionKey).toHaveBeenCalledWith(key);
    });

    it('persists label via sessions.patch RPC', async () => {
      // Label is fire-and-forget persisted to the gateway so it survives refresh
      mockGatewayClient.request.mockResolvedValueOnce({});

      const key = await useSessionsStore.getState().createSession();

      expect(mockGatewayClient.request).toHaveBeenCalledWith('sessions.patch', {
        key,
        label: 'Session 1',
      });
    });
  });

  describe('deleteSession → sessions.delete', () => {
    it('sends correct RPC method and removes from local state', async () => {
      // Source: sessions.ts:107-126 — sessions.delete({ key })
      mockGatewayClient.request.mockResolvedValueOnce(SESSIONS_DELETE_RESPONSE);
      useSessionsStore.setState({
        sessions: SESSIONS_LIST_RESPONSE.sessions,
        activeSessionKey: 'agent:main:project-a1b2c3d4',
      });

      await useSessionsStore.getState().deleteSession('agent:main:project-a1b2c3d4');

      expect(mockGatewayClient.request).toHaveBeenCalledWith(
        'sessions.delete',
        { key: 'agent:main:project-a1b2c3d4', deleteTranscript: true },
      );
      expect(useSessionsStore.getState().sessions).toHaveLength(2);
      expect(useSessionsStore.getState().sessions.find((s) => s.key === 'agent:main:project-a1b2c3d4')).toBeUndefined();
    });

    it('switches to main session when deleting the active session', async () => {
      // Source: sessions.ts:116-125 — if wasActive, set activeSessionKey to MAIN_SESSION_KEY
      mockGatewayClient.request.mockResolvedValueOnce(SESSIONS_DELETE_RESPONSE);
      useSessionsStore.setState({
        sessions: SESSIONS_LIST_RESPONSE.sessions,
        activeSessionKey: 'agent:main:project-a1b2c3d4',
      });

      await useSessionsStore.getState().deleteSession('agent:main:project-a1b2c3d4');

      expect(useSessionsStore.getState().activeSessionKey).toBe('main');
      expect(mockSetSessionKey).toHaveBeenCalledWith('main');
      expect(mockLoadHistory).toHaveBeenCalled();
    });

    it('does NOT switch session when deleting an inactive session', async () => {
      mockGatewayClient.request.mockResolvedValueOnce(SESSIONS_DELETE_RESPONSE);
      useSessionsStore.setState({
        sessions: SESSIONS_LIST_RESPONSE.sessions,
        activeSessionKey: 'agent:main:main',
      });

      await useSessionsStore.getState().deleteSession('agent:main:project-a1b2c3d4');

      expect(useSessionsStore.getState().activeSessionKey).toBe('agent:main:main');
      expect(mockSetSessionKey).not.toHaveBeenCalled();
    });

    it('prevents deletion of main session (bare "main" key)', async () => {
      // Source: sessions.ts:108 — isMain() check
      useSessionsStore.setState({ sessions: SESSIONS_LIST_RESPONSE.sessions });

      await useSessionsStore.getState().deleteSession('main');

      expect(mockGatewayClient.request).not.toHaveBeenCalled();
    });

    it('prevents deletion of main session (canonical "agent:main:main" key)', async () => {
      // Source: sessions.ts:55-58 — isMain() handles both 'main' and 'agent:main:main'
      useSessionsStore.setState({ sessions: SESSIONS_LIST_RESPONSE.sessions });

      await useSessionsStore.getState().deleteSession('agent:main:main');

      expect(mockGatewayClient.request).not.toHaveBeenCalled();
    });

    it('handles RPC error gracefully and still removes from local state', async () => {
      // Source: sessions.ts:112-115 — catch block ignores error, then removes locally
      mockGatewayClient.request.mockRejectedValueOnce(new Error('Session already deleted'));
      useSessionsStore.setState({
        sessions: SESSIONS_LIST_RESPONSE.sessions,
        activeSessionKey: 'agent:main:main',
      });

      await useSessionsStore.getState().deleteSession('agent:main:project-a1b2c3d4');

      // Should still be removed from local state
      expect(useSessionsStore.getState().sessions).toHaveLength(2);
    });
  });

  describe('renameSession → sessions.patch', () => {
    it('sends correct RPC method and updates local state', async () => {
      // Source: sessions.ts:128-142 — sessions.patch({ key, label })
      mockGatewayClient.request.mockResolvedValueOnce(SESSIONS_PATCH_RESPONSE);
      useSessionsStore.setState({ sessions: SESSIONS_LIST_RESPONSE.sessions });

      await useSessionsStore.getState().renameSession('agent:main:project-a1b2c3d4', 'New Name');

      expect(mockGatewayClient.request).toHaveBeenCalledWith(
        'sessions.patch',
        { key: 'agent:main:project-a1b2c3d4', label: 'New Name' },
      );

      const renamed = useSessionsStore.getState().sessions.find((s) => s.key === 'agent:main:project-a1b2c3d4');
      expect(renamed?.label).toBe('New Name');
    });

    it('sends null label when clearing the name', async () => {
      // Source: sessions.ts:132 — label: label || null
      mockGatewayClient.request.mockResolvedValueOnce(SESSIONS_PATCH_RESPONSE);
      useSessionsStore.setState({ sessions: SESSIONS_LIST_RESPONSE.sessions });

      await useSessionsStore.getState().renameSession('agent:main:project-a1b2c3d4', '');

      expect(mockGatewayClient.request).toHaveBeenCalledWith(
        'sessions.patch',
        { key: 'agent:main:project-a1b2c3d4', label: null },
      );
    });
  });

  describe('isMainSession', () => {
    it('recognizes bare "main" key', () => {
      // Source: sessions.ts:55-58
      expect(useSessionsStore.getState().isMainSession('main')).toBe(true);
    });

    it('recognizes canonical "agent:main:main" key', () => {
      expect(useSessionsStore.getState().isMainSession('agent:main:main')).toBe(true);
    });

    it('is case-insensitive', () => {
      expect(useSessionsStore.getState().isMainSession('MAIN')).toBe(true);
      expect(useSessionsStore.getState().isMainSession('Agent:Main:Main')).toBe(true);
    });

    it('rejects non-main keys', () => {
      expect(useSessionsStore.getState().isMainSession('project-abc')).toBe(false);
      expect(useSessionsStore.getState().isMainSession('agent:main:project-abc')).toBe(false);
    });
  });

  describe('switchSession', () => {
    it('updates active session key and notifies chat store', () => {
      useSessionsStore.getState().switchSession('agent:main:project-a1b2c3d4');

      expect(useSessionsStore.getState().activeSessionKey).toBe('agent:main:project-a1b2c3d4');
      expect(mockSetSessionKey).toHaveBeenCalledWith('agent:main:project-a1b2c3d4');
      expect(mockLoadHistory).toHaveBeenCalled();
    });

    it('defaults to main when given empty key', () => {
      // Source: sessions.ts:81 — safeKey = key || MAIN_SESSION_KEY
      useSessionsStore.getState().switchSession('');

      expect(useSessionsStore.getState().activeSessionKey).toBe('main');
    });

    it('is a no-op when switching to the current session', () => {
      // Source: sessions.ts:83 — if (safeKey === prev) return
      useSessionsStore.setState({ activeSessionKey: 'project-x' });
      useSessionsStore.getState().switchSession('project-x');

      expect(mockSetSessionKey).not.toHaveBeenCalled();
      expect(mockLoadHistory).not.toHaveBeenCalled();
    });
  });

  describe('Gateway disconnection handling', () => {
    it('skips loadSessions when gateway is disconnected', async () => {
      mockGatewayClient.isConnected = false;

      await useSessionsStore.getState().loadSessions();

      expect(mockGatewayClient.request).not.toHaveBeenCalled();
    });

    it('skips deleteSession RPC when gateway is disconnected', async () => {
      mockGatewayClient.isConnected = false;
      useSessionsStore.setState({ sessions: SESSIONS_LIST_RESPONSE.sessions });

      await useSessionsStore.getState().deleteSession('agent:main:project-a1b2c3d4');

      expect(mockGatewayClient.request).not.toHaveBeenCalled();
    });

    it('skips renameSession when gateway is disconnected', async () => {
      mockGatewayClient.isConnected = false;

      await useSessionsStore.getState().renameSession('agent:main:project-a1b2c3d4', 'New');

      expect(mockGatewayClient.request).not.toHaveBeenCalled();
    });
  });

  describe('RPC error handling', () => {
    it('clears loading on sessions.list RPC error', async () => {
      mockGatewayClient.request.mockRejectedValueOnce(new Error('Gateway error'));

      await useSessionsStore.getState().loadSessions();

      expect(useSessionsStore.getState().loading).toBe(false);
    });
  });
});

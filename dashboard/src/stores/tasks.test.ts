/**
 * Tasks Store — Unit & RPC Parity Tests
 *
 * Tests the Zustand store behavior including:
 * - RPC call format parity with plugin expectations (rc.task.list, rc.task.get, etc.)
 * - State transitions (loading, error, optimistic updates)
 * - Perspective/filter parameter mapping
 *
 * Reference: extensions/research-claw-core/src/tasks/rpc.ts (RPC handlers)
 * Reference: extensions/research-claw-core/src/tasks/service.ts (Task/TaskWithDetails types)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useTasksStore } from './tasks';
import { useGatewayStore } from './gateway';
import {
  RC_TASK_LIST_RESPONSE,
  RC_TASK_LIST_EMPTY_RESPONSE,
  RC_TASK_GET_RESPONSE,
  RC_TASK_COMPLETE_RESPONSE,
  RC_TASK_CREATE_RESPONSE,
  RC_TASK_DELETE_RESPONSE,
} from '../__fixtures__/gateway-payloads/rpc-responses';

// ── Mock gateway store ──────────────────────────────────────────────────

const mockRequest = vi.fn();

vi.mock('./gateway', () => {
  const gatewayState = {
    client: {
      isConnected: true,
      request: (...args: unknown[]) => mockRequest(...args),
    },
    state: 'connected' as const,
  };

  const useGatewayStore = Object.assign(
    (selector: Function) => selector(gatewayState),
    { getState: () => gatewayState },
  );

  return { useGatewayStore };
});

// ── Helpers ─────────────────────────────────────────────────────────────

function resetStore() {
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
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('TasksStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStore();
  });

  // ── loadTasks RPC parity ────────────────────────────────────────────

  describe('loadTasks — RPC format parity with rc.task.list', () => {
    it('sends rc.task.list with default params (perspective=all, showCompleted=false)', async () => {
      mockRequest.mockResolvedValue(RC_TASK_LIST_EMPTY_RESPONSE);

      await useTasksStore.getState().loadTasks();

      expect(mockRequest).toHaveBeenCalledTimes(1);
      expect(mockRequest).toHaveBeenCalledWith('rc.task.list', {
        sort: 'deadline',
        include_completed: false,
        limit: 50,
        offset: 0,
      });
    });

    it('includes task_type=human when perspective is human', async () => {
      mockRequest.mockResolvedValue(RC_TASK_LIST_EMPTY_RESPONSE);
      useTasksStore.setState({ perspective: 'human' });

      await useTasksStore.getState().loadTasks();

      expect(mockRequest).toHaveBeenCalledWith('rc.task.list', {
        sort: 'deadline',
        include_completed: false,
        limit: 50,
        offset: 0,
        task_type: 'human',
      });
    });

    it('includes task_type=agent when perspective is agent', async () => {
      mockRequest.mockResolvedValue(RC_TASK_LIST_EMPTY_RESPONSE);
      useTasksStore.setState({ perspective: 'agent' });

      await useTasksStore.getState().loadTasks();

      expect(mockRequest).toHaveBeenCalledWith('rc.task.list', {
        sort: 'deadline',
        include_completed: false,
        limit: 50,
        offset: 0,
        task_type: 'agent',
      });
    });

    it('does NOT include task_type when perspective is all', async () => {
      mockRequest.mockResolvedValue(RC_TASK_LIST_EMPTY_RESPONSE);
      useTasksStore.setState({ perspective: 'all' });

      await useTasksStore.getState().loadTasks();

      const callParams = mockRequest.mock.calls[0][1];
      expect(callParams).not.toHaveProperty('task_type');
    });

    it('sends include_completed=true when showCompleted is true', async () => {
      mockRequest.mockResolvedValue(RC_TASK_LIST_EMPTY_RESPONSE);
      useTasksStore.setState({ showCompleted: true });

      await useTasksStore.getState().loadTasks();

      expect(mockRequest).toHaveBeenCalledWith('rc.task.list', {
        sort: 'deadline',
        include_completed: true,
        limit: 50,
        offset: 0,
      });
    });

    it('populates store with response items and total', async () => {
      mockRequest.mockResolvedValue(RC_TASK_LIST_RESPONSE);

      await useTasksStore.getState().loadTasks();

      const state = useTasksStore.getState();
      expect(state.tasks).toHaveLength(3);
      expect(state.total).toBe(3);
      expect(state.loading).toBe(false);
      expect(state.offset).toBe(3);
      expect(state.hasMore).toBe(false); // 3 < 50
      expect(state.tasks[0].title).toBe('Read Vaswani et al. 2017 — Attention Is All You Need');
      expect(state.tasks[0].task_type).toBe('human');
      expect(state.tasks[1].task_type).toBe('agent');
      expect(state.tasks[2].task_type).toBe('mixed');
    });

    it('sets loading=true during request, loading=false after', async () => {
      let resolveRequest: (val: unknown) => void;
      const pending = new Promise((resolve) => { resolveRequest = resolve; });
      mockRequest.mockReturnValue(pending);

      const loadPromise = useTasksStore.getState().loadTasks();
      expect(useTasksStore.getState().loading).toBe(true);

      resolveRequest!(RC_TASK_LIST_EMPTY_RESPONSE);
      await loadPromise;
      expect(useTasksStore.getState().loading).toBe(false);
    });

    it('sets loading=false on RPC error', async () => {
      mockRequest.mockRejectedValue(new Error('connection lost'));

      await useTasksStore.getState().loadTasks();

      expect(useTasksStore.getState().loading).toBe(false);
    });

    it('skips RPC call when gateway is not connected', async () => {
      // Temporarily override gateway state
      const originalGetState = useGatewayStore.getState;
      (useGatewayStore as any).getState = () => ({
        client: { isConnected: false, request: mockRequest },
        state: 'disconnected',
      });

      await useTasksStore.getState().loadTasks();

      expect(mockRequest).not.toHaveBeenCalled();

      // Restore
      (useGatewayStore as any).getState = originalGetState;
    });
  });

  // ── loadTaskDetail RPC parity ───────────────────────────────────────

  describe('loadTaskDetail — RPC format parity with rc.task.get', () => {
    it('sends rc.task.get with { id } param matching plugin expectation', async () => {
      // Plugin rpc.ts:195: const id = requireString(params.id, 'id');
      mockRequest.mockResolvedValue(RC_TASK_GET_RESPONSE);

      const result = await useTasksStore.getState().loadTaskDetail('task-001-uuid-placeholder');

      expect(mockRequest).toHaveBeenCalledTimes(1);
      expect(mockRequest).toHaveBeenCalledWith('rc.task.get', { id: 'task-001-uuid-placeholder' });
    });

    it('returns TaskWithDetails on success', async () => {
      mockRequest.mockResolvedValue(RC_TASK_GET_RESPONSE);

      const result = await useTasksStore.getState().loadTaskDetail('task-001-uuid-placeholder');

      expect(result).not.toBeNull();
      expect(result!.id).toBe('task-001-uuid-placeholder');
      expect(result!.activity_log).toHaveLength(3);
      expect(result!.subtasks).toHaveLength(2);
      expect(result!.activity_log[0].event_type).toBe('status_changed');
      expect(result!.subtasks[0].status).toBe('done');
      expect(result!.subtasks[1].status).toBe('todo');
    });

    it('returns null on RPC error', async () => {
      mockRequest.mockRejectedValue(new Error('Task not found: nonexistent'));

      const result = await useTasksStore.getState().loadTaskDetail('nonexistent');

      expect(result).toBeNull();
    });

    it('returns null when gateway is not connected', async () => {
      const originalGetState = useGatewayStore.getState;
      (useGatewayStore as any).getState = () => ({
        client: { isConnected: false, request: mockRequest },
        state: 'disconnected',
      });

      const result = await useTasksStore.getState().loadTaskDetail('task-001');

      expect(mockRequest).not.toHaveBeenCalled();
      expect(result).toBeNull();

      (useGatewayStore as any).getState = originalGetState;
    });
  });

  // ── completeTask ────────────────────────────────────────────────────

  describe('completeTask — optimistic update + RPC call', () => {
    it('optimistically updates task status to done', async () => {
      useTasksStore.setState({
        tasks: [RC_TASK_LIST_RESPONSE.items[0]], // in_progress task
      });
      mockRequest.mockResolvedValue(RC_TASK_COMPLETE_RESPONSE);

      // Don't await — check optimistic state
      const promise = useTasksStore.getState().completeTask('task-001-uuid-placeholder');

      const optimisticTask = useTasksStore.getState().tasks.find(t => t.id === 'task-001-uuid-placeholder');
      expect(optimisticTask?.status).toBe('done');
      expect(optimisticTask?.completed_at).toBeTruthy();

      await promise;
    });

    it('sends rc.task.complete with { id } matching plugin expectation', async () => {
      useTasksStore.setState({
        tasks: [RC_TASK_LIST_RESPONSE.items[0]],
      });
      mockRequest.mockResolvedValue(RC_TASK_COMPLETE_RESPONSE);

      await useTasksStore.getState().completeTask('task-001-uuid-placeholder');

      expect(mockRequest).toHaveBeenCalledWith('rc.task.complete', { id: 'task-001-uuid-placeholder' });
    });
  });

  // ── reopenTask ──────────────────────────────────────────────────────

  describe('reopenTask — optimistic update + RPC call', () => {
    it('optimistically updates task status to todo and clears completed_at', async () => {
      const doneTask = { ...RC_TASK_COMPLETE_RESPONSE };
      useTasksStore.setState({ tasks: [doneTask] });
      mockRequest.mockResolvedValue({ ...doneTask, status: 'todo', completed_at: null });

      const promise = useTasksStore.getState().reopenTask('task-001-uuid-placeholder');

      const optimisticTask = useTasksStore.getState().tasks.find(t => t.id === 'task-001-uuid-placeholder');
      expect(optimisticTask?.status).toBe('todo');
      expect(optimisticTask?.completed_at).toBeNull();

      await promise;
    });

    it('sends rc.task.update with { id, patch: { status: "todo" } }', async () => {
      const doneTask = { ...RC_TASK_COMPLETE_RESPONSE };
      useTasksStore.setState({ tasks: [doneTask] });
      mockRequest.mockResolvedValue({ ...doneTask, status: 'todo', completed_at: null });

      await useTasksStore.getState().reopenTask('task-001-uuid-placeholder');

      expect(mockRequest).toHaveBeenCalledWith('rc.task.update', {
        id: 'task-001-uuid-placeholder',
        patch: { status: 'todo' },
      });
    });
  });

  // ── createTask ──────────────────────────────────────────────────────

  describe('createTask — RPC format parity with rc.task.create', () => {
    it('sends rc.task.create with { task: input } matching plugin expectation', async () => {
      // Plugin rpc.ts:214: const taskData = requireObject(params.task, 'task');
      mockRequest.mockResolvedValue(RC_TASK_CREATE_RESPONSE);

      const input = {
        title: 'Review BERT fine-tuning approaches',
        task_type: 'human' as const,
        description: 'Survey fine-tuning strategies for BERT on NER tasks.',
        priority: 'medium' as const,
      };

      await useTasksStore.getState().createTask(input);

      expect(mockRequest).toHaveBeenCalledWith('rc.task.create', { task: input });
    });

    it('appends created task to the tasks array', async () => {
      useTasksStore.setState({ tasks: [...RC_TASK_LIST_RESPONSE.items], total: 3 });
      mockRequest.mockResolvedValue(RC_TASK_CREATE_RESPONSE);

      await useTasksStore.getState().createTask({
        title: 'Review BERT fine-tuning approaches',
        task_type: 'human' as const,
      });

      const state = useTasksStore.getState();
      expect(state.tasks).toHaveLength(4);
      expect(state.total).toBe(4);
      expect(state.tasks[3].id).toBe('task-004-new-uuid');
    });
  });

  // ── deleteTask ──────────────────────────────────────────────────────

  describe('deleteTask — RPC format parity with rc.task.delete', () => {
    it('sends rc.task.delete with { id } matching plugin expectation', async () => {
      useTasksStore.setState({ tasks: [...RC_TASK_LIST_RESPONSE.items], total: 3 });
      mockRequest.mockResolvedValue(RC_TASK_DELETE_RESPONSE);

      await useTasksStore.getState().deleteTask('task-002-uuid-placeholder');

      expect(mockRequest).toHaveBeenCalledWith('rc.task.delete', { id: 'task-002-uuid-placeholder' });
    });

    it('removes task from store and decrements total', async () => {
      useTasksStore.setState({ tasks: [...RC_TASK_LIST_RESPONSE.items], total: 3 });
      mockRequest.mockResolvedValue(RC_TASK_DELETE_RESPONSE);

      await useTasksStore.getState().deleteTask('task-002-uuid-placeholder');

      const state = useTasksStore.getState();
      expect(state.tasks).toHaveLength(2);
      expect(state.total).toBe(2);
      expect(state.tasks.find(t => t.id === 'task-002-uuid-placeholder')).toBeUndefined();
    });
  });

  // ── loadMoreTasks ──────────────────────────────────────────────────

  describe('loadMoreTasks — paginated append', () => {
    it('sends rc.task.list with current offset', async () => {
      useTasksStore.setState({
        tasks: RC_TASK_LIST_RESPONSE.items,
        total: 60,
        offset: 3,
        hasMore: true,
        loadingMore: false,
      });
      mockRequest.mockResolvedValue({ items: [RC_TASK_LIST_RESPONSE.items[0]], total: 60 });

      await useTasksStore.getState().loadMoreTasks();

      expect(mockRequest).toHaveBeenCalledWith('rc.task.list', expect.objectContaining({
        limit: 50,
        offset: 3,
      }));
    });

    it('appends items to existing tasks', async () => {
      const existingTasks = [RC_TASK_LIST_RESPONSE.items[0]];
      useTasksStore.setState({
        tasks: existingTasks,
        total: 60,
        offset: 1,
        hasMore: true,
        loadingMore: false,
      });
      const newItems = [RC_TASK_LIST_RESPONSE.items[1], RC_TASK_LIST_RESPONSE.items[2]];
      mockRequest.mockResolvedValue({ items: newItems, total: 60 });

      await useTasksStore.getState().loadMoreTasks();

      const state = useTasksStore.getState();
      expect(state.tasks).toHaveLength(3);
      expect(state.offset).toBe(3);
      expect(state.total).toBe(60);
    });

    it('does nothing when hasMore is false', async () => {
      useTasksStore.setState({ hasMore: false, loadingMore: false });

      await useTasksStore.getState().loadMoreTasks();

      expect(mockRequest).not.toHaveBeenCalled();
    });

    it('does nothing when already loading more', async () => {
      useTasksStore.setState({ hasMore: true, loadingMore: true });

      await useTasksStore.getState().loadMoreTasks();

      expect(mockRequest).not.toHaveBeenCalled();
    });

    it('sets loadingMore=false on error', async () => {
      useTasksStore.setState({ hasMore: true, loadingMore: false, offset: 50 });
      mockRequest.mockRejectedValue(new Error('network error'));

      await useTasksStore.getState().loadMoreTasks();

      expect(useTasksStore.getState().loadingMore).toBe(false);
    });
  });

  // ── setPerspective / toggleCompleted ────────────────────────────────

  describe('setPerspective and toggleCompleted', () => {
    it('setPerspective updates state and resets pagination', () => {
      useTasksStore.setState({ offset: 100, hasMore: true });

      useTasksStore.getState().setPerspective('human');
      expect(useTasksStore.getState().perspective).toBe('human');
      expect(useTasksStore.getState().offset).toBe(0);
      expect(useTasksStore.getState().hasMore).toBe(false);

      useTasksStore.getState().setPerspective('agent');
      expect(useTasksStore.getState().perspective).toBe('agent');

      useTasksStore.getState().setPerspective('all');
      expect(useTasksStore.getState().perspective).toBe('all');
    });

    it('toggleCompleted flips showCompleted and resets pagination', () => {
      useTasksStore.setState({ offset: 100, hasMore: true });
      expect(useTasksStore.getState().showCompleted).toBe(false);

      useTasksStore.getState().toggleCompleted();
      expect(useTasksStore.getState().showCompleted).toBe(true);
      expect(useTasksStore.getState().offset).toBe(0);
      expect(useTasksStore.getState().hasMore).toBe(false);

      useTasksStore.getState().toggleCompleted();
      expect(useTasksStore.getState().showCompleted).toBe(false);
    });
  });

  // ── RPC response shape parity ───────────────────────────────────────

  describe('RPC response shape parity with plugin', () => {
    it('rc.task.list response has { items: Task[], total: number } shape', () => {
      // Verify fixture matches service.ts:449 return type
      expect(RC_TASK_LIST_RESPONSE).toHaveProperty('items');
      expect(RC_TASK_LIST_RESPONSE).toHaveProperty('total');
      expect(Array.isArray(RC_TASK_LIST_RESPONSE.items)).toBe(true);
      expect(typeof RC_TASK_LIST_RESPONSE.total).toBe('number');

      // Every item has all Task fields per service.ts:25-41
      for (const item of RC_TASK_LIST_RESPONSE.items) {
        expect(item).toHaveProperty('id');
        expect(item).toHaveProperty('title');
        expect(item).toHaveProperty('description');
        expect(item).toHaveProperty('task_type');
        expect(item).toHaveProperty('status');
        expect(item).toHaveProperty('priority');
        expect(item).toHaveProperty('deadline');
        expect(item).toHaveProperty('completed_at');
        expect(item).toHaveProperty('created_at');
        expect(item).toHaveProperty('updated_at');
        expect(item).toHaveProperty('parent_task_id');
        expect(item).toHaveProperty('related_paper_id');
        expect(item).toHaveProperty('agent_session_id');
        expect(item).toHaveProperty('tags');
        expect(item).toHaveProperty('notes');
        expect(Array.isArray(item.tags)).toBe(true);
      }
    });

    it('rc.task.get response has { ...Task, activity_log: [], subtasks: [] } shape', () => {
      // Verify fixture matches service.ts:103-106 TaskWithDetails
      expect(RC_TASK_GET_RESPONSE).toHaveProperty('activity_log');
      expect(RC_TASK_GET_RESPONSE).toHaveProperty('subtasks');
      expect(Array.isArray(RC_TASK_GET_RESPONSE.activity_log)).toBe(true);
      expect(Array.isArray(RC_TASK_GET_RESPONSE.subtasks)).toBe(true);

      // Activity log entries match ActivityLogEntry shape (service.ts:70-78)
      for (const entry of RC_TASK_GET_RESPONSE.activity_log) {
        expect(entry).toHaveProperty('id');
        expect(entry).toHaveProperty('task_id');
        expect(entry).toHaveProperty('event_type');
        expect(entry).toHaveProperty('old_value');
        expect(entry).toHaveProperty('new_value');
        expect(entry).toHaveProperty('actor');
        expect(entry).toHaveProperty('created_at');
        expect(['human', 'agent']).toContain(entry.actor);
      }

      // Subtasks are full Task objects
      for (const sub of RC_TASK_GET_RESPONSE.subtasks) {
        expect(sub).toHaveProperty('id');
        expect(sub).toHaveProperty('title');
        expect(sub).toHaveProperty('task_type');
        expect(sub).toHaveProperty('status');
        expect(sub).toHaveProperty('parent_task_id');
        expect(sub.parent_task_id).toBe(RC_TASK_GET_RESPONSE.id);
      }
    });

    it('task_type enum values match plugin VALID_TASK_TYPES', () => {
      // rpc.ts:50 — const VALID_TASK_TYPES: readonly TaskType[] = ['human', 'agent', 'mixed'];
      const taskTypes = RC_TASK_LIST_RESPONSE.items.map(t => t.task_type);
      for (const tt of taskTypes) {
        expect(['human', 'agent', 'mixed']).toContain(tt);
      }
    });

    it('status enum values match plugin VALID_STATUSES', () => {
      // rpc.ts:52 — const VALID_STATUSES: readonly TaskStatus[] = ['todo', 'in_progress', 'blocked', 'done', 'cancelled'];
      const statuses = RC_TASK_LIST_RESPONSE.items.map(t => t.status);
      for (const s of statuses) {
        expect(['todo', 'in_progress', 'blocked', 'done', 'cancelled']).toContain(s);
      }
    });

    it('priority enum values match plugin VALID_PRIORITIES', () => {
      // rpc.ts:51 — const VALID_PRIORITIES: readonly TaskPriority[] = ['urgent', 'high', 'medium', 'low'];
      const priorities = RC_TASK_LIST_RESPONSE.items.map(t => t.priority);
      for (const p of priorities) {
        expect(['urgent', 'high', 'medium', 'low']).toContain(p);
      }
    });
  });
});

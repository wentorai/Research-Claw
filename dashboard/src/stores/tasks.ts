import { create } from 'zustand';
import { useGatewayStore } from './gateway';

// --- Type definitions aligned with 03b §3 ---

export type TaskType = 'human' | 'agent' | 'mixed';
export type TaskStatus = 'todo' | 'in_progress' | 'blocked' | 'done' | 'cancelled';
export type TaskPriority = 'urgent' | 'high' | 'medium' | 'low';

export interface Task {
  id: string;
  title: string;
  description: string | null;
  task_type: TaskType;
  status: TaskStatus;
  priority: TaskPriority;
  deadline: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
  parent_task_id: string | null;
  related_paper_id: string | null;
  related_file_path: string | null;
  agent_session_id: string | null;
  tags: string[];
  notes: string | null;
}

export interface ActivityLogEntry {
  id: string;
  task_id: string;
  event_type: string;
  old_value: string | null;
  new_value: string | null;
  actor: 'human' | 'agent';
  created_at: string;
}

export interface TaskWithDetails extends Task {
  activity_log: ActivityLogEntry[];
  subtasks: Task[];
}

export interface TaskInput {
  title: string;
  description?: string;
  task_type: TaskType;
  priority?: TaskPriority;
  deadline?: string;
  parent_task_id?: string;
  related_paper_id?: string;
  tags?: string[];
  notes?: string;
}

export interface TaskPatch {
  title?: string;
  description?: string | null;
  task_type?: TaskType;
  status?: TaskStatus;
  priority?: TaskPriority;
  deadline?: string | null;
  parent_task_id?: string | null;
  related_paper_id?: string | null;
  agent_session_id?: string | null;
  tags?: string[];
  notes?: string | null;
}

const TASKS_PAGE_SIZE = 50;

interface TasksState {
  tasks: Task[];
  loading: boolean;
  total: number;
  offset: number;
  hasMore: boolean;
  loadingMore: boolean;
  perspective: 'all' | 'human' | 'agent';
  showCompleted: boolean;
  sortBy: 'deadline' | 'priority' | 'created_at';

  loadTasks: () => Promise<void>;
  loadMoreTasks: () => Promise<void>;
  loadTaskDetail: (id: string) => Promise<TaskWithDetails | null>;
  setPerspective: (p: 'all' | 'human' | 'agent') => void;
  toggleCompleted: () => void;
  completeTask: (id: string) => Promise<void>;
  reopenTask: (id: string) => Promise<void>;
  createTask: (input: TaskInput) => Promise<void>;
  updateTask: (id: string, patch: TaskPatch) => Promise<void>;
  deleteTask: (id: string) => Promise<void>;
}

export const useTasksStore = create<TasksState>()((set, get) => ({
  tasks: [],
  loading: false,
  total: 0,
  offset: 0,
  hasMore: false,
  loadingMore: false,
  perspective: 'all',
  showCompleted: false,
  sortBy: 'deadline',

  loadTasks: async () => {
    const client = useGatewayStore.getState().client;
    if (!client?.isConnected) {
      console.log('[TasksStore] loadTasks skipped: not connected');
      return;
    }
    console.log('[TasksStore] loadTasks → rc.task.list');
    set({ loading: true });
    try {
      const { perspective, showCompleted, sortBy } = get();
      const params: Record<string, unknown> = {
        sort: sortBy,
        include_completed: showCompleted,
        limit: TASKS_PAGE_SIZE,
        offset: 0,
      };
      if (perspective === 'human') params.task_type = 'human';
      if (perspective === 'agent') params.task_type = 'agent';
      const result = await client.request<{ items: Task[]; total: number }>('rc.task.list', params);
      set({
        tasks: result.items,
        total: result.total,
        offset: result.items.length,
        hasMore: result.items.length >= TASKS_PAGE_SIZE,
        loading: false,
      });
    } catch {
      set({ loading: false });
    }
  },

  loadMoreTasks: async () => {
    const client = useGatewayStore.getState().client;
    if (!client?.isConnected) return;
    const { hasMore, loadingMore, offset, perspective, showCompleted, sortBy } = get();
    if (!hasMore || loadingMore) return;
    set({ loadingMore: true });
    try {
      const params: Record<string, unknown> = {
        sort: sortBy,
        include_completed: showCompleted,
        limit: TASKS_PAGE_SIZE,
        offset,
      };
      if (perspective === 'human') params.task_type = 'human';
      if (perspective === 'agent') params.task_type = 'agent';
      const result = await client.request<{ items: Task[]; total: number }>('rc.task.list', params);
      set((s) => ({
        tasks: [...s.tasks, ...result.items],
        total: result.total,
        offset: s.offset + result.items.length,
        hasMore: result.items.length >= TASKS_PAGE_SIZE,
        loadingMore: false,
      }));
    } catch {
      set({ loadingMore: false });
    }
  },

  loadTaskDetail: async (id: string) => {
    const client = useGatewayStore.getState().client;
    if (!client?.isConnected) return null;
    try {
      const result = await client.request<TaskWithDetails>('rc.task.get', { id });
      return result;
    } catch {
      return null;
    }
  },

  setPerspective: (p: 'all' | 'human' | 'agent') => {
    set({ perspective: p, offset: 0, hasMore: false });
  },

  toggleCompleted: () => {
    set((s) => ({ showCompleted: !s.showCompleted, offset: 0, hasMore: false }));
  },

  completeTask: async (id: string) => {
    const client = useGatewayStore.getState().client;
    if (!client?.isConnected) return;
    // Optimistic update
    set((s) => ({
      tasks: s.tasks.map((t) =>
        t.id === id
          ? { ...t, status: 'done' as const, completed_at: new Date().toISOString() }
          : t,
      ),
    }));
    try {
      await client.request<Task>('rc.task.complete', { id });
    } catch {
      // Revert on failure — reload
      get().loadTasks();
    }
  },

  reopenTask: async (id: string) => {
    const client = useGatewayStore.getState().client;
    if (!client?.isConnected) return;
    // Optimistic update
    set((s) => ({
      tasks: s.tasks.map((t) =>
        t.id === id
          ? { ...t, status: 'todo' as const, completed_at: null }
          : t,
      ),
    }));
    try {
      await client.request<Task>('rc.task.update', { id, patch: { status: 'todo' } });
    } catch {
      get().loadTasks();
    }
  },

  createTask: async (input: TaskInput) => {
    const client = useGatewayStore.getState().client;
    if (!client?.isConnected) return;
    const result = await client.request<Task>('rc.task.create', { task: input });
    set((s) => ({
      tasks: [...s.tasks, result],
      total: s.total + 1,
    }));
  },

  updateTask: async (id: string, patch: TaskPatch) => {
    const client = useGatewayStore.getState().client;
    if (!client?.isConnected) return;
    const result = await client.request<Task>('rc.task.update', { id, patch });
    set((s) => ({
      tasks: s.tasks.map((t) => (t.id === id ? result : t)),
    }));
  },

  deleteTask: async (id: string) => {
    const client = useGatewayStore.getState().client;
    if (!client?.isConnected) return;
    await client.request('rc.task.delete', { id });
    set((s) => ({
      tasks: s.tasks.filter((t) => t.id !== id),
      total: s.total - 1,
    }));
  },
}));

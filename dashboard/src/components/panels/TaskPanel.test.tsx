import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import React from 'react';
import TaskPanel from './TaskPanel';
import { useTasksStore } from '../../stores/tasks';
import { useConfigStore } from '../../stores/config';
import type { Task, TaskWithDetails } from '../../stores/tasks';
import { RC_TASK_LIST_RESPONSE, RC_TASK_GET_RESPONSE } from '../../__fixtures__/gateway-payloads/rpc-responses';

// ── Mock i18next ──────────────────────────────────────────────────────────

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (opts && 'count' in opts) return `${key}:${opts.count}`;
      if (opts && 'title' in opts) return `${key}:${opts.title}`;
      if (opts && 'days' in opts) return `${key}:${opts.days}`;
      if (opts && 'defaultValue' in opts) return opts.defaultValue as string;
      return key;
    },
    i18n: { changeLanguage: vi.fn() },
  }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

// ── Mock chat store ──────────────────────────────────────────────────────

const mockSend = vi.fn();
vi.mock('../../stores/chat', () => ({
  useChatStore: (selector: Function) => {
    const state = { send: mockSend, messages: [] };
    return selector(state);
  },
}));

// ── Mock gateway store ──────────────────────────────────────────────────

const mockRequest = vi.fn();

vi.mock('../../stores/gateway', () => {
  const gatewayState = {
    client: {
      isConnected: true,
      request: vi.fn().mockResolvedValue({ items: [], total: 0 }),
    },
    state: 'connected' as const,
  };

  const useGatewayStore = Object.assign(
    (selector: Function) => selector(gatewayState),
    { getState: () => gatewayState },
  );

  return { useGatewayStore };
});

// ── Test Fixtures ────────────────────────────────────────────────────────

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    title: 'Write introduction',
    description: 'Write the introduction section of the paper',
    task_type: 'human',
    status: 'todo',
    priority: 'high',
    deadline: new Date(Date.now() + 86400000 * 5).toISOString(),
    completed_at: null,
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
    parent_task_id: null,
    related_paper_id: null,
    related_file_path: null,
    agent_session_id: null,
    tags: ['writing', 'survey'],
    notes: null,
    ...overrides,
  };
}

function makeTaskWithDetails(overrides: Partial<TaskWithDetails> = {}): TaskWithDetails {
  return {
    ...makeTask(overrides),
    activity_log: [
      {
        id: 'log-1',
        task_id: 'task-1',
        event_type: 'created',
        old_value: null,
        new_value: 'Write introduction',
        actor: 'human',
        created_at: '2025-01-01T00:00:00Z',
      },
      {
        id: 'log-2',
        task_id: 'task-1',
        event_type: 'status_changed',
        old_value: 'todo',
        new_value: 'in_progress',
        actor: 'agent',
        created_at: '2025-01-02T00:00:00Z',
      },
      {
        id: 'log-3',
        task_id: 'task-1',
        event_type: 'note_added',
        old_value: null,
        new_value: 'Started first draft',
        actor: 'agent',
        created_at: '2025-01-03T00:00:00Z',
      },
    ],
    subtasks: [],
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('TaskPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Override loadTasks to be a no-op so the useEffect doesn't wipe state
    const noopLoadTasks = vi.fn().mockResolvedValue(undefined);
    const noopLoadTaskDetail = vi.fn().mockResolvedValue(null);
    useTasksStore.setState({
      tasks: [],
      loading: false,
      total: 0,
      perspective: 'all',
      showCompleted: false,
      sortBy: 'deadline',
      loadTasks: noopLoadTasks,
      loadTaskDetail: noopLoadTaskDetail,
    });
    useConfigStore.setState({ theme: 'dark' });
  });

  // ── Basic rendering ──────────────────────────────────────────────────

  it('renders empty state when no tasks', async () => {
    await act(async () => {
      render(<TaskPanel />);
    });
    expect(screen.getByText('tasks.empty')).toBeTruthy();
  });

  it('shows perspective toggle even when tasks list is empty (Issue #10)', async () => {
    // Bug: switching to "助手任务" with 0 agent tasks hid the Segmented control,
    // preventing the user from switching back without a page refresh.
    useTasksStore.setState({ tasks: [], total: 0, perspective: 'agent' });
    await act(async () => {
      render(<TaskPanel />);
    });
    expect(screen.getByText('tasks.perspective.all')).toBeTruthy();
    expect(screen.getByText('tasks.perspective.human')).toBeTruthy();
    expect(screen.getByText('tasks.perspective.agent')).toBeTruthy();
    expect(screen.getByText('tasks.empty')).toBeTruthy();
  });

  it('renders perspective toggle', () => {
    useTasksStore.setState({
      tasks: [makeTask()],
      total: 1,
    });

    render(<TaskPanel />);
    expect(screen.getByText('tasks.perspective.all')).toBeTruthy();
    expect(screen.getByText('tasks.perspective.human')).toBeTruthy();
    expect(screen.getByText('tasks.perspective.agent')).toBeTruthy();
  });

  it('groups tasks into overdue and upcoming sections', () => {
    const pastDate = new Date(Date.now() - 86400000 * 2).toISOString();
    const futureDate = new Date(Date.now() + 86400000 * 5).toISOString();

    useTasksStore.setState({
      tasks: [
        makeTask({ id: '1', title: 'Overdue task', priority: 'urgent', deadline: pastDate }),
        makeTask({ id: '2', title: 'Upcoming task', status: 'in_progress', priority: 'medium', deadline: futureDate }),
      ],
      total: 2,
    });

    render(<TaskPanel />);
    expect(screen.getByText('tasks.overdue')).toBeTruthy();
    expect(screen.getByText('tasks.upcoming')).toBeTruthy();
    expect(screen.getByText('Overdue task')).toBeTruthy();
    expect(screen.getByText('Upcoming task')).toBeTruthy();
  });

  it('renders completed tasks in collapsible section', () => {
    useTasksStore.setState({
      tasks: [
        makeTask({
          id: '1',
          title: 'Done task',
          status: 'done',
          deadline: null,
          completed_at: '2025-01-05T00:00:00Z',
        }),
      ],
      total: 1,
    });

    render(<TaskPanel />);
    expect(screen.getByText('tasks.completedCount:1')).toBeTruthy();
  });

  // ── GAP-7: Task Type Badge Tests ──────────────────────────────────────

  describe('GAP-7: Task Type Badge', () => {
    it('renders task type icon for human task in All perspective', () => {
      useTasksStore.setState({
        tasks: [makeTask({ id: '1', task_type: 'human' })],
        total: 1,
        perspective: 'all',
      });

      render(<TaskPanel />);
      expect(screen.getByTestId('task-type-icon-human')).toBeTruthy();
    });

    it('renders task type icon for agent task in All perspective', () => {
      useTasksStore.setState({
        tasks: [makeTask({ id: '1', task_type: 'agent' })],
        total: 1,
        perspective: 'all',
      });

      render(<TaskPanel />);
      expect(screen.getByTestId('task-type-icon-agent')).toBeTruthy();
    });

    it('renders task type icon for mixed task in All perspective', () => {
      useTasksStore.setState({
        tasks: [makeTask({ id: '1', task_type: 'mixed' })],
        total: 1,
        perspective: 'all',
      });

      render(<TaskPanel />);
      expect(screen.getByTestId('task-type-icon-mixed')).toBeTruthy();
    });

    it('hides task type icon when perspective is human', () => {
      useTasksStore.setState({
        tasks: [makeTask({ id: '1', task_type: 'human' })],
        total: 1,
        perspective: 'human',
      });

      render(<TaskPanel />);
      expect(screen.queryByTestId('task-type-icon-human')).toBeNull();
    });

    it('hides task type icon when perspective is agent', () => {
      useTasksStore.setState({
        tasks: [makeTask({ id: '1', task_type: 'agent' })],
        total: 1,
        perspective: 'agent',
      });

      render(<TaskPanel />);
      expect(screen.queryByTestId('task-type-icon-agent')).toBeNull();
    });
  });

  // ── GAP-8: In-Place Task Detail Expansion Tests ───────────────────────

  describe('GAP-8: In-Place Task Detail Expansion', () => {
    it('clicking task row does not send chat message', async () => {
      useTasksStore.setState({
        tasks: [makeTask({ id: 'task-1' })],
        total: 1,
      });
      // Mock loadTaskDetail to return details
      const loadTaskDetailMock = vi.fn().mockResolvedValue(makeTaskWithDetails());
      useTasksStore.setState({ loadTaskDetail: loadTaskDetailMock });

      render(<TaskPanel />);

      await act(async () => {
        fireEvent.click(screen.getByTestId('task-row-task-1'));
      });

      expect(mockSend).not.toHaveBeenCalled();
    });

    it('clicking task row expands detail view with loading state', async () => {
      useTasksStore.setState({
        tasks: [makeTask({ id: 'task-1' })],
        total: 1,
      });

      // Make loadTaskDetail slow so we can observe loading state
      let resolveDetail: (val: TaskWithDetails) => void;
      const detailPromise = new Promise<TaskWithDetails>((resolve) => {
        resolveDetail = resolve;
      });
      const loadTaskDetailMock = vi.fn().mockReturnValue(detailPromise);
      useTasksStore.setState({ loadTaskDetail: loadTaskDetailMock });

      render(<TaskPanel />);

      await act(async () => {
        fireEvent.click(screen.getByTestId('task-row-task-1'));
      });

      // Loading state should be visible
      expect(screen.getByTestId('task-detail-loading')).toBeTruthy();

      // Resolve the detail
      await act(async () => {
        resolveDetail!(makeTaskWithDetails());
      });

      // Detail should be visible
      expect(screen.getByTestId('task-detail-expand')).toBeTruthy();
    });

    it('expanded detail shows status, priority, description', async () => {
      const detail = makeTaskWithDetails({
        id: 'task-1',
        status: 'in_progress',
        priority: 'high',
        description: 'Write the introduction section',
      });

      useTasksStore.setState({
        tasks: [makeTask({ id: 'task-1' })],
        total: 1,
      });
      const loadTaskDetailMock = vi.fn().mockResolvedValue(detail);
      useTasksStore.setState({ loadTaskDetail: loadTaskDetailMock });

      render(<TaskPanel />);

      await act(async () => {
        fireEvent.click(screen.getByTestId('task-row-task-1'));
      });

      await waitFor(() => {
        expect(screen.getByTestId('task-detail-expand')).toBeTruthy();
      });

      expect(screen.getByText('tasks.status.in_progress')).toBeTruthy();
      expect(screen.getByText('tasks.priority.high')).toBeTruthy();
      expect(screen.getByText('Write the introduction section')).toBeTruthy();
    });

    it('expanded detail shows activity log entries', async () => {
      const detail = makeTaskWithDetails({ id: 'task-1' });
      useTasksStore.setState({
        tasks: [makeTask({ id: 'task-1' })],
        total: 1,
      });
      const loadTaskDetailMock = vi.fn().mockResolvedValue(detail);
      useTasksStore.setState({ loadTaskDetail: loadTaskDetailMock });

      render(<TaskPanel />);

      await act(async () => {
        fireEvent.click(screen.getByTestId('task-row-task-1'));
      });

      await waitFor(() => {
        expect(screen.getByTestId('task-detail-expand')).toBeTruthy();
      });

      // Activity entries are rendered (event types translated via mock t() which returns defaultValue)
      expect(screen.getByText(/created/)).toBeTruthy();
      expect(screen.getByText(/todo -> in_progress/)).toBeTruthy();
    });

    it('clicking same task again collapses detail', async () => {
      const detail = makeTaskWithDetails({ id: 'task-1' });
      useTasksStore.setState({
        tasks: [makeTask({ id: 'task-1' })],
        total: 1,
      });
      const loadTaskDetailMock = vi.fn().mockResolvedValue(detail);
      useTasksStore.setState({ loadTaskDetail: loadTaskDetailMock });

      render(<TaskPanel />);

      // Expand
      await act(async () => {
        fireEvent.click(screen.getByTestId('task-row-task-1'));
      });

      await waitFor(() => {
        expect(screen.getByTestId('task-detail-expand')).toBeTruthy();
      });

      // Collapse
      await act(async () => {
        fireEvent.click(screen.getByTestId('task-row-task-1'));
      });

      expect(screen.queryByTestId('task-detail-expand')).toBeNull();
    });

    it('clicking different task collapses previous and expands new', async () => {
      const detail1 = makeTaskWithDetails({ id: 'task-1', title: 'Task One' });
      const detail2 = makeTaskWithDetails({
        id: 'task-2',
        title: 'Task Two',
        description: 'Second task description',
      });

      useTasksStore.setState({
        tasks: [
          makeTask({ id: 'task-1', title: 'Task One' }),
          makeTask({ id: 'task-2', title: 'Task Two' }),
        ],
        total: 2,
      });
      const loadTaskDetailMock = vi.fn()
        .mockResolvedValueOnce(detail1)
        .mockResolvedValueOnce(detail2);
      useTasksStore.setState({ loadTaskDetail: loadTaskDetailMock });

      render(<TaskPanel />);

      // Expand first
      await act(async () => {
        fireEvent.click(screen.getByTestId('task-row-task-1'));
      });

      await waitFor(() => {
        expect(screen.getByTestId('task-detail-expand')).toBeTruthy();
      });

      // Expand second
      await act(async () => {
        fireEvent.click(screen.getByTestId('task-row-task-2'));
      });

      await waitFor(() => {
        expect(screen.getByTestId('task-detail-expand')).toBeTruthy();
      });

      // Only one detail should be rendered
      expect(screen.getAllByTestId('task-detail-expand')).toHaveLength(1);
    });

    it('expanded detail shows related paper when linked', async () => {
      const detail = makeTaskWithDetails({
        id: 'task-1',
        related_paper_id: 'paper-abc-123',
    related_file_path: null,
      });
      useTasksStore.setState({
        tasks: [makeTask({ id: 'task-1' })],
        total: 1,
      });
      const loadTaskDetailMock = vi.fn().mockResolvedValue(detail);
      useTasksStore.setState({ loadTaskDetail: loadTaskDetailMock });

      render(<TaskPanel />);

      await act(async () => {
        fireEvent.click(screen.getByTestId('task-row-task-1'));
      });

      await waitFor(() => {
        expect(screen.getByTestId('task-detail-related-paper')).toBeTruthy();
      });

      expect(screen.getByText('paper-abc-123')).toBeTruthy();
    });

    it('expanded detail shows empty notes message when no notes', async () => {
      const detail = makeTaskWithDetails({
        id: 'task-1',
        activity_log: [
          {
            id: 'log-1',
            task_id: 'task-1',
            event_type: 'created',
            old_value: null,
            new_value: 'Write introduction',
            actor: 'human',
            created_at: '2025-01-01T00:00:00Z',
          },
        ],
      });
      useTasksStore.setState({
        tasks: [makeTask({ id: 'task-1' })],
        total: 1,
      });
      const loadTaskDetailMock = vi.fn().mockResolvedValue(detail);
      useTasksStore.setState({ loadTaskDetail: loadTaskDetailMock });

      render(<TaskPanel />);

      await act(async () => {
        fireEvent.click(screen.getByTestId('task-row-task-1'));
      });

      await waitFor(() => {
        expect(screen.getByTestId('task-detail-expand')).toBeTruthy();
      });

      // The "no notes" message
      expect(screen.getByText('tasks.detail.noNotes')).toBeTruthy();
    });
  });

  // ── GAP-9: Search Box Tests ───────────────────────────────────────────

  describe('GAP-9: Search Box', () => {
    it('renders search input', () => {
      useTasksStore.setState({
        tasks: [makeTask({ id: '1' })],
        total: 1,
      });

      render(<TaskPanel />);
      expect(screen.getByTestId('task-search-input')).toBeTruthy();
    });

    it('search filters tasks by title (case insensitive)', async () => {
      useTasksStore.setState({
        tasks: [
          makeTask({ id: '1', title: 'Write introduction', description: null }),
          makeTask({ id: '2', title: 'Analyze dataset', description: null }),
        ],
        total: 2,
      });

      await act(async () => {
        render(<TaskPanel />);
      });

      // Both tasks visible initially
      expect(screen.getByText('Write introduction')).toBeTruthy();
      expect(screen.getByText('Analyze dataset')).toBeTruthy();

      const input = screen.getByTestId('task-search-input');

      // Type in the search box and wait for debounce
      fireEvent.change(input, { target: { value: 'WRITE' } });

      await waitFor(
        () => {
          expect(screen.queryByText('Analyze dataset')).toBeNull();
        },
        { timeout: 500 },
      );

      expect(screen.getByText('Write introduction')).toBeTruthy();
    });

    it('search filters tasks by description', async () => {
      useTasksStore.setState({
        tasks: [
          makeTask({ id: '1', title: 'Task A', description: 'Uses transformer models' }),
          makeTask({ id: '2', title: 'Task B', description: 'Statistical analysis' }),
        ],
        total: 2,
      });

      await act(async () => {
        render(<TaskPanel />);
      });

      const input = screen.getByTestId('task-search-input');
      fireEvent.change(input, { target: { value: 'transformer' } });

      await waitFor(
        () => {
          expect(screen.queryByText('Task B')).toBeNull();
        },
        { timeout: 500 },
      );

      expect(screen.getByText('Task A')).toBeTruthy();
    });

    it('clear search shows all tasks', async () => {
      useTasksStore.setState({
        tasks: [
          makeTask({ id: '1', title: 'Task A' }),
          makeTask({ id: '2', title: 'Task B' }),
        ],
        total: 2,
      });

      await act(async () => {
        render(<TaskPanel />);
      });

      const input = screen.getByTestId('task-search-input');

      // Search first
      fireEvent.change(input, { target: { value: 'Task A' } });

      await waitFor(
        () => {
          expect(screen.queryByText('Task B')).toBeNull();
        },
        { timeout: 500 },
      );

      // Clear
      fireEvent.change(input, { target: { value: '' } });

      await waitFor(
        () => {
          expect(screen.getByText('Task B')).toBeTruthy();
        },
        { timeout: 500 },
      );

      expect(screen.getByText('Task A')).toBeTruthy();
    });

    it('shows no results message when search matches nothing', async () => {
      useTasksStore.setState({
        tasks: [makeTask({ id: '1', title: 'Write introduction' })],
        total: 1,
      });

      await act(async () => {
        render(<TaskPanel />);
      });

      const input = screen.getByTestId('task-search-input');
      fireEvent.change(input, { target: { value: 'nonexistent-xyz' } });

      await waitFor(
        () => {
          expect(screen.getByText('tasks.noResults')).toBeTruthy();
        },
        { timeout: 500 },
      );
    });

    it('search preserves perspective filter', async () => {
      // Both tasks have same title pattern but different types
      useTasksStore.setState({
        tasks: [
          makeTask({ id: '1', title: 'Write intro', task_type: 'human' }),
          makeTask({ id: '2', title: 'Write summary', task_type: 'agent' }),
        ],
        total: 2,
        // Perspective filtering happens server-side (via loadTasks RPC param),
        // but the search is client-side. We test that search works on whatever
        // tasks the store returns (which are already perspective-filtered).
        perspective: 'human',
      });

      await act(async () => {
        render(<TaskPanel />);
      });

      const input = screen.getByTestId('task-search-input');
      fireEvent.change(input, { target: { value: 'Write' } });

      await waitFor(
        () => {
          // Both tasks match because perspective filtering is server-side
          // (the store already has the filtered tasks)
          expect(screen.getByText('Write intro')).toBeTruthy();
          expect(screen.getByText('Write summary')).toBeTruthy();
        },
        { timeout: 500 },
      );
    });
  });

  // ── GAP-10: Ask Agent Button Tests ────────────────────────────────────

  describe('GAP-10: Ask Agent Button', () => {
    it('renders Ask Agent button in expanded detail', async () => {
      const detail = makeTaskWithDetails({ id: 'task-1' });
      useTasksStore.setState({
        tasks: [makeTask({ id: 'task-1' })],
        total: 1,
      });
      const loadTaskDetailMock = vi.fn().mockResolvedValue(detail);
      useTasksStore.setState({ loadTaskDetail: loadTaskDetailMock });

      render(<TaskPanel />);

      await act(async () => {
        fireEvent.click(screen.getByTestId('task-row-task-1'));
      });

      await waitFor(() => {
        expect(screen.getByTestId('ask-agent-button')).toBeTruthy();
      });
    });

    it('sends agent prompt for task_type=agent', async () => {
      const detail = makeTaskWithDetails({
        id: 'task-1',
        task_type: 'agent',
        title: 'Scan arXiv',
      });
      useTasksStore.setState({
        tasks: [makeTask({ id: 'task-1', task_type: 'agent', title: 'Scan arXiv' })],
        total: 1,
      });
      const loadTaskDetailMock = vi.fn().mockResolvedValue(detail);
      useTasksStore.setState({ loadTaskDetail: loadTaskDetailMock });

      render(<TaskPanel />);

      await act(async () => {
        fireEvent.click(screen.getByTestId('task-row-task-1'));
      });

      await waitFor(() => {
        expect(screen.getByTestId('ask-agent-button')).toBeTruthy();
      });

      await act(async () => {
        fireEvent.click(screen.getByTestId('ask-agent-button'));
      });

      expect(mockSend).toHaveBeenCalledTimes(1);
      expect(mockSend).toHaveBeenCalledWith('tasks.askAgent.agentPrompt:Scan arXiv');
    });

    it('sends human prompt for task_type=human', async () => {
      const detail = makeTaskWithDetails({
        id: 'task-1',
        task_type: 'human',
        title: 'Write paper',
      });
      useTasksStore.setState({
        tasks: [makeTask({ id: 'task-1', task_type: 'human', title: 'Write paper' })],
        total: 1,
      });
      const loadTaskDetailMock = vi.fn().mockResolvedValue(detail);
      useTasksStore.setState({ loadTaskDetail: loadTaskDetailMock });

      render(<TaskPanel />);

      await act(async () => {
        fireEvent.click(screen.getByTestId('task-row-task-1'));
      });

      await waitFor(() => {
        expect(screen.getByTestId('ask-agent-button')).toBeTruthy();
      });

      await act(async () => {
        fireEvent.click(screen.getByTestId('ask-agent-button'));
      });

      expect(mockSend).toHaveBeenCalledTimes(1);
      expect(mockSend).toHaveBeenCalledWith('tasks.askAgent.humanPrompt:Write paper');
    });

    it('sends mixed prompt for task_type=mixed', async () => {
      const detail = makeTaskWithDetails({
        id: 'task-1',
        task_type: 'mixed',
        title: 'Collaborate on experiment',
      });
      useTasksStore.setState({
        tasks: [makeTask({ id: 'task-1', task_type: 'mixed', title: 'Collaborate on experiment' })],
        total: 1,
      });
      const loadTaskDetailMock = vi.fn().mockResolvedValue(detail);
      useTasksStore.setState({ loadTaskDetail: loadTaskDetailMock });

      render(<TaskPanel />);

      await act(async () => {
        fireEvent.click(screen.getByTestId('task-row-task-1'));
      });

      await waitFor(() => {
        expect(screen.getByTestId('ask-agent-button')).toBeTruthy();
      });

      await act(async () => {
        fireEvent.click(screen.getByTestId('ask-agent-button'));
      });

      expect(mockSend).toHaveBeenCalledTimes(1);
      expect(mockSend).toHaveBeenCalledWith('tasks.askAgent.mixedPrompt:Collaborate on experiment');
    });

    it('collapses detail after asking agent', async () => {
      const detail = makeTaskWithDetails({ id: 'task-1', task_type: 'agent' });
      useTasksStore.setState({
        tasks: [makeTask({ id: 'task-1', task_type: 'agent' })],
        total: 1,
      });
      const loadTaskDetailMock = vi.fn().mockResolvedValue(detail);
      useTasksStore.setState({ loadTaskDetail: loadTaskDetailMock });

      render(<TaskPanel />);

      await act(async () => {
        fireEvent.click(screen.getByTestId('task-row-task-1'));
      });

      await waitFor(() => {
        expect(screen.getByTestId('task-detail-expand')).toBeTruthy();
      });

      await act(async () => {
        fireEvent.click(screen.getByTestId('ask-agent-button'));
      });

      expect(screen.queryByTestId('task-detail-expand')).toBeNull();
    });
  });

  // ── Additional coverage ──────────────────────────────────────────────

  describe('Task sections and sorting', () => {
    it('renders no-deadline tasks in their own section', () => {
      useTasksStore.setState({
        tasks: [
          makeTask({ id: '1', title: 'No deadline task', deadline: null }),
        ],
        total: 1,
      });

      render(<TaskPanel />);
      // "tasks.noDeadline" appears both as section header and in the task row deadline text
      const noDeadlineTexts = screen.getAllByText('tasks.noDeadline');
      expect(noDeadlineTexts.length).toBeGreaterThanOrEqual(2); // section header + task row
      expect(screen.getByText('No deadline task')).toBeTruthy();
    });

    it('sorts no-deadline tasks by priority (urgent first)', () => {
      useTasksStore.setState({
        tasks: [
          makeTask({ id: '1', title: 'Low task', deadline: null, priority: 'low' }),
          makeTask({ id: '2', title: 'Urgent task', deadline: null, priority: 'urgent' }),
          makeTask({ id: '3', title: 'Medium task', deadline: null, priority: 'medium' }),
        ],
        total: 3,
      });

      render(<TaskPanel />);
      const rows = screen.getAllByTestId(/^task-row-/);
      // Urgent should be first
      expect(rows[0].getAttribute('data-testid')).toBe('task-row-2');
      expect(rows[1].getAttribute('data-testid')).toBe('task-row-3');
      expect(rows[2].getAttribute('data-testid')).toBe('task-row-1');
    });

    it('shows "all done" message when only completed tasks exist and no search', () => {
      useTasksStore.setState({
        tasks: [
          makeTask({
            id: '1',
            title: 'Done task',
            status: 'done',
            deadline: null,
            completed_at: '2025-01-05T00:00:00Z',
          }),
        ],
        total: 1,
      });

      render(<TaskPanel />);
      expect(screen.getByText('tasks.allDone')).toBeTruthy();
    });
  });

  describe('Checkbox completion toggle', () => {
    it('calls completeTask when checking an active task', async () => {
      const mockComplete = vi.fn().mockResolvedValue(undefined);
      useTasksStore.setState({
        tasks: [makeTask({ id: 'task-1', status: 'todo' })],
        total: 1,
        completeTask: mockComplete,
      });

      render(<TaskPanel />);

      // The checkbox is inside the task row; click it (not the row itself)
      const checkbox = screen.getByRole('checkbox');
      await act(async () => {
        fireEvent.click(checkbox);
      });

      expect(mockComplete).toHaveBeenCalledWith('task-1');
    });

    it('calls reopenTask when unchecking a done task', async () => {
      const mockReopen = vi.fn().mockResolvedValue(undefined);
      useTasksStore.setState({
        tasks: [makeTask({ id: 'task-1', status: 'done', completed_at: '2025-01-05T00:00:00Z' })],
        total: 1,
        reopenTask: mockReopen,
      });

      render(<TaskPanel />);

      // Done tasks are inside a collapsed Collapse section. Expand it first.
      const collapseHeader = screen.getByRole('button', { name: /tasks.completedCount/ });
      await act(async () => {
        fireEvent.click(collapseHeader);
      });

      // Now the checkbox should be accessible
      await waitFor(() => {
        expect(screen.getByRole('checkbox')).toBeTruthy();
      });

      const checkbox = screen.getByRole('checkbox');
      await act(async () => {
        fireEvent.click(checkbox);
      });

      expect(mockReopen).toHaveBeenCalledWith('task-1');
    });

    it('checkbox click does NOT trigger row expansion', async () => {
      const loadTaskDetailMock = vi.fn().mockResolvedValue(null);
      useTasksStore.setState({
        tasks: [makeTask({ id: 'task-1', status: 'todo' })],
        total: 1,
        loadTaskDetail: loadTaskDetailMock,
        completeTask: vi.fn().mockResolvedValue(undefined),
      });

      render(<TaskPanel />);

      const checkbox = screen.getByRole('checkbox');
      await act(async () => {
        fireEvent.click(checkbox);
      });

      // loadTaskDetail should NOT have been called (checkbox stopPropagation)
      expect(loadTaskDetailMock).not.toHaveBeenCalled();
      expect(screen.queryByTestId('task-detail-expand')).toBeNull();
      expect(screen.queryByTestId('task-detail-loading')).toBeNull();
    });
  });

  describe('GAP-9: Search debounce timing', () => {
    it('does not filter immediately — waits for 300ms debounce', async () => {
      vi.useFakeTimers();

      useTasksStore.setState({
        tasks: [
          makeTask({ id: '1', title: 'Alpha task', description: null }),
          makeTask({ id: '2', title: 'Beta task', description: null }),
        ],
        total: 2,
      });

      await act(async () => {
        render(<TaskPanel />);
      });

      const input = screen.getByTestId('task-search-input');

      // Type search text
      await act(async () => {
        fireEvent.change(input, { target: { value: 'Alpha' } });
      });

      // Before debounce: both tasks should still be visible
      expect(screen.getByText('Alpha task')).toBeTruthy();
      expect(screen.getByText('Beta task')).toBeTruthy();

      // Advance past 300ms debounce
      await act(async () => {
        vi.advanceTimersByTime(350);
      });

      // After debounce: only matching task visible
      expect(screen.getByText('Alpha task')).toBeTruthy();
      expect(screen.queryByText('Beta task')).toBeNull();

      vi.useRealTimers();
    });

    it('debounce resets on subsequent keystrokes within 300ms', async () => {
      vi.useFakeTimers();

      useTasksStore.setState({
        tasks: [
          makeTask({ id: '1', title: 'Alpha task', description: null }),
          makeTask({ id: '2', title: 'Beta task', description: null }),
        ],
        total: 2,
      });

      await act(async () => {
        render(<TaskPanel />);
      });

      const input = screen.getByTestId('task-search-input');

      // First keystroke
      await act(async () => {
        fireEvent.change(input, { target: { value: 'Al' } });
      });

      // Wait only 200ms (before debounce)
      await act(async () => {
        vi.advanceTimersByTime(200);
      });

      // Second keystroke (resets debounce)
      await act(async () => {
        fireEvent.change(input, { target: { value: 'Beta' } });
      });

      // Wait 200ms (400ms total, but only 200ms since last keystroke)
      await act(async () => {
        vi.advanceTimersByTime(200);
      });

      // Still both visible because debounce not yet fired
      expect(screen.getByText('Alpha task')).toBeTruthy();
      expect(screen.getByText('Beta task')).toBeTruthy();

      // Wait remaining 150ms (350ms since last keystroke)
      await act(async () => {
        vi.advanceTimersByTime(150);
      });

      // Now debounce has fired with "Beta"
      expect(screen.queryByText('Alpha task')).toBeNull();
      expect(screen.getByText('Beta task')).toBeTruthy();

      vi.useRealTimers();
    });
  });

  describe('GAP-8: loadTaskDetail error handling in panel', () => {
    it('shows no detail (fallback) when loadTaskDetail throws', async () => {
      useTasksStore.setState({
        tasks: [makeTask({ id: 'task-1' })],
        total: 1,
      });
      const loadTaskDetailMock = vi.fn().mockRejectedValue(new Error('Network error'));
      useTasksStore.setState({ loadTaskDetail: loadTaskDetailMock });

      render(<TaskPanel />);

      await act(async () => {
        fireEvent.click(screen.getByTestId('task-row-task-1'));
      });

      // After error, loading is complete but no detail rendered (null detail returns null from component)
      await waitFor(() => {
        expect(screen.queryByTestId('task-detail-loading')).toBeNull();
      });

      // The detail expand should not be rendered since detail is null
      expect(screen.queryByTestId('task-detail-expand')).toBeNull();
    });
  });

  describe('Fixture-based integration: real rc.task.list data', () => {
    it('renders tasks from fixture payload with correct task types', async () => {
      // Use actual fixture data format
      useTasksStore.setState({
        tasks: RC_TASK_LIST_RESPONSE.items as Task[],
        total: RC_TASK_LIST_RESPONSE.total,
        perspective: 'all',
      });

      await act(async () => {
        render(<TaskPanel />);
      });

      // All three fixture tasks should render
      expect(screen.getByText('Read Vaswani et al. 2017 — Attention Is All You Need')).toBeTruthy();
      expect(screen.getByText('Run arXiv scan for transformer efficiency papers')).toBeTruthy();
      expect(screen.getByText('Write related work section draft')).toBeTruthy();

      // Type icons should show in "all" perspective
      expect(screen.getByTestId('task-type-icon-human')).toBeTruthy();
      expect(screen.getByTestId('task-type-icon-agent')).toBeTruthy();
      expect(screen.getByTestId('task-type-icon-mixed')).toBeTruthy();
    });

    it('renders fixture task with expand showing full rc.task.get detail', async () => {
      useTasksStore.setState({
        tasks: RC_TASK_LIST_RESPONSE.items as Task[],
        total: RC_TASK_LIST_RESPONSE.total,
        perspective: 'all',
      });
      const loadTaskDetailMock = vi.fn().mockResolvedValue(RC_TASK_GET_RESPONSE);
      useTasksStore.setState({ loadTaskDetail: loadTaskDetailMock });

      await act(async () => {
        render(<TaskPanel />);
      });

      // Click the first task to expand
      await act(async () => {
        fireEvent.click(screen.getByTestId('task-row-task-001-uuid-placeholder'));
      });

      await waitFor(() => {
        expect(screen.getByTestId('task-detail-expand')).toBeTruthy();
      });

      // Verify loadTaskDetail was called with the fixture task's ID
      expect(loadTaskDetailMock).toHaveBeenCalledWith('task-001-uuid-placeholder');

      // Verify fixture detail data is rendered
      expect(screen.getByText('tasks.status.in_progress')).toBeTruthy();
      expect(screen.getByText('tasks.priority.high')).toBeTruthy();
      expect(screen.getByText('Read the full paper and write a 2-page summary of key contributions.')).toBeTruthy();

      // Subtasks from fixture
      expect(screen.getByText('Read abstract and introduction')).toBeTruthy();
      expect(screen.getByText('Read methodology section')).toBeTruthy();
    });
  });

  describe('GAP-7: type icon rendering for all task_types with fixture data', () => {
    it('maps human -> UserOutlined, agent -> RobotOutlined, mixed -> TeamOutlined', () => {
      // The TASK_TYPE_ICONS map in TaskPanel.tsx maps:
      // human -> UserOutlined, agent -> RobotOutlined, mixed -> TeamOutlined
      // This verifies each fixture task_type renders its correct icon testid
      useTasksStore.setState({
        tasks: RC_TASK_LIST_RESPONSE.items as Task[],
        total: 3,
        perspective: 'all',
      });

      render(<TaskPanel />);

      // task-001 is human, task-002 is agent, task-003 is mixed
      expect(screen.getByTestId('task-type-icon-human')).toBeTruthy();
      expect(screen.getByTestId('task-type-icon-agent')).toBeTruthy();
      expect(screen.getByTestId('task-type-icon-mixed')).toBeTruthy();
    });
  });
});

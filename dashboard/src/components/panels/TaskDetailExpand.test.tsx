import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import TaskDetailExpand from './TaskDetailExpand';
import { getThemeTokens } from '../../styles/theme';
import type { TaskWithDetails, ActivityLogEntry } from '../../stores/tasks';
import { RC_TASK_GET_RESPONSE } from '../../__fixtures__/gateway-payloads/rpc-responses';

// ── Mock i18next ──────────────────────────────────────────────────────────

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (opts && 'days' in opts) return `${key}:${opts.days}`;
      if (opts && 'defaultValue' in opts) return opts.defaultValue as string;
      return key;
    },
    i18n: { changeLanguage: vi.fn() },
  }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

// ── Test Helpers ────────────────────────────────────────────────────────

const tokens = getThemeTokens('dark');

function makeDetail(overrides: Partial<TaskWithDetails> = {}): TaskWithDetails {
  return {
    id: 'task-1',
    title: 'Write introduction',
    description: 'Write the introduction section of the paper',
    task_type: 'human',
    status: 'in_progress',
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

describe('TaskDetailExpand', () => {
  const mockOnClose = vi.fn();
  const mockOnAskAgent = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders loading state', () => {
    render(
      <TaskDetailExpand
        detail={null}
        loading={true}
        tokens={tokens}
        onClose={mockOnClose}
        onAskAgent={mockOnAskAgent}
      />,
    );

    expect(screen.getByTestId('task-detail-loading')).toBeTruthy();
    expect(screen.getByText('tasks.detail.loading')).toBeTruthy();
  });

  it('renders nothing when not loading and no detail', () => {
    const { container } = render(
      <TaskDetailExpand
        detail={null}
        loading={false}
        tokens={tokens}
        onClose={mockOnClose}
        onAskAgent={mockOnAskAgent}
      />,
    );

    expect(container.innerHTML).toBe('');
  });

  it('renders status and priority badges', () => {
    render(
      <TaskDetailExpand
        detail={makeDetail({ status: 'in_progress', priority: 'high' })}
        loading={false}
        tokens={tokens}
        onClose={mockOnClose}
        onAskAgent={mockOnAskAgent}
      />,
    );

    expect(screen.getByText('tasks.status.in_progress')).toBeTruthy();
    expect(screen.getByText('tasks.priority.high')).toBeTruthy();
  });

  it('renders task type badge', () => {
    render(
      <TaskDetailExpand
        detail={makeDetail({ task_type: 'human' })}
        loading={false}
        tokens={tokens}
        onClose={mockOnClose}
        onAskAgent={mockOnAskAgent}
      />,
    );

    expect(screen.getByText('tasks.taskType.human')).toBeTruthy();
  });

  it('renders description', () => {
    render(
      <TaskDetailExpand
        detail={makeDetail({ description: 'This is the description text' })}
        loading={false}
        tokens={tokens}
        onClose={mockOnClose}
        onAskAgent={mockOnAskAgent}
      />,
    );

    expect(screen.getByText('This is the description text')).toBeTruthy();
  });

  it('renders tags as chips', () => {
    render(
      <TaskDetailExpand
        detail={makeDetail({ tags: ['machine-learning', 'NLP', 'transformers'] })}
        loading={false}
        tokens={tokens}
        onClose={mockOnClose}
        onAskAgent={mockOnAskAgent}
      />,
    );

    expect(screen.getByText('machine-learning')).toBeTruthy();
    expect(screen.getByText('NLP')).toBeTruthy();
    expect(screen.getByText('transformers')).toBeTruthy();
  });

  it('renders related paper when linked', () => {
    render(
      <TaskDetailExpand
        detail={makeDetail({ related_paper_id: 'paper-xyz' })}
        loading={false}
        tokens={tokens}
        onClose={mockOnClose}
        onAskAgent={mockOnAskAgent}
      />,
    );

    expect(screen.getByTestId('task-detail-related-paper')).toBeTruthy();
    expect(screen.getByText('paper-xyz')).toBeTruthy();
  });

  it('does not render related paper section when not linked', () => {
    render(
      <TaskDetailExpand
        detail={makeDetail({ related_paper_id: null })}
        loading={false}
        tokens={tokens}
        onClose={mockOnClose}
        onAskAgent={mockOnAskAgent}
      />,
    );

    expect(screen.queryByTestId('task-detail-related-paper')).toBeNull();
  });

  it('renders related file when linked', () => {
    render(
      <TaskDetailExpand
        detail={makeDetail({ related_file_path: 'outputs/drafts/chapter-3.md' })}
        loading={false}
        tokens={tokens}
        onClose={mockOnClose}
        onAskAgent={mockOnAskAgent}
      />,
    );

    expect(screen.getByTestId('task-detail-related-file')).toBeTruthy();
    expect(screen.getByText('outputs/drafts/chapter-3.md')).toBeTruthy();
  });

  it('does not render related file section when not linked', () => {
    render(
      <TaskDetailExpand
        detail={makeDetail({ related_file_path: null })}
        loading={false}
        tokens={tokens}
        onClose={mockOnClose}
        onAskAgent={mockOnAskAgent}
      />,
    );

    expect(screen.queryByTestId('task-detail-related-file')).toBeNull();
  });

  it('renders subtasks when present', () => {
    const subtasks = [
      {
        id: 'sub-1',
        title: 'Read chapter 3',
        description: null,
        task_type: 'human' as const,
        status: 'todo' as const,
        priority: 'medium' as const,
        deadline: null,
        completed_at: null,
        created_at: '2025-01-01T00:00:00Z',
        updated_at: '2025-01-01T00:00:00Z',
        parent_task_id: 'task-1',
        related_paper_id: null,
    related_file_path: null,
        agent_session_id: null,
        tags: [],
        notes: null,
      },
      {
        id: 'sub-2',
        title: 'Read chapter 4',
        description: null,
        task_type: 'human' as const,
        status: 'done' as const,
        priority: 'medium' as const,
        deadline: null,
        completed_at: '2025-01-05T00:00:00Z',
        created_at: '2025-01-01T00:00:00Z',
        updated_at: '2025-01-05T00:00:00Z',
        parent_task_id: 'task-1',
        related_paper_id: null,
    related_file_path: null,
        agent_session_id: null,
        tags: [],
        notes: null,
      },
    ];

    render(
      <TaskDetailExpand
        detail={makeDetail({ subtasks })}
        loading={false}
        tokens={tokens}
        onClose={mockOnClose}
        onAskAgent={mockOnAskAgent}
      />,
    );

    expect(screen.getByText('Read chapter 3')).toBeTruthy();
    expect(screen.getByText('Read chapter 4')).toBeTruthy();
  });

  it('renders notes from activity log', () => {
    render(
      <TaskDetailExpand
        detail={makeDetail()}
        loading={false}
        tokens={tokens}
        onClose={mockOnClose}
        onAskAgent={mockOnAskAgent}
      />,
    );

    // The note "Started first draft" should appear in the notes section
    expect(screen.getByText('Started first draft')).toBeTruthy();
  });

  it('renders "no notes" when no note_added entries', () => {
    const detail = makeDetail({
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

    render(
      <TaskDetailExpand
        detail={detail}
        loading={false}
        tokens={tokens}
        onClose={mockOnClose}
        onAskAgent={mockOnAskAgent}
      />,
    );

    expect(screen.getByText('tasks.detail.noNotes')).toBeTruthy();
  });

  it('renders recent activity entries', () => {
    render(
      <TaskDetailExpand
        detail={makeDetail()}
        loading={false}
        tokens={tokens}
        onClose={mockOnClose}
        onAskAgent={mockOnAskAgent}
      />,
    );

    // Activity section header
    expect(screen.getByText('tasks.detail.activityLog')).toBeTruthy();
    // Event types rendered — the mock t() returns opts.defaultValue which is the raw event_type string
    expect(screen.getByText(/created/)).toBeTruthy();
  });

  it('renders Ask Agent button', () => {
    render(
      <TaskDetailExpand
        detail={makeDetail()}
        loading={false}
        tokens={tokens}
        onClose={mockOnClose}
        onAskAgent={mockOnAskAgent}
      />,
    );

    expect(screen.getByTestId('ask-agent-button')).toBeTruthy();
    expect(screen.getByText('tasks.detail.askAgent')).toBeTruthy();
  });

  it('calls onAskAgent when Ask Agent button clicked', () => {
    const detail = makeDetail();
    render(
      <TaskDetailExpand
        detail={detail}
        loading={false}
        tokens={tokens}
        onClose={mockOnClose}
        onAskAgent={mockOnAskAgent}
      />,
    );

    fireEvent.click(screen.getByTestId('ask-agent-button'));
    expect(mockOnAskAgent).toHaveBeenCalledTimes(1);
    expect(mockOnAskAgent).toHaveBeenCalledWith(detail);
  });

  it('calls onClose when collapse button clicked', () => {
    render(
      <TaskDetailExpand
        detail={makeDetail()}
        loading={false}
        tokens={tokens}
        onClose={mockOnClose}
        onAskAgent={mockOnAskAgent}
      />,
    );

    fireEvent.click(screen.getByText('tasks.detail.collapse'));
    expect(mockOnClose).toHaveBeenCalledTimes(1);
  });

  it('renders deadline with overdue coloring for past deadlines', () => {
    const pastDeadline = new Date(Date.now() - 86400000 * 3).toISOString();
    render(
      <TaskDetailExpand
        detail={makeDetail({ deadline: pastDeadline })}
        loading={false}
        tokens={tokens}
        onClose={mockOnClose}
        onAskAgent={mockOnAskAgent}
      />,
    );

    // The deadline info text should contain the overdue suffix
    expect(screen.getByText(/tasks.detail.daysOverdue/)).toBeTruthy();
  });

  it('renders deadline with warning coloring for upcoming deadlines within 3 days', () => {
    const soonDeadline = new Date(Date.now() + 86400000 * 1).toISOString();
    render(
      <TaskDetailExpand
        detail={makeDetail({ deadline: soonDeadline })}
        loading={false}
        tokens={tokens}
        onClose={mockOnClose}
        onAskAgent={mockOnAskAgent}
      />,
    );

    // Should contain "days remaining" text
    expect(screen.getByText(/tasks.detail.daysRemaining/)).toBeTruthy();
  });

  // ── Additional coverage: missing field handling ────────────────────

  it('renders "no notes" fallback for description when description is null', () => {
    render(
      <TaskDetailExpand
        detail={makeDetail({ description: null })}
        loading={false}
        tokens={tokens}
        onClose={mockOnClose}
        onAskAgent={mockOnAskAgent}
      />,
    );

    // description field uses: detail.description || t('tasks.detail.noNotes')
    // When description is null, the description section shows the noNotes key
    const descriptionSection = screen.getByText('tasks.detail.description');
    expect(descriptionSection).toBeTruthy();
    // The fallback text appears in the description area (not the notes section)
    const noNotesElements = screen.getAllByText('tasks.detail.noNotes');
    expect(noNotesElements.length).toBeGreaterThanOrEqual(1);
  });

  it('renders "no activity" when activity_log is empty', () => {
    render(
      <TaskDetailExpand
        detail={makeDetail({ activity_log: [] })}
        loading={false}
        tokens={tokens}
        onClose={mockOnClose}
        onAskAgent={mockOnAskAgent}
      />,
    );

    expect(screen.getByText('tasks.detail.noActivity')).toBeTruthy();
  });

  it('does not render tags section when tags is empty array', () => {
    render(
      <TaskDetailExpand
        detail={makeDetail({ tags: [] })}
        loading={false}
        tokens={tokens}
        onClose={mockOnClose}
        onAskAgent={mockOnAskAgent}
      />,
    );

    // Tags header should not be present (tags section conditionally rendered)
    expect(screen.queryByText('tasks.detail.tags')).toBeNull();
  });

  it('renders deadline as "no deadline" when deadline is null', () => {
    render(
      <TaskDetailExpand
        detail={makeDetail({ deadline: null })}
        loading={false}
        tokens={tokens}
        onClose={mockOnClose}
        onAskAgent={mockOnAskAgent}
      />,
    );

    expect(screen.getByText('tasks.noDeadline')).toBeTruthy();
  });

  it('renders correct priority border color for each priority level', () => {
    const priorities = [
      { priority: 'urgent' as const, color: '#EF4444' },
      { priority: 'high' as const, color: '#F59E0B' },
      { priority: 'medium' as const, color: '#3B82F6' },
      { priority: 'low' as const, color: '#6B7280' },
    ];

    for (const { priority, color } of priorities) {
      const { container, unmount } = render(
        <TaskDetailExpand
          detail={makeDetail({ priority })}
          loading={false}
          tokens={tokens}
          onClose={mockOnClose}
          onAskAgent={mockOnAskAgent}
        />,
      );

      const expandDiv = screen.getByTestId('task-detail-expand');
      expect(expandDiv.style.borderLeft).toContain(color);
      unmount();
    }
  });

  it('renders subtask with [x] marker and line-through for done status', () => {
    const subtasks = [
      {
        id: 'sub-done',
        title: 'Completed subtask',
        description: null,
        task_type: 'human' as const,
        status: 'done' as const,
        priority: 'medium' as const,
        deadline: null,
        completed_at: '2025-01-05T00:00:00Z',
        created_at: '2025-01-01T00:00:00Z',
        updated_at: '2025-01-05T00:00:00Z',
        parent_task_id: 'task-1',
        related_paper_id: null,
    related_file_path: null,
        agent_session_id: null,
        tags: [],
        notes: null,
      },
    ];

    render(
      <TaskDetailExpand
        detail={makeDetail({ subtasks })}
        loading={false}
        tokens={tokens}
        onClose={mockOnClose}
        onAskAgent={mockOnAskAgent}
      />,
    );

    expect(screen.getByText('[x]')).toBeTruthy();
    expect(screen.getByText('Completed subtask')).toBeTruthy();
  });

  it('renders subtask with [ ] marker for non-done status', () => {
    const subtasks = [
      {
        id: 'sub-todo',
        title: 'Pending subtask',
        description: null,
        task_type: 'human' as const,
        status: 'todo' as const,
        priority: 'medium' as const,
        deadline: null,
        completed_at: null,
        created_at: '2025-01-01T00:00:00Z',
        updated_at: '2025-01-01T00:00:00Z',
        parent_task_id: 'task-1',
        related_paper_id: null,
    related_file_path: null,
        agent_session_id: null,
        tags: [],
        notes: null,
      },
    ];

    render(
      <TaskDetailExpand
        detail={makeDetail({ subtasks })}
        loading={false}
        tokens={tokens}
        onClose={mockOnClose}
        onAskAgent={mockOnAskAgent}
      />,
    );

    expect(screen.getByText('[ ]')).toBeTruthy();
    expect(screen.getByText('Pending subtask')).toBeTruthy();
  });

  it('does not render subtasks section when subtasks is empty', () => {
    render(
      <TaskDetailExpand
        detail={makeDetail({ subtasks: [] })}
        loading={false}
        tokens={tokens}
        onClose={mockOnClose}
        onAskAgent={mockOnAskAgent}
      />,
    );

    expect(screen.queryByText('tasks.detail.subtasks')).toBeNull();
  });

  it('limits notes to 3 most recent note_added entries', () => {
    const activityLog: ActivityLogEntry[] = [
      { id: 'n1', task_id: 'task-1', event_type: 'note_added', old_value: null, new_value: 'Note A', actor: 'human', created_at: '2025-01-05T00:00:00Z' },
      { id: 'n2', task_id: 'task-1', event_type: 'note_added', old_value: null, new_value: 'Note B', actor: 'agent', created_at: '2025-01-04T00:00:00Z' },
      { id: 'n3', task_id: 'task-1', event_type: 'note_added', old_value: null, new_value: 'Note C', actor: 'human', created_at: '2025-01-03T00:00:00Z' },
      { id: 'n4', task_id: 'task-1', event_type: 'note_added', old_value: null, new_value: 'Note D (hidden)', actor: 'human', created_at: '2025-01-02T00:00:00Z' },
      { id: 'e1', task_id: 'task-1', event_type: 'created', old_value: null, new_value: 'task', actor: 'human', created_at: '2025-01-01T00:00:00Z' },
    ];

    render(
      <TaskDetailExpand
        detail={makeDetail({ activity_log: activityLog })}
        loading={false}
        tokens={tokens}
        onClose={mockOnClose}
        onAskAgent={mockOnAskAgent}
      />,
    );

    expect(screen.getByText('Note A')).toBeTruthy();
    expect(screen.getByText('Note B')).toBeTruthy();
    expect(screen.getByText('Note C')).toBeTruthy();
    expect(screen.queryByText('Note D (hidden)')).toBeNull();
  });

  it('limits activity log to 5 most recent entries', () => {
    const activityLog: ActivityLogEntry[] = Array.from({ length: 7 }, (_, i) => ({
      id: `log-${i}`,
      task_id: 'task-1',
      event_type: `event_${i}`,
      old_value: null,
      new_value: `Activity entry ${i}`,
      actor: 'human' as const,
      created_at: `2025-01-0${7 - i}T00:00:00Z`,
    }));

    render(
      <TaskDetailExpand
        detail={makeDetail({ activity_log: activityLog })}
        loading={false}
        tokens={tokens}
        onClose={mockOnClose}
        onAskAgent={mockOnAskAgent}
      />,
    );

    // First 5 should appear, last 2 should not
    expect(screen.getByText(/Activity entry 0/)).toBeTruthy();
    expect(screen.getByText(/Activity entry 4/)).toBeTruthy();
    expect(screen.queryByText(/Activity entry 5/)).toBeNull();
    expect(screen.queryByText(/Activity entry 6/)).toBeNull();
  });

  it('renders activity entry with old_value -> new_value transition', () => {
    const activityLog: ActivityLogEntry[] = [
      {
        id: 'log-transition',
        task_id: 'task-1',
        event_type: 'status_changed',
        old_value: 'todo',
        new_value: 'in_progress',
        actor: 'human',
        created_at: '2025-01-02T00:00:00Z',
      },
    ];

    render(
      <TaskDetailExpand
        detail={makeDetail({ activity_log: activityLog })}
        loading={false}
        tokens={tokens}
        onClose={mockOnClose}
        onAskAgent={mockOnAskAgent}
      />,
    );

    // Activity entry renders as: "event_type: old_value -> new_value"
    expect(screen.getByText(/todo -> in_progress/)).toBeTruthy();
  });

  it('renders activity entry with only new_value (no old_value)', () => {
    const activityLog: ActivityLogEntry[] = [
      {
        id: 'log-new-only',
        task_id: 'task-1',
        event_type: 'note_added',
        old_value: null,
        new_value: 'Some note text',
        actor: 'agent',
        created_at: '2025-01-02T00:00:00Z',
      },
    ];

    render(
      <TaskDetailExpand
        detail={makeDetail({ activity_log: activityLog })}
        loading={false}
        tokens={tokens}
        onClose={mockOnClose}
        onAskAgent={mockOnAskAgent}
      />,
    );

    // note_added entries appear in both notes section and activity log
    // Activity log entry renders as: "event_type: new_value" (without old_value -> arrow)
    const matches = screen.getAllByText(/Some note text/);
    expect(matches.length).toBeGreaterThanOrEqual(1);
    // Verify the activity log renders the ": new_value" format (not "old -> new")
    expect(screen.getByText(/note_added.*: Some note text/)).toBeTruthy();
  });

  it('renders all task_type badge variants correctly', () => {
    for (const taskType of ['human', 'agent', 'mixed'] as const) {
      const { unmount } = render(
        <TaskDetailExpand
          detail={makeDetail({ task_type: taskType })}
          loading={false}
          tokens={tokens}
          onClose={mockOnClose}
          onAskAgent={mockOnAskAgent}
        />,
      );

      expect(screen.getByText(`tasks.taskType.${taskType}`)).toBeTruthy();
      unmount();
    }
  });

  it('renders all status badge variants correctly', () => {
    for (const status of ['todo', 'in_progress', 'blocked', 'done', 'cancelled'] as const) {
      const { unmount } = render(
        <TaskDetailExpand
          detail={makeDetail({ status })}
          loading={false}
          tokens={tokens}
          onClose={mockOnClose}
          onAskAgent={mockOnAskAgent}
        />,
      );

      expect(screen.getByText(`tasks.status.${status}`)).toBeTruthy();
      unmount();
    }
  });

  it('renders far-future deadline without overdue or warning coloring', () => {
    const farFuture = new Date(Date.now() + 86400000 * 30).toISOString();
    render(
      <TaskDetailExpand
        detail={makeDetail({ deadline: farFuture })}
        loading={false}
        tokens={tokens}
        onClose={mockOnClose}
        onAskAgent={mockOnAskAgent}
      />,
    );

    // Should contain "days remaining" text but NOT overdue
    expect(screen.getByText(/tasks.detail.daysRemaining/)).toBeTruthy();
    expect(screen.queryByText(/tasks.detail.daysOverdue/)).toBeNull();
  });

  // ── Fixture-based parity test ─────────────────────────────────────

  it('renders all fields from real rc.task.get fixture payload', () => {
    // Use the fixture from rpc-responses.ts — this is the shape actually returned by the plugin
    const fixtureDetail = {
      ...RC_TASK_GET_RESPONSE,
    } as unknown as TaskWithDetails;

    render(
      <TaskDetailExpand
        detail={fixtureDetail}
        loading={false}
        tokens={tokens}
        onClose={mockOnClose}
        onAskAgent={mockOnAskAgent}
      />,
    );

    // Status, priority, task_type badges
    expect(screen.getByText('tasks.status.in_progress')).toBeTruthy();
    expect(screen.getByText('tasks.priority.high')).toBeTruthy();
    expect(screen.getByText('tasks.taskType.human')).toBeTruthy();

    // Description from fixture
    expect(screen.getByText('Read the full paper and write a 2-page summary of key contributions.')).toBeTruthy();

    // Tags from fixture
    expect(screen.getByText('reading')).toBeTruthy();
    expect(screen.getByText('literature-review')).toBeTruthy();

    // Related paper from fixture
    expect(screen.getByTestId('task-detail-related-paper')).toBeTruthy();
    expect(screen.getByText('019523a4-7b2c-7e00-8d3f-1a2b3c4d5e6f')).toBeTruthy();

    // Subtasks from fixture
    expect(screen.getByText('Read abstract and introduction')).toBeTruthy();
    expect(screen.getByText('Read methodology section')).toBeTruthy();

    // Notes from activity_log (note_added entries)
    expect(screen.getByText('Started reading section 3 on multi-head attention.')).toBeTruthy();

    // Activity log
    expect(screen.getByText('tasks.detail.activityLog')).toBeTruthy();
  });
});

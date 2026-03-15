import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import TaskCard from './TaskCard';
import type { TaskCard as TaskCardType } from '@/types/cards';

// Mock i18n
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (opts) return `${key}:${JSON.stringify(opts)}`;
      return key;
    },
  }),
}));

// Mock stores
const mockRequest = vi.fn();
const mockSetRightPanelTab = vi.fn();

vi.mock('@/stores/config', () => ({
  useConfigStore: (selector: (s: { theme: string }) => unknown) =>
    selector({ theme: 'dark' }),
}));
vi.mock('@/stores/gateway', () => ({
  useGatewayStore: (selector: (s: { client: { request: typeof mockRequest } | null }) => unknown) =>
    selector({ client: { request: mockRequest } }),
}));
vi.mock('@/stores/ui', () => ({
  useUiStore: (selector: (s: { setRightPanelTab: typeof mockSetRightPanelTab }) => unknown) =>
    selector({ setRightPanelTab: mockSetRightPanelTab }),
}));

const fullTask: TaskCardType = {
  type: 'task_card',
  id: 'task-001',
  title: 'Review transformer paper',
  description: 'Read and annotate the attention paper',
  task_type: 'human',
  status: 'in_progress',
  priority: 'high',
  deadline: new Date(Date.now() + 2 * 86400000).toISOString(),
  related_paper_title: 'Attention Is All You Need',
};

describe('TaskCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders all required fields', () => {
    render(<TaskCard {...fullTask} />);
    expect(screen.getByText('Review transformer paper')).toBeInTheDocument();
    expect(screen.getByText('Read and annotate the attention paper')).toBeInTheDocument();
    expect(screen.getByText('tasks.priority.high:{"defaultValue":"high"}')).toBeInTheDocument();
  });

  it('renders status badge', () => {
    render(<TaskCard {...fullTask} />);
    expect(screen.getByText('tasks.status.in_progress:{"defaultValue":"in progress"}')).toBeInTheDocument();
  });

  it('renders related paper title', () => {
    render(<TaskCard {...fullTask} />);
    expect(screen.getByText('Attention Is All You Need')).toBeInTheDocument();
  });

  it('renders related file path when provided', () => {
    render(<TaskCard {...fullTask} related_file_path="outputs/drafts/review.md" />);
    expect(screen.getByText('outputs/drafts/review.md')).toBeInTheDocument();
  });

  it('does not render related file when not provided', () => {
    render(<TaskCard {...fullTask} />);
    expect(screen.queryByText('card.task.relatedFile')).not.toBeInTheDocument();
  });

  it('handles missing optional fields gracefully', () => {
    const minimal: TaskCardType = {
      type: 'task_card',
      title: 'Minimal task',
      task_type: 'agent',
      status: 'todo',
      priority: 'low',
    };
    render(<TaskCard {...minimal} />);
    expect(screen.getByText('Minimal task')).toBeInTheDocument();
    expect(screen.getByText('card.task.noDl')).toBeInTheDocument();
  });

  it('shows overdue when deadline is past', () => {
    const overdue: TaskCardType = {
      ...fullTask,
      deadline: new Date(Date.now() - 86400000).toISOString(),
    };
    render(<TaskCard {...overdue} />);
    expect(screen.getByText('card.task.overdue')).toBeInTheDocument();
  });

  it('shows "View in Tasks Panel" link that switches panel tab', () => {
    render(<TaskCard {...fullTask} />);
    const viewLink = screen.getByText(/card.task.viewInPanel/);
    fireEvent.click(viewLink);
    expect(mockSetRightPanelTab).toHaveBeenCalledWith('tasks');
  });

  it('shows "Mark Complete" button when id present and status not done', () => {
    render(<TaskCard {...fullTask} />);
    expect(screen.getByText('card.task.markComplete')).toBeInTheDocument();
  });

  it('calls rc.task.complete when Mark Complete is clicked', () => {
    mockRequest.mockResolvedValueOnce({ ok: true });
    render(<TaskCard {...fullTask} />);
    fireEvent.click(screen.getByText('card.task.markComplete'));
    expect(mockRequest).toHaveBeenCalledWith('rc.task.complete', { id: 'task-001' });
  });

  it('hides Mark Complete when status is done', () => {
    render(<TaskCard {...fullTask} status="done" />);
    expect(screen.queryByText('card.task.markComplete')).not.toBeInTheDocument();
  });

  it('hides Mark Complete when no id', () => {
    render(<TaskCard {...fullTask} id={undefined} />);
    expect(screen.queryByText('card.task.markComplete')).not.toBeInTheDocument();
  });

  it('applies strikethrough for cancelled status', () => {
    render(<TaskCard {...fullTask} status="cancelled" />);
    const title = screen.getByText('Review transformer paper');
    const styledParent = title.closest('span[style]');
    expect(styledParent).toHaveStyle({ textDecoration: 'line-through' });
    // Status tag uses i18n key
    expect(screen.getByText('tasks.status.cancelled:{"defaultValue":"cancelled"}')).toBeInTheDocument();
  });
});

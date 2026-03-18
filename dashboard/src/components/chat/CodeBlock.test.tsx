import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import CodeBlock from './CodeBlock';

// Mock i18n
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

// Mock stores
vi.mock('@/stores/config', () => ({
  useConfigStore: (selector: (s: { theme: string }) => unknown) =>
    selector({ theme: 'dark' }),
}));
vi.mock('@/stores/gateway', () => ({
  useGatewayStore: (selector: (s: { client: null }) => unknown) =>
    selector({ client: null }),
}));
vi.mock('@/stores/ui', () => ({
  useUiStore: (selector: (s: { setRightPanelTab: () => void }) => unknown) =>
    selector({ setRightPanelTab: vi.fn() }),
}));

// Mock shiki to avoid async complexity in tests
vi.mock('shiki', () => ({
  createHighlighter: vi.fn().mockResolvedValue({
    codeToHtml: (_code: string) => '<pre><code>highlighted</code></pre>',
    getLoadedLanguages: () => ['python', 'javascript', 'json'],
  }),
}));

// Mock antd message
vi.mock('antd', async () => {
  const actual = await vi.importActual('antd');
  return {
    ...actual,
    message: { success: vi.fn(), error: vi.fn() },
  };
});

describe('CodeBlock', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders a paper_card when language is paper_card and JSON is valid', () => {
    const json = JSON.stringify({
      type: 'paper_card',
      title: 'Test Paper',
      authors: ['Author A'],
    });
    render(<CodeBlock className="language-paper_card">{json + '\n'}</CodeBlock>);
    expect(screen.getByText('Test Paper')).toBeInTheDocument();
  });

  it('renders a task_card when language is task_card', () => {
    const json = JSON.stringify({
      type: 'task_card',
      title: 'My Task',
      task_type: 'human',
      status: 'todo',
      priority: 'medium',
    });
    render(<CodeBlock className="language-task_card">{json + '\n'}</CodeBlock>);
    expect(screen.getByText('My Task')).toBeInTheDocument();
  });

  it('renders a progress_card', () => {
    const json = JSON.stringify({
      type: 'progress_card',
      period: 'today',
      papers_read: 5,
      papers_added: 2,
      tasks_completed: 3,
      tasks_created: 1,
    });
    render(<CodeBlock className="language-progress_card">{json + '\n'}</CodeBlock>);
    expect(screen.getByText('card.progress.title')).toBeInTheDocument();
  });

  it('renders an approval_card', () => {
    const json = JSON.stringify({
      type: 'approval_card',
      action: 'Delete files',
      context: 'Cleanup requested',
      risk_level: 'low',
    });
    render(<CodeBlock className="language-approval_card">{json + '\n'}</CodeBlock>);
    expect(screen.getByText('Delete files')).toBeInTheDocument();
  });

  it('renders a file_card', () => {
    const json = JSON.stringify({
      type: 'file_card',
      name: 'data.csv',
      path: '/data.csv',
    });
    render(<CodeBlock className="language-file_card">{json + '\n'}</CodeBlock>);
    expect(screen.getByText('data.csv')).toBeInTheDocument();
  });

  it('falls back to code block when JSON is malformed for card type', () => {
    render(
      <CodeBlock className="language-paper_card">
        {'{"title": "incomplete JSON\n'}
      </CodeBlock>,
    );
    // Should render as a code block (no card title visible)
    expect(screen.queryByTestId('card-container')).not.toBeInTheDocument();
  });

  it('renders regular code blocks with syntax highlighting placeholder', () => {
    render(
      <CodeBlock className="language-python">
        {'print("hello")\n'}
      </CodeBlock>,
    );
    // Should show code content (before async shiki loads, it shows in pre/code)
    expect(screen.getByText('print("hello")')).toBeInTheDocument();
  });

  it('renders code blocks with no language', () => {
    render(<CodeBlock>{'some plain text\n'}</CodeBlock>);
    expect(screen.getByText('some plain text')).toBeInTheDocument();
  });

  it('renders unknown language as regular code block', () => {
    render(
      <CodeBlock className="language-brainfuck">
        {'+++[>++<-]\n'}
      </CodeBlock>,
    );
    expect(screen.getByText('+++[>++<-]')).toBeInTheDocument();
    expect(screen.queryByTestId('card-container')).not.toBeInTheDocument();
  });

  it('shows copy button for code blocks', () => {
    render(
      <CodeBlock className="language-python">
        {'x = 1\n'}
      </CodeBlock>,
    );
    expect(screen.getByText('code.copy')).toBeInTheDocument();
  });
});

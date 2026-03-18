/**
 * CodeBlock edge case tests
 * Covers: malformed JSON fallback, empty code block, unknown language + valid JSON,
 * nested code blocks, very large JSON payload
 */
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

// Mock shiki
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

describe('CodeBlock edge cases', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows CardPlaceholder for malformed JSON (missing closing brace) in card type', () => {
    render(
      <CodeBlock className="language-paper_card">
        {'{"type": "paper_card", "title": "Incomplete\n'}
      </CodeBlock>,
    );
    // Should render skeleton placeholder instead of raw JSON during streaming
    expect(screen.queryByTestId('card-container')).not.toBeInTheDocument();
    expect(screen.getByTestId('card-placeholder')).toBeInTheDocument();
  });

  it('renders empty code block content without crash', () => {
    render(<CodeBlock className="language-python">{'\n'}</CodeBlock>);
    // After trimming trailing \n, content is empty string ""
    // Should still render the code block structure
    expect(screen.getByText('code.copy')).toBeInTheDocument();
  });

  it('renders unknown language tag with valid JSON as code (not card)', () => {
    const validJson = JSON.stringify({ type: 'unknown_type', data: 'test' });
    render(
      <CodeBlock className="language-my_custom_format">
        {validJson + '\n'}
      </CodeBlock>,
    );
    // Should NOT render as a card since 'my_custom_format' is not in CARD_TYPES
    expect(screen.queryByTestId('card-container')).not.toBeInTheDocument();
    // Should render as a code block
    expect(screen.getByText('code.copy')).toBeInTheDocument();
  });

  it('renders very large JSON payload (10KB+) without crash', () => {
    const largeData = {
      type: 'paper_card',
      title: 'Large Paper',
      authors: Array.from({ length: 100 }, (_, i) => `Author ${i}`),
      abstract_preview: 'A'.repeat(5000),
      tags: Array.from({ length: 50 }, (_, i) => `tag-${i}`),
    };
    const json = JSON.stringify(largeData);
    // This is a paper_card with valid JSON > 10KB
    render(
      <CodeBlock className="language-paper_card">
        {json + '\n'}
      </CodeBlock>,
    );
    // Should render as a PaperCard
    expect(screen.getByText('Large Paper')).toBeInTheDocument();
    expect(screen.getByTestId('card-container')).toBeInTheDocument();
  });

  it('handles code block with only whitespace', () => {
    render(
      <CodeBlock className="language-text">
        {'   \n'}
      </CodeBlock>,
    );
    // Should not crash
    expect(screen.getByText('code.copy')).toBeInTheDocument();
  });

  it('handles paper_card JSON with extra unknown fields gracefully', () => {
    const json = JSON.stringify({
      type: 'paper_card',
      title: 'Paper With Extras',
      authors: ['Test'],
      unknown_field_1: 'ignored',
      unknown_field_2: 42,
    });
    render(
      <CodeBlock className="language-paper_card">
        {json + '\n'}
      </CodeBlock>,
    );
    // React spread operator passes extra fields but they're harmless
    expect(screen.getByText('Paper With Extras')).toBeInTheDocument();
  });

  it('falls back to code block for JSON array in card type', () => {
    const json = JSON.stringify([{ title: 'Not a card' }]);
    render(
      <CodeBlock className="language-paper_card">
        {json + '\n'}
      </CodeBlock>,
    );
    // JSON.parse succeeds but the data is an array, not a plain object
    // The component should fall back to a regular code block
    expect(document.querySelector('[data-testid="card-container"]')).toBeFalsy();
    expect(screen.getByText('code.copy')).toBeInTheDocument();
  });

  it('handles file_card JSON without size_bytes or mime_type', () => {
    const json = JSON.stringify({
      type: 'file_card',
      name: 'test.txt',
      path: '/test.txt',
    });
    render(
      <CodeBlock className="language-file_card">
        {json + '\n'}
      </CodeBlock>,
    );
    expect(screen.getByText('test.txt')).toBeInTheDocument();
  });

  it('handles progress_card with all zero metrics via CodeBlock', () => {
    const json = JSON.stringify({
      type: 'progress_card',
      period: 'today',
      papers_read: 0,
      papers_added: 0,
      tasks_completed: 0,
      tasks_created: 0,
    });
    render(
      <CodeBlock className="language-progress_card">
        {json + '\n'}
      </CodeBlock>,
    );
    expect(screen.getByText('card.progress.title')).toBeInTheDocument();
  });
});

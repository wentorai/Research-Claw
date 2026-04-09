/**
 * PaperCard edge case tests
 * Covers: empty authors, very long title, all optionals missing,
 * invalid read_status, DOI with special chars, empty tags array
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import PaperCard from './PaperCard';
import type { PaperCard as PaperCardType } from '@/types/cards';

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
vi.mock('@/stores/config', () => ({
  useConfigStore: (selector: (s: { theme: string }) => unknown) =>
    selector({ theme: 'dark' }),
}));
vi.mock('@/stores/gateway', () => ({
  useGatewayStore: (selector: (s: { client: { request: typeof mockRequest } | null }) => unknown) =>
    selector({ client: { request: mockRequest } }),
}));
vi.mock('@/stores/library', () => ({
  useLibraryStore: { getState: () => ({ loadPapers: vi.fn(), loadTags: vi.fn() }) },
}));
vi.mock('@/stores/ui', () => ({
  useUiStore: { getState: () => ({ setRightPanelTab: vi.fn() }) },
}));

// Mock antd message
vi.mock('antd', async () => {
  const actual = await vi.importActual('antd');
  return {
    ...actual,
    message: { success: vi.fn(), error: vi.fn() },
  };
});

describe('PaperCard edge cases', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders with empty authors array without crash', () => {
    const paper: PaperCardType = {
      type: 'paper_card',
      title: 'Test Paper',
      authors: [],
    };
    render(<PaperCard {...paper} />);
    expect(screen.getByText('Test Paper')).toBeInTheDocument();
    // authors.join(', ') on empty array produces empty string — should not crash
    // The label renders as "card.paper.authors: " (with colon+space), so use regex
    expect(screen.getByText(/card\.paper\.authors/)).toBeInTheDocument();
  });

  it('handles very long title (200+ chars) without crash', () => {
    const longTitle = 'A'.repeat(250);
    const paper: PaperCardType = {
      type: 'paper_card',
      title: longTitle,
      authors: ['Author A'],
    };
    render(<PaperCard {...paper} />);
    expect(screen.getByText(longTitle)).toBeInTheDocument();
  });

  it('renders with only required fields (title + authors)', () => {
    const minimal: PaperCardType = {
      type: 'paper_card',
      title: 'Minimal Paper',
      authors: ['Single Author'],
    };
    render(<PaperCard {...minimal} />);
    expect(screen.getByText('Minimal Paper')).toBeInTheDocument();
    expect(screen.getByText('Single Author')).toBeInTheDocument();
    // No venue/year section
    expect(screen.queryByText('card.paper.venue')).not.toBeInTheDocument();
    expect(screen.queryByText('card.paper.year')).not.toBeInTheDocument();
    // No DOI
    expect(screen.queryByText('card.paper.doi')).not.toBeInTheDocument();
    // No tags
    expect(screen.queryByText('card.paper.tags')).not.toBeInTheDocument();
    // No abstract — shows noAbstract
    expect(screen.getByText('card.paper.noAbstract')).toBeInTheDocument();
    // No PDF button (no url, no arxiv_id)
    expect(screen.queryByText('card.paper.openPdf')).not.toBeInTheDocument();
  });

  it('handles invalid read_status gracefully (uses fallback color)', () => {
    const paper: PaperCardType = {
      type: 'paper_card',
      title: 'Paper With Invalid Status',
      authors: ['Test'],
      // Force a value not in the union type — simulating bad data from gateway
      read_status: 'nonexistent_status' as PaperCardType['read_status'],
    };
    // Should not throw
    render(<PaperCard {...paper} />);
    expect(screen.getByText('Paper With Invalid Status')).toBeInTheDocument();
    // StatusBadge still renders (uses fallback #71717A)
    expect(screen.getByTestId('status-badge')).toBeInTheDocument();
  });

  it('handles DOI with special characters', () => {
    const paper: PaperCardType = {
      type: 'paper_card',
      title: 'Special DOI Paper',
      authors: ['Author'],
      doi: '10.1000/xyz-abc_123.456(7)',
    };
    render(<PaperCard {...paper} />);
    const doiLink = screen.getByText('10.1000/xyz-abc_123.456(7)');
    expect(doiLink.closest('a')).toHaveAttribute(
      'href',
      'https://doi.org/10.1000/xyz-abc_123.456(7)',
    );
  });

  it('renders with empty tags array (hides tags section)', () => {
    const paper: PaperCardType = {
      type: 'paper_card',
      title: 'No Tags Paper',
      authors: ['Author'],
      tags: [],
    };
    render(<PaperCard {...paper} />);
    expect(screen.queryByText('card.paper.tags')).not.toBeInTheDocument();
  });

  it('disables Add to Library for papers without verifiable identifiers', () => {
    // Papers without doi, arxiv_id, or url should have disabled Add to Library
    // to prevent LLM-hallucinated content from entering the library
    const paper: PaperCardType = {
      type: 'paper_card',
      title: 'No Identifier Paper',
      authors: ['Author'],
    };
    render(<PaperCard {...paper} />);
    const addBtn = screen.getByText('card.paper.addToLibrary');
    expect(addBtn.closest('button')).toBeDisabled();
  });

  it('enables Add to Library when paper has a DOI', () => {
    vi.mocked(mockRequest).mockClear();
    const paper: PaperCardType = {
      type: 'paper_card',
      title: 'With DOI Paper',
      authors: ['Author'],
      doi: '10.1234/test',
    };
    render(<PaperCard {...paper} />);
    const addBtn = screen.getByText('card.paper.addToLibrary');
    expect(addBtn.closest('button')).not.toBeDisabled();
  });

  it('enables Add to Library when paper has arxiv_id only', () => {
    const paper: PaperCardType = {
      type: 'paper_card',
      title: 'ArXiv Paper',
      authors: ['Author'],
      arxiv_id: '2301.00001',
    };
    render(<PaperCard {...paper} />);
    expect(screen.getByText('card.paper.addToLibrary').closest('button')).not.toBeDisabled();
  });

  it('enables Add to Library when paper has url only', () => {
    const paper: PaperCardType = {
      type: 'paper_card',
      title: 'URL Paper',
      authors: ['Author'],
      url: 'https://example.com/paper.pdf',
    };
    render(<PaperCard {...paper} />);
    expect(screen.getByText('card.paper.addToLibrary').closest('button')).not.toBeDisabled();
  });

  it('generates bibtex with special characters in title', () => {
    // This tests the cite button path — bibtex generation with braces etc.
    const paper: PaperCardType = {
      type: 'paper_card',
      title: 'A {Review} of "Methods" & Approaches',
      authors: ['O\'Brien, J.', 'Muller, K.'],
    };
    render(<PaperCard {...paper} />);
    // Just verify it renders without crash and cite button is present
    expect(screen.getByText('card.paper.cite')).toBeInTheDocument();
  });

  it('renders PDF button when only arxiv_id is present (no url)', () => {
    const paper: PaperCardType = {
      type: 'paper_card',
      title: 'ArXiv Paper',
      authors: ['Author'],
      arxiv_id: '2301.12345',
    };
    render(<PaperCard {...paper} />);
    expect(screen.getByText('card.paper.openPdf')).toBeInTheDocument();
  });

  it('renders all four status badge states', () => {
    const statuses: PaperCardType['read_status'][] = ['unread', 'reading', 'read', 'reviewed'];
    for (const status of statuses) {
      const { unmount } = render(
        <PaperCard
          type="paper_card"
          title={`Paper ${status}`}
          authors={['A']}
          read_status={status}
        />,
      );
      expect(screen.getByTestId('status-badge')).toBeInTheDocument();
      unmount();
    }
  });
});

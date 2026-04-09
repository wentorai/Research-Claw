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
const mockSetRightPanelTab = vi.fn();
vi.mock('@/stores/ui', () => ({
  useUiStore: { getState: () => ({ setRightPanelTab: mockSetRightPanelTab }) },
}));

// Mock antd message
vi.mock('antd', async () => {
  const actual = await vi.importActual('antd');
  return {
    ...actual,
    message: { success: vi.fn(), error: vi.fn() },
  };
});

const fullPaper: PaperCardType = {
  type: 'paper_card',
  title: 'Attention Is All You Need',
  authors: ['Vaswani, A.', 'Shazeer, N.'],
  venue: 'NeurIPS',
  year: 2017,
  doi: '10.5555/3295222.3295349',
  url: 'https://arxiv.org/pdf/1706.03762',
  arxiv_id: '1706.03762',
  abstract_preview: 'The dominant sequence transduction models are based on...',
  read_status: 'reading',
  library_id: undefined,
  tags: ['transformer', 'attention'],
};

describe('PaperCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders all required fields', () => {
    render(<PaperCard {...fullPaper} />);
    expect(screen.getByText('Attention Is All You Need')).toBeInTheDocument();
    expect(screen.getByText(/Vaswani, A., Shazeer, N./)).toBeInTheDocument();
    expect(screen.getByText('NeurIPS')).toBeInTheDocument();
    expect(screen.getByText('2017')).toBeInTheDocument();
    expect(screen.getByText('10.5555/3295222.3295349')).toBeInTheDocument();
  });

  it('renders abstract preview', () => {
    render(<PaperCard {...fullPaper} />);
    expect(screen.getByText(/dominant sequence transduction/)).toBeInTheDocument();
  });

  it('renders noAbstract when abstract_preview is missing', () => {
    render(<PaperCard {...fullPaper} abstract_preview={undefined} />);
    expect(screen.getByText('card.paper.noAbstract')).toBeInTheDocument();
  });

  it('renders tags', () => {
    render(<PaperCard {...fullPaper} />);
    expect(screen.getByText('transformer')).toBeInTheDocument();
    expect(screen.getByText('attention')).toBeInTheDocument();
  });

  it('handles missing optional fields gracefully', () => {
    const minimalPaper: PaperCardType = {
      type: 'paper_card',
      title: 'Test Paper',
      authors: ['Author A'],
    };
    render(<PaperCard {...minimalPaper} />);
    expect(screen.getByText('Test Paper')).toBeInTheDocument();
    expect(screen.getByText('Author A')).toBeInTheDocument();
  });

  it('shows status badge', () => {
    render(<PaperCard {...fullPaper} />);
    expect(screen.getByTestId('status-badge')).toBeInTheDocument();
  });

  it('shows "View in Library" when library_id is set', () => {
    render(<PaperCard {...fullPaper} library_id="lib-123" />);
    const btn = screen.getByText('card.paper.viewInLibrary');
    expect(btn).toBeInTheDocument();
    expect(btn.closest('button')).not.toBeDisabled();
  });

  it('opens library panel when "View in Library" is clicked', () => {
    render(<PaperCard {...fullPaper} library_id="lib-123" />);
    fireEvent.click(screen.getByText('card.paper.viewInLibrary'));
    expect(mockSetRightPanelTab).toHaveBeenCalledWith('library');
  });

  it('calls rc.lit.add when Add to Library is clicked', async () => {
    mockRequest.mockResolvedValueOnce({ id: 'new-lib-id' });
    render(<PaperCard {...fullPaper} />);
    const addBtn = screen.getByText('card.paper.addToLibrary');
    fireEvent.click(addBtn);
    expect(mockRequest).toHaveBeenCalledWith('rc.lit.add', expect.objectContaining({
      title: 'Attention Is All You Need',
    }));
  });

  it('renders Open PDF button when url is present', () => {
    render(<PaperCard {...fullPaper} />);
    expect(screen.getByText('card.paper.openPdf')).toBeInTheDocument();
  });

  it('hides Open PDF button when no url and no arxiv_id', () => {
    render(<PaperCard {...fullPaper} url={undefined} arxiv_id={undefined} />);
    expect(screen.queryByText('card.paper.openPdf')).not.toBeInTheDocument();
  });

  it('renders DOI as clickable link', () => {
    render(<PaperCard {...fullPaper} />);
    const doiLink = screen.getByText('10.5555/3295222.3295349');
    expect(doiLink.closest('a')).toHaveAttribute('href', 'https://doi.org/10.5555/3295222.3295349');
  });
});

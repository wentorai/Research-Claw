import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import React from 'react';
import LibraryPanel from './LibraryPanel';
import { useLibraryStore } from '../../stores/library';
import { useConfigStore } from '../../stores/config';
import { useChatStore } from '../../stores/chat';

const sendMock = vi.fn();

// Mock i18next
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (opts && 'count' in opts) return `${key}:${opts.count}`;
      return key;
    },
    i18n: { changeLanguage: vi.fn() },
  }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

vi.mock('../../stores/chat', () => ({
  useChatStore: (selector: (s: { send: typeof sendMock }) => unknown) =>
    selector({ send: sendMock }),
}));

vi.mock('../../stores/ui', () => ({
  useUiStore: (selector: (s: { setRightPanelOpen: () => void }) => unknown) =>
    selector({ setRightPanelOpen: vi.fn() }),
}));

// Mock react-window v2
vi.mock('react-window', () => ({
  List: ({ rowComponent: Row, rowCount, rowProps }: { rowComponent: Function; rowCount: number; rowProps: Record<string, unknown> }) => (
    <div data-testid="virtual-list">
      {Array.from({ length: Math.min(rowCount, 5) }, (_, i) =>
        Row({ index: i, style: {}, ariaAttributes: {}, ...rowProps }),
      )}
    </div>
  ),
}));

describe('LibraryPanel', () => {
  beforeEach(() => {
    sendMock.mockReset();
    // Reset store state
    useLibraryStore.setState({
      papers: [],
      tags: [],
      collections: [],
      loading: false,
      total: 0,
      searchQuery: '',
      activeTab: 'inbox',
      filters: {},
    });
    useConfigStore.setState({ theme: 'dark' });
  });

  it('renders empty state when no papers', () => {
    render(<LibraryPanel />);
    expect(screen.getByText('library.empty')).toBeTruthy();
  });

  it('renders papers when data available', () => {
    useLibraryStore.setState({
      papers: [
        {
          id: '1',
          title: 'Test Paper on Transformers',
          authors: ['Smith, J.', 'Lee, K.'],
          year: 2025,
          tags: ['nlp'],
          read_status: 'unread',
          added_at: '2025-01-01T00:00:00Z',
          updated_at: '2025-01-01T00:00:00Z',
          abstract: null, doi: null, url: null, arxiv_id: null, pdf_path: null,
          source: null, source_id: null, venue: null, rating: null, notes: null,
          bibtex_key: null, metadata: {},
        },
      ],
      total: 1,
    });

    render(<LibraryPanel />);
    expect(screen.getByText('Test Paper on Transformers')).toBeTruthy();
  });

  it('renders sub-tabs without counts when tabCounts is null', () => {
    useLibraryStore.setState({ papers: [], total: 0, tabCounts: null });
    render(<LibraryPanel />);
    expect(screen.getByText('library.inbox')).toBeTruthy();
    expect(screen.getByText('library.archive')).toBeTruthy();
    expect(screen.getByText('library.starred')).toBeTruthy();
  });

  it('renders sub-tabs with counts from tabCounts', () => {
    useLibraryStore.setState({
      papers: [],
      total: 0,
      tabCounts: { inbox: 5, archive: 12, starred: 3 },
    });
    render(<LibraryPanel />);
    expect(screen.getByText('library.inbox (5)')).toBeTruthy();
    expect(screen.getByText('library.archive (12)')).toBeTruthy();
    expect(screen.getByText('library.starred (3)')).toBeTruthy();
  });

  it('renders search input', () => {
    useLibraryStore.setState({
      papers: [
        {
          id: '1',
          title: 'Paper',
          authors: [],
          year: 2025,
          tags: [],
          read_status: 'unread',
          added_at: '2025-01-01T00:00:00Z',
          updated_at: '2025-01-01T00:00:00Z',
          abstract: null, doi: null, url: null, arxiv_id: null, pdf_path: null,
          source: null, source_id: null, venue: null, rating: null, notes: null,
          bibtex_key: null, metadata: {},
        },
      ],
      total: 1,
    });

    render(<LibraryPanel />);
    const searchInput = screen.getByPlaceholderText('library.search');
    expect(searchInput).toBeTruthy();
  });
  // ── intra-view 提问框的 IME 合成守卫 (CJK) ────────────────────────────────
  //
  // 缺陷背景：Modal 里的 `Input.TextArea` 用 antd 的 `onPressEnter` 提交问题。
  // rc-textarea 的 onPressEnter 直接由 keydown 派生,**没有任何合成守卫**（对比
  // antd Input.Search 自带 composedRef）。于是中文用户敲「这篇论文的创新点」
  // 时,用来选定候选词的那一次 Enter 会被当成「提交」：
  //   - 把半成品拼音/未定字符当作问题发给 agent（一次真实的 agent 运行）
  //   - 关掉 Modal 并清空输入,用户来不及挽回
  const PAPER_FIXTURE = {
    id: 'p-ime',
    title: 'Attention Is All You Need',
    authors: ['Vaswani, A.'],
    year: 2017,
    tags: [],
    read_status: 'unread' as const,
    added_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
    abstract: null, doi: null, url: null, arxiv_id: null, pdf_path: null,
    source: null, source_id: null, venue: null, rating: null, notes: null,
    bibtex_key: null, metadata: {},
  };

  /** 打开某篇论文的「针对本文提问」Modal,并输入 question。 */
  function openIntraViewAndType(question: string): HTMLTextAreaElement {
    useLibraryStore.setState({ papers: [PAPER_FIXTURE], total: 1 } as never);
    render(<LibraryPanel />);

    // 论文行右侧的「更多」下拉 → intraView 菜单项
    fireEvent.click(screen.getByText('Attention Is All You Need'));
    const moreBtns = document.querySelectorAll('.ant-dropdown-trigger');
    fireEvent.click(moreBtns[moreBtns.length - 1]);
    fireEvent.click(screen.getByText('library.paperActions.intraView'));

    const textarea = document.querySelector('textarea') as HTMLTextAreaElement;
    expect(textarea).toBeTruthy();
    fireEvent.change(textarea, { target: { value: question } });
    return textarea;
  }

  it('intra-view: 合成期按 Enter 不得把半成品问题发给 agent', () => {
    const textarea = openIntraViewAndType('这篇论文的创新');

    // 候选窗打开时的 Enter = 选定候选词,不是提交
    fireEvent.keyDown(textarea, { key: 'Enter', isComposing: true });

    expect(sendMock).not.toHaveBeenCalled();
    // Modal 未被关闭 —— 输入还在,用户可以继续打字
    expect(document.querySelector('textarea')).toBeTruthy();
  });

  it('intra-view: 合成期的 keyCode=229 形态同样不得提交', () => {
    const textarea = openIntraViewAndType('这篇论文的创新');

    fireEvent.keyDown(textarea, { key: 'Enter', keyCode: 229 });

    expect(sendMock).not.toHaveBeenCalled();
  });

  it('intra-view: 非合成期按 Enter 照常提交（守卫不得误伤主路径）', () => {
    const textarea = openIntraViewAndType('这篇论文的创新点是什么?');

    fireEvent.keyDown(textarea, { key: 'Enter', isComposing: false });

    expect(sendMock).toHaveBeenCalledTimes(1);
    // 发出去的确实是完整问题
    expect(String(sendMock.mock.calls[0][0])).toContain('这篇论文的创新点是什么?');
  });

  it('intra-view: Shift+Enter 仍然是换行,不提交', () => {
    const textarea = openIntraViewAndType('第一行');

    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true, isComposing: false });

    expect(sendMock).not.toHaveBeenCalled();
  });
});

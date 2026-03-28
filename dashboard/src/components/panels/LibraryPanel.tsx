import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MenuProps } from 'antd';
import { Button, Input, Segmented, Select, Spin, Tag, Tooltip, Typography, Dropdown, message } from 'antd';
import {
  BookOutlined,
  CloseCircleOutlined,
  EllipsisOutlined,
  FilePdfOutlined,
  FolderAddOutlined,
  LoadingOutlined,
  SearchOutlined,
  StarFilled,
  StarOutlined,
} from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { List as VirtualList } from 'react-window';
import { useLibraryStore, type Paper, type PaperFilter, type ReadStatus, type LibraryCollection } from '../../stores/library';
import { useGatewayStore } from '../../stores/gateway';
import { useChatStore } from '../../stores/chat';
import { getThemeTokens } from '../../styles/theme';
import { useConfigStore } from '../../stores/config';
import EditTagsModal from './EditTagsModal';

// react-window v2 row component for virtual list
interface VirtualRowProps {
  papers: Paper[];
  tokens: ReturnType<typeof getThemeTokens>;
  onEditTags?: (paper: Paper) => void;
}

function VirtualRow(props: {
  index: number;
  style: React.CSSProperties;
  ariaAttributes: { 'aria-posinset': number; 'aria-setsize': number; role: 'listitem' };
} & VirtualRowProps) {
  const { index, style, ariaAttributes, papers, tokens, onEditTags } = props;
  return (
    <div style={{ ...style, overflow: 'hidden' }} {...ariaAttributes}>
      <PaperListItem paper={papers[index]} tokens={tokens} onEditTags={onEditTags} />
    </div>
  );
}

const { Text } = Typography;

const STATUS_COLORS: Record<ReadStatus, string> = {
  unread: '#71717A',
  reading: '#3B82F6',
  read: '#22C55E',
  reviewed: '#A855F7',
};

function StatusBadge({ status }: { status: ReadStatus }) {
  const { t } = useTranslation();
  const color = STATUS_COLORS[status];
  const isFilled = status === 'read' || status === 'reviewed';
  const isHalf = status === 'reading';

  return (
    <Tooltip title={t(`library.readStatus.${status}`)}>
      <div
        style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          border: `1.5px solid ${color}`,
          backgroundColor: isFilled ? color : isHalf ? `${color}66` : 'transparent',
          flexShrink: 0,
          marginTop: 5,
        }}
      />
    </Tooltip>
  );
}

interface PaperListItemProps {
  paper: Paper;
  tokens: ReturnType<typeof getThemeTokens>;
  onEditTags?: (paper: Paper) => void;
}

function PaperListItem({ paper, tokens, onEditTags }: PaperListItemProps) {
  const { t } = useTranslation();
  const updatePaperStatus = useLibraryStore((s) => s.updatePaperStatus);
  const activeTab = useLibraryStore((s) => s.activeTab);
  const ratePaper = useLibraryStore((s) => s.ratePaper);
  const deletePaper = useLibraryStore((s) => s.deletePaper);
  const collections = useLibraryStore((s) => s.collections);
  const addPaperToCollection = useLibraryStore((s) => s.addPaperToCollection);
  const send = useChatStore((s) => s.send);

  const authorsText = useMemo(() => {
    if (!paper.authors?.length) return '';
    if (paper.authors.length <= 3) return paper.authors.join(', ');
    return `${paper.authors.slice(0, 3).join(', ')}, +${paper.authors.length - 3}`;
  }, [paper.authors]);

  const visibleTags = paper.tags?.slice(0, 3) ?? [];
  const extraTagCount = (paper.tags?.length ?? 0) - 3;

  // Resolve a usable PDF URL: local path → paper URL → arxiv PDF
  const pdfUrl = paper.pdf_path ?? paper.url ?? (paper.arxiv_id ? `https://arxiv.org/pdf/${paper.arxiv_id}` : null);

  const handleCite = async () => {
    const bibtex = `@article{,
  title={${paper.title}},
  author={${paper.authors.join(' and ')}},${paper.venue ? `\n  journal={${paper.venue}},` : ''}${paper.year ? `\n  year={${paper.year}},` : ''}${paper.doi ? `\n  doi={${paper.doi}},` : ''}
}`;
    try {
      await navigator.clipboard.writeText(bibtex);
      message.success(t('card.paper.citationCopied'));
    } catch {
      // Clipboard not available — fallback to chat
      send(`Generate a citation for: ${paper.title} (${paper.year})`);
    }
  };

  const menuItems = [
    {
      key: 'openPdf',
      label: t('library.paperActions.openPdf'),
      icon: <FilePdfOutlined />,
      disabled: !pdfUrl,
      onClick: () => {
        if (pdfUrl) {
          window.open(pdfUrl, '_blank', 'noopener,noreferrer');
        }
      },
    },
    {
      key: 'cite',
      label: t('library.paperActions.cite'),
      onClick: handleCite,
    },
    {
      key: 'remove',
      label: t('library.paperActions.remove'),
      danger: true,
      onClick: () => {
        deletePaper(paper.id);
      },
    },
    {
      key: 'editTags',
      label: t('library.paperActions.editTags'),
      onClick: () => onEditTags?.(paper),
    },
  ];

  const statusCycleOrder: ReadStatus[] = ['unread', 'reading', 'read', 'reviewed'];

  const handleStatusClick = () => {
    const currentIndex = statusCycleOrder.indexOf(paper.read_status);
    const nextStatus = statusCycleOrder[(currentIndex + 1) % statusCycleOrder.length];
    const prevStatus = paper.read_status;
    updatePaperStatus(paper.id, nextStatus);

    // Show undo toast when paper leaves inbox
    if (activeTab === 'inbox' && (nextStatus === 'read' || nextStatus === 'reviewed')) {
      const key = `undo-${paper.id}`;
      message.info({
        key,
        content: (
          <span>
            {t('library.movedToArchive')}{' '}
            <a onClick={() => { updatePaperStatus(paper.id, prevStatus); message.destroy(key); }}>
              {t('library.undo')}
            </a>
          </span>
        ),
        duration: 5,
      });
    }
  };

  const handleStarClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    ratePaper(paper.id, paper.rating ? 0 : 5);
  };

  const collectionMenuItems: MenuProps['items'] = useMemo(() => {
    if (collections.length === 0) {
      return [{ key: '_empty', label: t('library.noCollectionsYet'), disabled: true }];
    }
    return collections.map((c: LibraryCollection) => ({
      key: c.id,
      label: typeof c.paper_count === 'number' ? `${c.name} (${c.paper_count})` : c.name,
    }));
  }, [collections, t]);

  const handleCollectionMenuClick: MenuProps['onClick'] = async ({ key, domEvent }) => {
    domEvent?.stopPropagation();
    if (key === '_empty') return;
    try {
      await addPaperToCollection(paper.id, key);
      const name = collections.find((c) => c.id === key)?.name ?? key;
      message.success(t('library.addedToCollection', { name }));
    } catch {
      message.error(t('library.addToCollectionFailed'));
    }
  };

  return (
    <div
      style={{
        display: 'flex',
        gap: 8,
        padding: '8px 16px',
        cursor: 'pointer',
        borderBottom: `1px solid ${tokens.border.default}`,
      }}
    >
      <div onClick={handleStatusClick} style={{ cursor: 'pointer', paddingTop: 2 }}>
        <StatusBadge status={paper.read_status} />
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        <Text
          style={{
            fontSize: 13,
            fontWeight: 500,
            color: tokens.text.primary,
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
          }}
        >
          {paper.title}
        </Text>

        <div style={{ fontSize: 12, color: tokens.text.secondary, marginTop: 2 }}>
          {authorsText}
          {paper.year ? ` \u00B7 ${paper.year}` : ''}
        </div>

        {paper.venue && (
          <div style={{ fontSize: 12, color: tokens.text.muted, marginTop: 1 }}>
            {paper.venue}
          </div>
        )}

        {visibleTags.length > 0 && (
          <div style={{ marginTop: 4, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {visibleTags.map((tag) => (
              <Tag key={tag} style={{ fontSize: 10, lineHeight: '16px', margin: 0, padding: '0 4px' }}>
                {tag}
              </Tag>
            ))}
            {extraTagCount > 0 && (
              <Tag style={{ fontSize: 10, lineHeight: '16px', margin: 0, padding: '0 4px' }}>
                +{extraTagCount}
              </Tag>
            )}
          </div>
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
        <Button
          type="text"
          size="small"
          onClick={handleStarClick}
          icon={
            paper.rating ? (
              <StarFilled style={{ color: tokens.accent.amber, fontSize: 14 }} />
            ) : (
              <StarOutlined style={{ color: tokens.text.muted, fontSize: 14 }} />
            )
          }
          style={{ padding: 0, width: 24, height: 24 }}
        />
        <Dropdown
          menu={{ items: collectionMenuItems, onClick: handleCollectionMenuClick }}
          trigger={['click']}
          placement="bottomRight"
        >
          <Tooltip title={t('library.addToCollectionTooltip')}>
            <Button
              type="text"
              size="small"
              icon={<FolderAddOutlined style={{ color: tokens.text.muted, fontSize: 14 }} />}
              style={{ padding: 0, width: 24, height: 24 }}
              onClick={(e) => e.stopPropagation()}
            />
          </Tooltip>
        </Dropdown>
        <Dropdown menu={{ items: menuItems }} trigger={['click']} placement="bottomRight">
          <Button
            type="text"
            size="small"
            icon={<EllipsisOutlined style={{ color: tokens.text.muted, fontSize: 14 }} />}
            style={{ padding: 0, width: 24, height: 24 }}
            onClick={(e) => e.stopPropagation()}
          />
        </Dropdown>
      </div>
    </div>
  );
}

export default function LibraryPanel() {
  const { t } = useTranslation();
  const theme = useConfigStore((s) => s.theme);
  const tokens = useMemo(() => getThemeTokens(theme), [theme]);

  const papers = useLibraryStore((s) => s.papers);
  const loading = useLibraryStore((s) => s.loading);
  const loadingMore = useLibraryStore((s) => s.loadingMore);
  const hasMore = useLibraryStore((s) => s.hasMore);
  const total = useLibraryStore((s) => s.total);
  const activeTab = useLibraryStore((s) => s.activeTab);
  const setActiveTab = useLibraryStore((s) => s.setActiveTab);
  const searchQuery = useLibraryStore((s) => s.searchQuery);
  const setSearchQuery = useLibraryStore((s) => s.setSearchQuery);
  const loadPapers = useLibraryStore((s) => s.loadPapers);
  const loadMorePapers = useLibraryStore((s) => s.loadMorePapers);
  const loadTags = useLibraryStore((s) => s.loadTags);
  const loadCollections = useLibraryStore((s) => s.loadCollections);
  const loadStats = useLibraryStore((s) => s.loadStats);
  const tabCounts = useLibraryStore((s) => s.tabCounts);
  const tags = useLibraryStore((s) => s.tags);
  const collections = useLibraryStore((s) => s.collections);
  const filters = useLibraryStore((s) => s.filters);
  const setFilters = useLibraryStore((s) => s.setFilters);

  const connState = useGatewayStore((s) => s.state);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();
  const listContainerRef = useRef<HTMLDivElement>(null);
  const [listHeight, setListHeight] = useState(400);
  const [editTagsPaper, setEditTagsPaper] = useState<Paper | null>(null);
  const [showAllTags, setShowAllTags] = useState(false);

  // Load data when gateway connection is established (or re-established)
  useEffect(() => {
    if (connState === 'connected') {
      console.log('[LibraryPanel] connected → loading papers, tags, collections & stats');
      loadPapers();
      loadTags();
      loadCollections();
      loadStats();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connState]);

  useEffect(() => {
    if (selectedTags.length > 0) {
      setFilters({ tags: selectedTags });
    } else {
      setFilters({ tags: undefined });
    }
    loadPapers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTags]);

  useEffect(() => {
    if (!listContainerRef.current) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setListHeight(entry.contentRect.height);
      }
    });
    observer.observe(listContainerRef.current);
    return () => observer.disconnect();
  }, []);

  const handleSearchChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = e.target.value;
      setSearchQuery(value);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        loadPapers();
      }, 300);
    },
    [setSearchQuery, loadPapers],
  );

  const handleSortChange = useCallback(
    (value: PaperFilter['sort']) => {
      setFilters({ sort: value });
      loadPapers();
    },
    [setFilters, loadPapers],
  );

  const handleTagToggle = useCallback(
    (tagName: string) => {
      setSelectedTags((prev) => {
        const next = prev.includes(tagName) ? prev.filter((t) => t !== tagName) : [...prev, tagName];
        return next;
      });
    },
    [],
  );

  const useVirtualScroll = papers.length > 100;

  // Compute tags that exist on currently visible papers
  const visibleTagNames = useMemo(() => {
    const tagSet = new Set<string>();
    for (const paper of papers) {
      for (const tag of paper.tags ?? []) {
        tagSet.add(tag);
      }
    }
    return tagSet;
  }, [papers]);

  // Filter the global tags list to only show tags on current papers
  const displayTags = useMemo(
    () => tags.filter((tag) => visibleTagNames.has(tag.name)),
    [tags, visibleTagNames],
  );

  const hasActiveFilter =
    selectedTags.length > 0 || !!filters.read_status || !!filters.year || !!filters.collection_id;

  // Global empty state only on inbox — archive/starred tabs are implicitly filtered
  const isGlobalEmpty = !loading && papers.length === 0 && !searchQuery && !hasActiveFilter && activeTab === 'inbox';

  const collectionOptions = useMemo(
    () =>
      collections.map((c: LibraryCollection) => ({
        value: c.id,
        label: typeof c.paper_count === 'number' ? `${c.name} (${c.paper_count})` : c.name,
      })),
    [collections],
  );

  const handleCollectionSelect = useCallback(
    (value: string | null) => {
      if (!value) {
        setFilters({ collection_id: undefined });
      } else {
        setFilters({ collection_id: value });
      }
      loadPapers();
    },
    [setFilters, loadPapers],
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Sub-tabs */}
      <div style={{ padding: '8px 16px' }}>
        <Segmented
          value={activeTab}
          onChange={(v) => setActiveTab(v as 'inbox' | 'archive' | 'starred')}
          options={[
            { label: tabCounts ? `${t('library.inbox')} (${tabCounts.inbox})` : t('library.inbox'), value: 'inbox' },
            { label: tabCounts ? `${t('library.archive')} (${tabCounts.archive})` : t('library.archive'), value: 'archive' },
            { label: tabCounts ? `${t('library.starred')} (${tabCounts.starred})` : t('library.starred'), value: 'starred' },
          ]}
          block
          size="small"
        />
      </div>

      {activeTab === 'starred' && (
        <div style={{ padding: '0 16px 8px' }}>
          <Select
            size="small"
            allowClear
            showSearch
            optionFilterProp="label"
            placeholder={t('library.selectCollection')}
            value={filters.collection_id ?? undefined}
            onChange={(v) => handleCollectionSelect(v ?? null)}
            style={{ width: '100%' }}
            options={collectionOptions}
            notFoundContent={collections.length === 0 ? t('library.noCollectionsYet') : undefined}
          />
        </div>
      )}

      {/* Search */}
      <div style={{ padding: '4px 16px 8px' }}>
        <Input
          prefix={<SearchOutlined style={{ color: tokens.text.muted }} />}
          placeholder={t('library.search')}
          value={searchQuery}
          onChange={handleSearchChange}
          allowClear
          size="small"
        />
      </div>

      {/* Sort */}
      <div style={{ padding: '0 16px 8px' }}>
        <Select
          size="small"
          value={filters.sort ?? 'added_at'}
          onChange={handleSortChange}
          style={{ width: '100%' }}
          options={[
            { label: t('library.sortOptions.addedAt'), value: 'added_at' },
            { label: t('library.sortOptions.year'), value: 'year' },
            { label: t('library.sortOptions.title'), value: 'title' },
          ]}
          prefix={t('library.sortBy')}
        />
      </div>

      {/* Tag filter — only show tags that belong to current papers */}
      {displayTags.length > 0 && (
        <div style={{ padding: '0 16px 8px', display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
          {selectedTags.length > 0 && (
            <Tag
              onClick={() => setSelectedTags([])}
              style={{
                cursor: 'pointer',
                fontSize: 11,
                color: tokens.accent.red,
                borderColor: tokens.accent.red,
                background: 'transparent',
              }}
            >
              <CloseCircleOutlined style={{ marginRight: 2 }} />
              {t('library.clearTags')}
            </Tag>
          )}
          {displayTags.slice(0, showAllTags ? displayTags.length : 10).map((tag) => (
            <Tag
              key={tag.name}
              color={selectedTags.includes(tag.name) ? tokens.accent.blue : undefined}
              onClick={() => handleTagToggle(tag.name)}
              style={{ cursor: 'pointer', fontSize: 11 }}
            >
              {tag.name}
            </Tag>
          ))}
          {displayTags.length > 10 && !showAllTags && (
            <Tag
              onClick={() => setShowAllTags(true)}
              style={{ cursor: 'pointer', fontSize: 11, borderStyle: 'dashed' }}
            >
              +{displayTags.length - 10}
            </Tag>
          )}
        </div>
      )}

      {/* Paper list */}
      <div ref={listContainerRef} style={{ flex: 1, overflow: useVirtualScroll ? 'hidden' : 'auto' }}>
        {loading && papers.length === 0 && (
          <div style={{ padding: 40, textAlign: 'center' }}>
            <Spin indicator={<LoadingOutlined style={{ fontSize: 24 }} spin />} />
          </div>
        )}

        {isGlobalEmpty ? (
          <div style={{ padding: 24, textAlign: 'center', paddingTop: 60 }}>
            <BookOutlined style={{ fontSize: 48, color: tokens.text.muted, opacity: 0.4 }} />
            <div style={{ marginTop: 16, whiteSpace: 'pre-line' }}>
              <Text type="secondary" style={{ fontSize: 13 }}>
                {t('library.empty')}
              </Text>
            </div>
          </div>
        ) : papers.length === 0 && !loading ? (
          <div style={{ padding: 24, textAlign: 'center', paddingTop: 40 }}>
            <BookOutlined style={{ fontSize: 36, color: tokens.text.muted, opacity: 0.3 }} />
            <div style={{ marginTop: 12 }}>
              <Text type="secondary" style={{ fontSize: 13 }}>
                {t('library.emptyFiltered')}
              </Text>
            </div>
            {(selectedTags.length > 0 || searchQuery || filters.collection_id) && (
              <Button
                size="small"
                type="link"
                onClick={() => {
                  setSelectedTags([]);
                  setSearchQuery('');
                  setFilters({
                    tags: undefined,
                    read_status: undefined,
                    year: undefined,
                    collection_id: undefined,
                  });
                  loadPapers();
                }}
                style={{ marginTop: 8 }}
              >
                {t('library.clearFilter')}
              </Button>
            )}
          </div>
        ) : useVirtualScroll ? (
          <VirtualList
            rowComponent={VirtualRow}
            rowCount={papers.length}
            rowHeight={112}
            rowProps={{ papers, tokens, onEditTags: setEditTagsPaper }}
            style={{ height: listHeight }}
          />
        ) : (
          <>
            {papers.map((paper) => (
              <PaperListItem key={paper.id} paper={paper} tokens={tokens} onEditTags={setEditTagsPaper} />
            ))}
            {hasMore && !loading && (
              <div style={{ padding: '12px 16px', textAlign: 'center' }}>
                <Button size="small" type="dashed" onClick={loadMorePapers} loading={loadingMore} style={{ width: '100%' }}>
                  {loadingMore ? '' : t('library.loadMore')}
                </Button>
                <Text type="secondary" style={{ fontSize: 11, marginTop: 4, display: 'block' }}>
                  {t('library.showingCount', { count: papers.length, total })}
                </Text>
              </div>
            )}
          </>
        )}
      </div>

      {/* Edit tags modal */}
      <EditTagsModal
        open={editTagsPaper !== null}
        paperId={editTagsPaper?.id ?? ''}
        paperTitle={editTagsPaper?.title ?? ''}
        currentTags={editTagsPaper?.tags ?? []}
        onClose={() => setEditTagsPaper(null)}
      />
    </div>
  );
}

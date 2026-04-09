// Verified against spec 03d §3.1 + 01 §12.1
import React, { useCallback, useState } from 'react';
import { Button, Tag, Typography, message } from 'antd';
import { BookOutlined, CopyOutlined, FilePdfOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import CardContainer from './CardContainer';
import { useConfigStore } from '@/stores/config';
import { useGatewayStore } from '@/stores/gateway';
import { useLibraryStore } from '@/stores/library';
import { useUiStore } from '@/stores/ui';
import { getThemeTokens } from '@/styles/theme';
import type { PaperCard as PaperCardType } from '@/types/cards';

const { Text } = Typography;

/** Status badge colors — spec 01 §12.1 */
const STATUS_COLORS: Record<string, string> = {
  unread: '#71717A',   // gray (muted)
  reading: '#3B82F6',  // blue
  read: '#22C55E',     // green
  reviewed: '#A855F7', // purple
};

function StatusBadge({ status }: { status?: string }) {
  if (!status) return null;
  const color = STATUS_COLORS[status] ?? '#71717A';
  const isFilled = status !== 'unread';

  return (
    <span
      data-testid="status-badge"
      style={{
        display: 'inline-block',
        width: 8,
        height: 8,
        borderRadius: '50%',
        border: `2px solid ${color}`,
        background: isFilled ? color : 'transparent',
        marginRight: 8,
        verticalAlign: 'middle',
      }}
    />
  );
}

export default function PaperCard(props: PaperCardType) {
  const { t } = useTranslation();
  const theme = useConfigStore((s) => s.theme);
  const tokens = getThemeTokens(theme);
  const client = useGatewayStore((s) => s.client);
  const [added, setAdded] = useState(!!props.library_id);

  const borderColor = STATUS_COLORS[props.read_status ?? ''] ?? tokens.text.muted;

  const handleAddToLibrary = useCallback(async () => {
    if (!client) return;
    try {
      await client.request('rc.lit.add', {
        title: props.title,
        authors: props.authors,
        venue: props.venue,
        year: props.year,
        doi: props.doi,
        url: props.url,
        arxiv_id: props.arxiv_id,
        abstract: props.abstract_preview,
        tags: props.tags,
      });
      setAdded(true);
      // Refresh library panel data so the paper appears there
      useLibraryStore.getState().loadPapers();
      useLibraryStore.getState().loadTags();
    } catch {
      message.error(t('card.paper.addFailed'));
    }
  }, [client, props, t]);

  const handleViewInLibrary = useCallback(() => {
    // TODO: pass library_id to LibraryPanel for auto-scroll to specific paper
    useUiStore.getState().setRightPanelTab('library');
  }, []);

  const handleCite = useCallback(async () => {
    // Generate a BibTeX key: firstAuthorSurname + year + firstTitleWord
    const authors = props.authors ?? [];
    const surname = (authors[0] ?? 'unknown').split(/[,\s]/)[0].toLowerCase().replace(/[^a-z]/g, '');
    const yr = props.year ?? '';
    const titleWord = (props.title.split(/\s+/).find((w) => w.length > 3) ?? 'paper').toLowerCase().replace(/[^a-z]/g, '');
    const citeKey = `${surname}${yr}${titleWord}`;

    const bibtex = `@article{${citeKey},
  title={${props.title}},
  author={${authors.join(' and ')}},${props.venue ? `\n  journal={${props.venue}},` : ''}${props.year ? `\n  year={${props.year}},` : ''}${props.doi ? `\n  doi={${props.doi}},` : ''}
}`;
    try {
      await navigator.clipboard.writeText(bibtex);
      message.success(t('card.paper.citationCopied'));
    } catch {
      // Clipboard not available
    }
  }, [props, t]);

  const pdfUrl = props.url ?? (props.arxiv_id ? `https://arxiv.org/pdf/${props.arxiv_id}` : null);

  // Defense: papers without any verifiable identifier (doi, arxiv_id, url) are likely
  // LLM hallucinations — disable "Add to Library" to prevent garbage entering the library.
  const hasVerifiableId = !!(props.doi || props.arxiv_id || props.url);

  return (
    <CardContainer borderColor={borderColor}>
      {/* Header: status badge + title */}
      <div style={{ display: 'flex', alignItems: 'flex-start', marginBottom: 8 }}>
        <StatusBadge status={props.read_status} />
        <Text
          strong
          style={{
            fontSize: 15,
            color: tokens.text.primary,
            lineHeight: 1.4,
            flex: 1,
          }}
        >
          {props.title}
        </Text>
      </div>

      {/* Authors */}
      <div style={{ marginBottom: 4 }}>
        <Text style={{ fontSize: 12, color: tokens.text.muted }}>
          {t('card.paper.authors')}:{' '}
        </Text>
        <Text style={{ fontSize: 12, color: tokens.text.secondary }}>
          {(props.authors ?? []).join(', ')}
        </Text>
      </div>

      {/* Venue + Year */}
      {(props.venue || props.year) && (
        <div style={{ marginBottom: 4 }}>
          {props.venue && (
            <>
              <Text style={{ fontSize: 12, color: tokens.text.muted }}>
                {t('card.paper.venue')}:{' '}
              </Text>
              <Text style={{ fontSize: 12, color: tokens.text.secondary }}>
                {props.venue}
              </Text>
            </>
          )}
          {props.venue && props.year && (
            <Text style={{ fontSize: 12, color: tokens.text.muted }}> | </Text>
          )}
          {props.year && (
            <>
              <Text style={{ fontSize: 12, color: tokens.text.muted }}>
                {t('card.paper.year')}:{' '}
              </Text>
              <Text style={{ fontSize: 12, color: tokens.text.secondary }}>
                {props.year}
              </Text>
            </>
          )}
        </div>
      )}

      {/* DOI */}
      {props.doi && (
        <div style={{ marginBottom: 4 }}>
          <Text style={{ fontSize: 12, color: tokens.text.muted }}>
            {t('card.paper.doi')}:{' '}
          </Text>
          <a
            href={`https://doi.org/${props.doi}`}
            target="_blank"
            rel="noopener noreferrer"
            style={{ fontSize: 12, color: tokens.accent.blue }}
          >
            {props.doi}
          </a>
        </div>
      )}

      {/* Abstract preview */}
      {props.abstract_preview ? (
        <Text
          style={{
            display: 'block',
            fontSize: 13,
            color: tokens.text.secondary,
            marginTop: 8,
            marginBottom: 8,
            lineHeight: 1.5,
          }}
        >
          {props.abstract_preview}
        </Text>
      ) : (
        <Text
          type="secondary"
          style={{ display: 'block', fontSize: 12, marginTop: 8, marginBottom: 8, fontStyle: 'italic' }}
        >
          {t('card.paper.noAbstract')}
        </Text>
      )}

      {/* Tags */}
      {props.tags && props.tags.length > 0 && (
        <div style={{ marginBottom: 8 }}>
          <Text style={{ fontSize: 12, color: tokens.text.muted }}>
            {t('card.paper.tags')}:{' '}
          </Text>
          {props.tags.map((tag) => (
            <Tag key={tag} style={{ fontSize: 11 }}>
              {tag}
            </Tag>
          ))}
        </div>
      )}

      {/* Actions */}
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <Button
          size="small"
          icon={<BookOutlined />}
          disabled={!added && !hasVerifiableId}
          onClick={added ? handleViewInLibrary : handleAddToLibrary}
          aria-label={added ? t('card.paper.viewInLibrary') : t('card.paper.addToLibrary')}
          title={!hasVerifiableId && !added ? t('card.paper.noIdentifier', { defaultValue: 'Paper has no DOI, arXiv ID, or URL' }) : undefined}
          style={{
            borderColor: tokens.accent.blue,
            color: (!added && !hasVerifiableId) ? tokens.text.muted : tokens.accent.blue,
          }}
        >
          {added ? t('card.paper.viewInLibrary') : t('card.paper.addToLibrary')}
        </Button>

        <Button
          size="small"
          icon={<CopyOutlined />}
          onClick={handleCite}
          aria-label={t('card.paper.cite')}
          style={{
            borderColor: tokens.accent.blue,
            color: tokens.accent.blue,
          }}
        >
          {t('card.paper.cite')}
        </Button>

        {pdfUrl && (
          <Button
            size="small"
            icon={<FilePdfOutlined />}
            onClick={() => window.open(pdfUrl, '_blank', 'noopener,noreferrer')}
            aria-label={t('card.paper.openPdf')}
            style={{
              borderColor: tokens.accent.blue,
              color: tokens.accent.blue,
            }}
          >
            {t('card.paper.openPdf')}
          </Button>
        )}
      </div>
    </CardContainer>
  );
}

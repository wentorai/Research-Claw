import React, { useCallback, useEffect, useState } from 'react';
import { Button, Tag, Typography, message } from 'antd';
import { BookOutlined, LinkOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';

import type { PaperCandidate } from '../../../stores/execution-trace';
import { useGatewayStore } from '../../../stores/gateway';
import { useLibraryStore } from '../../../stores/library';
import CardContainer from './CardContainer';

const { Text } = Typography;

export default function PaperCandidateCard({
  candidate,
  onSaved,
}: {
  candidate: PaperCandidate;
  onSaved?: () => void;
}) {
  const { t } = useTranslation();
  const client = useGatewayStore((state) => state.client);
  const [saved, setSaved] = useState(Boolean(candidate.libraryId));
  useEffect(() => setSaved(Boolean(candidate.libraryId)), [candidate.libraryId]);
  const primaryUrl = candidate.pdfUrl ?? candidate.url
    ?? (candidate.doi ? `https://doi.org/${candidate.doi}` : undefined)
    ?? (candidate.arxivId ? `https://arxiv.org/abs/${candidate.arxivId}` : undefined);

  const addToLibrary = useCallback(async () => {
    if (!client || !candidate.actionable) return;
    try {
      await client.request('rc.lit.add', {
        title: candidate.title,
        authors: candidate.authors,
        abstract: candidate.abstractPreview,
        doi: candidate.doi,
        url: candidate.url,
        arxiv_id: candidate.arxivId,
        source: candidate.source,
        source_id: candidate.sourceId,
        venue: candidate.venue,
        year: candidate.year,
        citation_count: candidate.citationCount,
      });
      setSaved(true);
      void useLibraryStore.getState().loadPapers();
      onSaved?.();
    } catch {
      message.error(t('presentation.addFailed'));
    }
  }, [candidate, client, onSaved, t]);

  return (
    <CardContainer borderColor="#3B82F6">
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
        <Text strong style={{ flex: 1, fontSize: 14 }}>{candidate.title}</Text>
        <Tag color="default" style={{ marginInlineEnd: 0 }}>{t('presentation.unscreened')}</Tag>
        {(candidate.sources ?? [candidate.provider]).map((source) => (
          <Tag key={source} color="blue" style={{ marginInlineEnd: 0 }}>{source}</Tag>
        ))}
      </div>
      {candidate.authors.length > 0 && (
        <Text type="secondary" style={{ display: 'block', fontSize: 12, marginTop: 5 }}>
          {candidate.authors.join(', ')}
        </Text>
      )}
      {(candidate.venue || candidate.year) && (
        <Text type="secondary" style={{ display: 'block', fontSize: 12, marginTop: 3 }}>
          {[candidate.venue, candidate.year].filter(Boolean).join(' · ')}
        </Text>
      )}
      {candidate.doi && <Text code style={{ display: 'block', fontSize: 11, marginTop: 5 }}>DOI {candidate.doi}</Text>}
      {candidate.arxivId && <Text code style={{ display: 'block', fontSize: 11, marginTop: 5 }}>arXiv {candidate.arxivId}</Text>}
      {candidate.providerId && <Text code style={{ display: 'block', fontSize: 11, marginTop: 5 }}>ID {candidate.providerId}</Text>}
      <Text type="secondary" style={{ display: 'block', fontSize: 11, marginTop: 5 }}>
        {t('presentation.returnPositions', {
          positions: (candidate.sourcePositions ?? [{
            provider: candidate.provider,
            returnIndex: candidate.returnIndex,
          }]).map((position) => `${position.provider} #${position.returnIndex}`).join(' · '),
        })}
      </Text>
      {candidate.conflictingFields?.length ? (
        <Text type="secondary" style={{ display: 'block', fontSize: 11, marginTop: 5 }}>
          {t('presentation.metadataConflict', { fields: candidate.conflictingFields.join(', ') })}
        </Text>
      ) : null}
      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        {primaryUrl && (
          <Button size="small" icon={<LinkOutlined />} href={primaryUrl} target="_blank" rel="noopener noreferrer">
            {t('presentation.openResult')}
          </Button>
        )}
        <Button
          size="small"
          icon={<BookOutlined />}
          disabled={saved || !candidate.actionable}
          onClick={addToLibrary}
          title={!candidate.actionable ? t('presentation.noStrongIdentity') : undefined}
        >
          {saved ? t('presentation.saved') : t('presentation.addToLibrary')}
        </Button>
      </div>
    </CardContainer>
  );
}

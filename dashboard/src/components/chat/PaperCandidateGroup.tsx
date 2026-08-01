import React, { useCallback, useState } from 'react';
import { Button, Tag, Typography } from 'antd';
import { useTranslation } from 'react-i18next';

import type { PaperCandidateGroup as PaperCandidateGroupType } from '../../stores/execution-trace';
import { useExecutionTraceStore } from '../../stores/execution-trace';
import PaperCandidateCard from './cards/PaperCandidateCard';

const { Text } = Typography;

export default function PaperCandidateGroup({
  sessionKey,
  runId,
  group,
}: {
  sessionKey: string;
  runId: string;
  group: PaperCandidateGroupType;
}) {
  const { t } = useTranslation();
  const [opened, setOpened] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const refresh = useExecutionTraceStore((state) => state.refreshPresentations);
  const visible = group.candidates.slice(0, expanded ? group.candidates.length : group.shown);
  const refreshSavedState = useCallback(() => {
    void refresh(sessionKey, [runId]);
  }, [refresh, runId, sessionKey]);

  return (
    <section aria-label={group.label} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <Text strong>{group.label}</Text>
        <Tag>{t('presentation.rawRetrieved')}</Tag>
        <Text type="secondary" style={{ fontSize: 12 }}>
          {group.hasAvailableResults
            ? t('presentation.candidateSummary', {
              count: group.unique,
              sources: group.providers.length,
            })
            : t('presentation.unavailableSummary')}
        </Text>
        <Button
          type="link"
          size="small"
          onClick={() => {
            setOpened((value) => !value);
            if (opened) setExpanded(false);
          }}
        >
          {opened ? t('presentation.hideCandidates') : t('presentation.showCandidates')}
        </Button>
      </div>
      {opened && (
        <>
          <Text type="secondary" style={{ fontSize: 12 }}>{t('presentation.candidateDisclaimer')}</Text>
          {group.partialProviders.length > 0 && (
            <Text type="secondary" style={{ fontSize: 12 }}>
              {t('presentation.partialSources', { sources: group.partialProviders.join(', ') })}
            </Text>
          )}
          {group.unavailableProviders.length > 0 && (
            <Text type="secondary" style={{ fontSize: 12 }}>
              {t('presentation.unavailableSources', { sources: group.unavailableProviders.join(', ') })}
            </Text>
          )}
          <Text type="secondary" style={{ fontSize: 12 }}>
            {group.queries.length > 0
              ? t('presentation.queries', { queries: group.queries.join(' · ') })
              : t('presentation.queryUnavailable')}
            {group.queryUnavailable && group.queries.length > 0 ? ` · ${t('presentation.someQueriesUnavailable')}` : ''}
          </Text>
          {group.hasAvailableResults && (
            <div data-testid="paper-candidate-counts" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {group.matchedTotal !== undefined && <Tag>{t('presentation.counts.matchedTotal')}: {group.matchedTotal}</Tag>}
              <Tag>{t('presentation.counts.returned')}: {group.returned}</Tag>
              <Tag>{t('presentation.counts.eligible')}: {group.eligible}</Tag>
              <Tag>{t('presentation.counts.stored')}: {group.stored}</Tag>
              <Tag>{t('presentation.counts.unique')}: {group.unique}</Tag>
              <Tag>{t('presentation.counts.shown')}: {visible.length}</Tag>
            </div>
          )}
          {!group.hasAvailableResults && (
            <Text type="secondary">{t('presentation.sourceResultsUnavailable')}</Text>
          )}
          {group.hasAvailableResults && group.returned === 0 && (
            <Text type="secondary">{t('presentation.noResultsReturned')}</Text>
          )}
          {group.hasAvailableResults && group.returned > 0 && visible.length === 0 && (
            <Text type="secondary">{t('presentation.resultsUnavailable')}</Text>
          )}
          {visible.map((candidate) => (
            <PaperCandidateCard key={candidate.candidateId} candidate={candidate} onSaved={refreshSavedState} />
          ))}
          {group.candidates.length > group.shown && (
            <Button type="link" size="small" onClick={() => setExpanded((value) => !value)} style={{ alignSelf: 'flex-start' }}>
              {expanded ? t('presentation.showLess') : t('presentation.showMore', { count: group.candidates.length - group.shown })}
            </Button>
          )}
        </>
      )}
    </section>
  );
}

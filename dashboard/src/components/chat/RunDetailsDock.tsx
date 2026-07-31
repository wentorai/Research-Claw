import React, { useEffect, useMemo } from 'react';
import { Typography } from 'antd';
import { useTranslation } from 'react-i18next';

import {
  executionKey,
  useExecutionTraceStore,
} from '../../stores/execution-trace';
import ExecutionDetailsBadge from './ExecutionDetailsBadge';
import FileCard from './cards/FileCard';
import PaperCandidateGroup from './PaperCandidateGroup';

const { Text } = Typography;

export default function RunDetailsDock({
  sessionKey,
  runId,
  noFinal = false,
  selectedPaperAliases = new Set<string>(),
}: {
  sessionKey: string;
  runId: string;
  noFinal?: boolean;
  selectedPaperAliases?: Set<string>;
}) {
  const { t } = useTranslation();
  const key = executionKey(sessionKey, runId);
  const summary = useExecutionTraceStore((state) => state.summaries[key]);
  const presentation = useExecutionTraceStore((state) => state.presentations[key]);
  const availability = useExecutionTraceStore((state) => state.availability);
  const loadAvailability = useExecutionTraceStore((state) => state.loadAvailability);
  const candidateGroup = useMemo(() => {
    const group = presentation?.paperCandidates;
    if (!group || selectedPaperAliases.size === 0) return group;
    const candidates = group.candidates.filter((candidate) => (
      !candidate.strongAliases.some((alias) => selectedPaperAliases.has(alias))
    ));
    if (candidates.length === 0) return undefined;
    return { ...group, candidates, shown: Math.min(group.shown, candidates.length) };
  }, [presentation?.paperCandidates, selectedPaperAliases]);

  useEffect(() => {
    if (presentation?.files.length) void loadAvailability(sessionKey, presentation.files);
  }, [loadAvailability, presentation?.files, sessionKey]);

  if (!summary && !presentation) return null;
  return (
    <div
      data-testid={`run-details-${runId}`}
      style={{ margin: '6px 24px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}
    >
      <ExecutionDetailsBadge sessionKey={sessionKey} runId={runId} />
      {presentation?.files.length ? (
        <section aria-label={t('presentation.filesTitle')} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <Text strong style={{ fontSize: 12 }}>{t('presentation.filesTitle')}</Text>
          {noFinal && (
            <Text type="secondary" style={{ fontSize: 12 }}>
              {t('presentation.noFinalFileFact')}
            </Text>
          )}
          {presentation.files.map((file) => (
            <FileCard
              key={file.path}
              type="file_card"
              name={file.name}
              path={file.path}
              size_bytes={file.sizeBytes}
              mime_type={file.mimeType}
              git_status={file.gitStatus}
              availability={availability[`${sessionKey}\0${file.path}`] ?? 'unknown'}
            />
          ))}
        </section>
      ) : null}
      {candidateGroup && (
        <PaperCandidateGroup
          sessionKey={sessionKey}
          runId={runId}
          group={candidateGroup}
        />
      )}
    </div>
  );
}

import React from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Button, Tag, Typography } from 'antd';
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  FolderOpenOutlined,
  LoadingOutlined,
} from '@ant-design/icons';

import { useStagedWritingStore, STAGED_WRITING_STAGES } from '../../stores/staged-writing';
import type { StagedWritingStageStatus } from '../../utils/staged-writing-run';
import { countCompletedStages } from '../../utils/staged-writing-run';
import { useGatewayStore } from '../../stores/gateway';

const { Text } = Typography;

function stageIcon(status: StagedWritingStageStatus) {
  switch (status) {
    case 'done':
      return <CheckCircleOutlined style={{ color: '#22c55e', fontSize: 13 }} />;
    case 'failed':
      return <CloseCircleOutlined style={{ color: '#ef4444', fontSize: 13 }} />;
    case 'running':
      return <LoadingOutlined spin style={{ color: '#f59e0b', fontSize: 13 }} />;
    default:
      return <span className="staged-writing-step-dot" />;
  }
}

function statusTagColor(status: string): string {
  switch (status) {
    case 'completed': return 'success';
    case 'partial': return 'warning';
    case 'running': return 'processing';
    case 'failed': return 'error';
    default: return 'default';
  }
}

export default function StagedWritingTimeline() {
  const { t } = useTranslation();
  const connected = useGatewayStore((s) => s.state === 'connected');
  const job = useStagedWritingStore((s) => s.job);
  const resumeJob = useStagedWritingStore((s) => s.resumeJob);
  const cancelJob = useStagedWritingStore((s) => s.cancelJob);
  const retryStage = useStagedWritingStore((s) => s.retryStage);
  const syncStageFiles = useStagedWritingStore((s) => s.syncStageFiles);
  const clearJob = useStagedWritingStore((s) => s.clearJob);
  const openStageFile = useStagedWritingStore((s) => s.openStageFile);

  if (!job || job.status === 'cancelled') return null;

  const doneCount = countCompletedStages(job.stages);
  const running = job.status === 'running';

  return (
    <div className="staged-writing-timeline" role="status" aria-live="polite">
      <div className="staged-writing-header">
        <Text strong className="staged-writing-title">{t('stagedWriting.builtInTitle')}</Text>
        <Tag color={statusTagColor(job.status)}>{t(`stagedWriting.status.${job.status}`)}</Tag>
        <Text type="secondary" className="staged-writing-count">
          {t('stagedWriting.progressCount', { done: doneCount, total: STAGED_WRITING_STAGES.length })}
        </Text>
      </div>

      {job.lastError && (
        <Alert
          type={job.status === 'partial' ? 'warning' : 'error'}
          showIcon
          message={job.lastError}
          style={{ marginBottom: 8 }}
        />
      )}

      {job.status === 'partial' && (
        <Alert type="info" showIcon message={t('stagedWriting.partialHint')} style={{ marginBottom: 8 }} />
      )}

      <ol className="staged-writing-steps">
        {job.stages.map((stage, index) => {
          const def = STAGED_WRITING_STAGES[index];
          const isActive = stage.status === 'running' || stage.status === 'failed';
          return (
            <li
              key={stage.id}
              className={`staged-writing-step is-${stage.status}${isActive ? ' is-current' : ''}`}
            >
              <span className="staged-writing-step-icon">{stageIcon(stage.status)}</span>
              <span className="staged-writing-step-body">
                <span className="staged-writing-step-label">{t(`stagedWriting.stages.${def.titleKey}`)}</span>
                <Text code className="staged-writing-step-path">{stage.outputPath}</Text>
              </span>
              <span className="staged-writing-step-actions">
                {stage.status === 'done' && (
                  <Button type="link" size="small" icon={<FolderOpenOutlined />} onClick={() => openStageFile(stage.outputPath)}>
                    {t('stagedWriting.openFile')}
                  </Button>
                )}
                {stage.status === 'failed' && (
                  <Button type="link" size="small" disabled={!connected || running} onClick={() => void retryStage(index)}>
                    {t('stagedWriting.retryStep')}
                  </Button>
                )}
              </span>
            </li>
          );
        })}
      </ol>

      <div className="staged-writing-footer">
        {(job.status === 'partial' || job.status === 'failed') && (
          <Button size="small" disabled={!connected || running} onClick={() => void resumeJob()}>
            {t('stagedWriting.resume')}
          </Button>
        )}
        <Button size="small" disabled={!connected || running} onClick={() => void syncStageFiles()}>
          {t('stagedWriting.syncFiles')}
        </Button>
        {running && (
          <Button size="small" danger onClick={cancelJob}>
            {t('stagedWriting.cancel')}
          </Button>
        )}
        {!running && (
          <Button size="small" onClick={clearJob}>
            {t('stagedWriting.clear')}
          </Button>
        )}
      </div>
    </div>
  );
}

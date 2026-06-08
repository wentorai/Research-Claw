import React, { useCallback, useEffect, useMemo } from 'react';
import {
  Alert,
  App,
  Button,
  Collapse,
  Empty,
  Select,
  Space,
  Spin,
  Tag,
  Typography,
} from 'antd';
import {
  CopyOutlined,
  DeleteOutlined,
  FolderOpenOutlined,
  ReloadOutlined,
  RobotOutlined,
} from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import MarkdownBody from '../MarkdownBody';
import { useConfigStore } from '../../stores/config';
import { useGatewayStore } from '../../stores/gateway';
import { usePaperReviewStore } from '../../stores/paper-review';
import { useUiStore } from '../../stores/ui';
import type { PaperReview, PaperReviewStatus } from '../../gateway/paper-review-types';
import type { PaperReviewStageProgress } from '../../utils/paper-review-run';
import {
  buildPaperReviewBrief,
  buildReviewRecordSummary,
  formatReviewDateTime,
  getReviewSequenceNumber,
  reviewOutputPath,
  type ReviewEvidenceSufficiency,
} from '../../utils/paper-review-brief';
import { REVIEW_DISCIPLINES } from '../../utils/paper-review-discipline';
import { getThemeTokens } from '../../styles/theme';

const { Text, Paragraph } = Typography;

const STATUS_COLORS: Record<PaperReviewStatus, string> = {
  draft: 'default',
  in_progress: 'processing',
  completed: 'success',
  failed: 'error',
};

function BriefMarkdown({ text }: { text: string }) {
  return <MarkdownBody compact>{text}</MarkdownBody>;
}

function splitVerdictBody(verdict: string | null): string | null {
  if (!verdict?.trim()) return null;
  const rest = verdict.trim().split('\n').slice(1).join('\n').trim();
  return rest || null;
}

function verdictTagColor(headline: string | null): string {
  if (!headline) return 'default';
  const v = headline.toLowerCase();
  if (/\breject\b|拒稿|拒绝/.test(v)) return 'error';
  if (/\bborderline\b|边界/.test(v)) return 'warning';
  if (/\baccept\b|接收|录用/.test(v)) return 'success';
  return 'default';
}

function BriefField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="paper-review-brief-section">
      <Text type="secondary" className="paper-review-brief-section-label">{label}</Text>
      <div className="paper-review-brief-section-body">{children}</div>
    </div>
  );
}

const SUFFICIENCY_TAG_COLORS: Record<ReviewEvidenceSufficiency, string> = {
  sufficient: 'success',
  partial: 'warning',
  not_found: 'error',
};

function EvidenceSufficiencyField({
  brief,
  t,
}: {
  brief: ReturnType<typeof buildPaperReviewBrief>;
  t: ReturnType<typeof useTranslation>['t'];
}) {
  if (!brief.evidenceSufficiency && !brief.evidenceSufficiencyDetail) {
    return <>—</>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {brief.evidenceSufficiency && (
        <Tag color={SUFFICIENCY_TAG_COLORS[brief.evidenceSufficiency]}>
          {t(`paperReview.sufficiency.${brief.evidenceSufficiency}`)}
        </Tag>
      )}
      {brief.evidenceSufficiencyDetail && (
        <BriefMarkdown text={brief.evidenceSufficiencyDetail} />
      )}
    </div>
  );
}

interface ReviewRecordBodyProps {
  review: PaperReview;
  tokens: ReturnType<typeof getThemeTokens>;
  running: boolean;
  stageProgress: PaperReviewStageProgress | null;
  onCopy: (review: PaperReview) => void;
  onOpenFile: (review: PaperReview) => void;
  onDelete: (id: string) => void;
  onCancel: (id: string) => void;
  isBusy: boolean;
  t: ReturnType<typeof useTranslation>['t'];
}

function ReviewRecordBody({
  review,
  tokens,
  running,
  stageProgress,
  onCopy,
  onOpenFile,
  onDelete,
  onCancel,
  isBusy,
  t,
}: ReviewRecordBodyProps) {
  const brief = useMemo(() => buildPaperReviewBrief(review), [review]);
  const recordSummary = useMemo(() => buildReviewRecordSummary(review), [review]);
  const verdictBody = useMemo(() => splitVerdictBody(brief.verdict), [brief.verdict]);
  const hasReport = Boolean(review.report_markdown?.trim());
  const isRunningThis = running && review.status === 'in_progress';
  const stageLabel = stageProgress
    ? t(`paperReview.stages.${stageProgress.stageId}`)
    : '';

  if (isRunningThis && !hasReport) {
    return (
      <div style={{ padding: 16, textAlign: 'center' }}>
        <Spin size="small" />
        <Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 12, fontSize: 12 }}>
          {stageProgress
            ? t('paperReview.stageProgress', {
                current: stageProgress.current,
                total: stageProgress.total,
                label: stageLabel,
              })
            : t('paperReview.runningHint')}
        </Paragraph>
        <Button size="small" disabled={isBusy} onClick={() => onCancel(review.id)}>
          {t('paperReview.cancelReview')}
        </Button>
      </div>
    );
  }

  if (review.status === 'failed') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <Alert
          type="error"
          showIcon
          message={t('paperReview.failedTitle')}
          description={review.failure_reason ?? t('paperReview.errors.unknown')}
        />
        <Space>
          <Button size="small" danger icon={<DeleteOutlined />} disabled={isBusy} onClick={() => onDelete(review.id)}>
            {t('paperReview.delete')}
          </Button>
        </Space>
      </div>
    );
  }

  if (!hasReport && review.status === 'draft') {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('paperReview.emptyResult')} />;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {(hasReport || brief.summary || brief.score != null) && (
        <div
          style={{
            border: `1px solid ${tokens.border.default}`,
            borderRadius: 8,
            padding: 12,
            background: tokens.bg.surface,
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginBottom: 8 }}>
            <Text strong style={{ fontSize: 13 }}>{t('paperReview.briefTitle')}</Text>
            <Tag color={STATUS_COLORS[review.status]}>
              {t(`paperReview.status.${review.status === 'in_progress' ? 'inProgress' : review.status}`)}
            </Tag>
          </div>
          <div className="paper-review-brief-metrics">
            <div className="paper-review-brief-metric">
              <Text type="secondary" className="paper-review-brief-metric-label">
                {t('paperReview.fields.score')}
              </Text>
              <Text strong>{recordSummary.score}</Text>
            </div>
            <div className="paper-review-brief-metric">
              <Text type="secondary" className="paper-review-brief-metric-label">
                {t('paperReview.fields.confidence')}
              </Text>
              {brief.confidence ? <BriefMarkdown text={brief.confidence} /> : <Text>—</Text>}
            </div>
            <div className="paper-review-brief-metric">
              <Text type="secondary" className="paper-review-brief-metric-label">
                {t('paperReview.fields.verdict')}
              </Text>
              {recordSummary.verdict !== '—' ? (
                <Tag color={verdictTagColor(recordSummary.verdict)}>{recordSummary.verdict}</Tag>
              ) : (
                <Text>—</Text>
              )}
            </div>
          </div>
          {verdictBody && (
            <BriefField label={t('paperReview.fields.verdictDetail')}>
              <BriefMarkdown text={verdictBody} />
            </BriefField>
          )}
          {(brief.evidenceSufficiency || brief.evidenceSufficiencyDetail) && (
            <BriefField label={t('paperReview.fields.evidenceSufficiency')}>
              <EvidenceSufficiencyField brief={brief} t={t} />
            </BriefField>
          )}
          {brief.summary && (
            <BriefField label={t('paperReview.fields.summary')}>
              <BriefMarkdown text={brief.summary} />
            </BriefField>
          )}
          {brief.topRejectReason && (
            <BriefField label={t('paperReview.fields.topReject')}>
              <BriefMarkdown text={brief.topRejectReason} />
            </BriefField>
          )}
        </div>
      )}

      {hasReport && (
        <Collapse
          items={[
            {
              key: 'report',
              label: t('paperReview.fullReport'),
              extra: (
                <Space size={4} onClick={(e) => e.stopPropagation()}>
                  <Button size="small" type="text" icon={<CopyOutlined />} onClick={() => onCopy(review)}>
                    {t('paperReview.copyReport')}
                  </Button>
                  <Button size="small" type="text" onClick={() => onOpenFile(review)}>
                    {t('paperReview.openReportFile')}
                  </Button>
                  <Button
                    size="small"
                    type="text"
                    danger
                    icon={<DeleteOutlined />}
                    disabled={isBusy}
                    onClick={() => onDelete(review.id)}
                  >
                    {t('paperReview.delete')}
                  </Button>
                </Space>
              ),
              children: (
                <MarkdownBody
                  style={{
                    fontSize: 13,
                    lineHeight: 1.65,
                    color: tokens.text.primary,
                    maxHeight: 'min(48vh, 480px)',
                    overflow: 'auto',
                  }}
                >
                  {review.report_markdown ?? ''}
                </MarkdownBody>
              ),
            },
          ]}
        />
      )}

      {!hasReport && review.status !== 'draft' && (
        <Space>
          <Button size="small" danger icon={<DeleteOutlined />} disabled={isBusy} onClick={() => onDelete(review.id)}>
            {t('paperReview.delete')}
          </Button>
        </Space>
      )}

      {isRunningThis && hasReport && (
        <Alert type="info" showIcon message={t('paperReview.refreshingHint')} />
      )}
    </div>
  );
}

export default function PaperReviewPanel() {
  const { t } = useTranslation();
  const { message: messageApi } = App.useApp();
  const theme = useConfigStore((s) => s.theme);
  const tokens = useMemo(() => getThemeTokens(theme), [theme]);
  const connState = useGatewayStore((s) => s.state);
  const candidates = usePaperReviewStore((s) => s.candidates);
  const reviews = usePaperReviewStore((s) => s.reviews);
  const activeReview = usePaperReviewStore((s) => s.activeReview);
  const selectedPath = usePaperReviewStore((s) => s.selectedPath);
  const loading = usePaperReviewStore((s) => s.loading);
  const saving = usePaperReviewStore((s) => s.saving);
  const running = usePaperReviewStore((s) => s.running);
  const error = usePaperReviewStore((s) => s.error);
  const selectedDiscipline = usePaperReviewStore((s) => s.selectedDiscipline);
  const stageProgress = usePaperReviewStore((s) => s.stageProgress);
  const loadCandidates = usePaperReviewStore((s) => s.loadCandidates);
  const loadReviews = usePaperReviewStore((s) => s.loadReviews);
  const selectPath = usePaperReviewStore((s) => s.selectPath);
  const setDiscipline = usePaperReviewStore((s) => s.setDiscipline);
  const loadReview = usePaperReviewStore((s) => s.loadReview);
  const runReview = usePaperReviewStore((s) => s.runReview);
  const deleteReview = usePaperReviewStore((s) => s.deleteReview);
  const cancelReview = usePaperReviewStore((s) => s.cancelReview);
  const stopPolling = usePaperReviewStore((s) => s.stopPolling);
  const clearError = usePaperReviewStore((s) => s.clearError);
  const requestWorkspacePreview = useUiStore((s) => s.requestWorkspacePreview);

  useEffect(() => {
    if (connState === 'connected') void loadCandidates();
  }, [connState, loadCandidates]);

  useEffect(() => () => stopPolling(), [stopPolling]);

  const isBusy = running || saving;
  const disciplineOptions = useMemo(
    () => REVIEW_DISCIPLINES.map((d) => ({
      value: d.id,
      label: t(`paperReview.disciplines.${d.id}`, { venues: d.venues }),
    })),
    [t],
  );

  const handleRefresh = useCallback(async () => {
    await loadCandidates();
    if (selectedPath) await loadReviews(selectedPath);
  }, [loadCandidates, loadReviews, selectedPath]);

  const handleRunReview = useCallback(async () => {
    if (!selectedPath) return;
    await runReview(selectedPath);
  }, [selectedPath, runReview]);

  const handleCancelReview = useCallback(async (reviewId: string) => {
    await cancelReview(reviewId);
    messageApi.info(t('paperReview.cancelled'));
  }, [cancelReview, messageApi, t]);

  const handleCopyReport = useCallback(async (review: PaperReview) => {
    const report = review.report_markdown?.trim();
    if (!report) return;
    try {
      await navigator.clipboard.writeText(report);
      messageApi.success(t('paperReview.copySuccess'));
    } catch {
      messageApi.error(t('paperReview.copyFailed'));
    }
  }, [messageApi, t]);

  const handleOpenReportFile = useCallback((review: PaperReview) => {
    if (!selectedPath) return;
    requestWorkspacePreview(reviewOutputPath(selectedPath, review.id));
  }, [requestWorkspacePreview, selectedPath]);

  const reviewSelectOptions = useMemo(
    () => reviews.map((review, index) => {
      const n = getReviewSequenceNumber(index, reviews.length);
      const { score, verdict } = buildReviewRecordSummary(review);
      const statusLabel = review.status === 'failed' ? t('paperReview.status.failed') : verdict;
      const when = formatReviewDateTime(review.created_at);
      const seqLabel = index === 0
        ? t('paperReview.reviewSequenceLatest', { n })
        : t('paperReview.reviewSequence', { n });
      return {
        value: review.id,
        label: `${seqLabel} · ${when} · ${score} · ${statusLabel}`,
      };
    }),
    [reviews, t],
  );

  const handleSelectReview = useCallback((id: string) => {
    void loadReview(id);
  }, [loadReview]);

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', padding: 16, gap: 12, minHeight: 0 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ minWidth: 0 }}>
          <Text type="secondary" style={{ fontSize: 12, display: 'block' }}>
            {t('paperReview.subtitle')}
          </Text>
          <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 4 }}>
            {t('paperReview.disclaimer')}
          </Text>
        </div>
        <Button icon={<ReloadOutlined />} onClick={() => void handleRefresh()} disabled={loading || isBusy}>
          {t('paperReview.refresh')}
        </Button>
      </div>

      {error && (
        <Alert type="error" showIcon message={error} closable onClose={clearError} />
      )}

      <div>
        <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 6 }}>
          {t('paperReview.selectDiscipline')}
        </Text>
        <Select
          style={{ width: '100%', marginBottom: 12 }}
          value={selectedDiscipline}
          disabled={isBusy}
          onChange={(value) => setDiscipline(value)}
          options={disciplineOptions}
        />
        <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 6 }}>
          {t('paperReview.selectPaper')}
        </Text>
        <Select
          showSearch
          allowClear
          style={{ width: '100%' }}
          placeholder={t('paperReview.selectPaperPlaceholder')}
          value={selectedPath ?? undefined}
          optionFilterProp="label"
          disabled={isBusy}
          onChange={(value) => selectPath(value ?? null)}
          options={candidates.map((c) => ({
            value: c.path,
            label: c.path,
          }))}
        />
      </div>

      {!selectedPath ? (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          {loading ? <Spin /> : (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('paperReview.emptySelect')} />
          )}
        </div>
      ) : (
        <>
          <Space wrap>
            <Button
              type="primary"
              icon={<RobotOutlined />}
              loading={isBusy}
              onClick={() => void handleRunReview()}
            >
              {t('paperReview.runReview')}
            </Button>
            <Button icon={<FolderOpenOutlined />} onClick={() => requestWorkspacePreview(selectedPath)}>
              {t('paperReview.openFile')}
            </Button>
          </Space>

          <div style={{ flex: 1, minHeight: 0, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
            {loading && reviews.length === 0 ? (
              <Spin style={{ alignSelf: 'center', marginTop: 24 }} />
            ) : reviews.length === 0 ? (
              <Empty description={t('paperReview.emptyResult')} />
            ) : (
              <>
                <div>
                  <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 6 }}>
                    {t('paperReview.selectReviewRecord')}
                    {' '}
                    {t('paperReview.reviewHistoryCount', { count: reviews.length })}
                  </Text>
                  <Select
                    style={{ width: '100%' }}
                    value={activeReview?.id}
                    disabled={isBusy}
                    optionLabelProp="label"
                    onChange={handleSelectReview}
                    options={reviewSelectOptions}
                  />
                </div>
                {activeReview && (
                  <ReviewRecordBody
                    review={activeReview}
                    tokens={tokens}
                    running={running}
                    stageProgress={stageProgress}
                    onCopy={handleCopyReport}
                    onOpenFile={handleOpenReportFile}
                    onDelete={(id) => void deleteReview(id)}
                    onCancel={(id) => void handleCancelReview(id)}
                    isBusy={isBusy}
                    t={t}
                  />
                )}
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}

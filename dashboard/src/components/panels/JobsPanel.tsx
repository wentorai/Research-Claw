import { useEffect, useState } from 'react';
import { App, Button, Empty, Spin, Tag, Tooltip, Typography } from 'antd';
import { DownOutlined, PlayCircleOutlined, RedoOutlined, ReloadOutlined, RightOutlined, StopOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import {
  useJobsStore,
  type Job,
  type JobCancelResult,
  type JobStatus,
  type JobStepStatus,
} from '../../stores/jobs';
import { useGatewayStore } from '../../stores/gateway';
import { relativeTime } from '../../utils/relativeTime';

const { Text } = Typography;

// rc_jobs timestamps are SQLite 'YYYY-MM-DD HH:MM:SS' in UTC with no tz marker;
// new Date() would misparse that as local time, so normalize to ISO-UTC first.
function dbDateToIso(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.includes('T')) return trimmed;
  return `${trimmed.replace(' ', 'T')}Z`;
}

function friendlyJobType(type: string, t: (key: string) => string): string {
  if (type === 'openclaw-subagent') return t('jobs.type.researchAgent');
  if (type === 'staged-writing') return t('jobs.type.stagedWriting');
  if (type.includes('upload')) return t('jobs.type.upload');
  if (type.includes('export')) return t('jobs.type.export');
  return t('jobs.type.other');
}

function friendlyJobError(error: string, t: (key: string) => string): string {
  if (/worker heartbeat expired/i.test(error)) return t('jobs.error.heartbeatExpired');
  if (/未能按时启动|never started|failed to start/i.test(error)) {
    return t('jobs.error.notStarted');
  }
  if (/no active openclaw|no active .* run/i.test(error)) {
    return t('jobs.error.noActiveRun');
  }
  return t('jobs.error.generic');
}

function friendlyCurrentStep(job: Job, t: (key: string) => string): string {
  if (job.status === 'cancelled') return t('jobs.step.cancelled');
  if (job.status === 'completed') return t('jobs.step.completed');
  if (job.status === 'failed') return t('jobs.step.failed');
  if (job.status === 'partial') return t('jobs.step.partial');
  if (job.status === 'queued') return t('jobs.waiting');
  if (!job.current_step) return t('jobs.waiting');
  if (/openclaw.*子会话.*运行中/i.test(job.current_step)) return t('jobs.step.agentRunning');
  if (/resumed by user/i.test(job.current_step)) return t('jobs.step.resumed');
  return job.current_step;
}

const STATUS_COLORS: Record<JobStatus, string> = {
  queued: 'default',
  running: 'processing',
  completed: 'success',
  partial: 'warning',
  failed: 'error',
  stalled: 'warning',
  cancelled: 'default',
};

const STEP_STATUS_COLORS: Record<JobStepStatus, string> = {
  pending: 'default',
  running: 'processing',
  completed: 'success',
  failed: 'error',
  skipped: 'default',
};

function JobSteps({ steps }: { steps: NonNullable<Job['steps']> }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  if (steps.length === 0) return null;
  return (
    <div>
      <Text
        type="secondary"
        style={{ fontSize: 12, cursor: 'pointer', userSelect: 'none', display: 'inline-flex', alignItems: 'center', gap: 4 }}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? <DownOutlined style={{ fontSize: 10 }} /> : <RightOutlined style={{ fontSize: 10 }} />}
        {t('jobs.steps')} ({steps.length})
      </Text>
      {open && (
        <div style={{ display: 'grid', gap: 4, marginTop: 6, paddingLeft: 8, borderLeft: '1px solid var(--border)' }}>
          {steps.map((step) => (
            <div key={step.step_key} style={{ display: 'grid', gap: 2 }}>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <Tag color={STEP_STATUS_COLORS[step.status]} style={{ marginInlineEnd: 0 }}>
                  {t(`jobs.stepStatus.${step.status}`)}
                </Tag>
                <Text style={{ fontSize: 12, flex: 1 }}>{step.label}</Text>
                {step.attempt > 1 && (
                  <Text type="secondary" style={{ fontSize: 11 }}>{t('jobs.stepAttempt', { count: step.attempt })}</Text>
                )}
              </div>
              {step.error && (
                <Text type="danger" style={{ fontSize: 11 }}>
                  {friendlyJobError(step.error, t)}
                </Text>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function JobCard({ job }: { job: Job }) {
  const { t, i18n } = useTranslation();
  const { message } = App.useApp();
  const updatedIso = dbDateToIso(job.updated_at);
  const updatedRel = relativeTime(updatedIso, i18n.language);
  const updatedLocal = updatedIso ? new Date(updatedIso).toLocaleString() : job.updated_at;
  const cancelJob = useJobsStore((s) => s.cancelJob);
  const resumeJob = useJobsStore((s) => s.resumeJob);
  const retryJob = useJobsStore((s) => s.retryJob);
  const action = useJobsStore((s) => s.actionById[job.id]);
  const active = job.status === 'queued' || job.status === 'running' || job.status === 'stalled';
  const controllableOpenClaw = job.type === 'openclaw-subagent' && Boolean(job.session_key);
  const cancellable = active;
  const resumable = controllableOpenClaw
    && (job.status === 'stalled' || job.status === 'cancelled');
  const retryable = controllableOpenClaw && job.status === 'failed';

  const runAction = (fn: () => Promise<void>) => {
    void fn().catch((err) => {
      const detail = err instanceof Error ? err.message : String(err);
      message.error(detail || t('jobs.actionFailed'));
    });
  };

  const runCancel = () => {
    void cancelJob(job.id).then((result: JobCancelResult) => {
      if (result.backingStop === 'unconfirmed') {
        message.warning(t('jobs.cancelledBackingUnconfirmed'));
      } else if (result.backingStop === 'not-active') {
        message.success(t('jobs.cancelledNoActiveBacking'));
      } else {
        message.success(t('jobs.cancelledSuccess'));
      }
    }).catch(() => {
      message.error(t('jobs.actionFailed'));
    });
  };

  return (
    <div style={{ padding: 12, borderBottom: '1px solid var(--border)', display: 'grid', gap: 8 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <Text strong style={{ flex: 1 }}>{job.title}</Text>
        <Tag color={STATUS_COLORS[job.status]}>{t(`jobs.status.${job.status}`)}</Tag>
      </div>
      <Text type="secondary" style={{ fontSize: 12 }}>
        {t('jobs.currentActivity')}{friendlyCurrentStep(job, t)}
      </Text>
      {job.error && job.status !== 'cancelled' && job.status !== 'completed' && (
        <Text type="danger" style={{ fontSize: 12 }}>
          {friendlyJobError(job.error, t)}
        </Text>
      )}
      {job.steps && job.steps.length > 0 && <JobSteps steps={job.steps} />}
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
        <Tooltip title={updatedLocal}>
          <Text type="secondary" style={{ fontSize: 11 }}>
            {friendlyJobType(job.type, t)} · {updatedRel}
          </Text>
        </Tooltip>
        <span style={{ display: 'inline-flex', gap: 4 }}>
          {resumable && (
            <Tooltip title={t('jobs.resume')}>
              <Button
                size="small"
                icon={<PlayCircleOutlined />}
                loading={action === 'resume'}
                disabled={Boolean(action)}
                onClick={() => runAction(() => resumeJob(job.id))}
              >
                {t('jobs.resume')}
              </Button>
            </Tooltip>
          )}
          {retryable && (
            <Tooltip title={t('jobs.retry')}>
              <Button
                size="small"
                icon={<RedoOutlined />}
                loading={action === 'retry'}
                disabled={Boolean(action)}
                onClick={() => runAction(() => retryJob(job.id))}
              >
                {t('jobs.retry')}
              </Button>
            </Tooltip>
          )}
          {cancellable && (
            <Tooltip title={t('jobs.cancel')}>
              <Button
                size="small"
                danger
                icon={<StopOutlined />}
                loading={action === 'cancel'}
                disabled={Boolean(action)}
                onClick={runCancel}
              >
                {t('jobs.cancel')}
              </Button>
            </Tooltip>
          )}
        </span>
      </div>
    </div>
  );
}

export default function JobsPanel() {
  const { t, i18n } = useTranslation();
  const { message } = App.useApp();
  const jobs = useJobsStore((s) => s.jobs);
  const loading = useJobsStore((s) => s.loading);
  const lastLoadedAt = useJobsStore((s) => s.lastLoadedAt);
  const loadJobs = useJobsStore((s) => s.loadJobs);
  const connState = useGatewayStore((s) => s.state);
  const lastLoadedLabel = lastLoadedAt
    ? relativeTime(new Date(lastLoadedAt).toISOString(), i18n.language)
    : null;

  // Refresh once when the panel opens; the global JobsActivityListener owns the
  // ongoing poll so jobs stay live (and notify) even when this panel is closed.
  useEffect(() => {
    if (connState !== 'connected') return;
    void loadJobs();
  }, [connState, loadJobs]);

  const refreshAll = () => {
    void loadJobs().then((ok) => {
      if (ok) message.success(t('jobs.refreshSuccess'));
      else message.error(t('jobs.refreshFailed'));
    });
  };

  return (
    <div style={{ height: '100%', overflow: 'auto' }}>
      <div style={{ padding: 12, display: 'grid', gap: 8, borderBottom: '1px solid var(--border)' }}>
        <Text type="secondary">{t('jobs.hint')}</Text>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Text type="secondary" style={{ fontSize: 11, flex: 1 }}>
            {loading
              ? t('jobs.refreshing')
              : lastLoadedLabel
                ? t('jobs.lastUpdated', { time: lastLoadedLabel })
                : t('jobs.autoRefreshHint')}
          </Text>
          <Button
            size="small"
            icon={<ReloadOutlined />}
            loading={loading}
            disabled={connState !== 'connected'}
            onClick={refreshAll}
          >
            {t('jobs.refreshAll')}
          </Button>
        </div>
      </div>
      {loading && jobs.length === 0 ? (
        <div style={{ padding: 32, textAlign: 'center' }}><Spin /></div>
      ) : jobs.length === 0 ? (
        <Empty description={t('jobs.empty')} />
      ) : jobs.map((job) => <JobCard key={job.id} job={job} />)}
    </div>
  );
}

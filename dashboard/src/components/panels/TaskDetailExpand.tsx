import React from 'react';
import { Button, Spin, Tag, Typography } from 'antd';
import { FileOutlined, RobotOutlined, UpOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import type { TaskWithDetails, ActivityLogEntry, Task } from '../../stores/tasks';
import { useUiStore } from '../../stores/ui';
import type { ThemeTokens } from '../../styles/theme';
import { PRIORITY_COLORS } from '../../utils/task-constants';

const { Text } = Typography;

const STATUS_COLORS: Record<string, string> = {
  todo: '#6B7280',
  in_progress: '#3B82F6',
  blocked: '#EF4444',
  done: '#22C55E',
  cancelled: '#6B7280',
};

function formatActivityDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function getDeadlineDisplay(
  deadline: string | null,
  t: (key: string, opts?: Record<string, unknown>) => string,
): { text: string; color: string } {
  if (!deadline) return { text: t('tasks.noDeadline'), color: '' };
  const now = new Date();
  const dl = new Date(deadline);
  const diffMs = dl.getTime() - now.getTime();
  const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

  const formatted = dl.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });

  if (diffDays < 0) {
    return {
      text: `${formatted} (${t('tasks.detail.daysOverdue', { days: Math.abs(diffDays) })})`,
      color: '#EF4444',
    };
  }
  if (diffDays <= 3) {
    return {
      text: `${formatted} (${t('tasks.detail.daysRemaining', { days: diffDays })})`,
      color: '#F59E0B',
    };
  }
  return {
    text: `${formatted} (${t('tasks.detail.daysRemaining', { days: diffDays })})`,
    color: '',
  };
}

interface TaskDetailExpandProps {
  detail: TaskWithDetails | null;
  loading: boolean;
  tokens: ThemeTokens;
  onClose: () => void;
  onAskAgent: (detail: TaskWithDetails) => void;
}

export default function TaskDetailExpand({
  detail,
  loading,
  tokens,
  onClose,
  onAskAgent,
}: TaskDetailExpandProps) {
  const { t } = useTranslation();

  if (loading) {
    return (
      <div
        data-testid="task-detail-loading"
        style={{
          padding: '16px 16px 16px 32px',
          borderLeft: '3px solid transparent',
          marginLeft: 16,
          background: tokens.bg.surface,
          borderBottom: `1px solid ${tokens.border.default}`,
        }}
      >
        <Spin size="small" />
        <Text style={{ fontSize: 12, color: tokens.text.muted, marginLeft: 8 }}>
          {t('tasks.detail.loading')}
        </Text>
      </div>
    );
  }

  if (!detail) return null;

  const deadlineInfo = getDeadlineDisplay(detail.deadline, t);
  const recentNotes = (detail.activity_log ?? [])
    .filter((e: ActivityLogEntry) => e.event_type === 'note_added')
    .slice(0, 3);
  const recentActivity = (detail.activity_log ?? []).slice(0, 5);

  return (
    <div
      data-testid="task-detail-expand"
      style={{
        padding: '12px 16px 12px 32px',
        borderLeft: `3px solid ${PRIORITY_COLORS[detail.priority] ?? '#6B7280'}`,
        marginLeft: 16,
        background: tokens.bg.surface,
        borderBottom: `1px solid ${tokens.border.default}`,
        fontSize: 12,
        color: tokens.text.secondary,
      }}
    >
      {/* Metadata row: status, priority, task_type */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 8, alignItems: 'center' }}>
        <Tag color={STATUS_COLORS[detail.status]} style={{ fontSize: 11, margin: 0 }}>
          {t(`tasks.status.${detail.status}`)}
        </Tag>
        <Tag color={PRIORITY_COLORS[detail.priority]} style={{ fontSize: 11, margin: 0 }}>
          {t(`tasks.priority.${detail.priority}`)}
        </Tag>
        <Tag style={{ fontSize: 11, margin: 0 }}>
          {t(`tasks.taskType.${detail.task_type}`)}
        </Tag>
      </div>

      {/* Deadline */}
      <div style={{ marginBottom: 6 }}>
        <Text style={{ fontSize: 11, color: tokens.text.muted }}>
          {t('tasks.detail.deadline')}:{' '}
        </Text>
        <Text
          style={{
            fontSize: 11,
            color: deadlineInfo.color || tokens.text.secondary,
            fontFamily: "'Fira Code', monospace",
          }}
        >
          {deadlineInfo.text}
        </Text>
      </div>

      {/* Tags */}
      {detail.tags && detail.tags.length > 0 && (
        <div style={{ marginBottom: 6 }}>
          <Text style={{ fontSize: 11, color: tokens.text.muted }}>
            {t('tasks.detail.tags')}:{' '}
          </Text>
          {detail.tags.map((tag: string) => (
            <Tag key={tag} style={{ fontSize: 10, margin: '0 4px 2px 0' }}>
              {tag}
            </Tag>
          ))}
        </div>
      )}

      {/* Related Paper */}
      {detail.related_paper_id && (
        <div style={{ marginBottom: 6 }} data-testid="task-detail-related-paper">
          <Text style={{ fontSize: 11, color: tokens.text.muted }}>
            {t('tasks.detail.relatedPaper')}:{' '}
          </Text>
          <Text style={{ fontSize: 11, color: tokens.accent.blue }}>
            {detail.related_paper_id}
          </Text>
        </div>
      )}

      {/* Related File */}
      {detail.related_file_path && (
        <div style={{ marginBottom: 6 }} data-testid="task-detail-related-file">
          <Text style={{ fontSize: 11, color: tokens.text.muted }}>
            {t('tasks.detail.relatedFile', { defaultValue: 'Related File' })}:{' '}
          </Text>
          <a
            role="button"
            tabIndex={0}
            onClick={() => useUiStore.getState().requestWorkspacePreview(detail.related_file_path!)}
            onKeyDown={(e) => { if (e.key === 'Enter') useUiStore.getState().requestWorkspacePreview(detail.related_file_path!); }}
            style={{ fontSize: 11, color: tokens.accent.blue, cursor: 'pointer' }}
          >
            <FileOutlined style={{ marginRight: 3 }} />
            {detail.related_file_path}
          </a>
        </div>
      )}

      {/* Description */}
      <div style={{ marginTop: 8, marginBottom: 8 }}>
        <Text strong style={{ fontSize: 11, color: tokens.text.muted, textTransform: 'uppercase', letterSpacing: 0.5 }}>
          {t('tasks.detail.description')}
        </Text>
        <div style={{ marginTop: 4 }}>
          <Text style={{ fontSize: 12, color: tokens.text.secondary, whiteSpace: 'pre-wrap' }}>
            {detail.description || t('tasks.detail.noNotes')}
          </Text>
        </div>
      </div>

      {/* Subtasks */}
      {detail.subtasks && detail.subtasks.length > 0 && (
        <div style={{ marginBottom: 8 }}>
          <Text strong style={{ fontSize: 11, color: tokens.text.muted, textTransform: 'uppercase', letterSpacing: 0.5 }}>
            {t('tasks.detail.subtasks')} ({detail.subtasks.length})
          </Text>
          <div style={{ marginTop: 4 }}>
            {detail.subtasks.map((sub: Task) => (
              <div key={sub.id} style={{ display: 'flex', alignItems: 'center', gap: 6, paddingTop: 2 }}>
                <span style={{ color: sub.status === 'done' ? tokens.accent.green : tokens.text.muted }}>
                  {sub.status === 'done' ? '[x]' : '[ ]'}
                </span>
                <Text
                  style={{
                    fontSize: 11,
                    color: sub.status === 'done' ? tokens.text.muted : tokens.text.secondary,
                    textDecoration: sub.status === 'done' ? 'line-through' : undefined,
                  }}
                  ellipsis
                >
                  {sub.title}
                </Text>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Notes (from activity log entries of type note_added) */}
      <div style={{ marginBottom: 8 }}>
        <Text strong style={{ fontSize: 11, color: tokens.text.muted, textTransform: 'uppercase', letterSpacing: 0.5 }}>
          {t('tasks.detail.notes')}
        </Text>
        <div style={{ marginTop: 4 }}>
          {recentNotes.length === 0 ? (
            <Text style={{ fontSize: 11, color: tokens.text.muted, fontStyle: 'italic' }}>
              {t('tasks.detail.noNotes')}
            </Text>
          ) : (
            recentNotes.map((entry: ActivityLogEntry) => (
              <div key={entry.id} style={{ marginBottom: 4 }}>
                <Text style={{ fontSize: 10, color: tokens.text.muted, fontFamily: "'Fira Code', monospace" }}>
                  [{formatActivityDate(entry.created_at)} | {entry.actor}]
                </Text>
                <div>
                  <Text style={{ fontSize: 11, color: tokens.text.secondary }}>
                    {entry.new_value}
                  </Text>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Recent Activity */}
      <div style={{ marginBottom: 8 }}>
        <Text strong style={{ fontSize: 11, color: tokens.text.muted, textTransform: 'uppercase', letterSpacing: 0.5 }}>
          {t('tasks.detail.activityLog')}
        </Text>
        <div style={{ marginTop: 4 }}>
          {recentActivity.length === 0 ? (
            <Text style={{ fontSize: 11, color: tokens.text.muted, fontStyle: 'italic' }}>
              {t('tasks.detail.noActivity')}
            </Text>
          ) : (
            recentActivity.map((entry: ActivityLogEntry) => (
              <div key={entry.id} style={{ display: 'flex', gap: 6, alignItems: 'baseline', paddingTop: 2 }}>
                <Text style={{ fontSize: 10, color: tokens.text.muted }}>
                  {formatActivityDate(entry.created_at)}
                </Text>
                <Text style={{ fontSize: 11, color: tokens.text.secondary }}>
                  {t(`tasks.activity.${entry.event_type}`, { defaultValue: entry.event_type })}
                  {entry.old_value && entry.new_value
                    ? `: ${entry.old_value} -> ${entry.new_value}`
                    : entry.new_value
                      ? `: ${entry.new_value}`
                      : ''}
                </Text>
                <Text style={{ fontSize: 10, color: tokens.text.muted }}>
                  ({entry.actor})
                </Text>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Action buttons */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 }}>
        <Button
          type="default"
          size="small"
          icon={<RobotOutlined />}
          onClick={() => onAskAgent(detail)}
          data-testid="ask-agent-button"
          style={{ fontSize: 12 }}
        >
          {t('tasks.detail.askAgent')}
        </Button>
        <Button
          type="text"
          size="small"
          icon={<UpOutlined />}
          onClick={onClose}
          style={{ fontSize: 11, color: tokens.text.muted }}
        >
          {t('tasks.detail.collapse')}
        </Button>
      </div>
    </div>
  );
}

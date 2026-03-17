// Verified against spec 03d §3.2 + 01 §12.2
import React, { useCallback } from 'react';
import { Button, Tag, Typography } from 'antd';
import { CheckCircleOutlined, FileOutlined, RightOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import CardContainer from './CardContainer';
import { useConfigStore } from '@/stores/config';
import { useGatewayStore } from '@/stores/gateway';
import { useUiStore } from '@/stores/ui';
import { getThemeTokens } from '@/styles/theme';
import type { TaskCard as TaskCardType } from '@/types/cards';
import { PRIORITY_COLORS } from '@/utils/task-constants';

const { Text } = Typography;

/** Status badge colors — spec 01 §12.2 */
const STATUS_STYLES: Record<string, { color: string; strikethrough?: boolean }> = {
  todo: { color: '#6B7280' },
  in_progress: { color: '#3B82F6' },
  done: { color: '#22C55E' },
  blocked: { color: '#EF4444' },
  cancelled: { color: '#6B7280', strikethrough: true },
};

function getDeadlineInfo(
  deadline: string | undefined,
  t: (key: string, opts?: Record<string, unknown>) => string,
): { text: string; color?: string } {
  if (!deadline) return { text: t('card.task.noDl') };

  const now = new Date();
  const dl = new Date(deadline);
  const diffMs = dl.getTime() - now.getTime();
  const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays < 0) {
    return { text: t('card.task.overdue'), color: '#EF4444' };
  }
  if (diffDays <= 3) {
    return { text: t('card.task.dueIn', { days: diffDays }), color: '#F59E0B' };
  }
  return { text: dl.toLocaleDateString() };
}

export default function TaskCard(props: TaskCardType) {
  const { t } = useTranslation();
  const theme = useConfigStore((s) => s.theme);
  const tokens = getThemeTokens(theme);
  const client = useGatewayStore((s) => s.client);
  const setRightPanelTab = useUiStore((s) => s.setRightPanelTab);

  const borderColor = PRIORITY_COLORS[props.priority] ?? '#6B7280';
  const statusStyle = STATUS_STYLES[props.status] ?? { color: '#6B7280' };
  const deadlineInfo = getDeadlineInfo(props.deadline, t);

  const canComplete = !!props.id && props.status !== 'done' && props.status !== 'cancelled';

  const handleMarkComplete = useCallback(async () => {
    if (!client || !props.id) return;
    try {
      await client.request('rc.task.complete', { id: props.id });
    } catch {
      // Error handled by gateway layer
    }
  }, [client, props.id]);

  const handleViewInPanel = useCallback(() => {
    setRightPanelTab('tasks');
  }, [setRightPanelTab]);

  return (
    <CardContainer borderColor={borderColor}>
      {/* Title */}
      <Text
        strong
        style={{
          fontSize: 15,
          color: tokens.text.primary,
          display: 'block',
          marginBottom: 8,
          textDecoration: statusStyle.strikethrough ? 'line-through' : undefined,
        }}
      >
        {props.title}
      </Text>

      {/* Description */}
      {props.description && (
        <Text
          style={{
            fontSize: 13,
            color: tokens.text.secondary,
            display: 'block',
            marginBottom: 8,
            lineHeight: 1.5,
          }}
        >
          {props.description}
        </Text>
      )}

      {/* Metadata grid */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 8 }}>
        {/* Priority */}
        <div>
          <Text style={{ fontSize: 12, color: tokens.text.muted }}>
            {t('card.task.priority')}:{' '}
          </Text>
          <Tag
            color={borderColor}
            style={{ fontSize: 11 }}
          >
            {t(`tasks.priority.${props.priority}`, { defaultValue: props.priority })}
          </Tag>
        </div>

        {/* Status */}
        <div>
          <Text style={{ fontSize: 12, color: tokens.text.muted }}>
            {t('card.task.status')}:{' '}
          </Text>
          <Tag
            color={statusStyle.color}
            style={{
              fontSize: 11,
              textDecoration: statusStyle.strikethrough ? 'line-through' : undefined,
            }}
          >
            {t(`tasks.status.${props.status}`, { defaultValue: props.status.replace('_', ' ') })}
          </Tag>
        </div>

        {/* Deadline */}
        <div>
          <Text style={{ fontSize: 12, color: tokens.text.muted }}>
            {t('card.task.deadline')}:{' '}
          </Text>
          <Text
            style={{
              fontSize: 12,
              color: deadlineInfo.color ?? tokens.text.secondary,
              fontFamily: "'JetBrains Mono', 'Fira Code', Consolas, monospace",
            }}
          >
            {deadlineInfo.text}
          </Text>
        </div>

        {/* Related paper */}
        {props.related_paper_title && (
          <div>
            <Text style={{ fontSize: 12, color: tokens.text.muted }}>
              {t('card.task.relatedPaper')}:{' '}
            </Text>
            <Text style={{ fontSize: 12, color: tokens.text.secondary }}>
              {props.related_paper_title}
            </Text>
          </div>
        )}

        {/* Related file */}
        {props.related_file_path && (
          <div>
            <Text style={{ fontSize: 12, color: tokens.text.muted }}>
              {t('card.task.relatedFile', { defaultValue: 'Related File' })}:{' '}
            </Text>
            <a
              role="button"
              tabIndex={0}
              onClick={() => useUiStore.getState().requestWorkspacePreview(props.related_file_path!)}
              style={{ fontSize: 12, color: tokens.accent.blue, cursor: 'pointer' }}
            >
              <FileOutlined style={{ marginRight: 3 }} />
              {props.related_file_path}
            </a>
          </div>
        )}
      </div>

      {/* Actions */}
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <Button
          type="link"
          size="small"
          onClick={handleViewInPanel}
          aria-label={t('card.task.viewInPanel')}
          style={{ color: tokens.accent.blue, paddingLeft: 0, fontSize: 12 }}
        >
          {t('card.task.viewInPanel')} <RightOutlined />
        </Button>

        {canComplete && (
          <Button
            size="small"
            icon={<CheckCircleOutlined />}
            onClick={handleMarkComplete}
            aria-label={t('card.task.markComplete')}
            style={{
              borderColor: tokens.accent.green,
              color: tokens.accent.green,
            }}
          >
            {t('card.task.markComplete')}
          </Button>
        )}
      </div>
    </CardContainer>
  );
}

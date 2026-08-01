import React, { useState } from 'react';
import { Popover, Spin, Tag, Tooltip, Typography } from 'antd';
import { SafetyCertificateOutlined, ToolOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { executionKey, useExecutionTraceStore } from '../../stores/execution-trace';

const { Text } = Typography;

export default function ExecutionDetailsBadge({ sessionKey, runId }: { sessionKey: string; runId: string }) {
  const { t } = useTranslation();
  const key = executionKey(sessionKey, runId);
  const summary = useExecutionTraceStore((state) => state.summaries[key]);
  const detail = useExecutionTraceStore((state) => state.details[key]);
  const loadDetail = useExecutionTraceStore((state) => state.loadDetail);
  const [loading, setLoading] = useState(false);
  if (!summary || (summary.toolCount === 0 && summary.skillCount === 0)) return null;

  const skillEvents = detail?.skillEvents ?? [];
  const candidates = skillEvents.filter((event) => event.lifecycle === 'candidate');
  const terminalEventFor = (skill: NonNullable<typeof detail>['skills'][number]) => (
    [...skillEvents].reverse().find((event) => (
      (event.skill_key === skill.skill_key || event.skill_name === skill.skill_name)
      && (event.lifecycle === 'loaded' || event.lifecycle === 'executed')
    ))
  );

  const content = detail ? (
    <div style={{ width: 360, maxWidth: 'calc(100vw - 24px)' }}>
      <Text strong>{t('executionDetails.tools')}</Text>
      <div style={{ margin: '6px 0 12px', display: 'flex', flexDirection: 'column', gap: 5 }}>
        {detail.tools.map((tool) => (
          <div key={tool.id} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Tag color={tool.status === 'error' ? 'error' : tool.status === 'completed' ? 'success' : 'default'}>
              {t(`executionDetails.status.${tool.status}`)}
            </Tag>
            <Text style={{ flex: 1 }}>{tool.tool_name}</Text>
            {tool.duration_ms !== null && <Text type="secondary">{tool.duration_ms}ms</Text>}
          </div>
        ))}
      </div>
      <Text strong>{t('executionDetails.skills')}</Text>
      <div style={{ margin: '6px 0 12px', display: 'flex', flexDirection: 'column', gap: 5 }}>
        {detail.skills.length > 0
          ? detail.skills.map((skill) => {
            const terminal = terminalEventFor(skill);
            return (
              <div key={skill.id} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <Tag color="blue" style={{ marginInlineEnd: 0 }}>{skill.skill_name}</Tag>
                {terminal && (
                  <Tag color={terminal.lifecycle === 'executed' ? 'green' : 'cyan'} style={{ marginInlineEnd: 0 }}>
                    {t(`executionDetails.lifecycle.${terminal.lifecycle}`)}
                  </Tag>
                )}
                <Text type="secondary" style={{ fontSize: 11 }}>
                  {t(`executionDetails.activation.${skill.activation}`)}
                  {' · '}
                  {t(`executionDetails.skillSource.${skill.skill_source}`, {
                    defaultValue: skill.skill_source,
                  })}
                </Text>
              </div>
            );
          })
          : <Text type="secondary">{t('executionDetails.noneDetected')}</Text>}
      </div>
      {candidates.length > 0 && (
        <>
          <Text strong>{t('executionDetails.candidates')}</Text>
          <div style={{ margin: '6px 0 12px', display: 'flex', flexWrap: 'wrap', gap: 5 }}>
            {candidates.map((candidate) => (
              <Tag key={candidate.id} style={{ marginInlineEnd: 0 }}>
                {candidate.skill_name}
              </Tag>
            ))}
          </div>
        </>
      )}
      <Text strong>{t('executionDetails.review')}</Text>
      <div style={{ marginTop: 6 }}>
        {(detail.reviews?.length ?? 0) > 0
          ? detail.reviews!.map((review) => (
            <Tag key={review.reviewId} icon={<SafetyCertificateOutlined />}>
              {review.verdict || review.state}
            </Tag>
          ))
          : <Text type="secondary">{t('executionDetails.noLinkedReview')}</Text>}
      </div>
    </div>
  ) : <div style={{ width: 180, textAlign: 'center', padding: 12 }}><Spin size="small" /></div>;

  const label = t('executionDetails.summary', {
    tools: summary.toolCount,
    skills: summary.skillCount,
  });
  return (
    <Popover
      content={content}
      title={t('executionDetails.title')}
      trigger="click"
      placement="topLeft"
      onOpenChange={(open) => {
        if (!open || detail || loading) return;
        setLoading(true);
        void loadDetail(sessionKey, runId).finally(() => setLoading(false));
      }}
    >
      <Tooltip title={label}>
        <button
          type="button"
          aria-label={label}
          style={{
            border: '1px solid var(--border)',
            borderRadius: 999,
            background: 'transparent',
            color: 'var(--text-tertiary)',
            fontSize: 11,
            padding: '2px 7px',
            cursor: 'pointer',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
          }}
        >
          <ToolOutlined />
          <span>{summary.toolCount}</span>
          {summary.skillCount > 0 && <span>· S {summary.skillCount}</span>}
        </button>
      </Tooltip>
    </Popover>
  );
}

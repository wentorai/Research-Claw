// Verified against spec 03d §3.3 + 01 §12.3
import React from 'react';
import { Typography } from 'antd';
import { BarChartOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import CardContainer from './CardContainer';
import { useConfigStore } from '@/stores/config';
import { getThemeTokens } from '@/styles/theme';
import type { ProgressCard as ProgressCardType } from '@/types/cards';

const { Text } = Typography;

interface MetricRowProps {
  label: string;
  value: string | number;
  tokens: ReturnType<typeof getThemeTokens>;
}

function MetricRow({ label, value, tokens }: MetricRowProps) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '4px 0',
      }}
    >
      <Text style={{ fontSize: 12, color: tokens.text.muted, textAlign: 'left' }}>
        {label}
      </Text>
      <Text
        style={{
          fontSize: 13,
          color: tokens.text.primary,
          fontFamily: "'JetBrains Mono', 'Fira Code', Consolas, monospace",
          textAlign: 'right',
        }}
      >
        {value}
      </Text>
    </div>
  );
}

export default function ProgressCard(props: ProgressCardType) {
  const { t } = useTranslation();
  const theme = useConfigStore((s) => s.theme);
  const tokens = getThemeTokens(theme);

  // Urgent border: if highlights contain overdue/urgent keywords, use red
  const hasUrgent = props.highlights?.some((h) =>
    /\b(overdue|urgent|逾期|紧急|URGENT|OVERDUE)\b/i.test(h),
  );
  const borderColor = hasUrgent ? '#EF4444' : tokens.accent.blue;

  return (
    <CardContainer borderColor={borderColor}>
      {/* Header: icon + title + period */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <BarChartOutlined style={{ fontSize: 20, color: tokens.accent.blue }} />
        <div style={{ flex: 1 }}>
          <Text strong style={{ fontSize: 15, color: tokens.text.primary }}>
            {t('card.progress.title')}
          </Text>
          <Text style={{ fontSize: 12, color: tokens.text.muted, marginLeft: 8 }}>
            {props.period}
          </Text>
        </div>
      </div>

      {/* Metrics grid — 2 columns */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: '0 24px',
          marginBottom: props.highlights && props.highlights.length > 0 ? 12 : 0,
        }}
      >
        <MetricRow label={t('card.progress.papersRead')} value={props.papers_read} tokens={tokens} />
        <MetricRow label={t('card.progress.papersAdded')} value={props.papers_added} tokens={tokens} />
        <MetricRow label={t('card.progress.tasksCompleted')} value={props.tasks_completed} tokens={tokens} />
        <MetricRow label={t('card.progress.tasksCreated')} value={props.tasks_created} tokens={tokens} />
        {props.writing_words != null && (
          <MetricRow label={t('card.progress.writingWords')} value={props.writing_words} tokens={tokens} />
        )}
        {props.reading_minutes != null && (
          <MetricRow label={t('card.progress.readingMinutes')} value={props.reading_minutes} tokens={tokens} />
        )}
      </div>

      {/* Highlights */}
      {props.highlights && props.highlights.length > 0 && (
        <div>
          <Text style={{ fontSize: 12, color: tokens.text.muted, display: 'block', marginBottom: 4 }}>
            {t('card.progress.highlights')}:
          </Text>
          <ul style={{ margin: 0, paddingLeft: 20 }}>
            {props.highlights.map((item, idx) => (
              <li key={idx}>
                <Text style={{ fontSize: 13, color: tokens.text.secondary, lineHeight: 1.5 }}>
                  {item}
                </Text>
              </li>
            ))}
          </ul>
        </div>
      )}
    </CardContainer>
  );
}

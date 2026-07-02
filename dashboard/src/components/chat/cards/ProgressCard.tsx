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
const MAX_HIGHLIGHTS = 5;
const MAX_HIGHLIGHT_CHARS = 96;

interface MetricRowProps {
  label: string;
  value: string | number;
  tokens: ReturnType<typeof getThemeTokens>;
}

function MetricPill({ label, value, tokens }: MetricRowProps) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 3,
        minWidth: 0,
        padding: '8px 10px',
        border: `1px solid ${tokens.border.default}`,
        borderRadius: 6,
        background: tokens.bg.surfaceHover,
      }}
    >
      <Text
        style={{
          fontSize: 11,
          color: tokens.text.muted,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {label}
      </Text>
      <Text
        strong
        style={{
          fontSize: 16,
          color: tokens.text.primary,
          fontFamily: "'JetBrains Mono', 'Fira Code', Consolas, monospace",
          lineHeight: 1.1,
        }}
      >
        {value}
      </Text>
    </div>
  );
}

function formatPeriod(period: string, t: ReturnType<typeof useTranslation>['t']): string {
  const key = `card.progress.period.${period}`;
  const translated = t(key);
  return translated === key ? period : translated;
}

function truncateHighlight(value: string): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  if (compact.length <= MAX_HIGHLIGHT_CHARS) return compact;
  return `${compact.slice(0, MAX_HIGHLIGHT_CHARS - 1)}…`;
}

export default function ProgressCard(props: ProgressCardType) {
  const { t } = useTranslation();
  const theme = useConfigStore((s) => s.theme);
  const tokens = getThemeTokens(theme);
  const highlights = (props.highlights ?? []).slice(0, MAX_HIGHLIGHTS).map(truncateHighlight);
  const hiddenHighlightCount = Math.max((props.highlights?.length ?? 0) - MAX_HIGHLIGHTS, 0);

  // Urgent border: if highlights contain overdue/urgent keywords, use red
  const hasUrgent = props.highlights?.some((h) =>
    /\b(overdue|urgent|逾期|紧急|URGENT|OVERDUE)\b/i.test(h),
  );
  const borderColor = hasUrgent ? '#EF4444' : tokens.accent.blue;

  return (
    <CardContainer borderColor={borderColor} maxWidth={520}>
      {/* Header: icon + title + period */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
        <BarChartOutlined style={{ fontSize: 18, color: borderColor }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <Text strong style={{ fontSize: 15, color: tokens.text.primary }}>
            {t('card.progress.title')}
          </Text>
          <Text
            style={{
              fontSize: 12,
              color: tokens.text.muted,
              marginLeft: 8,
              whiteSpace: 'nowrap',
            }}
          >
            {formatPeriod(props.period, t)}
          </Text>
        </div>
      </div>

      {/* Metrics grid */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(112px, 1fr))',
          gap: 8,
          marginBottom: highlights.length > 0 ? 10 : 0,
        }}
      >
        <MetricPill label={t('card.progress.papersRead')} value={props.papers_read} tokens={tokens} />
        <MetricPill label={t('card.progress.papersAdded')} value={props.papers_added} tokens={tokens} />
        <MetricPill label={t('card.progress.tasksCompleted')} value={props.tasks_completed} tokens={tokens} />
        <MetricPill label={t('card.progress.tasksCreated')} value={props.tasks_created} tokens={tokens} />
        {props.writing_words != null && (
          <MetricPill label={t('card.progress.writingWords')} value={props.writing_words} tokens={tokens} />
        )}
        {props.reading_minutes != null && (
          <MetricPill label={t('card.progress.readingMinutes')} value={props.reading_minutes} tokens={tokens} />
        )}
      </div>

      {/* Highlights */}
      {highlights.length > 0 && (
        <div>
          <Text style={{ fontSize: 11, color: tokens.text.muted, display: 'block', marginBottom: 6 }}>
            {t('card.progress.highlights')}:
          </Text>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {highlights.map((item, idx) => (
              <li key={idx}>
                <Text style={{ fontSize: 12, color: tokens.text.secondary, lineHeight: 1.45 }}>
                  {item}
                </Text>
              </li>
            ))}
          </ul>
          {hiddenHighlightCount > 0 && (
            <Text style={{ fontSize: 11, color: tokens.text.muted, display: 'block', marginTop: 4 }}>
              {t('card.progress.moreHighlights', { count: hiddenHighlightCount })}
            </Text>
          )}
        </div>
      )}
    </CardContainer>
  );
}

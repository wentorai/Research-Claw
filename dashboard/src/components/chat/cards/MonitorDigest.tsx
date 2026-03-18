// Monitor Digest card — universal monitor scan results
// Replaces radar_digest for monitor-initiated scans (8 source types).
import React from 'react';
import { Tag, Typography } from 'antd';
import { MonitorOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import CardContainer from './CardContainer';
import { useConfigStore } from '@/stores/config';
import { getThemeTokens } from '@/styles/theme';
import type { MonitorDigest as MonitorDigestType } from '@/types/cards';

const { Text } = Typography;

/** Source type → display color */
const SOURCE_COLORS: Record<string, string> = {
  arxiv: '#B91C1C',
  semantic_scholar: '#2563EB',
  github: '#6E5494',
  rss: '#F97316',
  webpage: '#0EA5E9',
  openalex: '#059669',
  twitter: '#1DA1F2',
  custom: '#6B7280',
};

export default function MonitorDigest(props: MonitorDigestType) {
  const { t } = useTranslation();
  const theme = useConfigStore((s) => s.theme);
  const tokens = getThemeTokens(theme);

  // Visual weight: green for hits, muted for empty results
  const borderColor = props.total_found > 0 ? '#10B981' : tokens.text.muted;
  const sourceColor = SOURCE_COLORS[props.source_type] ?? '#6B7280';

  return (
    <CardContainer borderColor={borderColor}>
      {/* Header: monitor icon + title */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <MonitorOutlined style={{ fontSize: 20, color: '#10B981' }} />
        <Text strong style={{ fontSize: 15, color: tokens.text.primary }}>
          {t('card.monitor.title', { defaultValue: 'Monitor Results' })}
        </Text>
      </div>

      {/* Monitor name */}
      <Text style={{ fontSize: 14, color: tokens.text.primary, fontWeight: 500, display: 'block', marginBottom: 8 }}>
        {props.monitor_name}
      </Text>

      {/* Summary line */}
      <Text style={{ fontSize: 13, color: tokens.text.secondary, display: 'block', marginBottom: 8 }}>
        {t('card.monitor.found', { count: props.total_found, defaultValue: `Found ${props.total_found} result(s)` })}
      </Text>

      {/* Source + Target + Schedule metadata */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
        <div>
          <Text style={{ fontSize: 12, color: tokens.text.muted }}>
            {t('card.monitor.source', { defaultValue: 'Source' })}:{' '}
          </Text>
          <Tag color={sourceColor} style={{ fontSize: 11 }}>{props.source_type}</Tag>
        </div>
        <div>
          <Text style={{ fontSize: 12, color: tokens.text.muted }}>
            {t('card.monitor.target', { defaultValue: 'Target' })}:{' '}
          </Text>
          <Text style={{ fontSize: 12, color: tokens.text.secondary }}>
            {props.target}
          </Text>
        </div>
        {props.schedule && (
          <div>
            <Text style={{ fontSize: 12, color: tokens.text.muted }}>
              {t('card.monitor.schedule', { defaultValue: 'Schedule' })}:{' '}
            </Text>
            <Text style={{
              fontSize: 12,
              color: tokens.text.secondary,
              fontFamily: "'JetBrains Mono', 'Fira Code', Consolas, monospace",
            }}>
              {props.schedule}
            </Text>
          </div>
        )}
      </div>

      {/* Findings list */}
      {props.findings.length > 0 && (
        <div>
          <Text style={{ fontSize: 12, color: tokens.text.muted, display: 'block', marginBottom: 6 }}>
            {t('card.monitor.findings', { defaultValue: 'Findings' })}:
          </Text>
          <ol style={{ margin: 0, paddingLeft: 20 }}>
            {props.findings.map((finding, idx) => (
              <li key={idx} style={{ marginBottom: 8 }}>
                {finding.url ? (
                  <a
                    href={finding.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ fontSize: 13, color: tokens.accent.blue, fontWeight: 500 }}
                  >
                    {finding.title}
                  </a>
                ) : (
                  <Text style={{ fontSize: 13, color: tokens.text.primary, fontWeight: 500, display: 'block' }}>
                    {finding.title}
                  </Text>
                )}
                {finding.summary && (
                  <Text style={{ fontSize: 12, color: tokens.text.muted, fontStyle: 'italic', display: 'block' }}>
                    {finding.summary}
                  </Text>
                )}
              </li>
            ))}
          </ol>
        </div>
      )}
    </CardContainer>
  );
}

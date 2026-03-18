// Verified against spec 03d §3.5 + 01 §12.5
import React from 'react';
import { Tag, Typography } from 'antd';
import { RadarChartOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import CardContainer from './CardContainer';
import { useConfigStore } from '@/stores/config';
import { getThemeTokens } from '@/styles/theme';
import type { RadarDigest as RadarDigestType } from '@/types/cards';

const { Text } = Typography;

export default function RadarDigest(props: RadarDigestType) {
  const { t } = useTranslation();
  const theme = useConfigStore((s) => s.theme);
  const tokens = getThemeTokens(theme);

  // Visual weight: green for hits, muted for empty results
  const borderColor = props.total_found > 0 ? '#10B981' : tokens.text.muted;

  return (
    <CardContainer borderColor={borderColor}>
      {/* Header: satellite icon + title */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <RadarChartOutlined style={{ fontSize: 20, color: tokens.accent.blue }} />
        <Text strong style={{ fontSize: 15, color: tokens.text.primary }}>
          {t('card.radar.title')}
        </Text>
      </div>

      {/* Summary line */}
      <Text style={{ fontSize: 13, color: tokens.text.secondary, display: 'block', marginBottom: 8 }}>
        {t('card.radar.found', { count: props.total_found })}
      </Text>

      {/* Source + Query + Period metadata */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
        <div>
          <Text style={{ fontSize: 12, color: tokens.text.muted }}>
            {t('card.radar.source')}:{' '}
          </Text>
          <Tag style={{ fontSize: 11 }}>{props.source}</Tag>
        </div>
        <div>
          <Text style={{ fontSize: 12, color: tokens.text.muted }}>
            {t('card.radar.query')}:{' '}
          </Text>
          <Text style={{ fontSize: 12, color: tokens.text.secondary }}>
            &quot;{props.query}&quot;
          </Text>
        </div>
        <div>
          <Text style={{ fontSize: 12, color: tokens.text.muted }}>
            {t('card.radar.period')}:{' '}
          </Text>
          <Text style={{ fontSize: 12, color: tokens.text.secondary }}>
            {props.period}
          </Text>
        </div>
      </div>

      {/* Notable papers list */}
      {props.notable_papers.length > 0 && (
        <div>
          <Text style={{ fontSize: 12, color: tokens.text.muted, display: 'block', marginBottom: 6 }}>
            {t('card.radar.notablePapers')}:
          </Text>
          <ol style={{ margin: 0, paddingLeft: 20 }}>
            {props.notable_papers.map((paper, idx) => (
              <li key={idx} style={{ marginBottom: 8 }}>
                <Text
                  style={{
                    fontSize: 13,
                    color: tokens.text.primary,
                    fontWeight: 500,
                    display: 'block',
                  }}
                >
                  {paper.title}
                </Text>
                <Text style={{ fontSize: 12, color: tokens.text.muted, display: 'block' }}>
                  {paper.authors.join(', ')}
                </Text>
                <Text style={{ fontSize: 12, color: tokens.text.muted, fontStyle: 'italic' }}>
                  {t('card.radar.relevance')}: {paper.relevance_note}
                </Text>
              </li>
            ))}
          </ol>
        </div>
      )}
    </CardContainer>
  );
}

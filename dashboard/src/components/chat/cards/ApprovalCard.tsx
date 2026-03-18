// Verified against spec 03d §3.4 + 01 §12.4
import React, { useCallback, useState } from 'react';
import { Button, Dropdown, Tag, Typography } from 'antd';
import { WarningOutlined, ExclamationCircleOutlined, CheckCircleOutlined, CloseCircleOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import CardContainer from './CardContainer';
import { useConfigStore } from '@/stores/config';
import { useGatewayStore } from '@/stores/gateway';
import { getThemeTokens } from '@/styles/theme';
import type { ApprovalCard as ApprovalCardType } from '@/types/cards';

const { Text } = Typography;

type ApprovalStatus = 'pending' | 'allowed' | 'denied';

/** Risk level colors — spec 01 §12.4 */
const RISK_BORDER_COLORS: Record<string, string> = {
  low: '#22C55E',
  medium: '#F59E0B',
  high: '#EF4444',
};

interface ApprovalCardProps extends ApprovalCardType {
  onResolve?: (decision: 'allow-once' | 'allow-always' | 'deny') => void;
}

export default function ApprovalCard(props: ApprovalCardProps) {
  const { t } = useTranslation();
  const theme = useConfigStore((s) => s.theme);
  const tokens = getThemeTokens(theme);
  const client = useGatewayStore((s) => s.client);
  const [status, setStatus] = useState<ApprovalStatus>('pending');

  const borderColor = RISK_BORDER_COLORS[props.risk_level] ?? '#F59E0B';

  const handleResolve = useCallback(async (decision: 'allow-once' | 'allow-always' | 'deny') => {
    if (!client || !props.approval_id) {
      // No approval_id: update visual state only (informational card).
      // The onResolve callback may also fire if the parent provided one.
      setStatus(decision === 'deny' ? 'denied' : 'allowed');
      props.onResolve?.(decision);
      return;
    }
    try {
      await client.request('exec.approval.resolve', {
        id: props.approval_id,
        decision,
      });
      setStatus(decision === 'deny' ? 'denied' : 'allowed');
      props.onResolve?.(decision);
    } catch {
      // Error handled by gateway layer
    }
  }, [client, props]);

  const riskLabel = {
    low: t('card.approval.riskLow'),
    medium: t('card.approval.riskMedium'),
    high: t('card.approval.riskHigh'),
  }[props.risk_level] ?? props.risk_level;

  const riskIcon = props.risk_level === 'high'
    ? <WarningOutlined style={{ color: '#EF4444' }} />
    : props.risk_level === 'medium'
      ? <ExclamationCircleOutlined style={{ color: '#F59E0B' }} />
      : null;

  const isPending = status === 'pending';

  return (
    <CardContainer borderColor={borderColor}>
      {/* Header: warning icon + title */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <WarningOutlined style={{ fontSize: 20, color: '#F59E0B' }} />
        <Text strong style={{ fontSize: 15, color: '#F59E0B' }}>
          {t('card.approval.title')}
        </Text>
      </div>

      {/* Status badge if resolved */}
      {!isPending && (
        <div style={{ marginBottom: 8 }}>
          {status === 'allowed' ? (
            <Tag
              icon={<CheckCircleOutlined />}
              color="#22C55E"
              style={{ fontSize: 12 }}
            >
              {t('card.approval.approved')}
            </Tag>
          ) : (
            <Tag
              icon={<CloseCircleOutlined />}
              color="#EF4444"
              style={{ fontSize: 12 }}
            >
              {t('card.approval.rejected')}
            </Tag>
          )}
        </div>
      )}

      {/* Key-value pairs: Action, Context, Risk */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
        <div>
          <Text style={{ fontSize: 12, color: tokens.text.muted }}>
            {t('card.approval.action')}:{' '}
          </Text>
          <Text style={{ fontSize: 14, color: tokens.text.primary }}>
            {props.action}
          </Text>
        </div>

        <div>
          <Text style={{ fontSize: 12, color: tokens.text.muted }}>
            {t('card.approval.context')}:{' '}
          </Text>
          <Text style={{ fontSize: 14, color: tokens.text.secondary }}>
            {props.context}
          </Text>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <Text style={{ fontSize: 12, color: tokens.text.muted }}>
            {t('card.approval.riskLevel')}:{' '}
          </Text>
          {riskIcon}
          <Tag
            color={borderColor}
            style={{
              fontSize: 11,
              animation: props.risk_level === 'high' ? 'pulse-glow 2s ease-in-out infinite' : undefined,
            }}
          >
            {riskLabel}
          </Tag>
        </div>
      </div>

      {/* Details — JSON key-value summary */}
      {props.details && Object.keys(props.details).length > 0 && (
        <div
          style={{
            background: tokens.bg.code,
            borderRadius: 4,
            padding: 8,
            marginBottom: 12,
          }}
        >
          <Text style={{ fontSize: 12, color: tokens.text.muted, display: 'block', marginBottom: 4 }}>
            {t('card.approval.details')}:
          </Text>
          {Object.entries(props.details).map(([key, value]) => (
            <div key={key} style={{ display: 'flex', justifyContent: 'space-between', padding: '2px 0' }}>
              <Text style={{
                fontSize: 12,
                color: tokens.text.muted,
                fontFamily: "'JetBrains Mono', 'Fira Code', Consolas, monospace",
              }}>
                {key}
              </Text>
              <Text style={{
                fontSize: 12,
                color: tokens.text.secondary,
                fontFamily: "'JetBrains Mono', 'Fira Code', Consolas, monospace",
                maxWidth: 300,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}>
                {typeof value === 'string' ? value : JSON.stringify(value)}
              </Text>
            </div>
          ))}
        </div>
      )}

      {/* Action buttons */}
      {isPending && (
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          {/* Approve: primary "Allow Once" + dropdown "Always Allow" (hidden for high risk) */}
          {props.risk_level === 'high' ? (
            <Button
              type="primary"
              size="small"
              onClick={() => handleResolve('allow-once')}
              aria-label={t('card.approval.approve')}
              style={{
                background: '#22C55E',
                borderColor: '#22C55E',
                color: '#FFFFFF',
              }}
            >
              {t('card.approval.approve')}
            </Button>
          ) : (
            <Dropdown.Button
              type="primary"
              size="small"
              onClick={() => handleResolve('allow-once')}
              menu={{
                items: [
                  {
                    key: 'always',
                    label: t('card.approval.approveAlways'),
                    onClick: () => handleResolve('allow-always'),
                  },
                ],
              }}
              buttonsRender={([leftButton, rightButton]) => [
                React.cloneElement(leftButton as React.ReactElement, {
                  'aria-label': t('card.approval.approve'),
                  style: {
                    background: '#22C55E',
                    borderColor: '#22C55E',
                    color: '#FFFFFF',
                  },
                }),
                React.cloneElement(rightButton as React.ReactElement, {
                  'aria-label': t('card.approval.approveAlways'),
                  style: {
                    background: '#22C55E',
                    borderColor: '#22C55E',
                    color: '#FFFFFF',
                  },
                }),
              ]}
            >
              {t('card.approval.approve')}
            </Dropdown.Button>
          )}

          {/* Reject button */}
          <Button
            size="small"
            danger
            onClick={() => handleResolve('deny')}
            aria-label={t('card.approval.reject')}
            style={{
              borderColor: '#EF4444',
              color: '#EF4444',
            }}
          >
            {t('card.approval.reject')}
          </Button>
        </div>
      )}
    </CardContainer>
  );
}

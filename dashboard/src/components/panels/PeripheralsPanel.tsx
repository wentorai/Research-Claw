/**
 * PeripheralsPanel — Peripheral device management hub
 *
 * Skeleton for Task 9; device slots filled in T14-T17.
 * Layout:
 *   - Panel title
 *   - Disconnected degradation (mirrors SupervisorPanel pattern)
 *   - Four device card placeholders when connected:
 *       camera / Plaud / physical-lab / embodied-research-AI
 */

import React, { useState } from 'react';
import { Button, Typography } from 'antd';
import { ArrowLeftOutlined, CameraOutlined, RightOutlined, UsbOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { useGatewayStore } from '../../stores/gateway';
import { getThemeTokens } from '../../styles/theme';
import { useConfigStore } from '../../stores/config';
import CameraDetail from '../peripherals/CameraDetail';
import PlaudCard from '../peripherals/PlaudCard';
import { LabPlaceholderCard, EmbodiedPlaceholderCard } from '../peripherals/PlaceholderCards';

const { Text } = Typography;

/** Which device detail view is open, or null for the slot list. */
type DetailView = 'camera' | null;

// ── Device slot placeholder ───────────────────────────────────────────────────

interface DeviceSlotProps {
  testId: string;
  labelKey: string;
  icon?: React.ReactNode;
  onClick?: () => void;
}

function DeviceSlot({ testId, labelKey, icon, onClick }: DeviceSlotProps) {
  const { t } = useTranslation();
  const interactive = Boolean(onClick);
  return (
    <div
      data-testid={testId}
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      onClick={onClick}
      onKeyDown={
        interactive
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onClick?.();
              }
            }
          : undefined
      }
      style={{
        padding: '16px',
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: '8px',
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        color: 'var(--text-secondary)',
        cursor: interactive ? 'pointer' : 'default',
      }}
    >
      {icon ?? <UsbOutlined style={{ fontSize: 20, color: 'var(--text-secondary)', flexShrink: 0 }} />}
      <Text style={{ fontSize: 14, color: 'var(--text-secondary)', flex: 1 }}>
        {t(labelKey)}
      </Text>
      {interactive && <RightOutlined style={{ fontSize: 12, color: 'var(--text-secondary)', flexShrink: 0 }} />}
    </div>
  );
}

// ── Main Panel ────────────────────────────────────────────────────────────────

export default function PeripheralsPanel() {
  const { t } = useTranslation();
  const theme = useConfigStore((s) => s.theme);
  const tokens = getThemeTokens(theme);
  const isConnected = useGatewayStore((s) => s.state === 'connected');

  // Panel-local list ↔ detail navigation (no global routing).
  const [detail, setDetail] = useState<DetailView>(null);

  if (!isConnected) {
    return (
      <div style={{ padding: 16, textAlign: 'center' }}>
        <Text style={{ color: tokens.text.muted }}>{t('periph.disconnected', 'Connect to gateway to manage peripherals')}</Text>
      </div>
    );
  }

  // ── Camera detail view ─────────────────────────────────────────
  if (detail === 'camera') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '8px 12px',
            borderBottom: '1px solid var(--border)',
            flexShrink: 0,
          }}
        >
          <Button
            data-testid="periph-detail-back"
            size="small"
            type="text"
            icon={<ArrowLeftOutlined />}
            onClick={() => setDetail(null)}
          >
            {t('periph.back', 'Back')}
          </Button>
          <CameraOutlined style={{ color: 'var(--accent-secondary)' }} />
          <Text strong style={{ fontSize: 14, color: 'var(--text-primary)' }}>
            {t('periph.slotCamera')}
          </Text>
        </div>
        <div style={{ flex: 1, overflowY: 'auto' }}>
          <CameraDetail browserDeviceId={null} />
        </div>
      </div>
    );
  }

  // ── Slot list ──────────────────────────────────────────────────
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        overflow: 'hidden',
      }}
    >
      {/* ── Header ──────────────────────────────────────────────── */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '12px 16px',
          borderBottom: '1px solid var(--border)',
          flexShrink: 0,
        }}
      >
        <UsbOutlined style={{ color: 'var(--accent-secondary)' }} />
        <Text strong style={{ fontSize: 14, color: 'var(--text-primary)' }}>
          {t('periph.title')}
        </Text>
      </div>

      {/* ── Device card grid ────────────────────────────────────── */}
      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '16px',
          display: 'flex',
          flexDirection: 'column',
          gap: '12px',
        }}
      >
        <DeviceSlot
          testId="periph-slot-camera"
          labelKey="periph.slotCamera"
          icon={<CameraOutlined style={{ fontSize: 20, color: 'var(--text-secondary)', flexShrink: 0 }} />}
          onClick={() => setDetail('camera')}
        />
        <div data-testid="periph-slot-plaud">
          <PlaudCard />
        </div>
        <div data-testid="periph-slot-lab">
          <LabPlaceholderCard />
        </div>
        <div data-testid="periph-slot-embodied">
          <EmbodiedPlaceholderCard />
        </div>
      </div>
    </div>
  );
}

/**
 * PeripheralsPanel — Peripheral device management hub (Information Architecture v2).
 *
 * §14 rewrite: device cards are first-class citizens.
 *   - Data source flip (§14.1): the top level renders usePeripheralsStore.devices
 *     (rc_periph_devices), NOT four hardcoded slots and NOT the current browser
 *     enumeration. Browser enumeration is DEMOTED to an internal source for the
 *     add-device / detail / rebind flows only.
 *   - Explicit [+ Add device] entry (§14.3) → AddDeviceFlow (browser camera / Plaud
 *     / RTSP-greyed).
 *   - Each device renders a DeviceCard (§14.2) with its OWN monitors + timeline
 *     (§14.4).
 *   - Camera detail (§14.5) is reached FROM a card; CameraDetail receives the
 *     registered rc_periph_devices id for every camera driver.
 *   - Unregistered / bridge-off state renders a GUIDE card (§14.6 / P1-U1), never a
 *     silent empty div.
 *   - Lab / Embodied placeholder cards (non-device vision cards) stay at the bottom.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Button, Typography } from 'antd';
import { ArrowLeftOutlined, CameraOutlined, PlusOutlined, UsbOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { useGatewayStore } from '../../stores/gateway';
import { getThemeTokens } from '../../styles/theme';
import { useConfigStore } from '../../stores/config';
import { useModelCatalogStore } from '../../stores/model-catalog';
import { useMonitorStore } from '../../stores/monitor';
import { usePeripheralsStore, type PeriphDeviceRow } from '../../stores/peripherals';
import CameraDetail from '../peripherals/CameraDetail';
import DeviceCard, { type BrowserCameraOption } from '../peripherals/DeviceCard';
import AddDeviceFlow from '../peripherals/AddDeviceFlow';
import { LabPlaceholderCard, EmbodiedPlaceholderCard } from '../peripherals/PlaceholderCards';

const { Text } = Typography;

/** Panel-local navigation: the stable registered peripheral id. */
interface CameraDetailNav {
  deviceId: string;
  deviceName?: string;
}

function isCameraUsable(): boolean {
  return Boolean(window.isSecureContext) && Boolean(navigator.mediaDevices?.getUserMedia);
}

export default function PeripheralsPanel() {
  const { t } = useTranslation();
  const theme = useConfigStore((s) => s.theme);
  const tokens = getThemeTokens(theme);
  const isConnected = useGatewayStore((s) => s.state === 'connected');

  const devices = usePeripheralsStore((s) => s.devices);
  const loadDevices = usePeripheralsStore((s) => s.loadDevices);
  const announceBridge = usePeripheralsStore((s) => s.announceBridge);
  const unavailable = usePeripheralsStore((s) => s.unavailable);
  const loadMonitors = useMonitorStore((s) => s.loadMonitors);
  const monitorsLoaded = useMonitorStore((s) => s.loaded);

  // Panel-local list ↔ camera-detail navigation (no global routing).
  const [detail, setDetail] = useState<CameraDetailNav | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  // ── Browser enumeration (§14.1: internal source only) ──────────────────────
  const usable = isCameraUsable();
  const [browserCameras, setBrowserCameras] = useState<BrowserCameraOption[]>([]);
  const [needsAuth, setNeedsAuth] = useState(false);

  const refreshCameras = useCallback(async () => {
    if (!usable) return;
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      const cams = all
        .filter((d) => d.kind === 'videoinput')
        .map((d) => ({ deviceId: d.deviceId, label: d.label }));
      setBrowserCameras(cams);
      // Labels are empty until getUserMedia has been granted once.
      setNeedsAuth(cams.length > 0 && cams.every((c) => !c.label));
    } catch {
      setBrowserCameras([]);
    }
  }, [usable]);

  const authorizeCameras = useCallback(async () => {
    if (!usable) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      for (const track of stream.getTracks()) track.stop();
      await refreshCameras();
    } catch {
      // Non-fatal in the panel; AddDeviceFlow/CameraDetail surface actionable copy.
    }
  }, [usable, refreshCameras]);

  // ── Mount: warm devices + monitors + catalog + enumeration ──────────────────
  const fetchCatalog = useModelCatalogStore((s) => s.fetchCatalog);
  useEffect(() => {
    if (!isConnected) return;
    void loadDevices();
    if (!monitorsLoaded) void loadMonitors();
    if (!useModelCatalogStore.getState().catalog) void fetchCatalog();
    void refreshCameras();
  }, [isConnected, loadDevices, loadMonitors, monitorsLoaded, fetchCatalog, refreshCameras]);

  // ── Re-announce enabled camera bridges once enumeration is available ────────
  // Enabled browser-camera devices need their bridge re-announced so the gateway
  // can map frame requests to the current mediaDevice id (bridge announce is
  // fire-and-forget; the panel is the natural place to re-run it on mount).
  useEffect(() => {
    if (!isConnected || !usable || browserCameras.length === 0) return;
    const toAnnounce = devices
      .filter((d) => d.driver === 'browser-camera' && d.enabled)
      .map((d) => {
        const cfg = d.config as { deviceId?: string; label?: string };
        return cfg.deviceId && browserCameras.some((c) => c.deviceId === cfg.deviceId)
          ? { deviceId: cfg.deviceId, label: cfg.label || d.name }
          : null;
      })
      .filter(Boolean) as Array<{ deviceId: string; label: string }>;
    if (toAnnounce.length > 0) void announceBridge(toAnnounce, window.isSecureContext);
    // Only re-announce when the device set or enumeration changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isConnected, usable, devices, browserCameras]);

  const bridgeOnline = usable && window.isSecureContext;

  // ── Split devices: real device cards vs placeholder kinds ───────────────────
  const deviceCards = useMemo(
    () => devices.filter((d) => d.kind !== 'lab-instrument' && d.kind !== 'embodied'),
    [devices],
  );

  const openCameraDetail = useCallback((device: PeriphDeviceRow) => {
    setDetail({ deviceId: device.id, deviceName: device.name });
  }, []);

  if (!isConnected) {
    return (
      <div style={{ padding: 16, textAlign: 'center' }}>
        <Text style={{ color: tokens.text.muted }}>
          {t('periph.disconnected', 'Connect to gateway to manage peripherals')}
        </Text>
      </div>
    );
  }

  // ── Camera detail view (§14.5) ─────────────────────────────────────────────
  if (detail) {
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
            {detail.deviceName ?? t('periph.slotCamera', 'Camera')}
          </Text>
        </div>
        <div style={{ flex: 1, overflowY: 'auto' }}>
          <CameraDetail deviceId={detail.deviceId} />
        </div>
      </div>
    );
  }

  // ── Device-card hub ─────────────────────────────────────────────────────────
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* Header + [+ Add device] */}
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
        <Text strong style={{ fontSize: 14, color: 'var(--text-primary)', flex: 1 }}>
          {t('periph.title', 'Peripherals')}
        </Text>
        <Button
          data-testid="periph-add-device-btn"
          size="small"
          type="primary"
          icon={<PlusOutlined />}
          onClick={() => setAddOpen(true)}
        >
          {t('periph.add.button', 'Add device')}
        </Button>
      </div>

      {/* Device cards + guide + placeholders */}
      <div
        data-testid="periph-device-list"
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          padding: '16px',
          // A constrained column flexbox shrinks its children by default.
          // DeviceCard intentionally clips its rounded border with
          // overflow:hidden, so shrinking used to cut off the action row.
          // Max-content grid tracks preserve each card's intrinsic height and
          // move overflow ownership to this scrolling list.
          display: 'grid',
          gridAutoRows: 'max-content',
          alignContent: 'start',
          gap: '12px',
        }}
      >
        {unavailable && (
          <Alert
            data-testid="periph-unavailable-banner"
            type="error"
            showIcon
            message={t('periph.pluginOutdated', 'Plugin version is too old — please update Research-Claw.')}
            style={{ borderRadius: 8 }}
          />
        )}

        {/* Registered device cards (§14.2), each with its own monitors+timeline */}
        {deviceCards.length === 0 ? (
          // Guide card (§14.6 / P1-U1) — never a silent empty div.
          <div
            data-testid="periph-empty-guide"
            style={{
              padding: '20px 16px',
              borderRadius: 8,
              border: `1px dashed ${tokens.border.default}`,
              background: tokens.bg.surface,
              textAlign: 'center',
            }}
          >
            <CameraOutlined style={{ fontSize: 28, color: tokens.text.muted, display: 'block', marginBottom: 8 }} />
            <Text style={{ color: tokens.text.secondary, display: 'block', marginBottom: 4 }}>
              {t('periph.emptyTitle', 'No devices yet')}
            </Text>
            <Text style={{ color: tokens.text.muted, fontSize: 12, display: 'block', marginBottom: 12 }}>
              {t(
                'periph.emptyHint',
                'Add a camera or recorder, then the agent can verify it on a schedule and keep an observation timeline.',
              )}
            </Text>
            <Button
              data-testid="periph-empty-add-btn"
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => setAddOpen(true)}
            >
              {t('periph.add.button', 'Add device')}
            </Button>
          </div>
        ) : (
          deviceCards.map((device) => (
            <DeviceCard
              key={device.id}
              device={device}
              browserCameras={browserCameras}
              bridgeOnline={bridgeOnline}
              onOpenCameraDetail={openCameraDetail}
            />
          ))
        )}

        {/* Placeholder vision cards (§14.7) — non-device, kept below device cards */}
        <div data-testid="periph-slot-lab">
          <LabPlaceholderCard />
        </div>
        <div data-testid="periph-slot-embodied">
          <EmbodiedPlaceholderCard />
        </div>
      </div>

      {/* Add-device modal (§14.3) */}
      <AddDeviceFlow
        open={addOpen}
        onClose={() => setAddOpen(false)}
        browserCameras={browserCameras}
        onRefreshCameras={refreshCameras}
        cameraUsable={usable}
        needsAuth={needsAuth}
        onAuthorize={authorizeCameras}
      />
    </div>
  );
}

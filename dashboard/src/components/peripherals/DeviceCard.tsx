/**
 * DeviceCard — a top-level peripheral device card (§14.2 / §14.4 / §14.6).
 *
 * Information Architecture v2: device cards are first-class citizens. This card
 * renders ONE registered `rc_periph_devices` row (from usePeripheralsStore.devices)
 * — NOT a browser enumeration slot. It carries:
 *   - name + kind icon (camera / audio-recorder)
 *   - a ChannelCard-style status strip + a TEXT status label
 *     (unregistered / registered / bridging / offline)  §14.2
 *   - latest-observation summary (verdict colour dot + relative time)  §14.2 / P2-S1
 *   - device-monitor count (monitor.source_type==='device' && target===device.id)
 *   - actions: rename / delete (deleteDevice, P1-M1) / driver-aware rebind
 *     (browser config.deviceId; local-camera config.device, P1-M2 / L3)
 *   - an expandable, per-device DeviceMonitors + ObservationTimeline whose title
 *     carries the device name (§14.4, decouples "preview target" from "manage
 *     target" — no shared selectedId)
 *   - for camera devices, an "open camera detail" entry into CameraDetail (§14.5),
 *     receiving the stable registered device id
 *
 * Offline/orphan rule (§14.6): a registered browser-camera whose config.deviceId
 * is NOT in the current enumeration is rendered as an OFFLINE card with a
 * "rebind to current camera" action + delete — never silently dropped.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { App, Button, Input, Popconfirm, Select, Tag, Typography } from 'antd';
import Hls from 'hls.js';
import {
  AudioOutlined,
  CameraOutlined,
  CheckOutlined,
  CloseOutlined,
  DeleteOutlined,
  DownOutlined,
  EditOutlined,
  PlayCircleOutlined,
  RightOutlined,
  StopOutlined,
  SwapOutlined,
  UsbOutlined,
  VideoCameraOutlined,
} from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { getThemeTokens } from '../../styles/theme';
import { useConfigStore } from '../../stores/config';
import { useMonitorStore } from '../../stores/monitor';
import {
  usePeripheralsStore,
  type PeriphDeviceRow,
  type PeriphVerdict,
} from '../../stores/peripherals';
import { relativeTime } from '../../utils/relativeTime';
import DeviceMonitors from './DeviceMonitors';
import ObservationTimeline from './ObservationTimeline';

const { Text } = Typography;

// ── Gateway HTTP base + auth token (mirrors ObservationTimeline.tsx) ──────────
export function getGatewayHttpUrl(): string {
  const loc = window.location;
  if (loc.port === '5175') return 'http://127.0.0.1:28789';
  return loc.origin;
}

function getGatewayToken(): string {
  return new URLSearchParams(window.location.search).get('token') || 'research-claw';
}

// ── RtspLivePreview (§15 v1.3 场景③ H5/H6) ────────────────────────────────────
// Live RTSP→HLS preview for an rtsp device. Distinct from browser-camera
// getUserMedia preview (H5: USB/browser-camera keep their own path) and from the
// agent's single-frame snapshot (H6: preview failure does NOT affect scheduled
// evidence grabs — this component talks only to rtspPreview.* RPC + the HLS HTTP
// route, never the capture path).
//
// Flow: click Start → rtspPreviewStart(deviceId) → playlistUrl → hls.js attaches
// to <video> (Bearer token set on every segment/playlist request via xhrSetup,
// because the gateway HLS route reuses /rc/download's Bearer auth). A
// native-HLS-only browser cannot attach that header to playlist/segment
// requests, so it is explicitly rejected rather than starting a guaranteed
// 401 loop. On unmount / Stop, the hls instance is destroyed and
// rtspPreviewStop releases the gateway ffmpeg session (H1 resource reclaim).
export function RtspLivePreview({ deviceId }: { deviceId: string }) {
  const { t } = useTranslation();
  const rtspPreviewStart = usePeripheralsStore((s) => s.rtspPreviewStart);
  const rtspPreviewStop = usePeripheralsStore((s) => s.rtspPreviewStop);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const [active, setActive] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Tear down the hls instance + release the gateway session. Safe to call twice.
  const teardown = React.useCallback(() => {
    if (hlsRef.current) {
      try {
        hlsRef.current.destroy();
      } catch {
        /* noop */
      }
      hlsRef.current = null;
    }
    const v = videoRef.current;
    if (v) {
      try {
        v.pause();
        v.removeAttribute('src');
        v.load();
      } catch {
        /* noop */
      }
    }
  }, []);

  // Unmount cleanup (H1): destroy hls + stop the gateway session.
  useEffect(() => {
    return () => {
      teardown();
      // Fire-and-forget: release the ffmpeg session on the gateway.
      void rtspPreviewStop(deviceId);
    };
    // Only on deviceId change / unmount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceId]);

  const stop = React.useCallback(async () => {
    teardown();
    setActive(false);
    setError(null);
    await rtspPreviewStop(deviceId);
  }, [deviceId, rtspPreviewStop, teardown]);

  const start = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    const session = await rtspPreviewStart(deviceId);
    if (!session) {
      setLoading(false);
      setError(t('periph.preview.startFailed', 'Live preview unavailable. Try a snapshot instead.'));
      return;
    }
    setActive(true);

    const token = getGatewayToken();
    const src = `${getGatewayHttpUrl()}${session.playlistUrl}`;
    const video = videoRef.current;
    if (!video) {
      setLoading(false);
      return;
    }

    if (Hls.isSupported()) {
      const hls = new Hls({
        // Set the Bearer token on EVERY request (playlist + segments) so the
        // gateway's auth:'gateway' HLS route accepts them (H3).
        xhrSetup: (xhr: XMLHttpRequest) => {
          xhr.setRequestHeader('Authorization', `Bearer ${token}`);
        },
        // Live tuning: keep latency low, retry transient network hiccups.
        lowLatencyMode: true,
        liveSyncDurationCount: 3,
      });
      hlsRef.current = hls;
      hls.on(Hls.Events.ERROR, (_evt, data) => {
        // Only fatal errors kill the preview; hls.js self-recovers from many
        // transient ones. On fatal, degrade to an error message (H5).
        if (data.fatal) {
          teardown();
          setLoading(false);
          setActive(false);
          setError(t('periph.preview.playbackError', 'Preview stream error. Try a snapshot instead.'));
        }
      });
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        setLoading(false);
        void video.play().catch(() => {
          /* autoplay may be blocked; the user can press play */
        });
      });
      hls.loadSource(src);
      hls.attachMedia(video);
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      // Reachable when native HLS exists but MediaSource/SourceBuffer (required
      // by Hls.isSupported()) does not. HTMLMediaElement has no API for adding
      // the gateway's mandatory Authorization header, and OC's gateway auth
      // reads Bearer headers only — never URL/query credentials. Do not assign
      // src and leak into a deterministic 401 loop; release ffmpeg immediately.
      setLoading(false);
      setActive(false);
      setError(
        t(
          'periph.preview.nativeAuthUnsupported',
          'This browser’s native HLS player cannot attach gateway authentication. Use a browser with MediaSource support or take a snapshot.',
        ),
      );
      await rtspPreviewStop(deviceId);
    } else {
      // No HLS support at all — degrade cleanly.
      setLoading(false);
      setActive(false);
      setError(t('periph.preview.unsupported', 'This browser cannot play the live preview.'));
      await rtspPreviewStop(deviceId);
    }
  }, [deviceId, rtspPreviewStart, rtspPreviewStop, t, teardown]);

  return (
    <div data-testid={`periph-rtsp-preview-${deviceId}`} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {!active ? (
          <Button
            data-testid={`periph-rtsp-preview-start-${deviceId}`}
            size="small"
            type="primary"
            icon={<PlayCircleOutlined />}
            loading={loading}
            onClick={() => void start()}
          >
            {t('periph.preview.start', 'Live preview')}
          </Button>
        ) : (
          <Button
            data-testid={`periph-rtsp-preview-stop-${deviceId}`}
            size="small"
            icon={<StopOutlined />}
            onClick={() => void stop()}
          >
            {t('periph.preview.stop', 'Stop preview')}
          </Button>
        )}
        <VideoCameraOutlined style={{ opacity: 0.5 }} />
      </div>

      {/* The <video> is always mounted (so refs are stable) but only shown when active. */}
      <video
        data-testid={`periph-rtsp-preview-video-${deviceId}`}
        ref={videoRef}
        muted
        playsInline
        controls
        style={{
          width: '100%',
          maxHeight: 320,
          borderRadius: 6,
          background: '#000',
          display: active ? 'block' : 'none',
        }}
      />

      {error && (
        <Text data-testid={`periph-rtsp-preview-error-${deviceId}`} type="danger" style={{ fontSize: 12 }}>
          {error}
        </Text>
      )}
    </div>
  );
}

// ── Verdict colour (mirrors ObservationTimeline.VERDICT_COLOR) ────────────────
const VERDICT_COLOR: Record<PeriphVerdict, string> = {
  ok: '#22C55E',
  alert: '#EF4444',
  missed: '#9CA3AF',
  error: '#9CA3AF',
  unverified: '#F59E0B',
  info: '#3B82F6',
};

// ── Status classification (§14.2) ─────────────────────────────────────────────
type DeviceStatus = 'online' | 'registered' | 'unregistered' | 'offline';

export interface BrowserCameraOption {
  deviceId: string;
  label: string;
}

export interface DeviceCardProps {
  device: PeriphDeviceRow;
  /**
   * Current browser videoinput enumeration (labels+ids), used to decide whether a
   * browser-camera device is present (green/blue) or orphan/offline (grey), and to
   * populate the rebind dropdown. Empty for non-camera drivers / when unavailable.
   */
  browserCameras?: BrowserCameraOption[];
  /** True when the gateway reports the camera bridge as announced/online. */
  bridgeOnline?: boolean;
  /** Enter the full camera detail view (§14.5) for this device. */
  onOpenCameraDetail?: (device: PeriphDeviceRow) => void;
}

/**
 * Classify a device's live status from the store row + current browser enumeration.
 *   - browser-camera: online iff enumerated AND enabled AND bridgeOnline;
 *     registered iff enumerated (or non-camera driver); offline iff enabled but
 *     the config.deviceId is not in the current enumeration (orphan, §14.6).
 *   - mcp-plaud: registered when the row exists (login state lives in PlaudCard);
 *   - anything with last_error: (caller may override to error strip).
 */
export function classifyDeviceStatus(
  device: PeriphDeviceRow,
  browserCameras: BrowserCameraOption[],
  bridgeOnline: boolean,
): DeviceStatus {
  if (device.driver === 'browser-camera') {
    const cfgId = (device.config as { deviceId?: string })?.deviceId;
    const enumerated = !!cfgId && browserCameras.some((c) => c.deviceId === cfgId);
    if (!enumerated) return 'offline'; // orphan: registered but not currently present
    if (device.enabled && bridgeOnline) return 'online';
    return 'registered';
  }
  // Non-browser drivers (plaud etc.): treat enabled+present as registered/online.
  if (device.enabled) return 'registered';
  return 'unregistered';
}

export default function DeviceCard({
  device,
  browserCameras = [],
  bridgeOnline = false,
  onOpenCameraDetail,
}: DeviceCardProps) {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const theme = useConfigStore((s) => s.theme);
  const tokens = getThemeTokens(theme);

  const updateDevice = usePeripheralsStore((s) => s.updateDevice);
  const deleteDevice = usePeripheralsStore((s) => s.deleteDevice);
  const announceBridge = usePeripheralsStore((s) => s.announceBridge);
  const loadLocalCameras = usePeripheralsStore((s) => s.loadLocalCameras);
  const observationsMap = usePeripheralsStore((s) => s.observations);
  const loadObservations = usePeripheralsStore((s) => s.loadObservations);

  // Device-monitor count for THIS device (§14.2). Filter mirrors DeviceMonitors.
  const monitorCount = useMonitorStore(
    (s) => s.monitors.filter((m) => m.source_type === 'device' && m.target === device.id).length,
  );

  const [expanded, setExpanded] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState(device.name);
  const [rebindOpen, setRebindOpen] = useState(false);
  const [rebindTarget, setRebindTarget] = useState<string | null>(null);
  const [localRebindOptions, setLocalRebindOptions] = useState<Array<{ device: string; label: string }>>([]);
  const [localRebindLoading, setLocalRebindLoading] = useState(false);

  // Load latest observation lazily (one small page) so the card can show the most
  // recent verdict dot + time (§14.2 / P2-S1) without opening the timeline.
  const latestObs = observationsMap[device.id]?.[0] ?? null;
  useEffect(() => {
    if (!observationsMap[device.id]) {
      void loadObservations(device.id);
    }
    // Only on device id change; loadObservations is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [device.id]);

  const status = useMemo(
    () => classifyDeviceStatus(device, browserCameras, bridgeOnline),
    [device, browserCameras, bridgeOnline],
  );
  const hasError = !!device.last_error;

  const isCamera = device.driver === 'browser-camera' || device.kind === 'camera';
  const isPlaud = device.driver === 'mcp-plaud' || device.kind === 'audio-recorder';
  const isBrowserCamera = device.driver === 'browser-camera';
  const isLocalCamera = device.driver === 'local-camera';
  const canRebind = isBrowserCamera || isLocalCamera;
  // Only rtsp devices get the HLS live preview (§15 场景③ H5): browser-camera /
  // local-camera use their own getUserMedia / snapshot paths.
  const isRtsp = device.driver === 'rtsp';

  // ── status strip colour + label ─────────────────────────────────────────────
  const stripColor = hasError
    ? tokens.accent.red
    : status === 'online'
      ? tokens.accent.green
      : status === 'registered'
        ? tokens.accent.blue
        : tokens.text.muted; // unregistered / offline → grey

  const statusLabel = hasError
    ? t('periph.device.statusError', 'Error')
    : status === 'online'
      ? t('periph.device.statusOnline', 'Bridging')
      : status === 'registered'
        ? t('periph.device.statusRegistered', 'Registered')
        : status === 'offline'
          ? t('periph.device.statusOffline', 'Not detected (offline)')
          : t('periph.device.statusUnregistered', 'Unregistered');

  const KindIcon = isPlaud ? AudioOutlined : isCamera ? CameraOutlined : UsbOutlined;

  // ── actions ─────────────────────────────────────────────────────────────────
  const commitRename = async () => {
    const next = nameDraft.trim();
    if (!next || next === device.name) {
      setRenaming(false);
      setNameDraft(device.name);
      return;
    }
    await updateDevice(device.id, { name: next });
    setRenaming(false);
    message.success(t('periph.device.renamed', 'Device renamed'));
  };

  const handleDelete = async () => {
    await deleteDevice(device.id);
    // deleteDevice never throws — it records failures on the store. Reporting
    // success unconditionally told the user the device was gone while it was
    // still listed (R2-I3); read the outcome back instead.
    const { devices, error } = usePeripheralsStore.getState();
    if (devices.some((d) => d.id === device.id)) {
      message.error(error || t('periph.device.deleteFailed', 'Failed to delete device'));
      return;
    }
    if (error) {
      // Device is gone, but something downstream (its cron jobs) did not clean up.
      message.warning(error);
      return;
    }
    message.success(t('periph.device.deleted', 'Device deleted'));
  };

  const handleRebind = async () => {
    const target = rebindTarget?.trim();
    if (!target) return;
    if (isLocalCamera) {
      await updateDevice(device.id, {
        config: { ...device.config, device: target },
      });
      setRebindOpen(false);
      setRebindTarget(null);
      message.success(t('periph.device.reboundLocal', 'Rebound to the system camera'));
      return;
    }
    const cam = browserCameras.find((c) => c.deviceId === target);
    const label = cam?.label || (device.config as { label?: string })?.label || device.name;
    await updateDevice(device.id, {
      config: { ...device.config, deviceId: target, label },
    });
    // Re-announce so the gateway maps the bridge to the newly-bound mediaDevice id.
    await announceBridge([{ deviceId: target, label }], window.isSecureContext);
    setRebindOpen(false);
    setRebindTarget(null);
    message.success(t('periph.device.rebound', 'Rebound to the current camera'));
  };

  const toggleRebind = async () => {
    const next = !rebindOpen;
    setRebindOpen(next);
    setRebindTarget(
      next && isLocalCamera
        ? String((device.config as { device?: unknown }).device ?? '')
        : null,
    );
    if (!next || !isLocalCamera) return;
    setLocalRebindLoading(true);
    try {
      setLocalRebindOptions(await loadLocalCameras());
    } finally {
      setLocalRebindLoading(false);
    }
  };

  return (
    <div
      data-testid={`periph-device-card-${device.id}`}
      data-status={status}
      style={{
        border: `1px solid ${tokens.border.default}`,
        borderRadius: 8,
        overflow: 'hidden',
        background: tokens.bg.surface,
      }}
    >
      {/* Status strip (ChannelCard style) */}
      <div
        data-testid={`periph-device-strip-${device.id}`}
        data-status-color={stripColor}
        style={{ height: 4, background: stripColor, transition: 'background 0.3s' }}
      />

      {/* Card body */}
      <div style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
        {/* Header row: icon + name + status label */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <KindIcon style={{ fontSize: 18, color: tokens.accent.blue, flexShrink: 0 }} />
          {renaming ? (
            <span style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1 }}>
              <Input
                data-testid={`periph-device-rename-input-${device.id}`}
                size="small"
                autoFocus
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                onKeyDown={(e) => {
                  // Guard against IME composition (CJK input) — do not submit mid-compose.
                  if (e.nativeEvent.isComposing) return;
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void commitRename();
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    setRenaming(false);
                    setNameDraft(device.name);
                  }
                }}
              />
              <Button
                data-testid={`periph-device-rename-save-${device.id}`}
                size="small"
                type="text"
                icon={<CheckOutlined />}
                onClick={() => void commitRename()}
              />
              <Button
                data-testid={`periph-device-rename-cancel-${device.id}`}
                size="small"
                type="text"
                icon={<CloseOutlined />}
                onClick={() => {
                  setRenaming(false);
                  setNameDraft(device.name);
                }}
              />
            </span>
          ) : (
            <Text
              data-testid={`periph-device-name-${device.id}`}
              strong
              style={{ fontSize: 14, color: tokens.text.primary, flex: 1 }}
              ellipsis
            >
              {device.name}
            </Text>
          )}
          <Tag
            data-testid={`periph-device-status-label-${device.id}`}
            style={{
              fontSize: 11,
              borderRadius: 4,
              marginInlineEnd: 0,
              color: stripColor,
              borderColor: stripColor,
              background: 'transparent',
            }}
          >
            {statusLabel}
          </Tag>
        </div>

        {/* Latest observation summary + monitor count (§14.2 / P2-S1) */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          {latestObs ? (
            <span
              data-testid={`periph-device-latest-obs-${device.id}`}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: tokens.text.secondary }}
            >
              <span
                data-testid={`periph-device-latest-dot-${device.id}`}
                data-verdict={latestObs.verdict}
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  background: VERDICT_COLOR[latestObs.verdict] ?? tokens.text.muted,
                  flexShrink: 0,
                }}
              />
              {relativeTime(latestObs.captured_at)}
            </span>
          ) : (
            <span
              data-testid={`periph-device-no-obs-${device.id}`}
              style={{ fontSize: 12, color: tokens.text.muted }}
            >
              {t('periph.device.noObservations', 'No observations yet')}
            </span>
          )}
          <span
            data-testid={`periph-device-monitor-count-${device.id}`}
            style={{ fontSize: 12, color: tokens.text.secondary }}
          >
            {t('periph.device.monitorCount', {
              count: monitorCount,
              defaultValue: `${monitorCount} scheduled check(s)`,
            })}
          </span>
        </div>

        {/* Offline/orphan notice + rebind (§14.6) */}
        {status === 'offline' && (
          <div
            data-testid={`periph-device-offline-note-${device.id}`}
            style={{ fontSize: 12, color: tokens.text.muted }}
          >
            {t(
              'periph.device.offlineHint',
              'This camera is registered but not detected in the current browser. Rebind it to a present camera, or delete it.',
            )}
          </div>
        )}

        {/* Action row: rename / rebind / delete / open detail / expand */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          {!renaming && (
            <Button
              data-testid={`periph-device-rename-btn-${device.id}`}
              size="small"
              type="text"
              icon={<EditOutlined />}
              onClick={() => {
                setNameDraft(device.name);
                setRenaming(true);
              }}
            >
              {t('periph.device.rename', 'Rename')}
            </Button>
          )}

          {canRebind && (
            <Button
              data-testid={`periph-device-rebind-btn-${device.id}`}
              size="small"
              type="text"
              icon={<SwapOutlined />}
              onClick={() => void toggleRebind()}
            >
              {t('periph.device.rebind', 'Rebind')}
            </Button>
          )}

          {isCamera && onOpenCameraDetail && (
            <Button
              data-testid={`periph-device-open-detail-${device.id}`}
              size="small"
              type="text"
              icon={<RightOutlined />}
              onClick={() => onOpenCameraDetail(device)}
            >
              {t('periph.device.openDetail', 'Camera detail')}
            </Button>
          )}

          <Popconfirm
            title={t('periph.device.deleteConfirm', 'Delete this device? Its scheduled checks stop.')}
            okType="danger"
            onConfirm={() => void handleDelete()}
          >
            <Button
              data-testid={`periph-device-delete-btn-${device.id}`}
              size="small"
              type="text"
              danger
              icon={<DeleteOutlined />}
            >
              {t('periph.device.delete', 'Delete')}
            </Button>
          </Popconfirm>

          <Button
            data-testid={`periph-device-expand-btn-${device.id}`}
            size="small"
            type="text"
            icon={expanded ? <DownOutlined /> : <RightOutlined />}
            onClick={() => setExpanded((v) => !v)}
            style={{ marginLeft: 'auto' }}
          >
            {expanded
              ? t('periph.device.collapseChecks', 'Hide checks')
              : t('periph.device.showChecks', 'Scheduled checks')}
          </Button>
        </div>

        {/* Rebind picker (§14.6 / P1-M2) */}
        {rebindOpen && canRebind && (
          <div
            data-testid={`periph-device-rebind-panel-${device.id}`}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '8px',
              borderRadius: 8,
              background: tokens.bg.surfaceHover,
            }}
          >
            {isLocalCamera ? (
              <>
                {localRebindOptions.length > 0 && (
                  <Select
                    data-testid={`periph-device-local-rebind-select-${device.id}`}
                    size="small"
                    style={{ flex: 1, minWidth: 0 }}
                    loading={localRebindLoading}
                    placeholder={t('periph.device.localRebindPlaceholder', 'Choose or enter a system camera address')}
                    value={rebindTarget ?? undefined}
                    onChange={(v) => setRebindTarget(v)}
                    options={localRebindOptions.map((camera) => ({
                      value: camera.device,
                      label: camera.label || camera.device,
                    }))}
                  />
                )}
                <Input
                  data-testid={`periph-device-local-rebind-input-${device.id}`}
                  size="small"
                  style={{ flex: 1, minWidth: 0 }}
                  placeholder={t('periph.device.localRebindPlaceholder', 'Choose or enter a system camera address')}
                  value={rebindTarget ?? ''}
                  onChange={(event) => setRebindTarget(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.nativeEvent.isComposing) return;
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      void handleRebind();
                    }
                  }}
                />
              </>
            ) : (
              <Select
                data-testid={`periph-device-rebind-select-${device.id}`}
                size="small"
                style={{ flex: 1, minWidth: 0 }}
                placeholder={t('periph.device.rebindPlaceholder', 'Choose a present camera')}
                value={rebindTarget ?? undefined}
                onChange={(v) => setRebindTarget(v)}
                options={browserCameras
                  .filter((c) => c.deviceId && c.deviceId !== '')
                  .map((c) => ({ value: c.deviceId, label: c.label || c.deviceId }))}
              />
            )}
            <Button
              data-testid={`periph-device-rebind-confirm-${device.id}`}
              size="small"
              type="primary"
              disabled={!rebindTarget}
              onClick={() => void handleRebind()}
            >
              {t('periph.device.rebindConfirm', 'Rebind')}
            </Button>
          </div>
        )}

        {/* Expanded per-device monitors + timeline (§14.4) — title carries the
            device name via DeviceMonitors' deviceName prop + timeline heading. */}
        {expanded && (
          <div data-testid={`periph-device-detail-${device.id}`} style={{ marginTop: 4 }}>
            {/* RTSP live preview (§15 场景③ H5): only for rtsp devices; mounted
                inside the expanded panel so unmount (collapse) tears down the
                hls instance + releases the gateway ffmpeg session (H1). */}
            {isRtsp && (
              <div style={{ marginBottom: 16 }}>
                <Text
                  data-testid={`periph-device-preview-title-${device.id}`}
                  style={{ fontWeight: 600, fontSize: 13, display: 'block', marginBottom: 8 }}
                >
                  {t('periph.preview.title', 'Live preview')}
                </Text>
                <RtspLivePreview deviceId={device.id} />
              </div>
            )}
            <DeviceMonitors
              deviceId={device.id}
              deviceName={device.name}
              checkPrompt={device.check_prompt}
            />
            <Text
              data-testid={`periph-device-timeline-title-${device.id}`}
              style={{ fontWeight: 600, fontSize: 13, display: 'block', marginBottom: 8, marginTop: 16 }}
            >
              {t('periph.timeline.titleFor', {
                name: device.name,
                defaultValue: `Observation Timeline — ${device.name}`,
              })}
            </Text>
            <ObservationTimeline deviceId={device.id} />
          </div>
        )}
      </div>
    </div>
  );
}

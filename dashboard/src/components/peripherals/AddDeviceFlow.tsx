/**
 * AddDeviceFlow — the explicit "+ Add device" entry (§14.3).
 *
 * IA v2 makes "add" a first-class verb (§14.1): the old implicit path
 * ("enter detail → flip an unlabeled switch to register") was the root cause of
 * "I can't find how to add a camera". This modal presents a SOURCE picker:
 *   ① Browser camera — lists enumerateDevices() results; each row has a name
 *     input + [Add as device] → createDevice(browser-camera) + announceBridge,
 *     then a toast "added — the agent can now check it on a schedule". (§14.3)
 *   ② Plaud — delegates to the existing PlaudCard connect flow (rendered inline).
 *   ③ RTSP / IP camera — ACTIVE (§15-D8 案 A / F6): RTSP URL (required) + optional
 *     username/password (password via Input.Password, never echoed to toast/label)
 *     → createDevice({kind:'camera', driver:'rtsp', config:{url, username?,
 *     password?}}). rtsp devices are gateway-side (ffmpeg single-frame grab, no
 *     browser bridge), so announceBridge is NOT called. Credentials are stored as
 *     separate config fields — never injected into the URL query string.
 *   ④ Local camera (server-side) — ACTIVE (§15 v1.3 场景②): the gateway enumerates
 *     OS-attached cameras (rc.periph.localCameras.list → ffmpeg avfoundation/dshow)
 *     and offers them here; pick one + name → createDevice({kind:'camera',
 *     driver:'local-camera', config:{device:<index/name>}}). Like rtsp, frames are
 *     grabbed gateway-side (ffmpeg, NO browser bridge), so announceBridge is NOT
 *     called and it works UNATTENDED even with the dashboard closed — the key
 *     difference from ① browser-camera (which is a "person present" enhancement
 *     that needs the dashboard open). If enumeration fails/returns nothing, the
 *     pane degrades to a manual device-index input.
 *
 * Browser enumeration lives HERE (and in CameraDetail), never as a top-level
 * device source (§14.1 / §14.5).
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { App, Button, Input, Modal, Segmented, Select, Tag, Typography } from 'antd';
import { AudioOutlined, CameraOutlined, DesktopOutlined, VideoCameraOutlined, WifiOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { getThemeTokens } from '../../styles/theme';
import { useConfigStore } from '../../stores/config';
import { usePeripheralsStore, type PeriphDeviceRow, type LocalCameraOption } from '../../stores/peripherals';
import PlaudCard from './PlaudCard';

const { Text } = Typography;

export interface BrowserCameraOption {
  deviceId: string;
  label: string;
}

export interface AddDeviceFlowProps {
  open: boolean;
  onClose: () => void;
  /** Present browser cameras (already enumerated by the panel). */
  browserCameras: BrowserCameraOption[];
  /** Re-enumerate (e.g. after authorize) — panel owns the enumeration. */
  onRefreshCameras?: () => void | Promise<void>;
  /** Whether getUserMedia is usable (secure context) — gates the camera source. */
  cameraUsable: boolean;
  /** True when device labels are empty (pre-authorization). */
  needsAuth: boolean;
  /** Trigger a one-shot getUserMedia to unlock labels/ids. */
  onAuthorize?: () => void | Promise<void>;
}

type Source = 'browser-camera' | 'plaud' | 'rtsp' | 'local-camera';

export default function AddDeviceFlow({
  open,
  onClose,
  browserCameras,
  onRefreshCameras,
  cameraUsable,
  needsAuth,
  onAuthorize,
}: AddDeviceFlowProps) {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const theme = useConfigStore((s) => s.theme);
  const tokens = getThemeTokens(theme);

  const devices = usePeripheralsStore((s) => s.devices);
  const createDevice = usePeripheralsStore((s) => s.createDevice);
  const announceBridge = usePeripheralsStore((s) => s.announceBridge);
  const loadLocalCameras = usePeripheralsStore((s) => s.loadLocalCameras);

  const [source, setSource] = useState<Source>('browser-camera');
  // Per-camera name drafts + busy flags keyed by mediaDevice id.
  const [nameDrafts, setNameDrafts] = useState<Record<string, string>>({});
  const [addingId, setAddingId] = useState<string | null>(null);

  // ── RTSP form state (§15-D8 案 A / F6) ────────────────────────────────────
  const [rtspName, setRtspName] = useState('');
  const [rtspUrl, setRtspUrl] = useState('');
  const [rtspUser, setRtspUser] = useState('');
  const [rtspPass, setRtspPass] = useState('');
  const [rtspBusy, setRtspBusy] = useState(false);

  // ── Local-camera (server-side) state (§15 v1.3 场景②) ──────────────────────
  const [localCameras, setLocalCameras] = useState<LocalCameraOption[]>([]);
  const [localLoading, setLocalLoading] = useState(false);
  const [localLoaded, setLocalLoaded] = useState(false);
  // Selected OS device address (avfoundation index / dshow name). When
  // enumeration is empty this is a free-text manual entry.
  const [localDevice, setLocalDevice] = useState('');
  const [localName, setLocalName] = useState('');
  const [localBusy, setLocalBusy] = useState(false);

  useEffect(() => {
    if (open && cameraUsable) void onRefreshCameras?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Enumerate OS cameras when the local-camera source is opened. Failures/empty
  // results degrade to a manual device-index input (localCameras stays []).
  useEffect(() => {
    if (!open || source !== 'local-camera' || localLoaded) return;
    let cancelled = false;
    setLocalLoading(true);
    void (async () => {
      const cams = await loadLocalCameras();
      if (cancelled) return;
      setLocalCameras(cams);
      // Pre-select the first enumerated camera for a one-click add.
      if (cams.length > 0 && !localDevice) setLocalDevice(cams[0].device);
      setLocalLoaded(true);
      setLocalLoading(false);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, source, localLoaded]);

  // Reset the local-camera load state when the modal closes so a re-open
  // re-enumerates (a webcam may have been plugged in since).
  useEffect(() => {
    if (!open) {
      setLocalLoaded(false);
      setLocalCameras([]);
      setLocalDevice('');
      setLocalName('');
    }
  }, [open]);

  // Cameras already registered (by config.deviceId) should not offer "add" again.
  const registeredIds = useMemo(
    () =>
      new Set(
        devices
          .filter((d) => d.driver === 'browser-camera')
          .map((d) => (d.config as { deviceId?: string })?.deviceId)
          .filter(Boolean) as string[],
      ),
    [devices],
  );

  const presentCameras = useMemo(
    () => browserCameras.filter((c) => c.deviceId && c.deviceId !== ''),
    [browserCameras],
  );

  const handleAddCamera = useCallback(
    async (cam: BrowserCameraOption) => {
      const name = (nameDrafts[cam.deviceId]?.trim() || cam.label || t('periph.camera.defaultName', 'Camera')).trim();
      setAddingId(cam.deviceId);
      try {
        const created: PeriphDeviceRow | null = await createDevice({
          name,
          kind: 'camera',
          driver: 'browser-camera',
          config: { deviceId: cam.deviceId, label: name },
        });
        if (created) {
          // Announce so the gateway can bridge frame requests to this camera.
          await announceBridge([{ deviceId: cam.deviceId, label: name }], window.isSecureContext);
          message.success(
            t('periph.add.cameraAdded', 'Added — the agent can now verify it on a schedule.'),
          );
          setNameDrafts((prev) => {
            const next = { ...prev };
            delete next[cam.deviceId];
            return next;
          });
        }
      } finally {
        setAddingId(null);
      }
    },
    [nameDrafts, createDevice, announceBridge, message, t],
  );

  const handleAddRtsp = useCallback(async () => {
    const url = rtspUrl.trim();
    if (!url) {
      message.error(t('periph.add.rtspUrlRequired', 'Enter an RTSP URL first.'));
      return;
    }
    const name = (rtspName.trim() || t('periph.add.rtspDefaultName', 'IP camera')).trim();
    const user = rtspUser.trim();
    // Credentials are stored as SEPARATE config fields — never injected into the
    // URL query string. The gateway ffmpeg driver composes/masks them at grab time.
    const config: Record<string, unknown> = { url };
    if (user) config.username = user;
    if (rtspPass) config.password = rtspPass;

    setRtspBusy(true);
    try {
      const created: PeriphDeviceRow | null = await createDevice({
        name,
        kind: 'camera',
        driver: 'rtsp',
        config,
      });
      if (created) {
        // rtsp devices are captured gateway-side (no browser bridge) — do NOT
        // announceBridge. Toast copy never echoes the URL or credentials.
        message.success(t('periph.add.rtspAdded', 'Added — the agent can now verify it on a schedule.'));
        setRtspName('');
        setRtspUrl('');
        setRtspUser('');
        setRtspPass('');
      }
    } finally {
      setRtspBusy(false);
    }
  }, [rtspUrl, rtspName, rtspUser, rtspPass, createDevice, message, t]);

  const handleAddLocalCamera = useCallback(async () => {
    const deviceAddr = localDevice.trim();
    if (!deviceAddr) {
      message.error(t('periph.add.localDeviceRequired', 'Pick or enter a camera device first.'));
      return;
    }
    // Derive a default name from the matching enumerated label, else the address.
    const matched = localCameras.find((c) => c.device === deviceAddr);
    const name = (localName.trim() || matched?.label || t('periph.add.localDefaultName', 'Local camera')).trim();

    setLocalBusy(true);
    try {
      const created: PeriphDeviceRow | null = await createDevice({
        name,
        kind: 'camera',
        driver: 'local-camera',
        // config.device is the platform address (avfoundation index / dshow name).
        config: { device: deviceAddr },
      });
      if (created) {
        // local-camera frames are grabbed gateway-side (no browser bridge) — do
        // NOT announceBridge. Copy mirrors the rtsp "verify on a schedule" toast.
        message.success(t('periph.add.localAdded', 'Added — the agent can now verify it on a schedule.'));
        setLocalName('');
      }
    } finally {
      setLocalBusy(false);
    }
  }, [localDevice, localName, localCameras, createDevice, message, t]);

  return (
    <Modal
      data-testid="periph-add-device-modal"
      open={open}
      onCancel={onClose}
      footer={null}
      title={t('periph.add.title', 'Add a device')}
      width={560}
      centered
    >
      <div data-testid="periph-add-device-flow" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {/* Source picker */}
        <Segmented
          data-testid="periph-add-source"
          value={source}
          onChange={(v) => setSource(v as Source)}
          options={[
            {
              value: 'browser-camera',
              label: (
                <span data-testid="periph-add-source-camera">
                  <CameraOutlined /> {t('periph.add.sourceCamera', 'Browser camera')}
                </span>
              ),
            },
            {
              value: 'plaud',
              label: (
                <span data-testid="periph-add-source-plaud">
                  <AudioOutlined /> {t('periph.add.sourcePlaud', 'Plaud')}
                </span>
              ),
            },
            {
              value: 'rtsp',
              label: (
                <span data-testid="periph-add-source-rtsp">
                  <WifiOutlined /> {t('periph.add.sourceRtsp', 'RTSP / IP camera')}
                </span>
              ),
            },
            {
              value: 'local-camera',
              label: (
                <span data-testid="periph-add-source-local">
                  <DesktopOutlined /> {t('periph.add.sourceLocal', 'Local camera (server-side)')}
                </span>
              ),
            },
          ]}
          block
        />

        {/* ① Browser camera source */}
        {source === 'browser-camera' && (
          <div data-testid="periph-add-camera-pane" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {!cameraUsable ? (
              <div data-testid="periph-add-camera-insecure" style={{ fontSize: 12, color: tokens.text.muted }}>
                {t(
                  'periph.camera.insecureHint',
                  'Camera requires opening on this machine (127.0.0.1) or configuring HTTPS.',
                )}
              </div>
            ) : needsAuth ? (
              <div data-testid="periph-add-camera-authorize" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <Text style={{ fontSize: 12, color: tokens.text.secondary }}>
                  {t('periph.camera.permissionHint', 'Grant camera access to list and preview devices.')}
                </Text>
                <Button
                  data-testid="periph-add-camera-authorize-btn"
                  type="primary"
                  size="small"
                  style={{ alignSelf: 'flex-start' }}
                  onClick={() => void onAuthorize?.()}
                >
                  {t('periph.camera.authorize', 'Authorize camera')}
                </Button>
              </div>
            ) : presentCameras.length === 0 ? (
              <div data-testid="periph-add-camera-empty" style={{ padding: '16px 0', textAlign: 'center' }}>
                <VideoCameraOutlined style={{ fontSize: 24, color: tokens.text.muted, display: 'block', marginBottom: 6 }} />
                <Text style={{ color: tokens.text.muted }}>{t('periph.camera.noDevices', 'No camera detected.')}</Text>
              </div>
            ) : (
              presentCameras.map((cam) => {
                const already = registeredIds.has(cam.deviceId);
                return (
                  <div
                    key={cam.deviceId}
                    data-testid={`periph-add-camera-row-${cam.deviceId}`}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '8px',
                      borderRadius: 8,
                      border: `1px solid ${tokens.border.default}`,
                      background: tokens.bg.surface,
                    }}
                  >
                    <CameraOutlined style={{ color: tokens.text.secondary, flexShrink: 0 }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <Text style={{ fontSize: 13, display: 'block', color: tokens.text.primary }} ellipsis>
                        {cam.label || cam.deviceId}
                      </Text>
                      {!already && (
                        <Input
                          data-testid={`periph-add-camera-name-${cam.deviceId}`}
                          size="small"
                          style={{ marginTop: 4 }}
                          placeholder={t('periph.add.namePlaceholder', 'Name this device (optional)')}
                          value={nameDrafts[cam.deviceId] ?? ''}
                          onChange={(e) =>
                            setNameDrafts((prev) => ({ ...prev, [cam.deviceId]: e.target.value }))
                          }
                          onKeyDown={(e) => {
                            // IME composition guard (CJK) — never submit mid-compose.
                            if (e.nativeEvent.isComposing) return;
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              void handleAddCamera(cam);
                            }
                          }}
                        />
                      )}
                    </div>
                    {already ? (
                      <Tag data-testid={`periph-add-camera-already-${cam.deviceId}`} color="default">
                        {t('periph.add.alreadyAdded', 'Added')}
                      </Tag>
                    ) : (
                      <Button
                        data-testid={`periph-add-camera-btn-${cam.deviceId}`}
                        type="primary"
                        size="small"
                        loading={addingId === cam.deviceId}
                        onClick={() => void handleAddCamera(cam)}
                      >
                        {t('periph.add.addAsDevice', 'Add as device')}
                      </Button>
                    )}
                  </div>
                );
              })
            )}
          </div>
        )}

        {/* ② Plaud source — reuse the existing connect flow */}
        {source === 'plaud' && (
          <div data-testid="periph-add-plaud-pane">
            <Text style={{ fontSize: 12, color: tokens.text.secondary, display: 'block', marginBottom: 8 }}>
              {t('periph.add.plaudHint', 'Connect a Plaud recorder to transcribe and summarize recordings in chat.')}
            </Text>
            <PlaudCard />
          </div>
        )}

        {/* ③ RTSP / IP camera source — ACTIVE (§15-D8 案 A / F6) */}
        {source === 'rtsp' && (
          <div
            data-testid="periph-add-rtsp-pane"
            style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <WifiOutlined style={{ color: tokens.text.secondary }} />
              <Text strong style={{ color: tokens.text.primary }}>
                {t('periph.add.rtspTitle', 'RTSP / IP camera')}
              </Text>
            </div>
            <Text data-testid="periph-add-rtsp-blurb" style={{ fontSize: 12, color: tokens.text.secondary }}>
              {t(
                'periph.add.rtspBlurb',
                'The agent pulls single frames directly (gateway-side, no browser bridge), so this camera works for unattended overnight monitoring even with the dashboard closed.',
              )}
            </Text>
            <Input
              data-testid="periph-add-rtsp-name"
              size="small"
              placeholder={t('periph.add.namePlaceholder', 'Name this device (optional)')}
              value={rtspName}
              onChange={(e) => setRtspName(e.target.value)}
              onKeyDown={(e) => {
                // IME composition guard (CJK) — never submit mid-compose.
                if (e.nativeEvent.isComposing) return;
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void handleAddRtsp();
                }
              }}
            />
            <Input
              data-testid="periph-add-rtsp-url"
              size="small"
              placeholder={t('periph.add.rtspUrlPlaceholder', 'rtsp://host:554/stream (required)')}
              value={rtspUrl}
              onChange={(e) => setRtspUrl(e.target.value)}
              onKeyDown={(e) => {
                // IME composition guard (CJK) — never submit mid-compose.
                if (e.nativeEvent.isComposing) return;
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void handleAddRtsp();
                }
              }}
            />
            <div style={{ display: 'flex', gap: 8 }}>
              <Input
                data-testid="periph-add-rtsp-username"
                size="small"
                style={{ flex: 1 }}
                placeholder={t('periph.add.rtspUserPlaceholder', 'Username (optional)')}
                value={rtspUser}
                onChange={(e) => setRtspUser(e.target.value)}
                autoComplete="off"
              />
              <Input.Password
                data-testid="periph-add-rtsp-password"
                size="small"
                style={{ flex: 1 }}
                placeholder={t('periph.add.rtspPassPlaceholder', 'Password (optional)')}
                value={rtspPass}
                onChange={(e) => setRtspPass(e.target.value)}
                autoComplete="new-password"
              />
            </div>
            <Button
              data-testid="periph-add-rtsp-submit"
              type="primary"
              size="small"
              loading={rtspBusy}
              disabled={rtspUrl.trim() === ''}
              style={{ alignSelf: 'flex-start' }}
              onClick={() => void handleAddRtsp()}
            >
              {t('periph.add.addAsDevice', 'Add as device')}
            </Button>
          </div>
        )}

        {/* ④ Local camera (server-side) source — ACTIVE (§15 v1.3 场景②) */}
        {source === 'local-camera' && (
          <div
            data-testid="periph-add-local-pane"
            style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <DesktopOutlined style={{ color: tokens.text.secondary }} />
              <Text strong style={{ color: tokens.text.primary }}>
                {t('periph.add.localTitle', 'Local camera (server-side)')}
              </Text>
            </div>
            <Text data-testid="periph-add-local-blurb" style={{ fontSize: 12, color: tokens.text.secondary }}>
              {t(
                'periph.add.localBlurb',
                'The gateway grabs single frames directly from a USB / built-in webcam (ffmpeg, no browser). Unlike the browser camera (which needs the dashboard open), this works unattended even with the dashboard closed.',
              )}
            </Text>
            {localCameras.length > 0 ? (
              <Select
                data-testid="periph-add-local-select"
                size="small"
                value={localDevice || undefined}
                onChange={(v) => setLocalDevice(v)}
                placeholder={t('periph.add.localSelectPlaceholder', 'Select a camera')}
                options={localCameras.map((c) => ({
                  value: c.device,
                  label: `${c.label} (#${c.device})`,
                }))}
                style={{ width: '100%' }}
              />
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <Text data-testid="periph-add-local-empty" style={{ fontSize: 12, color: tokens.text.muted }}>
                  {localLoading
                    ? t('periph.add.localLoading', 'Detecting cameras…')
                    : t('periph.add.localEmpty', 'No local camera detected. Enter a device index manually.')}
                </Text>
                <Input
                  data-testid="periph-add-local-device-manual"
                  size="small"
                  placeholder={t('periph.add.localDevicePlaceholder', 'Device index (e.g. 0) or name')}
                  value={localDevice}
                  onChange={(e) => setLocalDevice(e.target.value)}
                  onKeyDown={(e) => {
                    // IME composition guard (CJK) — never submit mid-compose.
                    if (e.nativeEvent.isComposing) return;
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      void handleAddLocalCamera();
                    }
                  }}
                />
              </div>
            )}
            <Input
              data-testid="periph-add-local-name"
              size="small"
              placeholder={t('periph.add.namePlaceholder', 'Name this device (optional)')}
              value={localName}
              onChange={(e) => setLocalName(e.target.value)}
              onKeyDown={(e) => {
                // IME composition guard (CJK) — never submit mid-compose.
                if (e.nativeEvent.isComposing) return;
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void handleAddLocalCamera();
                }
              }}
            />
            <Button
              data-testid="periph-add-local-submit"
              type="primary"
              size="small"
              loading={localBusy}
              disabled={localDevice.trim() === ''}
              style={{ alignSelf: 'flex-start' }}
              onClick={() => void handleAddLocalCamera()}
            >
              {t('periph.add.addAsDevice', 'Add as device')}
            </Button>
          </div>
        )}
      </div>
    </Modal>
  );
}

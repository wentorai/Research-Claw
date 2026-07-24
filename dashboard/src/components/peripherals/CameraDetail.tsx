/**
 * CameraDetail — the core camera device page inside the Peripherals panel.
 *
 * Rendered when the user clicks into the camera slot from PeripheralsPanel.
 * Owns:
 *   - secure-context degradation (getUserMedia is unavailable off 127.0.0.1/HTTPS)
 *   - device enumeration + selection (videoinput only)
 *   - a *resident* live preview stream (distinct from captureFrameFromCamera's
 *     grab-and-release; tracks are stopped on device switch / unmount)
 *   - action row: snap-to-chat (red primary) + save-to-workspace
 *   - "enable camera bridge" switch (create/update device + announceBridge)
 *   - a non-blocking multi-modal vision hint (blue info Alert, three states)
 *
 * The monitors query area (T16) and observation timeline (T16) are NOT built
 * here; two mount points are exposed for them:
 *   data-testid="periph-camera-monitors" / "periph-camera-timeline".
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, App, Button, Select, Switch, Typography } from 'antd';
import { CameraOutlined, SaveOutlined, VideoCameraOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { getThemeTokens } from '../../styles/theme';
import { useConfigStore } from '../../stores/config';
import { usePeripheralsStore } from '../../stores/peripherals';
import { useUiStore } from '../../stores/ui';
import { captureFrameFromCamera } from '../../gateway/camera';
import { uploadFileToWorkspace } from '../../gateway/upload';
import { resolveVisionSupport } from '../../utils/vision-capability';
import type { ChatAttachment } from '../../gateway/types';
import DeviceMonitors from './DeviceMonitors';
import ObservationTimeline from './ObservationTimeline';

const { Text } = Typography;

/** Blobs larger than this are uploaded but not inlined as a chat dataUrl. */
const MAX_INLINE_BYTES = 5 * 1024 * 1024;

interface VideoDeviceOption {
  deviceId: string;
  label: string;
}

interface CameraDetailProps {
  /**
   * The registered-device id or browser mediaDevice id to preselect, or null to
   * let the user pick. Used as the capture target + bridge config.deviceId.
   */
  browserDeviceId: string | null;
}

// ── secure-context probe ──────────────────────────────────────────────────────

function isCameraUsable(): boolean {
  return Boolean(window.isSecureContext) && Boolean(navigator.mediaDevices?.getUserMedia);
}

// ── blob → dataUrl (bounded) ──────────────────────────────────────────────────

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'));
    reader.readAsDataURL(blob);
  });
}

export default function CameraDetail({ browserDeviceId }: CameraDetailProps) {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const theme = useConfigStore((s) => s.theme);
  const tokens = getThemeTokens(theme);

  const devices = usePeripheralsStore((s) => s.devices);
  const unavailable = usePeripheralsStore((s) => s.unavailable);
  const createDevice = usePeripheralsStore((s) => s.createDevice);
  const updateDevice = usePeripheralsStore((s) => s.updateDevice);
  const announceBridge = usePeripheralsStore((s) => s.announceBridge);
  const setChatAttachmentPrefill = useUiStore((s) => s.setChatAttachmentPrefill);

  const usable = isCameraUsable();

  const [videoDevices, setVideoDevices] = useState<VideoDeviceOption[]>([]);
  const [needsAuth, setNeedsAuth] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(browserDeviceId);
  const [caption, setCaption] = useState<string>('');
  const [busy, setBusy] = useState(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  // Vision support is a pure store read; resolve once per render pass.
  const vision = useMemo(() => resolveVisionSupport(), []);

  // ── device enumeration ──────────────────────────────────────────────────────
  const refreshDevices = useCallback(async () => {
    if (!usable) return;
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      const cams = all
        .filter((d) => d.kind === 'videoinput')
        .map((d) => ({ deviceId: d.deviceId, label: d.label }));
      setVideoDevices(cams);
      // Labels are empty until getUserMedia has been granted once.
      setNeedsAuth(cams.length > 0 && cams.every((c) => !c.label));
      // Preselect: prop → first camera.
      setSelectedId((cur) => cur ?? cams[0]?.deviceId ?? null);
    } catch {
      setVideoDevices([]);
    }
  }, [usable]);

  useEffect(() => {
    void refreshDevices();
  }, [refreshDevices]);

  // ── resident preview stream (start on selectedId, stop on switch/unmount) ────
  const stopStream = useCallback(() => {
    const s = streamRef.current;
    if (s) {
      for (const track of s.getTracks()) track.stop();
      streamRef.current = null;
    }
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  useEffect(() => {
    if (!usable || !selectedId) return;
    let cancelled = false;

    (async () => {
      // Release any prior stream before opening the new device.
      stopStream();
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { deviceId: { exact: selectedId } },
        });
        if (cancelled) {
          for (const track of stream.getTracks()) track.stop();
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          void videoRef.current.play?.().catch(() => undefined);
        }
        // Once granted, labels become available → re-enumerate to fill names.
        if (needsAuth) void refreshDevices();

        const track = stream.getVideoTracks()[0];
        const settings = track?.getSettings?.() ?? {};
        const label =
          videoDevices.find((d) => d.deviceId === selectedId)?.label ||
          t('periph.camera.defaultName', 'Camera');
        const dims =
          settings.width && settings.height ? `${settings.width}×${settings.height}` : '';
        const fps = settings.frameRate ? ` @ ${Math.round(settings.frameRate)}fps` : '';
        setCaption([label, dims + fps].filter(Boolean).join(' · '));
      } catch {
        if (!cancelled) setCaption('');
      }
    })();

    return () => {
      cancelled = true;
      stopStream();
    };
    // videoDevices/needsAuth intentionally excluded — only re-open on device switch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [usable, selectedId, stopStream]);

  // Stop the resident stream on unmount (belt-and-suspenders over the effect cleanup).
  useEffect(() => () => stopStream(), [stopStream]);

  // ── authorize (one getUserMedia to unlock labels) ───────────────────────────
  const handleAuthorize = useCallback(async () => {
    if (!usable) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      for (const track of stream.getTracks()) track.stop();
      await refreshDevices();
    } catch {
      message.error(t('periph.camera.authorizeFailed', 'Camera authorization failed'));
    }
  }, [usable, refreshDevices, message, t]);

  // ── capture link: capture → upload → optional inject ────────────────────────
  const captureAndUpload = useCallback(
    async (inject: boolean) => {
      if (!selectedId) return;
      setBusy(true);
      try {
        const { blob } = await captureFrameFromCamera(selectedId);
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const file = new File([blob], `camera-${stamp}.jpg`, { type: 'image/jpeg' });
        const destId = browserDeviceId ?? selectedId;
        const uploaded = await uploadFileToWorkspace(file, `periph/${destId}`);

        if (inject) {
          let dataUrl = '';
          if (blob.size <= MAX_INLINE_BYTES) {
            dataUrl = await blobToDataUrl(blob);
          }
          const att: ChatAttachment = {
            id: crypto.randomUUID(),
            dataUrl,
            mimeType: blob.type || 'image/jpeg',
            wsPath: uploaded.path,
          };
          setChatAttachmentPrefill([att]);
          message.success(t('periph.camera.snapInjected', 'Photo added to chat'));
        } else {
          message.success(
            t('periph.camera.saved', { defaultValue: `Saved to ${uploaded.path}`, path: uploaded.path }),
          );
        }
      } catch {
        message.error(t('periph.camera.captureFailed', 'Capture failed'));
      } finally {
        setBusy(false);
      }
    },
    [selectedId, browserDeviceId, setChatAttachmentPrefill, message, t],
  );

  // ── bridge switch state (derived from store) ────────────────────────────────
  const bridgeDevice = useMemo(
    () =>
      devices.find(
        (d) => d.driver === 'browser-camera' && (d.config as { deviceId?: string })?.deviceId === selectedId,
      ),
    [devices, selectedId],
  );
  const bridgeOn = Boolean(bridgeDevice?.enabled);

  const handleBridgeToggle = useCallback(
    async (next: boolean) => {
      if (!selectedId) return;
      const label = videoDevices.find((d) => d.deviceId === selectedId)?.label || 'Camera';
      if (next) {
        if (bridgeDevice) {
          await updateDevice(bridgeDevice.id, { enabled: true });
        } else {
          await createDevice({
            name: label,
            kind: 'camera',
            driver: 'browser-camera',
            config: { deviceId: selectedId, label },
          });
        }
        await announceBridge([{ deviceId: selectedId, label }], window.isSecureContext);
      } else if (bridgeDevice) {
        await updateDevice(bridgeDevice.id, { enabled: false });
      }
    },
    [selectedId, videoDevices, bridgeDevice, updateDevice, createDevice, announceBridge],
  );

  // ── render: insecure degradation ────────────────────────────────────────────
  if (!usable) {
    return (
      <div style={{ padding: 16 }}>
        <Alert
          data-testid="periph-camera-insecure"
          type="warning"
          showIcon
          message={t(
            'periph.camera.insecureHint',
            'Camera requires opening on this machine (127.0.0.1) or configuring HTTPS.',
          )}
          style={{ borderRadius: 8 }}
        />
      </div>
    );
  }

  const visionCopy =
    vision.supportsImage === true
      ? t('periph.camera.visionOk', 'The current model supports image input.')
      : vision.supportsImage === false
        ? t('periph.camera.visionMaybe', 'The current model may not support images; it will fall back to an image description.')
        : t('periph.camera.visionUnknown', 'Cannot confirm whether the current model supports image input.');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 16, overflowY: 'auto' }}>
      {/* Plugin-too-old banner */}
      {unavailable && (
        <Alert
          data-testid="periph-camera-unavailable"
          type="error"
          showIcon
          message={t('periph.camera.pluginOutdated', 'Plugin version is too old — please update Research-Claw.')}
          style={{ borderRadius: 8 }}
        />
      )}

      {/* Multi-modal vision hint (non-blocking) */}
      <Alert
        data-testid="periph-camera-vision-hint"
        type="info"
        showIcon
        message={visionCopy}
        style={{ borderRadius: 8 }}
      />

      {/* Device selection */}
      {videoDevices.length === 0 ? (
        <div data-testid="periph-camera-empty" style={{ padding: '24px 8px', textAlign: 'center' }}>
          <VideoCameraOutlined style={{ fontSize: 28, color: tokens.text.muted, display: 'block', marginBottom: 8 }} />
          <Text style={{ color: tokens.text.muted }}>
            {t('periph.camera.noDevices', 'No camera detected.')}
          </Text>
        </div>
      ) : needsAuth ? (
        <div data-testid="periph-camera-authorize-wrap" style={{ padding: '12px 0' }}>
          <Text style={{ color: tokens.text.secondary, display: 'block', marginBottom: 8 }}>
            {t('periph.camera.permissionHint', 'Grant camera access to list and preview devices.')}
          </Text>
          <Button data-testid="periph-camera-authorize" type="primary" onClick={handleAuthorize}>
            {t('periph.camera.authorize', 'Authorize camera')}
          </Button>
        </div>
      ) : (
        <>
          <div data-testid="periph-camera-device-select">
            <Text style={{ fontSize: 12, color: tokens.text.muted, display: 'block', marginBottom: 4 }}>
              {t('periph.camera.selectDevice', 'Camera device')}
            </Text>
            <Select
              value={selectedId ?? undefined}
              onChange={(v) => setSelectedId(v)}
              style={{ width: '100%' }}
              options={videoDevices.map((d) => ({ value: d.deviceId, label: d.label || d.deviceId }))}
            />
          </div>

          {/* Live preview + caption */}
          <div
            data-testid="periph-camera-preview"
            style={{
              position: 'relative',
              background: '#000',
              borderRadius: 8,
              overflow: 'hidden',
              border: `1px solid ${tokens.border.default}`,
            }}
          >
            <video
              ref={videoRef}
              autoPlay
              muted
              playsInline
              style={{ width: '100%', display: 'block' }}
            />
            <div
              style={{
                position: 'absolute',
                left: 0,
                right: 0,
                bottom: 0,
                padding: '4px 8px',
                background: 'rgba(0,0,0,0.55)',
                color: '#fff',
                fontSize: 11,
                fontFamily: "'Fira Code', monospace",
              }}
            >
              {caption || t('periph.camera.starting', 'Starting preview…')}
            </div>
          </div>

          {/* Action row */}
          <div style={{ display: 'flex', gap: 8 }}>
            <Button
              data-testid="periph-camera-snap"
              type="primary"
              icon={<CameraOutlined />}
              loading={busy}
              onClick={() => captureAndUpload(true)}
              style={{ background: tokens.accent.red, borderColor: tokens.accent.red }}
            >
              {t('periph.camera.snapToChat', 'Snap & add to chat')}
            </Button>
            <Button
              data-testid="periph-camera-save"
              icon={<SaveOutlined />}
              loading={busy}
              onClick={() => captureAndUpload(false)}
            >
              {t('periph.camera.saveToWorkspace', 'Save to workspace')}
            </Button>
          </div>

          {/* Camera bridge switch */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '8px 12px',
              background: tokens.bg.surfaceHover,
              borderRadius: 8,
            }}
          >
            <div>
              <Text style={{ color: tokens.text.primary, display: 'block' }}>
                {t('periph.camera.enableBridge', 'Enable camera bridge')}
              </Text>
              <Text style={{ fontSize: 11, color: tokens.text.muted }}>
                {t('periph.camera.enableBridgeHint', 'Let the agent request snapshots from this camera.')}
              </Text>
            </div>
            <span data-testid="periph-camera-bridge-switch">
              <Switch checked={bridgeOn} onChange={handleBridgeToggle} />
            </span>
          </div>
        </>
      )}

      {/* T16 mount points — monitors query + observation timeline.
          Both divs always present (test-id contract); content shown when bridge is active.
          DeviceMonitors owns the "Scheduled Checks" section only (no ObservationTimeline).
          ObservationTimeline lives here with its own title (Fix 3, T16 review). */}
      <div data-testid="periph-camera-monitors">
        {bridgeDevice && (
          <DeviceMonitors
            deviceId={bridgeDevice.id}
            checkPrompt={bridgeDevice.check_prompt}
          />
        )}
      </div>
      <div data-testid="periph-camera-timeline">
        {bridgeDevice && (
          <>
            <Text style={{ fontWeight: 600, fontSize: 13, display: 'block', marginBottom: 8, marginTop: 16 }}>
              {t('periph.timeline.title', 'Observation Timeline')}
            </Text>
            <ObservationTimeline deviceId={bridgeDevice.id} />
          </>
        )}
      </div>
    </div>
  );
}

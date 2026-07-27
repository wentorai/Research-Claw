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
import { Alert, App, Button, Switch, Tooltip, Typography } from 'antd';
import { CameraOutlined, SaveOutlined, VideoCameraOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { getThemeTokens } from '../../styles/theme';
import { useConfigStore } from '../../stores/config';
import { usePeripheralsStore } from '../../stores/peripherals';
import { useSessionsStore } from '../../stores/sessions';
import { useGatewayStore } from '../../stores/gateway';
import { useUiStore } from '../../stores/ui';
import { captureFrameFromCamera } from '../../gateway/camera';
import { uploadFileToWorkspace } from '../../gateway/upload';
import { useVisionSupport } from '../../hooks/useVisionSupport';
import type { ChatAttachment } from '../../gateway/types';
import DeviceMonitors from './DeviceMonitors';
import ObservationTimeline from './ObservationTimeline';
import { RtspLivePreview } from './DeviceCard';

const { Text } = Typography;

/** Blobs larger than this are uploaded but not inlined as a chat dataUrl. */
const MAX_INLINE_BYTES = 5 * 1024 * 1024;

interface VideoDeviceOption {
  deviceId: string;
  label: string;
}

interface CameraDetailProps {
  /**
   * Stable rc_periph_devices id from the selected device card. Null keeps the
   * standalone browser-camera picker available.
   */
  deviceId: string | null;
}

// ── secure-context probe ──────────────────────────────────────────────────────

function isCameraUsable(): boolean {
  return Boolean(window.isSecureContext) && Boolean(navigator.mediaDevices?.getUserMedia);
}

// ── getUserMedia error classification (T19 P-2) ───────────────────────────────
/**
 * Map a getUserMedia rejection to actionable copy keyed by DOMException.name.
 * A bare "authorization failed" toast gave the user nothing to act on; this
 * distinguishes permission-denied vs no-device vs in-use vs bad-constraint, and
 * appends the raw name/message for anything unclassified.
 */
function describeCameraError(err: unknown, t: (k: string, d: string) => string): string {
  const name = err instanceof Error ? err.name : '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return t(
        'periph.camera.err.notAllowed',
        '浏览器或系统拒绝了摄像头权限:请检查地址栏摄像头图标,及 系统设置→隐私与安全性→摄像头 中允许当前浏览器',
      );
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return t('periph.camera.err.notFound', '未检测到摄像头设备');
    case 'NotReadableError':
    case 'TrackStartError':
      return t('periph.camera.err.notReadable', '摄像头被其他应用占用');
    case 'OverconstrainedError':
    case 'ConstraintNotSatisfiedError':
      return t('periph.camera.err.overconstrained', '所选设备不可用,请重新选择');
    default: {
      const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      return `${t('periph.camera.err.other', '摄像头启动失败')} (${detail})`;
    }
  }
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

export default function CameraDetail({ deviceId }: CameraDetailProps) {
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
  const gatewayClient = useGatewayStore((s) => s.client);
  // Config primary model ref — compared against the resolver's modelRef to detect
  // whether the current judgment is driven by a per-session /model override (P1-V2).
  const configPrimaryRef = useConfigStore((s) => s.gatewayConfig?.agents?.defaults?.model?.primary ?? null);
  const activeSessionKey = useSessionsStore((s) => s.activeSessionKey);
  const patchSession = useSessionsStore((s) => s.patchSession);
  const loadSessions = useSessionsStore((s) => s.loadSessions);

  const usable = isCameraUsable();

  const registeredDevice = useMemo(
    () => devices.find((d) => d.id === deviceId) ?? null,
    [devices, deviceId],
  );
  const rtspDevice = registeredDevice?.driver === 'rtsp' ? registeredDevice : null;
  const localCameraDevice = registeredDevice?.driver === 'local-camera' ? registeredDevice : null;
  const initialBrowserDeviceId =
    registeredDevice?.driver === 'browser-camera'
      ? ((registeredDevice.config as { deviceId?: string }).deviceId ?? null)
      : registeredDevice
        ? null
        : deviceId;

  const [videoDevices, setVideoDevices] = useState<VideoDeviceOption[]>([]);
  const [needsAuth, setNeedsAuth] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(initialBrowserDeviceId);
  const [caption, setCaption] = useState<string>('');
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    setSelectedId(initialBrowserDeviceId);
  }, [initialBrowserDeviceId]);

  // Vision support is reactive (P1-V3): the hook subscribes to catalog / config /
  // active-session model so the hint recomputes on async catalog arrival and on
  // /model session switches, instead of freezing at first render.
  const vision = useVisionSupport();
  // A per-session /model override is in effect when the judgment came from the
  // session tier AND the effective model differs from the config primary (P1-V2).
  const isSessionOverride =
    vision.source === 'session' &&
    vision.modelRef !== null &&
    vision.modelRef !== configPrimaryRef;

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
      // Preselect: prop → first camera with a NON-EMPTY deviceId.
      // T19 P4: pre-authorization browsers report a placeholder videoinput with
      // deviceId=''. `cur ?? cams[0]?.deviceId` used to latch that empty string
      // ('' is not nullish), leaving selectedId='' — a falsy-but-present value
      // that then punched through downstream "is a device selected?" checks.
      // Only auto-select the first device whose deviceId is truthy; keep null
      // (→ nothing selected) until authorization yields real ids.
      setSelectedId((cur) => {
        if (cur && cur !== '') return cur;
        return cams.find((c) => c.deviceId && c.deviceId !== '')?.deviceId ?? null;
      });
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
    // Gateway-side camera drivers have no getUserMedia stream.
    if (rtspDevice || localCameraDevice) return;
    if (!usable || !selectedId) return;
    let cancelled = false;

    (async () => {
      // Release any prior stream before opening the new device.
      stopStream();
      setPreviewError(null);
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          // Guard: some browsers report an empty-string deviceId before
          // authorization; { exact:'' } always fails. Fall back to video:true.
          video: selectedId ? { deviceId: { exact: selectedId } } : true,
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
      } catch (err) {
        if (!cancelled) {
          setCaption('');
          setPreviewError(describeCameraError(err, t));
        }
      }
    })();

    return () => {
      cancelled = true;
      stopStream();
    };
    // videoDevices/needsAuth intentionally excluded — only re-open on device switch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [usable, selectedId, stopStream, rtspDevice, localCameraDevice]);

  // Stop the resident stream on unmount (belt-and-suspenders over the effect cleanup).
  useEffect(() => () => stopStream(), [stopStream]);

  // ── authorize (one getUserMedia to unlock labels) ───────────────────────────
  const handleAuthorize = useCallback(async () => {
    if (!usable) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      for (const track of stream.getTracks()) track.stop();
      await refreshDevices();
    } catch (err) {
      // Classify by DOMException.name so the user gets actionable copy (which
      // setting to flip, whether a device even exists) instead of a bare toast.
      message.error(describeCameraError(err, t));
    }
  }, [usable, refreshDevices, message, t]);

  // ── clear per-session /model override (P1-V2) ────────────────────────────────
  // sessions.patch { model: null } resets to the config default (OC
  // sessions-patch.ts:517-534 → applyModelOverride isDefault:true). Reload the
  // session list so modelProvider/model refresh and the hint recomputes.
  const handleClearOverride = useCallback(async () => {
    // patchSession now reports the real outcome (false = gateway not connected,
    // or sessions.patch rejected). Announcing success unconditionally used to
    // leave the user with "override cleared" sitting next to a still-present
    // override hint — the toast and the UI contradicted each other.
    const ok = await patchSession(activeSessionKey, { model: null });
    if (!ok) {
      message.error(
        t(
          'periph.camera.visionOverrideClearFailed',
          'Failed to clear the session model override — please retry.',
        ),
      );
      return;
    }
    await loadSessions();
    message.success(t('periph.camera.visionOverrideCleared', 'Session model override cleared.'));
  }, [patchSession, loadSessions, activeSessionKey, message, t]);

  // ── observation write for a manual snap (P2-T1) ──────────────────────────────
  // A manual "take photo" only uploaded + optionally injected into chat; it never
  // landed on the observation timeline, so a human snap was invisible next to
  // agent/cron snaps. When the selected camera has a REGISTERED bridge device
  // (rc_periph_devices row), record a kind='snapshot' observation keyed on that
  // stable uuid so the frame shows up in the same timeline the agent writes to.
  //
  // Gateway contract (rpc.ts rc.periph.observations.create, mirrors
  // service.recordObservation; kind='snapshot' + verdict='info' are valid):
  //   req:  { device_id, kind:'snapshot', verdict:'info', summary, frame_path }
  //   resp: { observation: PeriphObservation }  (types.ts:26-43)
  // Guarded end-to-end on the client: an unregistered device (no bridge) writes
  // nothing (the FK would reject it), and a missing method / transport error never
  // breaks the snap (best-effort catch below).
  // A card-opened browser camera already gives us the registered row. The
  // fallback match keeps the standalone picker able to discover a bridge after
  // the user changes its mediaDevice selection.
  const resolveTargetBridge = useCallback(
    () => {
      if (registeredDevice?.driver === 'browser-camera') return registeredDevice;
      return devices.find(
        (d) =>
          d.driver === 'browser-camera' &&
          (d.config as { deviceId?: string })?.deviceId === selectedId,
      );
    },
    [devices, registeredDevice, selectedId],
  );

  const recordManualSnapshot = useCallback(
    async (bridge: ReturnType<typeof resolveTargetBridge>, framePath: string) => {
      const client = gatewayClient;
      if (!client?.isConnected) return;
      // Only registered bridge devices have a durable device_id the observation
      // table can reference (FK to rc_periph_devices).
      if (!bridge) return;
      try {
        await client.request('rc.periph.observations.create', {
          device_id: bridge.id,
          kind: 'snapshot',
          verdict: 'info',
          // Stored verbatim in the observation row (not a UI-facing string), so
          // no i18n key is introduced here — avoids an en/zh key-alignment gap.
          summary: 'Manual snapshot from the dashboard',
          frame_path: framePath,
        });
      } catch {
        // Best-effort: a plugin without the observation-write method (METHOD_NOT_FOUND)
        // or any transport failure must not fail the user's snap.
      }
    },
    [gatewayClient],
  );

  // ── capture link: capture → upload → optional inject ────────────────────────
  const captureAndUpload = useCallback(
    async (inject: boolean) => {
      if (!selectedId || selectedId === '') return;
      setBusy(true);
      try {
        const { blob } = await captureFrameFromCamera(selectedId);
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const file = new File([blob], `camera-${stamp}.jpg`, { type: 'image/jpeg' });
        // P2-F1: frame directories unify on the STABLE registered uuid. When the
        // camera has a registered bridge, upload under `periph/<bridge.id>/` — the
        // same path the agent capture (PeriphCaptureListener destinationKey =
        // registeredDeviceId) and the observation timeline reference. Only when
        // there is NO bridge do we fall back to the browser mediaDevice id.
        const bridge = resolveTargetBridge();
        const destId = bridge?.id ?? selectedId;
        const uploaded = await uploadFileToWorkspace(file, `periph/${destId}`);

        // P2-T1: a successful manual snap joins the observation timeline. Reuse the
        // bridge resolved above so the observation device_id and the upload dir key
        // on one and the same registered uuid.
        await recordManualSnapshot(bridge, uploaded.path);

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
      } catch (err) {
        // getUserMedia-shaped failures (permission/device/in-use) get the
        // classified copy; anything else falls back to the generic message.
        const name = err instanceof Error ? err.name : '';
        if (/^(NotAllowed|NotFound|NotReadable|Overconstrained|Security|TrackStart|ConstraintNotSatisfied|DevicesNotFound)/.test(name)) {
          message.error(describeCameraError(err, t));
        } else {
          message.error(t('periph.camera.captureFailed', 'Capture failed'));
        }
      } finally {
        setBusy(false);
      }
    },
    [selectedId, resolveTargetBridge, setChatAttachmentPrefill, recordManualSnapshot, message, t],
  );

  // ── selection validity (T19 P4) ─────────────────────────────────────────────
  // A device is "selected" only when selectedId is a truthy, non-empty id — the
  // pre-auth placeholder deviceId='' must never count as a selection. Gates the
  // capture actions (snap / save) so they can't fire against no real device.
  const isValidId = !!selectedId && selectedId !== '';

  // Effective list of REAL cameras (drop the pre-auth deviceId='' placeholder).
  const validDevices = useMemo(
    () => videoDevices.filter((d) => d.deviceId && d.deviceId !== ''),
    [videoDevices],
  );

  // ── bridge lookup, per device (derived from store) ──────────────────────────
  /** Find the registered browser-camera device bridging a given mediaDevice id. */
  const bridgeForDevice = useCallback(
    (deviceId: string) =>
      devices.find(
        (d) => d.driver === 'browser-camera' && (d.config as { deviceId?: string })?.deviceId === deviceId,
      ),
    [devices],
  );

  // The bridge for the *currently-selected* device drives the monitors/timeline.
  const bridgeDevice = useMemo(
    () => (isValidId ? bridgeForDevice(selectedId!) : undefined),
    [isValidId, selectedId, bridgeForDevice],
  );

  // Row status classification: registered+enabled → green, registered → blue,
  // unregistered → grey. Data source: peripherals store devices matched by
  // driver==='browser-camera' && config.deviceId.
  const statusColorFor = useCallback(
    (deviceId: string): string => {
      const bridge = bridgeForDevice(deviceId);
      if (bridge?.enabled) return tokens.accent.green ?? '#22C55E';
      if (bridge) return tokens.accent.blue ?? '#3B82F6';
      return tokens.text.muted;
    },
    [bridgeForDevice, tokens],
  );

  // ── per-device bridge toggle (idempotent create/update + announce) ──────────
  // T19 P4: parameterized by an explicit device (id+label) so each list row
  // toggles its OWN bridge, not whichever device happens to be selectedId.
  const handleBridgeToggle = useCallback(
    async (deviceId: string, label: string, next: boolean) => {
      if (!deviceId || deviceId === '') return;
      const bridge = bridgeForDevice(deviceId);
      const name = label || 'Camera';
      if (next) {
        if (bridge) {
          await updateDevice(bridge.id, { enabled: true });
        } else {
          await createDevice({
            name,
            kind: 'camera',
            driver: 'browser-camera',
            config: { deviceId, label: name },
          });
        }
        await announceBridge([{ deviceId, label: name }], window.isSecureContext);
      } else if (bridge) {
        await updateDevice(bridge.id, { enabled: false });
      }
    },
    [bridgeForDevice, updateDevice, createDevice, announceBridge],
  );

  // ── render: rtsp device → HLS live preview (no getUserMedia) ────────────────
  // An rtsp device has no browser camera; show the gateway HLS transmux preview
  // plus its monitors + timeline. This path bypasses the secure-context /
  // enumeration flow entirely (H5: rtsp preview is separate from getUserMedia).
  if (rtspDevice) {
    return (
      <div
        data-testid="periph-camera-rtsp-detail"
        style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 16, overflowY: 'auto' }}
      >
        <Text strong style={{ fontSize: 14 }}>
          {t('periph.preview.titleFor', { name: rtspDevice.name, defaultValue: `Live preview — ${rtspDevice.name}` })}
        </Text>
        <RtspLivePreview deviceId={rtspDevice.id} />
        <DeviceMonitors
          deviceId={rtspDevice.id}
          deviceName={rtspDevice.name}
          checkPrompt={rtspDevice.check_prompt}
        />
        <Text
          data-testid="periph-camera-rtsp-timeline-title"
          style={{ fontWeight: 600, fontSize: 13, display: 'block', marginTop: 8 }}
        >
          {t('periph.timeline.titleFor', { name: rtspDevice.name, defaultValue: `Observation Timeline — ${rtspDevice.name}` })}
        </Text>
        <ObservationTimeline deviceId={rtspDevice.id} />
      </div>
    );
  }

  // local-camera is captured by gateway ffmpeg, not getUserMedia. It has no
  // browser-native live stream, but its stable detail still exposes scheduled
  // checks and the complete observation timeline.
  if (localCameraDevice) {
    const localAddress = String(
      (localCameraDevice.config as { device?: unknown }).device ?? '',
    );
    return (
      <div
        data-testid="periph-camera-local-detail"
        style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 16, overflowY: 'auto' }}
      >
        <Alert
          type="info"
          showIcon
          message={t(
            'periph.camera.localGatewayHint',
            'This camera is captured by the gateway. Scheduled checks continue while the dashboard is closed.',
          )}
          description={
            localAddress
              ? t('periph.camera.localDeviceAddress', {
                  defaultValue: 'System camera address: {{device}}',
                  device: localAddress,
                })
              : undefined
          }
        />
        <DeviceMonitors
          deviceId={localCameraDevice.id}
          deviceName={localCameraDevice.name}
          checkPrompt={localCameraDevice.check_prompt}
        />
        <Text
          data-testid="periph-camera-local-timeline-title"
          style={{ fontWeight: 600, fontSize: 13, display: 'block', marginTop: 8 }}
        >
          {t('periph.timeline.titleFor', {
            name: localCameraDevice.name,
            defaultValue: `Observation Timeline — ${localCameraDevice.name}`,
          })}
        </Text>
        <ObservationTimeline deviceId={localCameraDevice.id} />
      </div>
    );
  }

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

  // Model name shown in the copy (P1-V2). Prefer the "provider/model" basename;
  // fall back to a generic word when no ref was resolvable.
  const visionModelName =
    vision.modelRef?.split('/').pop() ??
    vision.modelRef ??
    t('periph.camera.visionModelFallback', 'the current model');

  // P2-V4: split the false branch into an AUTHORITATIVE verdict (catalog/config
  // card confirmed text-only) with a definite, action-accurate wording, vs the
  // weak 'unknown' wording. `true` → supported; 'unknown' → cannot confirm.
  const visionCopy =
    vision.supportsImage === true
      ? t('periph.camera.visionOk', { defaultValue: 'The current model ({{model}}) supports image input.', model: visionModelName })
      : vision.supportsImage === false
        ? t('periph.camera.visionFalse', {
            defaultValue: 'The current session model {{model}} does not support image input; photos will be saved to the workspace and described via /image before being handed to the model.',
            model: visionModelName,
          })
        : t('periph.camera.visionUnknown', { defaultValue: 'Cannot confirm whether the current model ({{model}}) supports image input.', model: visionModelName });

  // Override provenance line + clear entry (P1-V2). Shown only when a per-session
  // /model override drives the judgment. sessions.patch { model: null } clears it;
  // if the RPC is somehow unavailable the copy still guides the /model reset.
  const overrideHint = isSessionOverride
    ? t('periph.camera.visionOverrideHint', {
        defaultValue: 'This session has a /model override ({{model}}).',
        model: visionModelName,
      })
    : null;

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

      {/* Multi-modal vision hint (non-blocking). When a per-session /model
          override drives the judgment, append a provenance line + one-click
          clear (P1-V2). */}
      <Alert
        data-testid="periph-camera-vision-hint"
        type="info"
        showIcon
        message={
          <span>
            <span data-testid="periph-camera-vision-copy">{visionCopy}</span>
            {overrideHint && (
              <span
                data-testid="periph-camera-vision-override"
                style={{ display: 'block', marginTop: 6, color: tokens.text.secondary }}
              >
                {overrideHint}{' '}
                <Button
                  data-testid="periph-camera-vision-clear-override"
                  type="link"
                  size="small"
                  style={{ padding: 0, height: 'auto' }}
                  onClick={handleClearOverride}
                >
                  {t('periph.camera.visionOverrideClear', 'Clear override')}
                </Button>
              </span>
            )}
          </span>
        }
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
        // ── Pre-authorization: labels/deviceIds are empty. Show a placeholder in
        //    place of the device list + keep the primary Authorize button (T19 P4).
        <div data-testid="periph-camera-authorize-wrap" style={{ padding: '12px 0' }}>
          <Text style={{ fontSize: 12, color: tokens.text.muted, display: 'block', marginBottom: 6 }}>
            {t('periph.camera.deviceListTitle', { defaultValue: `Camera devices [${validDevices.length}]`, count: validDevices.length })}
          </Text>
          <div
            data-testid="periph-camera-list-locked"
            style={{
              padding: '16px 12px',
              textAlign: 'center',
              background: tokens.bg.surfaceHover,
              borderRadius: 8,
              marginBottom: 10,
            }}
          >
            <Text style={{ color: tokens.text.muted }}>
              {t('periph.camera.listLocked', 'Visible after you grant access')}
            </Text>
          </div>
          <Text style={{ color: tokens.text.secondary, display: 'block', marginBottom: 8 }}>
            {t('periph.camera.permissionHint', 'Grant camera access to list and preview devices.')}
          </Text>
          <Button data-testid="periph-camera-authorize" type="primary" onClick={handleAuthorize}>
            {t('periph.camera.authorize', 'Authorize camera')}
          </Button>
        </div>
      ) : (
        <>
          {/* ── Device list (T19 P4): every videoinput is one row ─────────── */}
          <div data-testid="periph-camera-device-select">
            <Text
              data-testid="periph-camera-list-title"
              style={{ fontSize: 12, color: tokens.text.muted, display: 'block', marginBottom: 6 }}
            >
              {t('periph.camera.deviceListTitle', { defaultValue: `Camera devices [${validDevices.length}]`, count: validDevices.length })}
            </Text>
            <div data-testid="periph-camera-device-list" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {validDevices.map((d) => {
                const isSelected = d.deviceId === selectedId;
                const bridge = bridgeForDevice(d.deviceId);
                const rowLabel = d.label || d.deviceId;
                return (
                  <div
                    key={d.deviceId}
                    data-testid={`periph-camera-device-row-${d.deviceId}`}
                    data-selected={isSelected ? 'true' : 'false'}
                    role="button"
                    tabIndex={0}
                    onClick={() => setSelectedId(d.deviceId)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setSelectedId(d.deviceId);
                      }
                    }}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      padding: '8px 12px',
                      borderRadius: 8,
                      cursor: 'pointer',
                      background: isSelected ? tokens.bg.surfaceHover : tokens.bg.surface,
                      border: `1px solid ${isSelected ? tokens.accent.blue : tokens.border.default}`,
                    }}
                  >
                    {/* Registration status dot */}
                    <span
                      data-testid={`periph-camera-status-dot-${d.deviceId}`}
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: '50%',
                        background: statusColorFor(d.deviceId),
                        flexShrink: 0,
                      }}
                    />
                    <Text style={{ color: tokens.text.primary, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {rowLabel}
                    </Text>
                    {/* Per-row bridge register / enable switch (idempotent) */}
                    <span
                      data-testid={`periph-camera-bridge-switch-${d.deviceId}`}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <Switch
                        size="small"
                        checked={Boolean(bridge?.enabled)}
                        onChange={(next) => handleBridgeToggle(d.deviceId, d.label, next)}
                      />
                    </span>
                  </div>
                );
              })}
            </div>
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
              data-testid="periph-camera-caption"
              style={{
                position: 'absolute',
                left: 0,
                right: 0,
                bottom: 0,
                padding: '4px 8px',
                background: previewError ? 'rgba(127,29,29,0.85)' : 'rgba(0,0,0,0.55)',
                color: '#fff',
                fontSize: 11,
                fontFamily: "'Fira Code', monospace",
              }}
            >
              {previewError || caption || t('periph.camera.starting', 'Starting preview…')}
            </div>
          </div>

          {/* Action row — disabled until a real device is selected (T19 P4) */}
          <div style={{ display: 'flex', gap: 8 }}>
            <Tooltip title={isValidId ? '' : t('periph.camera.selectFirst', 'Please select a camera device first')}>
              <Button
                data-testid="periph-camera-snap"
                type="primary"
                icon={<CameraOutlined />}
                loading={busy}
                disabled={!isValidId}
                onClick={() => captureAndUpload(true)}
                style={{ background: isValidId ? tokens.accent.red : undefined, borderColor: isValidId ? tokens.accent.red : undefined }}
              >
                {t('periph.camera.snapToChat', 'Snap & add to chat')}
              </Button>
            </Tooltip>
            <Tooltip title={isValidId ? '' : t('periph.camera.selectFirst', 'Please select a camera device first')}>
              <Button
                data-testid="periph-camera-save"
                icon={<SaveOutlined />}
                loading={busy}
                disabled={!isValidId}
                onClick={() => captureAndUpload(false)}
              >
                {t('periph.camera.saveToWorkspace', 'Save to workspace')}
              </Button>
            </Tooltip>
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

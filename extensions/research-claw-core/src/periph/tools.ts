/**
 * Research-Claw Core — Peripheral Tools
 *
 * 3 agent tools in the `periph_*` namespace.
 *
 * ── ToolDefinition shape (摘录自 src/literature/tools.ts:1-80 与 index.ts:1114-1138) ────
 *
 *   interface ToolDefinition {
 *     name:        string;
 *     description: string;
 *     parameters:  Record<string, unknown>;   // raw JSON Schema object (no TypeBox)
 *     execute: (
 *       toolCallId: string,
 *       params:    Record<string, unknown>,
 *       signal?:   unknown,
 *       onUpdate?: unknown,
 *     ) => Promise<unknown>;
 *   }
 *
 * Return shape (from ok() helper pattern across all tool modules):
 *   { content: [{ type: 'text', text: string }], details: unknown }
 *
 * All text returns are JSON strings when structured data is needed (same
 * convention as monitor_* and job_* tools that JSON.stringify their payloads).
 *
 * Source references:
 *   - src/literature/tools.ts lines 1-80  → ToolDefinition fields + ok/fail helpers
 *   - src/monitor/tools.ts lines 17-24    → ok/fail return form
 *   - index.ts lines 1114-1138            → registration guard, for-of pattern
 * ────────────────────────────────────────────────────────────────────────────
 *
 * 图像内联 (F2): buildSnapResult(payload, opts:{inlineImage}) 单点控制.
 * OC embedded runner 的工具结果 content 类型为 (TextContent | ImageContent)[]
 * (openclaw/packages/agent-core/src/types.ts:418-420);ImageContent 形态为
 * { type:'image', data:<base64>, mimeType } (openclaw/packages/llm-core/src/types.ts:225-229).
 * 插件工具结果只要带 content[] 即原样透传 (openclaw/src/agents/agent-tool-definition-adapter.ts:225-234),
 * 历史回放时图像块由 OC 自动缩放护栏处理 (openclaw/src/agents/tool-images.ts:33-39).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { ToolDefinition } from '../types.js';
import type { PeriphService } from './service.js';
import type { PeriphBridge } from './bridge.js';
import type { CaptureResult } from './bridge.js';
import { PathEscapeError, resolveWithinRoot } from '../workspace/path-guard.js';
import { PeriphDeviceIdError } from './service.js';
import { captureRtspFrame } from './rtsp.js';
import { captureLocalCameraFrame } from './local-camera.js';

// ── Inline image switch (F2) ─────────────────────────────────────────────────

/** F2: snap 成功后把帧读回并作为 image content 内联(真机探针由控制器验收)。 */
export const PERIPH_SNAP_INLINE_IMAGE = true;

/**
 * 帧超过此大小时跳过内联仅留 text(对齐 OC DEFAULT_IMAGE_MAX_BYTES,
 * openclaw/src/agents/image-sanitization.ts:9 — Anthropic API 拒收 >5MB 图像,
 * 且插件工具结果在当轮不会被 OC 自动压缩)。
 */
export const PERIPH_SNAP_INLINE_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

// ── Helpers ──────────────────────────────────────────────────────────────────

function ok(text: string, details?: unknown): unknown {
  return { content: [{ type: 'text', text }], details: details ?? {} };
}

function fail(message: string): unknown {
  return { content: [{ type: 'text', text: `Error: ${message}` }], details: { error: message } };
}

// ── buildSnapResult ───────────────────────────────────────────────────────────

interface SnapPayload {
  frame_path: string;
  width?: number;
  height?: number;
  captured_at: string;
  imageBase64?: string;
  imageMimeType?: string;
}

/**
 * Build the tool return value for a successful snap.
 *
 * base64 只进 image content 块 — text JSON 与 details 均剔除 imageBase64,
 * 避免兆级 base64 重复占用上下文与会话日志。
 *
 * @param payload   - snap result fields
 * @param opts.inlineImage - when true, attach image content
 *                           ({type:'image', data:<base64>, mimeType} —
 *                           openclaw/packages/llm-core/src/types.ts:225-229).
 *                           When false, return pure text JSON.
 */
export function buildSnapResult(
  payload: SnapPayload,
  opts: { inlineImage: boolean } = { inlineImage: PERIPH_SNAP_INLINE_IMAGE },
): unknown {
  const { imageBase64, imageMimeType, ...textPayload } = payload;
  const text = JSON.stringify(textPayload);

  if (!opts.inlineImage) {
    return ok(text, textPayload);
  }

  if (imageBase64) {
    return {
      content: [
        { type: 'text', text },
        { type: 'image', data: imageBase64, mimeType: imageMimeType ?? 'image/jpeg' },
      ],
      details: textPayload,
    };
  }
  // imageBase64 缺失时退化为纯 text
  return ok(text, textPayload);
}

// ── Frame read-back for inline (F2) ──────────────────────────────────────────

function frameMimeType(absPath: string): string {
  const ext = path.extname(absPath).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  return 'image/jpeg';
}

/**
 * Read a captured frame back for inlining.
 * Returns null (→ text-only fallback) when the file is missing/unreadable,
 * exceeds PERIPH_SNAP_INLINE_IMAGE_MAX_BYTES, or resolves outside
 * <workspaceRoot>/periph/ (strict prefix check, same as service.ts trimming).
 */
export function readFrameForInline(
  workspaceRoot: string,
  framePath: string,
): { base64: string; mimeType: string } | null {
  try {
    // Symlink-aware containment (audit #5): a lexical path.resolve + startsWith
    // check does NOT follow symlinks, so `periph/link.jpg → /etc/passwd` (or a
    // symlinked intermediate dir) reads outside the workspace. resolveWithinRoot
    // rejects absolute/.. paths AND realpath-walks every ancestor, throwing on any
    // symlink that escapes the workspace root. We then require the frame's REAL
    // location to sit under the REAL periph/ dir (not just anywhere in workspace).
    const abs = resolveWithinRoot(workspaceRoot, framePath); // throws PathEscapeError on escape
    const realPeriph = fs.realpathSync(path.resolve(workspaceRoot, 'periph'));
    const realAbs = fs.realpathSync(abs); // resolves the file's own symlink, if any
    if (realAbs !== realPeriph && !realAbs.startsWith(realPeriph + path.sep)) {
      return null;
    }
    const stat = fs.statSync(realAbs);
    if (stat.size > PERIPH_SNAP_INLINE_IMAGE_MAX_BYTES) return null;
    return { base64: fs.readFileSync(realAbs).toString('base64'), mimeType: frameMimeType(realAbs) };
  } catch {
    // Missing/unreadable frame, or a symlink/traversal escape — snap 本身已成功,
    // 退化为纯 text 不算失败。
    return null;
  }
}

// ── Gateway-driver frame path normalisation ──────────────────────────────────

/**
 * Normalise a captured frame path to the WORKSPACE-RELATIVE form the rest of the
 * system speaks.
 *
 * The browser-camera bridge already returns a relative path (the dashboard
 * uploads through POST /rc/upload, which answers with `periph/<id>/<ts>.jpg`).
 * The gateway-side drivers (rtsp / local-camera) instead write to an ABSOLUTE
 * path under `<workspaceRoot>/periph/<deviceId>/` (service.frameDirFor). Every
 * downstream consumer resolves through path-guard `resolveWithinRoot`, which
 * REJECTS absolute paths by design:
 *   • readFrameForInline()          → returns null → the F2 inline ImageContent
 *                                     silently disappears, so the model never
 *                                     sees the frame it is asked to verify;
 *   • GET /rc/download?path=<...>   → wsService.resolvePath → 400 PATH_ESCAPE,
 *                                     so the dashboard observation timeline
 *                                     cannot render the thumbnail.
 * Converting once, here at the tool boundary, makes all three drivers agree.
 *
 * Security is unchanged: a path that resolves OUTSIDE the workspace yields a
 * `..`-prefixed relative path (or is returned verbatim), and the downstream
 * guard still rejects it.
 */
export function toWorkspaceRelativeFramePath(workspaceRoot: string, framePath: string): string {
  if (!framePath || !path.isAbsolute(framePath)) return framePath;
  const rel = path.relative(workspaceRoot, framePath);
  // Empty / escaping / still-absolute → leave as-is so the guard can reject it.
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return framePath;
  return rel;
}

// ── createPeriphTools ─────────────────────────────────────────────────────────

export function createPeriphTools(
  service: PeriphService,
  bridge: PeriphBridge,
  opts: { workspaceRoot: string },
): ToolDefinition[] {
  const { workspaceRoot } = opts;
  const tools: ToolDefinition[] = [];

  // ── 1. periph_list ────────────────────────────────────────────────────────

  tools.push({
    name: 'periph_list',
    description:
      'List all registered peripheral devices and the camera bridge status. ' +
      'Returns a JSON object with two fields: ' +
      '"devices" (array; each entry has id, name, kind, driver, enabled, last_seen_at, ' +
      'latest_observation (verdict/summary/captured_at) or null, and monitor_hint — ' +
      'the exact monitor_create call to schedule recurring checks for that device) and ' +
      '"camera_bridge" ({online: boolean, last_announce_at: string|null, ' +
      'browser_devices: [{deviceId, label}]}). ' +
      'Check camera_bridge.online before calling periph_camera_snap to diagnose bridge-offline errors.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
    async execute(_toolCallId: string, _params: Record<string, unknown>): Promise<unknown> {
      try {
        const devices = service.listDevices();
        const deviceList = devices.map((dev) => {
          const obs = service.listObservations({ device_id: dev.id, limit: 1 });
          const latest = obs[0]
            ? {
                verdict: obs[0].verdict,
                summary: obs[0].summary,
                captured_at: obs[0].captured_at,
              }
            : null;
          return {
            id: dev.id,
            name: dev.name,
            kind: dev.kind,
            driver: dev.driver,
            enabled: dev.enabled,
            last_seen_at: dev.last_seen_at,
            latest_observation: latest,
            // §13.3 机器可读指引 — agent 无需读 AGENTS.md 即可正确建 device 监控
            monitor_hint: `创建定时查证请用 monitor_create(source_type='device', target='${dev.id}')`,
          };
        });

        const announce = bridge.getAnnounce();
        const cameraBridge = announce
          ? {
              online: true,
              last_announce_at: announce.at,
              browser_devices: announce.devices.map((d) => ({ deviceId: d.deviceId, label: d.label })),
            }
          : {
              online: false,
              last_announce_at: null,
              browser_devices: [],
            };

        const result = { devices: deviceList, camera_bridge: cameraBridge };
        return ok(JSON.stringify(result), result);
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  });

  // ── 2. periph_camera_snap ─────────────────────────────────────────────────

  tools.push({
    name: 'periph_camera_snap',
    description:
      'Request a camera frame from the dashboard bridge. ' +
      'If device_id is omitted the tool selects the unique enabled camera device automatically; ' +
      'if 0 or 2+ enabled cameras are registered, a structured error is returned listing available ids. ' +
      'Requires the dashboard to be open to provide the camera bridge.',
    parameters: {
      type: 'object',
      properties: {
        device_id: {
          type: 'string',
          description:
            'Peripheral device id. Omit to auto-select the only enabled camera; ' +
            'if multiple enabled cameras exist the call returns an error listing them.',
        },
        purpose: {
          type: 'string',
          description: 'Short description of why the frame is needed (used as observation summary).',
        },
        monitor_id: {
          type: 'string',
          description:
            'The scheduled monitor\'s id (from the MONITOR_ID line in your run context), so the ' +
            'auto-recorded observation is traceable to its monitor. Omit for manual/ad-hoc snaps.',
        },
      },
      required: [],
    },
    async execute(_toolCallId: string, params: Record<string, unknown>): Promise<unknown> {
      try {
        const monitorId = typeof params.monitor_id === 'string' && params.monitor_id.trim()
          ? params.monitor_id.trim()
          : undefined;
        // ── Resolve device ───────────────────────────────────────────────────
        let deviceId = typeof params.device_id === 'string' ? params.device_id : undefined;
        let device = deviceId ? service.getDevice(deviceId) : null;

        if (!deviceId) {
          // Auto-select: find enabled cameras
          const allDevices = service.listDevices();
          const cameras = allDevices.filter((d) => d.enabled && d.kind === 'camera');
          if (cameras.length === 0) {
            return fail(
              JSON.stringify({
                error: 'no-enabled-camera',
                message: 'No enabled camera devices found. Register a camera device first.',
              }),
            );
          }
          if (cameras.length > 1) {
            return fail(
              JSON.stringify({
                error: 'multiple-cameras',
                message: 'Multiple enabled cameras found. Specify device_id.',
                device_ids: cameras.map((d) => d.id),
              }),
            );
          }
          device = cameras[0];
          deviceId = device.id;
        } else if (!device) {
          return fail(
            JSON.stringify({
              error: 'device-not-found',
              message: `Device not found: ${deviceId}`,
            }),
          );
        }

        // Verify device is a camera
        if (device.kind !== 'camera') {
          return fail(
            JSON.stringify({
              error: 'not-a-camera',
              message: `Device ${deviceId} is kind '${device.kind}', not 'camera'.`,
            }),
          );
        }

        const purpose = typeof params.purpose === 'string' ? params.purpose : undefined;

        // ── Acquire a frame via the device's driver (§15-D8 案 A / §15 v1.3) ──
        // driver==='rtsp'         → gateway-side ffmpeg single-frame grab from an
        //                           IP camera (NO browser bridge) — works while the
        //                           dashboard is CLOSED (unattended monitoring).
        // driver==='local-camera' → gateway-side ffmpeg single-frame grab from a
        //                           locally-attached OS camera (USB/built-in webcam)
        //                           via avfoundation/dshow — also NO browser bridge,
        //                           also works with the dashboard CLOSED.
        // driver==='browser-camera' (or any other) → existing reverse bridge.
        // rtsp/local-camera devices keep kind='camera', so the not-a-camera guard
        // and auto-select (all camera drivers count as cameras) above are unchanged.
        //
        // The two gateway-side drivers turn the device id into a filesystem
        // path, so resolve that path FIRST — before any mkdir or ffmpeg spawn.
        // frameDirFor validates the id shape AND realpath-contains the result,
        // throwing instead of returning an escaping path, so a traversal id
        // (legacy row / hand-edited SQLite) or a symlinked periph/ aborts the
        // capture rather than writing outside the workspace. browser-camera
        // uploads instead go through POST /rc/upload, which guards separately.
        let gatewayOutDir: string | null = null;
        if (device.driver === 'rtsp' || device.driver === 'local-camera') {
          try {
            gatewayOutDir = service.frameDirFor(deviceId);
          } catch (err) {
            if (err instanceof PeriphDeviceIdError || err instanceof PathEscapeError) {
              return fail(
                JSON.stringify({
                  error: 'invalid-device-id',
                  message: `Device ${deviceId} does not resolve to a frame directory inside the workspace; capture refused.`,
                }),
              );
            }
            throw err;
          }
        }

        let result: CaptureResult;
        if (device.driver === 'rtsp') {
          const cfg = device.config as { url?: unknown; username?: unknown; password?: unknown };
          const url = typeof cfg.url === 'string' ? cfg.url : '';
          if (!url) {
            // Misconfigured rtsp device — no url in config.
            result = { ok: false, error: 'rtsp-url-missing' };
          } else {
            // Frames land in the same per-device dir as bridge uploads
            // (workspace/periph/<deviceId>/), so retention/inline read-back reuse
            // the existing path guard untouched. Already validated + contained
            // above; only the mkdir itself can still fail benignly here.
            const outDir = gatewayOutDir!;
            try {
              fs.mkdirSync(outDir, { recursive: true });
            } catch {
              /* mkdir failure surfaces as a capture failure below */
            }
            result = await captureRtspFrame({
              url,
              username: typeof cfg.username === 'string' ? cfg.username : undefined,
              password: typeof cfg.password === 'string' ? cfg.password : undefined,
              outDir,
            });
          }
        } else if (device.driver === 'local-camera') {
          // Gateway-side ffmpeg grab from an OS-attached camera. config.device is
          // the platform address (avfoundation index e.g. '0' / '0:none' on
          // darwin, DirectShow device NAME on win32). The device string is passed
          // as ONE array arg (shell:false) so shell metacharacters cannot inject.
          const cfg = device.config as { device?: unknown };
          const localDevice = typeof cfg.device === 'string' ? cfg.device.trim() : '';
          if (!localDevice) {
            // Misconfigured local-camera device — no device index/name in config.
            result = { ok: false, error: 'local-camera-device-missing' };
          } else {
            // Frames land in the same per-device dir as bridge/rtsp uploads
            // (workspace/periph/<deviceId>/), so retention/inline read-back reuse
            // the existing path guard untouched. Already validated + contained
            // above; only the mkdir itself can still fail benignly here.
            const outDir = gatewayOutDir!;
            try {
              fs.mkdirSync(outDir, { recursive: true });
            } catch {
              /* mkdir failure surfaces as a capture failure below */
            }
            result = await captureLocalCameraFrame({ device: localDevice, outDir });
          }
        } else {
          // ── Build browser-side deviceId ────────────────────────────────────
          // config.deviceId is the browser MediaDevices deviceId (browser-camera).
          const configDeviceId =
            typeof device.config.deviceId === 'string' ? device.config.deviceId : undefined;
          const browserDeviceId = configDeviceId ?? device.id;

          // Pass the registered device UUID (deviceId) as the 4th arg so the bridge
          // broadcast payload carries registeredDeviceId — the dashboard
          // PeriphCaptureListener keys the upload dir by it (P2-F1), not by the
          // browser mediaDeviceId. (3rd arg = default capture timeout.)
          result = await bridge.requestCapture(browserDeviceId, purpose ?? 'manual snap', undefined, deviceId);
        }

        if (result.ok && result.path) {
          // Success: record snapshot observation + update last_seen_at
          const captured_at = new Date().toISOString();

          // Gateway-side drivers (rtsp / local-camera) return an ABSOLUTE path;
          // the bridge returns a workspace-relative one. Normalise so the stored
          // observation, the returned payload and the inline read-back all speak
          // the workspace-relative form the path guard accepts.
          const framePath = toWorkspaceRelativeFramePath(workspaceRoot, result.path);

          service.recordObservation({
            device_id: deviceId,
            kind: 'snapshot',
            verdict: 'info',
            frame_path: framePath,
            summary: purpose ?? 'manual snap',
            monitor_id: monitorId,
          });

          service.updateDevice(deviceId, { last_seen_at: captured_at });

          const payload: SnapPayload = {
            frame_path: framePath,
            width: result.width,
            height: result.height,
            captured_at,
          };

          // F2: 读回帧文件内联为 image content,让模型直接看到画面
          // (>5MB 或读取失败时 readFrameForInline 返回 null → 纯 text)
          if (PERIPH_SNAP_INLINE_IMAGE) {
            const inline = readFrameForInline(workspaceRoot, framePath);
            if (inline) {
              payload.imageBase64 = inline.base64;
              payload.imageMimeType = inline.mimeType;
            }
          }
          return buildSnapResult(payload);
        }

        // ── Failure path ─────────────────────────────────────────────────────
        const errCode = result.error ?? 'unknown';
        const isOffline = errCode === 'bridge-offline' || errCode === 'bridge-timeout';

        const verdict = isOffline ? 'missed' : 'error';
        const summary = isOffline
          ? `${errCode}: dashboard bridge not available`
          : `capture failed: ${errCode}`;

        service.recordObservation({
          device_id: deviceId,
          kind: 'snapshot',
          verdict,
          summary,
          monitor_id: monitorId,
        });

        const errorPayload: Record<string, unknown> = {
          error: errCode,
          message: isOffline
            ? `摄像头捕获失败: 需要保持 dashboard 打开以提供摄像头桥 (${errCode})。可先调用 periph_list 查看 camera_bridge.online 确认桥状态`
            : `Capture failed: ${errCode}`,
        };

        return fail(JSON.stringify(errorPayload));
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  });

  // ── 3. periph_observe ────────────────────────────────────────────────────

  tools.push({
    name: 'periph_observe',
    description:
      'Record a manual observation (check or note) for a peripheral device. ' +
      "Use kind='check' for structured status checks, kind='note' for free-form notes. " +
      'snapshot observations are recorded automatically by periph_camera_snap.',
    parameters: {
      type: 'object',
      properties: {
        device_id: {
          type: 'string',
          description: 'ID of the peripheral device to observe.',
        },
        kind: {
          type: 'string',
          enum: ['check', 'note'],
          description: "Observation kind: 'check' for status checks, 'note' for free-form notes.",
        },
        verdict: {
          type: 'string',
          enum: ['ok', 'alert', 'info', 'unverified', 'missed', 'error'],
          description: "Observation verdict (default: 'info').",
        },
        summary: {
          type: 'string',
          description: 'Human-readable description of the observation.',
        },
        frame_path: {
          type: 'string',
          description: 'Optional path to an associated frame file.',
        },
        data: {
          type: 'object',
          description: 'Optional structured data for the observation (stored as result_json).',
        },
        monitor_id: {
          type: 'string',
          description: 'Optional monitor ID to associate this observation with.',
        },
      },
      required: ['device_id', 'kind'],
    },
    async execute(_toolCallId: string, params: Record<string, unknown>): Promise<unknown> {
      try {
        const deviceId = typeof params.device_id === 'string' ? params.device_id.trim() : '';
        if (!deviceId) return fail('device_id is required and must be a non-empty string');

        const kind = params.kind;
        if (kind !== 'check' && kind !== 'note') {
          return fail(`kind must be 'check' or 'note', got: ${String(kind)}`);
        }

        // Verify device exists
        const device = service.getDevice(deviceId);
        if (!device) {
          return fail(
            JSON.stringify({
              error: 'device-not-found',
              message: `Device not found: ${deviceId}`,
            }),
          );
        }

        const verdict =
          typeof params.verdict === 'string' && params.verdict
            ? (params.verdict as 'ok' | 'alert' | 'info' | 'unverified' | 'missed' | 'error')
            : 'info';

        const obs = service.recordObservation({
          device_id: deviceId,
          kind,
          verdict,
          summary: typeof params.summary === 'string' ? params.summary : undefined,
          frame_path: typeof params.frame_path === 'string' ? params.frame_path : undefined,
          result_json:
            typeof params.data === 'object' && params.data !== null && !Array.isArray(params.data)
              ? (params.data as Record<string, unknown>)
              : undefined,
          monitor_id: typeof params.monitor_id === 'string' ? params.monitor_id : undefined,
        });

        const result = {
          id: obs.id,
          captured_at: obs.captured_at,
        };

        return ok(JSON.stringify(result), result);
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  });

  return tools;
}

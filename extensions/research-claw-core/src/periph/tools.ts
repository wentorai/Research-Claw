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
 * T19 图像内联探针开关: buildSnapResult(payload, opts:{inlineImage}) 单点控制.
 * 当前 PERIPH_SNAP_INLINE_IMAGE = false → 纯 text 返回.
 * T19 真机探针后将 true 路径实现 MCP image content(type:'image', data:base64, mimeType).
 */

import type { ToolDefinition } from '../types.js';
import type { PeriphService } from './service.js';
import type { PeriphBridge } from './bridge.js';

// ── Probe switch (T19) ───────────────────────────────────────────────────────

/** Set to true in T19 after gateway systemPromptReport probe confirms image inline works. */
export const PERIPH_SNAP_INLINE_IMAGE = false;

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
 * @param payload   - snap result fields
 * @param opts.inlineImage - when true, attach MCP-style image content (T19).
 *                           When false (default), return pure text JSON.
 */
export function buildSnapResult(
  payload: SnapPayload,
  opts: { inlineImage: boolean } = { inlineImage: PERIPH_SNAP_INLINE_IMAGE },
): unknown {
  const text = JSON.stringify(payload);

  if (!opts.inlineImage) {
    return ok(text, payload);
  }

  // T19 image inline path.
  // Shape: MCP content array with { type:'image', data:<base64>, mimeType:'image/jpeg' }
  // T19 真机探针最终定形 — mimeType 默认 'image/jpeg'.
  if (payload.imageBase64) {
    return {
      content: [
        { type: 'text', text },
        { type: 'image', data: payload.imageBase64, mimeType: payload.imageMimeType ?? 'image/jpeg' },
      ],
      details: payload,
    };
  }
  // imageBase64 缺失时退化为纯 text
  return ok(text, payload);
}

// ── createPeriphTools ─────────────────────────────────────────────────────────

export function createPeriphTools(service: PeriphService, bridge: PeriphBridge): ToolDefinition[] {
  const tools: ToolDefinition[] = [];

  // ── 1. periph_list ────────────────────────────────────────────────────────

  tools.push({
    name: 'periph_list',
    description:
      'List all registered peripheral devices and their latest observation. ' +
      'Returns a JSON array; each entry has id, name, kind, driver, enabled, last_seen_at, ' +
      'and latest_observation (verdict/summary/captured_at) or null.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
    async execute(_toolCallId: string, _params: Record<string, unknown>): Promise<unknown> {
      try {
        const devices = service.listDevices();
        const result = devices.map((dev) => {
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
          };
        });
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
      },
      required: [],
    },
    async execute(_toolCallId: string, params: Record<string, unknown>): Promise<unknown> {
      try {
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

        // ── Build browser-side deviceId ──────────────────────────────────────
        // config.deviceId is the browser MediaDevices deviceId (browser-camera driver)
        const configDeviceId =
          typeof device.config.deviceId === 'string' ? device.config.deviceId : undefined;
        const browserDeviceId = configDeviceId ?? device.id;

        const purpose = typeof params.purpose === 'string' ? params.purpose : undefined;

        // ── Request capture ──────────────────────────────────────────────────
        const result = await bridge.requestCapture(browserDeviceId, purpose ?? 'manual snap');

        if (result.ok && result.path) {
          // Success: record snapshot observation + update last_seen_at
          const captured_at = new Date().toISOString();

          service.recordObservation({
            device_id: deviceId,
            kind: 'snapshot',
            verdict: 'info',
            frame_path: result.path,
            summary: purpose ?? 'manual snap',
          });

          service.updateDevice(deviceId, { last_seen_at: captured_at });

          const payload: SnapPayload = {
            frame_path: result.path,
            width: result.width,
            height: result.height,
            captured_at,
          };

          // T19: 启用 PERIPH_SNAP_INLINE_IMAGE 时需在此读取 frame 字节填充 imageBase64
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
        });

        const errorPayload: Record<string, unknown> = {
          error: errCode,
          message: isOffline
            ? `摄像头捕获失败: 需要保持 dashboard 打开以提供摄像头桥 (${errCode})`
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

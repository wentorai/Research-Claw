/**
 * Realistic RPC response fixtures for peripheral store parity tests.
 *
 * Shapes mirror the EXACT responses returned by the Research-Claw Core plugin:
 *   Source: extensions/research-claw-core/src/periph/rpc.ts (rpc.ts)
 *   Types:  extensions/research-claw-core/src/periph/types.ts (PeriphDevice / PeriphObservation)
 *
 * Each fixture is annotated with the rpc.ts handler line that produces the shape.
 */

// ── rc.periph.devices.list ────────────────────────────────────────────────
// Source: rpc.ts:90-92  → registerMethod('rc.periph.devices.list', ...)
//   returns { devices: service.listDevices() }  (PeriphDevice[])
// PeriphDevice shape: types.ts:12-24

export const RC_PERIPH_DEVICES_LIST_RESPONSE = {
  devices: [
    {
      id: 'dev-cam-001',
      name: 'Lab Camera Front',
      kind: 'camera' as const,
      driver: 'browser-camera' as const,
      enabled: true,
      config: { deviceId: 'media-device-abc123', width: 1280, height: 720 },
      check_prompt: 'Is the lab bench clear and equipment properly arranged?',
      last_seen_at: '2026-07-20T10:30:00.000Z',
      last_error: null,
      created_at: '2026-07-01T08:00:00.000Z',
      updated_at: '2026-07-20T10:30:00.000Z',
    },
    {
      id: 'dev-plaud-001',
      name: 'Plaud Note Recorder',
      kind: 'audio-recorder' as const,
      driver: 'mcp-plaud' as const,
      enabled: true,
      config: {},
      check_prompt: '',
      last_seen_at: null,
      last_error: null,
      created_at: '2026-07-10T09:00:00.000Z',
      updated_at: '2026-07-10T09:00:00.000Z',
    },
  ],
};

// ── rc.periph.devices.create ──────────────────────────────────────────────
// Source: rpc.ts:95-117 → registerMethod('rc.periph.devices.create', ...)
//   returns { device: PeriphDevice }

export const RC_PERIPH_DEVICES_CREATE_RESPONSE = {
  device: {
    id: 'dev-cam-002',
    name: 'Microscope Camera',
    kind: 'camera' as const,
    driver: 'browser-camera' as const,
    enabled: true,
    config: { deviceId: 'media-device-xyz789' },
    check_prompt: 'Is the microscope slide properly centered?',
    last_seen_at: null,
    last_error: null,
    created_at: '2026-07-23T14:00:00.000Z',
    updated_at: '2026-07-23T14:00:00.000Z',
  },
};

// ── rc.periph.devices.update ──────────────────────────────────────────────
// Source: rpc.ts:120-140 → registerMethod('rc.periph.devices.update', ...)
//   returns { device: PeriphDevice }

export const RC_PERIPH_DEVICES_UPDATE_RESPONSE = {
  device: {
    id: 'dev-cam-001',
    name: 'Lab Camera Front (Renamed)',
    kind: 'camera' as const,
    driver: 'browser-camera' as const,
    enabled: false,
    config: { deviceId: 'media-device-abc123', width: 1280, height: 720 },
    check_prompt: 'Is the lab bench clear?',
    last_seen_at: '2026-07-20T10:30:00.000Z',
    last_error: null,
    created_at: '2026-07-01T08:00:00.000Z',
    updated_at: '2026-07-23T15:00:00.000Z',
  },
};

// ── rc.periph.devices.delete ──────────────────────────────────────────────
// Source: rpc.ts → registerMethod('rc.periph.devices.delete', ...)
//   returns { ok: true, deleted_monitors: Array<{id, gateway_job_id}> }
// The array is the device monitors the plugin cascaded away with the device
// (R2-I3); each names the OpenClaw cron job the client must still remove.
// Shape asserted against the real handler in
// extensions/research-claw-core/src/__tests__/periph-rpc.test.ts.

export const RC_PERIPH_DEVICES_DELETE_RESPONSE = {
  ok: true,
  deleted_monitors: [] as Array<{ id: string; gateway_job_id: string | null }>,
};

/** Device that had two bound monitors — one enabled with a cron job, one not. */
export const RC_PERIPH_DEVICES_DELETE_CASCADE_RESPONSE = {
  ok: true,
  deleted_monitors: [
    { id: 'mon-device-001', gateway_job_id: 'cron-job-7' },
    { id: 'mon-device-002', gateway_job_id: null },
  ] as Array<{ id: string; gateway_job_id: string | null }>,
};

// ── rc.periph.observations.list ───────────────────────────────────────────
// Source: rpc.ts:154-165 → registerMethod('rc.periph.observations.list', ...)
//   returns { observations: PeriphObservation[] }
// PeriphObservation shape: types.ts:26-36

// NOTE: real gateway shape — captured_at is SQLite datetime('now') "YYYY-MM-DD HH:MM:SS"
// (UTC, NO trailing Z); frame_path is a workspace-relative path periph/<deviceId>/<file>.jpg
// (the destination uploadFileToWorkspace writes to, service.ts frameDirFor). Fixtures must
// mirror this so parity tests / ObservationTimeline exercise the real normalization path.

export const RC_PERIPH_OBSERVATIONS_LIST_RESPONSE = {
  observations: [
    {
      id: 'obs-001',
      device_id: 'dev-cam-001',
      monitor_id: 'mon-001',
      kind: 'check' as const,
      verdict: 'ok' as const,
      summary: 'Lab bench is clear. All equipment in proper positions.',
      frame_path: 'periph/dev-cam-001/2026-07-20T10-30-00.jpg',
      result_json: { confidence: 0.97, items_detected: ['beaker', 'microscope'] },
      captured_at: '2026-07-20 10:30:00',
      cursor: 3,
    },
    {
      id: 'obs-002',
      device_id: 'dev-cam-001',
      monitor_id: 'mon-001',
      kind: 'check' as const,
      verdict: 'alert' as const,
      summary: 'Chemical spill detected on left bench area.',
      frame_path: 'periph/dev-cam-001/2026-07-20T09-00-00.jpg',
      result_json: { confidence: 0.89, alert_type: 'spill' },
      captured_at: '2026-07-20 09:00:00',
      cursor: 2,
    },
    {
      id: 'obs-003',
      device_id: 'dev-cam-001',
      monitor_id: null,
      kind: 'snapshot' as const,
      verdict: 'missed' as const,
      summary: 'Camera offline — capture timed out.',
      frame_path: null,
      result_json: { timeout_ms: 5000 },
      captured_at: '2026-07-19 22:00:00',
      cursor: 1,
    },
  ],
};

export const RC_PERIPH_OBSERVATIONS_LIST_EMPTY_RESPONSE = {
  observations: [],
};

// ── rc.periph.captureResult ───────────────────────────────────────────────
// Source: rpc.ts:173-194 → registerMethod('rc.periph.captureResult', ...)
//   returns { ok: boolean }  — true when requestId was pending, false if late/dup

export const RC_PERIPH_CAPTURE_RESULT_OK_RESPONSE = {
  ok: true,
};

export const RC_PERIPH_CAPTURE_RESULT_LATE_RESPONSE = {
  ok: false,
};

// ── rc.periph.bridge.announce ─────────────────────────────────────────────
// Source: rpc.ts:200-233 → registerMethod('rc.periph.bridge.announce', ...)
//   returns { ok: true }

export const RC_PERIPH_BRIDGE_ANNOUNCE_RESPONSE = {
  ok: true,
};

// ── rc.periph.plaud.status ────────────────────────────────────────────────
// Source: rpc.ts registerMethod('rc.periph.plaud.status', ...)
//   returns { ...(await plaud.status()), docker: isDocker } → PlaudStatus
//   Fields: tokenPresent, account?, toolsReady?, lastError?, docker?
//   - docker is stamped by the HANDLER (isDocker = fs.existsSync('/.dockerenv')
//     || process.env.DOCKER==='1', mirrors workspace/rpc.ts:24). plaud.status()
//     itself never sets it (periph/plaud.ts status()). On a normal host docker
//     is false; inside a container it is true → dashboard greys out connect (P1-U4).
//   NOTE: 'configured' is NOT returned here — dashboard derives it from config.get (T15)

export const RC_PERIPH_PLAUD_STATUS_LOGGED_IN_RESPONSE = {
  tokenPresent: true,
  account: 'researcher@lab.edu',
  toolsReady: true,
  lastError: undefined,
  docker: false,
};

/** Clean "not logged in" state — no lastError.  Use for "configured but not logged in" scenarios. */
export const RC_PERIPH_PLAUD_STATUS_LOGGED_OUT_RESPONSE = {
  tokenPresent: false,
  account: undefined,
  toolsReady: false,
  docker: false,
};

/**
 * Docker container state (P1-U4). The gateway handler stamps docker:true when it
 * finds /.dockerenv or DOCKER=1 (mirrors workspace/rpc.ts:24). tokenPresent is
 * false because the container can never complete the browser OAuth login. The
 * dashboard greys out connect + shows the container-unsupported warning and never
 * enters the writeConfig/spawn path.
 */
export const RC_PERIPH_PLAUD_STATUS_DOCKER_RESPONSE = {
  tokenPresent: false,
  account: undefined,
  toolsReady: false,
  docker: true,
};

/** Error state — token expired, lastError present.  Use for "error strip" scenarios. */
export const RC_PERIPH_PLAUD_STATUS_ERROR_RESPONSE = {
  tokenPresent: false,
  account: undefined,
  toolsReady: false,
  lastError: 'Authentication token expired',
};

// ── rc.periph.plaud.login ─────────────────────────────────────────────────
// Source: rpc.ts:242-244 → registerMethod('rc.periph.plaud.login', ...)
//   returns plaud.login() → { ok: boolean; error?: string }

export const RC_PERIPH_PLAUD_LOGIN_OK_RESPONSE = {
  ok: true,
};

export const RC_PERIPH_PLAUD_LOGIN_FAIL_RESPONSE = {
  ok: false,
  error: 'Invalid credentials — please check Plaud account settings',
};

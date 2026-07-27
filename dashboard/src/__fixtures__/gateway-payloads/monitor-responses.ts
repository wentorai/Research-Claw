/**
 * Monitor RPC response fixtures for store and component tests.
 *
 * These payloads mirror the EXACT shapes returned by the Monitor module:
 *   - Monitor interface: extensions/research-claw-core/src/monitor/service.ts (Monitor interface, lines 32-51)
 *   - List RPC: extensions/research-claw-core/src/monitor/rpc.ts (rc.monitor.list, line 64)
 *   - Toggle RPC: extensions/research-claw-core/src/monitor/rpc.ts (rc.monitor.toggle, line 131)
 */

import type { Monitor } from '../../stores/monitor';

// ── rc.monitor.list response ──────────────────────────────────────────────
// Source: monitor/rpc.ts:64 → service.list() → { items: Monitor[], total: number }

export const RC_MONITOR_LIST_RESPONSE: { items: Monitor[]; total: number } = {
  items: [
    {
      id: 'arxiv-daily',
      name: 'arXiv Daily Digest',
      source_type: 'arxiv',
      target: '',
      filters: { keywords: ['protein folding'], authors: [], categories: ['cs.AI'] },
      schedule: '0 7 * * *',
      enabled: true,
      notify: true,
      agent_prompt: 'Scan arXiv for new papers...',
      gateway_job_id: 'gw-job-001',
      last_check_at: '2026-03-17T07:00:00.000Z',
      last_results: [
        { title: 'AlphaFold3 enables...', authors: ['Jumper'], year: 2026 },
        { title: 'Protein structure prediction...', authors: ['Hassabis'], year: 2026 },
      ],
      last_error: null,
      check_count: 14,
      finding_count: 42,
      created_at: '2026-03-01T00:00:00.000Z',
      updated_at: '2026-03-17T07:00:00.000Z',
    },
    {
      id: 'github-releases',
      name: 'GitHub Release Tracker',
      source_type: 'github',
      target: 'huggingface/transformers',
      filters: { events: ['release', 'tag'] },
      schedule: '0 9 * * *',
      enabled: false,
      notify: true,
      agent_prompt: 'Check the target GitHub repository...',
      gateway_job_id: null,
      last_check_at: null,
      last_results: null,
      last_error: null,
      check_count: 0,
      finding_count: 0,
      created_at: '2026-03-01T00:00:00.000Z',
      updated_at: '2026-03-01T00:00:00.000Z',
    },
    {
      id: 'rss-with-error',
      name: 'RSS Feed Monitor',
      source_type: 'rss',
      target: 'https://example.com/feed.xml',
      filters: { keywords: ['AI'] },
      schedule: '0 8 * * *',
      enabled: true,
      notify: true,
      agent_prompt: 'Fetch the RSS feed...',
      gateway_job_id: 'gw-job-003',
      last_check_at: '2026-03-17T08:00:00.000Z',
      last_results: null,
      last_error: 'HTTP 503: Service Unavailable',
      check_count: 5,
      finding_count: 12,
      created_at: '2026-03-01T00:00:00.000Z',
      updated_at: '2026-03-17T08:00:00.000Z',
    },
  ],
  total: 3,
};

// ── rc.monitor.toggle response ────────────────────────────────────────────
// Source: monitor/rpc.ts:131 → service.toggle() → Monitor

export const RC_MONITOR_TOGGLE_ENABLED: Monitor = {
  ...RC_MONITOR_LIST_RESPONSE.items[1], // github-releases
  enabled: true,
  updated_at: '2026-03-18T00:00:00.000Z',
};

export const RC_MONITOR_TOGGLE_DISABLED: Monitor = {
  ...RC_MONITOR_LIST_RESPONSE.items[0], // arxiv-daily
  enabled: false,
  gateway_job_id: null,
  updated_at: '2026-03-18T00:00:00.000Z',
};

// ── cron.add response ─────────────────────────────────────────────────────
// Source: OpenClaw gateway cron.ts → returns CronJob with id

export const CRON_ADD_RESPONSE = {
  id: 'gw-job-new-001',
  name: '[rc-monitor] GitHub Release Tracker',
  schedule: { kind: 'cron' as const, expr: '0 9 * * *' },
  enabled: true,
};

// ── rc.monitor.list — empty ───────────────────────────────────────────────
// Source: monitor/rpc.ts:64 → service.list() with no rows

export const RC_MONITOR_LIST_EMPTY_RESPONSE: { items: Monitor[]; total: number } = {
  items: [],
  total: 0,
};

// ── rc.monitor.list — orphan-enabled device monitor (F1 fixture) ──────────
// Real mid-session state after the agent ran monitor_update(enabled=true):
// the plugin DB flips enabled=1 (monitor/service.ts toggle/update) but only the
// dashboard registers cron jobs, so gateway_job_id stays NULL until reconcile.

const ORPHAN_DEVICE_AGENT_PROMPT =
  '你是外设定时查证代理。目标设备 ID: {target}。\n' +
  '1. 调用 periph_camera_snap({"device_id": "{target}", "purpose": "scheduled check"}) 抓取当前帧。\n' +
  '查证要求: {check_prompt 或 "描述画面中正在发生什么,判断是否存在异常。"}';

export const RC_MONITOR_LIST_ORPHAN_ENABLED_RESPONSE: { items: Monitor[]; total: number } = {
  items: [
    {
      id: 'cam-orphan-001',
      name: 'Lab Camera Check',
      source_type: 'device',
      target: 'dev-cam-001',
      filters: { check_prompt: '判断实验台是否整洁。' },
      schedule: '*/30 * * * *',
      enabled: true,
      notify: true,
      agent_prompt: ORPHAN_DEVICE_AGENT_PROMPT,
      gateway_job_id: null, // ← enabled but never bound to a gateway cron job
      last_check_at: null,
      last_results: null,
      last_error: null,
      check_count: 0,
      finding_count: 0,
      created_at: '2026-07-20T00:00:00.000Z',
      updated_at: '2026-07-20T00:05:00.000Z',
    },
  ],
  total: 1,
};

// Same monitor after reconcile bound the job (refreshed rc.monitor.list)
export const RC_MONITOR_LIST_ORPHAN_REPAIRED_RESPONSE: { items: Monitor[]; total: number } = {
  items: [
    {
      ...RC_MONITOR_LIST_ORPHAN_ENABLED_RESPONSE.items[0],
      gateway_job_id: CRON_ADD_RESPONSE.id,
      updated_at: '2026-07-20T00:06:00.000Z',
    },
  ],
  total: 1,
};

// ── rc.monitor.toggle — enabled with notify=false ─────────────────────────
// Source: monitor/rpc.ts:131 → service.toggle() → Monitor (notify persisted at create)

export const RC_MONITOR_TOGGLE_ENABLED_NOTIFY_OFF: Monitor = {
  ...RC_MONITOR_LIST_RESPONSE.items[1], // github-releases
  enabled: true,
  notify: false,
  updated_at: '2026-03-18T00:00:00.000Z',
};

// ── cron.list response — empty page ───────────────────────────────────────
// Source: openclaw/src/cron/service/ops.ts:400-407 (listPage result) merged with
// deliveryPreviews in openclaw/src/gateway/server-methods/cron.ts:314-319.

export const CRON_LIST_EMPTY_RESPONSE = {
  jobs: [],
  total: 0,
  offset: 0,
  limit: 50,
  hasMore: false,
  nextOffset: null,
  deliveryPreviews: {},
};

// ── rc.monitor.setJobId response ──────────────────────────────────────────
// Source: monitor/rpc.ts:234-241 → { ok: true }

export const RC_MONITOR_SET_JOB_ID_RESPONSE = { ok: true };

// ── channels.status response (F7 delivery-target derivation) ──────────────
// Shape mirrors OC ChannelsStatusResultSchema
// (openclaw/packages/gateway-protocol/src/schema/channels.ts:715-731) and the
// per-account ChannelAccountSnapshotSchema (channels.ts:646-684): accountId is
// present, but there is NO recipient/peer/`to` field — the dashboard can only
// derive an explicit { channel, accountId }, never an explicit `to`.
//
// "Live" (bound + reachable) predicate matches ExtensionsPanel.tsx:412-413:
//   connected===true || (running===true && configured===true).
// telegram → live external channel (first in channelOrder → selected target).
// discord  → configured but offline (connected=false, running=false) → skipped.
// webchat  → live but INTERNAL_NON_DELIVERY_CHANNEL
//            (openclaw/src/utils/message-channel-constants.ts:1) → excluded so
//            F7 alerts physically reach the user, not the dashboard's own web UI.

export const CHANNELS_STATUS_BOUND_WEIXIN = {
  ts: 1_700_000_000_000,
  channelOrder: ['webchat', 'discord', 'openclaw-weixin'],
  channelLabels: {
    webchat: 'Web',
    discord: 'Discord',
    'openclaw-weixin': 'WeChat',
  },
  channels: {
    webchat: { configured: true },
    discord: { configured: true },
    'openclaw-weixin': { configured: true },
  },
  channelAccounts: {
    // Internal web UI — live but non-delivery, must be skipped.
    webchat: [
      { accountId: 'default', enabled: true, configured: true, connected: true, running: true },
    ],
    // External but offline — configured only, not selectable.
    discord: [
      { accountId: 'default', enabled: false, configured: true, connected: false, running: false },
    ],
    // External + live → the delivery target the dashboard should derive.
    'openclaw-weixin': [
      { accountId: 'wx-primary', enabled: true, configured: true, connected: true, running: true },
    ],
  },
  channelDefaultAccountId: {
    webchat: 'default',
    discord: 'default',
    'openclaw-weixin': 'wx-primary',
  },
};

// No external channel is live: telegram configured but offline; web live but
// internal. Dashboard cannot derive an explicit target → announce/last fallback.
export const CHANNELS_STATUS_NO_BOUND = {
  ts: 1_700_000_000_000,
  channelOrder: ['webchat', 'telegram'],
  channelLabels: { webchat: 'Web', telegram: 'Telegram' },
  channels: { webchat: { configured: true }, telegram: { configured: true } },
  channelAccounts: {
    webchat: [
      { accountId: 'default', enabled: true, configured: true, connected: true, running: true },
    ],
    telegram: [
      { accountId: 'default', enabled: true, configured: true, connected: false, running: false },
    ],
  },
  channelDefaultAccountId: { webchat: 'default', telegram: 'default' },
};

// The explicit delivery target derived from CHANNELS_STATUS_BOUND_WEIXIN.
export const BOUND_DELIVERY = {
  mode: 'announce' as const,
  channel: 'openclaw-weixin',
  accountId: 'wx-primary',
  bestEffort: true,
};

/**
 * What a notify=true monitor registers when no external channel can be routed.
 *
 * This was `{mode:'announce', channel:'last', bestEffort:true}` until a live
 * gateway falsified it: OpenClaw previews that job as
 * "last -> no route, will fail-closed" and drops every alert at run time, while
 * the dashboard shows push as armed. `cron.add` accepts it silently, so nothing
 * surfaces the breakage. mode:'none' is the honest registration — the cron list
 * stays clean and the in-app bell still fires.
 *
 * The same applies to an announce job whose channel resolves no recipient:
 * `resolveDeliveryTarget`'s allowFrom fallback is gated on `mode === "implicit"`
 * (jobs-BUelsOiC.js:160-180), which an explicitly-set channel never is, so it
 * previews as "Delivering to <provider> requires target …" and is equally dead.
 * Verified live in `__tests__/live/f7-cron-delivery.live.test.ts`.
 */
export const NO_CHANNEL_DELIVERY = {
  mode: 'none' as const,
};

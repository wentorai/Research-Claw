/**
 * Monitor Store — unified replacement for radar.ts + cron.ts
 *
 * Manages N independent monitoring targets. Each monitor is backed by a
 * gateway cron job that triggers isolated agent turns on schedule.
 *
 * Key simplification vs the old cron.ts:
 *   - OC persists cron jobs to disk (jobs.json), but RC still verifies that
 *     enabled monitors have a live gateway job after reconnect/manual edits.
 *   - No PRESET_DEFINITIONS hardcoded list — monitors are DB-driven
 *   - No _inflightPresets mutex — use simple loading flag instead
 */

import { create } from 'zustand';
import { useGatewayStore } from './gateway';

export interface Monitor {
  id: string;
  name: string;
  source_type: string;
  target: string;
  filters: Record<string, unknown>;
  schedule: string;
  enabled: boolean;
  notify: boolean;
  agent_prompt: string;
  gateway_job_id: string | null;
  last_check_at: string | null;
  last_results: unknown[] | null;
  last_error: string | null;
  check_count: number;
  finding_count: number;
  created_at: string;
  updated_at: string;
}

export interface MonitorCreateInput {
  name: string;
  source_type: string;
  target?: string;
  filters?: Record<string, unknown>;
  schedule?: string;
  enabled?: boolean;
  notify?: boolean;
  /** Leave empty to let the plugin call defaultAgentPrompt(source_type, filters). */
  agent_prompt?: string;
}

export interface MonitorActionResult {
  ok: boolean;
  error?: string;
}

interface MonitorState {
  monitors: Monitor[];
  loading: boolean;
  loaded: boolean;
  error: string | null;

  loadMonitors: () => Promise<void>;
  createMonitor: (input: MonitorCreateInput) => Promise<Monitor | null>;
  toggleMonitor: (id: string, enabled: boolean) => Promise<MonitorActionResult>;
  deleteMonitor: (id: string) => Promise<void>;
  updateMonitor: (id: string, patch: Partial<Monitor>) => Promise<void>;
  runMonitor: (id: string) => Promise<void>;
}

type CronJobRow = { id?: unknown; state?: unknown; sessionKey?: unknown; name?: unknown };
type CronJobSnapshot = {
  id: string;
  sessionKey: string | null;
  name: string;
  state: Record<string, unknown>;
  schedule: unknown;
  payload: Record<string, unknown>;
  delivery: Record<string, unknown>;
  lastRunAtMs: number | null;
  lastStatus: string;
  lastError: string;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Tracks in-flight toggle/delete operations to prevent race conditions
const _inflightOps = new Set<string>();

// Tracks whether we've reconciled monitor cron bindings in this gateway session.
let _reconciled = false;

function extractCronJobs(res: unknown): Map<string, CronJobSnapshot> | null {
  const jobs = Array.isArray(res)
    ? res
    : res && typeof res === 'object'
      ? Object.values(res as Record<string, unknown>).find(Array.isArray)
      : null;

  if (!Array.isArray(jobs)) return null;

  const snapshots = new Map<string, CronJobSnapshot>();
  for (const job of jobs) {
    if (!job || typeof job !== 'object') continue;
    const row = job as CronJobRow & Record<string, unknown>;
    const id = row.id;
    if (typeof id !== 'string' || !id) continue;

    const state = row.state && typeof row.state === 'object'
      ? row.state as Record<string, unknown>
      : {};
    const payload = row.payload && typeof row.payload === 'object'
      ? row.payload as Record<string, unknown>
      : {};
    const delivery = row.delivery && typeof row.delivery === 'object'
      ? row.delivery as Record<string, unknown>
      : {};
    const lastRunAtMs = typeof state.lastRunAtMs === 'number'
      ? state.lastRunAtMs
      : typeof row.lastRunAtMs === 'number'
        ? row.lastRunAtMs
        : null;
    const lastStatus = String(state.lastRunStatus ?? state.lastStatus ?? row.status ?? '').toLowerCase();
    const lastError = String(state.lastError ?? state.error ?? row.error ?? '');

    const sessionKey = typeof row.sessionKey === 'string' && row.sessionKey ? row.sessionKey : null;
    const name = typeof row.name === 'string' ? row.name : '';

    snapshots.set(id, { id, sessionKey, name, state, schedule: row.schedule, payload, delivery, lastRunAtMs, lastStatus, lastError });
  }
  return snapshots;
}

// The gateway rejects cron.list with `limit must be <= 100`, and a cron.list
// called with NO limit returns at most 200 rows (listPage clamps to 200). A
// single-shot read therefore truncates silently on a busy gateway, and every
// monitor whose job fell off the page looks orphaned to reconcile — which then
// registers a duplicate. Always page to the end.
const CRON_LIST_PAGE_MAX = 100;

function extractPreviewDetail(preview: unknown): string | null {
  if (!preview || typeof preview !== 'object') return null;
  const detail = (preview as { detail?: unknown }).detail;
  return typeof detail === 'string' ? detail : null;
}

async function loadCronJobs(): Promise<Map<string, CronJobSnapshot> | null> {
  const client = useGatewayStore.getState().client;
  if (!client?.isConnected) return null;

  const jobs = new Map<string, CronJobSnapshot>();
  let offset = 0;
  for (;;) {
    let page: Record<string, unknown>;
    try {
      page = await client.request<Record<string, unknown>>('cron.list', { limit: CRON_LIST_PAGE_MAX, offset });
    } catch (err) {
      console.warn('[MonitorStore] cron.list failed:', err);
      return null;
    }

    const extracted = extractCronJobs(Array.isArray(page?.jobs) ? page.jobs : page);
    if (!extracted) return null;
    for (const [id, job] of extracted) jobs.set(id, job);

    const nextOffset = page?.nextOffset;
    if (page?.hasMore !== true || typeof nextOffset !== 'number' || nextOffset <= offset) break;
    offset = nextOffset;
  }
  return jobs;
}

/**
 * Reads the gateway's own verdict on whether a job's delivery can be routed.
 * OpenClaw reports "explicit" only for a delivery it actually resolved
 * (delivery-preview.ts:34); every other value — "Delivering to IRC requires
 * target <#channel|nick>", "last -> no route, will fail-closed" — means the
 * alert would be dropped at run time. `query` matches the job id, so this stays
 * a single small page instead of a full cron scan.
 */
async function readDeliveryPreviewDetail(jobId: string): Promise<string | null> {
  const client = useGatewayStore.getState().client;
  if (!client?.isConnected) return null;

  try {
    const page = await client.request<Record<string, unknown>>('cron.list', {
      query: jobId,
      limit: CRON_LIST_PAGE_MAX,
      includeDisabled: true,
    });
    const previews = page?.deliveryPreviews;
    if (!previews || typeof previews !== 'object') return null;
    return extractPreviewDetail((previews as Record<string, unknown>)[jobId]);
  } catch (err) {
    console.warn('[MonitorStore] delivery preview read failed:', err);
    return null;
  }
}

// ── F7: derive an explicit cron delivery target from bound channels ──────────
// notify=true monitors run in isolated cron sessions with NO outbound history,
// so delivery.channel='last' fail-closes: resolveDeliveryTarget returns
// "Channel is required when delivery.channel=last has no previous channel"
// (openclaw/src/cron/isolated-agent/delivery-target.ts:248-259) and the preview
// shows "last -> no route, will fail-closed" (delivery-preview.ts:24-32). To let
// the alert physically reach the user we pin an EXPLICIT channel + accountId
// instead: with a concrete channel set, resolveDeliveryTarget fills the bound
// accountId (delivery-target.ts:234-241) and can resolve without prior session
// route, so the preview reports "explicit" (delivery-preview.ts:34).
//
// A pinned channel is NOT sufficient on its own. resolveDeliveryTarget only
// synthesises a recipient from the channel's allowlist when mode === "implicit"
// (openclaw/dist/jobs-BUelsOiC.js:160-180), which an explicitly-set channel
// never is; and even there it only *replaces* an existing bad candidate, never
// fills an absent one. Channels that cannot derive a default outbound target —
// IRC, Twitch, anything room-addressed — therefore fail with
// "Delivering to <provider> requires target …" (target-errors:5) and the job is
// accepted by cron.add but can never deliver. Verified against a live gateway:
// { channel:'irc', accountId:'default' } previews as that error, while the same
// job plus to:'#rc-f7' previews as "explicit".
//
// channels.status carries no recipient at all (only accountId/host/port/nick),
// and OpenClaw exposes no RPC that lists a channel's deliverable targets. So the
// recipient is *derived* from the channel's own config entry and then *verified*
// against the gateway's delivery preview: generation is best-effort, validation
// is authoritative. If nothing resolves, the monitor registers mode:'none'
// rather than a job that looks armed and silently drops every alert.

export type BoundDeliveryTarget = {
  channel: string;
  accountId?: string;
  /** Recipient to pin; undefined means the channel resolves its own. */
  to?: string;
  /** Untried recipients, consumed by the gateway-verified probe. */
  toCandidates?: string[];
  /** Set once a probe proved no candidate resolves → callers must not announce. */
  unresolved?: boolean;
};

/** Per-gateway-session memo of the probe, so later passes don't churn cron.update. */
type DeliveryProbe = {
  channel: string;
  accountId?: string;
  to?: string;
  resolved: boolean;
  detail: string;
};
let _deliveryProbe: DeliveryProbe | null = null;
const _failedDeliveryTargets = new Set<string>();
const MAX_DELIVERY_TARGET_PROBES = 32;
const MAX_DELIVERY_RECIPIENT_PROBES = 32;

type ChannelAccountSnapshot = {
  accountId?: unknown;
  enabled?: unknown;
  configured?: unknown;
  connected?: unknown;
  running?: unknown;
};

type ChannelsStatusResult = {
  channelOrder?: unknown;
  channelAccounts?: unknown;
  channelDefaultAccountId?: unknown;
};

// OC treats "webchat" as internal, non-delivery (openclaw/src/utils/
// message-channel-constants.ts:1,10 — INTERNAL_MESSAGE_CHANNEL + heartbeat/cron/
// webhook/voice). Delivering an alert to the dashboard's own web UI does not
// physically reach the user, which is the whole point of F7, so exclude it.
const NON_DELIVERY_CHANNELS = new Set(['webchat', 'web', 'heartbeat', 'cron', 'webhook', 'voice']);

function deliveryTargetKey(channel: string, accountId?: string): string {
  return `${channel}\u0000${accountId ?? ''}`;
}

// Bound + reachable predicate mirrors ExtensionsPanel.tsx:412-413:
// connected===true covers Discord/WhatsApp/WeChat; running+configured covers
// Telegram/Slack/Signal/iMessage which only set running.
function channelAccountIsLive(account: ChannelAccountSnapshot): boolean {
  if (account.enabled === false) return false;
  if (account.connected === true) return true;
  return account.running === true && account.configured === true;
}

/**
 * Ordered recipient candidates for a channel/account, read from the gateway
 * config. Rooms the bot already joins come first — they are the closest thing
 * OpenClaw has to a channel default — then the owner allowlist, which is what
 * OpenClaw itself falls back to in implicit mode (allowFromOverride[0]).
 *
 * The config.get response carries the ENTIRE gateway config. Only `channels` is
 * read out of it, and neither the response nor the caught error is ever logged.
 */
async function resolveToCandidates(channel: string, accountId?: string): Promise<string[]> {
  const client = useGatewayStore.getState().client;
  if (!client?.isConnected) return [];

  let channels: Record<string, unknown>;
  try {
    const res = await client.request<{ config?: unknown }>('config.get', {});
    const cfg = res?.config && typeof res.config === 'object' ? res.config as Record<string, unknown> : {};
    channels = cfg.channels && typeof cfg.channels === 'object' ? cfg.channels as Record<string, unknown> : {};
  } catch {
    console.warn('[MonitorStore] config.get failed; no delivery recipient candidates');
    return [];
  }

  const base = channels[channel];
  if (!base || typeof base !== 'object') return [];
  const baseEntry = base as Record<string, unknown>;
  const accountsMap = baseEntry.accounts && typeof baseEntry.accounts === 'object'
    ? baseEntry.accounts as Record<string, unknown>
    : undefined;
  const scoped = accountId && accountsMap?.[accountId] && typeof accountsMap[accountId] === 'object'
    ? accountsMap[accountId] as Record<string, unknown>
    : undefined;

  const out: string[] = [];
  const push = (value: unknown): void => {
    if (typeof value !== 'string') return;
    const trimmed = value.trim();
    if (trimmed && !out.includes(trimmed)) out.push(trimmed);
  };
  // Account-scoped config wins over the channel-wide entry.
  for (const src of [scoped, baseEntry]) {
    if (!src) continue;
    if (Array.isArray(src.channels)) src.channels.forEach(push);
    if (src.groups && typeof src.groups === 'object') Object.keys(src.groups as object).forEach(push);
    if (Array.isArray(src.allowFrom)) src.allowFrom.forEach(push);
  }
  return out;
}

/**
 * Fetches channels.status and returns the first non-excluded live external
 * channel/account as the explicit cron delivery target. `exclude` is consumed
 * by the bounded probe loop after the gateway rejects an earlier target.
 * Targets already rejected in this gateway session are also skipped, so the
 * first bad channel cannot become sticky on every reconcile.
 */
async function resolveBoundDeliveryTarget(
  exclude: Set<string> = new Set(),
): Promise<BoundDeliveryTarget | null> {
  const client = useGatewayStore.getState().client;
  if (!client?.isConnected) return null;

  let status: ChannelsStatusResult;
  try {
    status = await client.request<ChannelsStatusResult>('channels.status', {});
  } catch (err) {
    console.warn('[MonitorStore] channels.status failed:', err);
    return null;
  }

  const order = Array.isArray(status.channelOrder)
    ? status.channelOrder.filter((id): id is string => typeof id === 'string' && !!id)
    : [];
  const accounts = status.channelAccounts && typeof status.channelAccounts === 'object'
    ? status.channelAccounts as Record<string, unknown>
    : {};
  const defaults = status.channelDefaultAccountId && typeof status.channelDefaultAccountId === 'object'
    ? status.channelDefaultAccountId as Record<string, unknown>
    : {};

  for (const channel of order) {
    if (NON_DELIVERY_CHANNELS.has(channel.toLowerCase())) continue;
    const list = Array.isArray(accounts[channel]) ? accounts[channel] as ChannelAccountSnapshot[] : [];
    const defaultId = typeof defaults[channel] === 'string' ? defaults[channel] as string : undefined;
    const liveAccounts = list.filter(channelAccountIsLive);
    liveAccounts.sort((left, right) => {
      const leftDefault = left.accountId === defaultId ? 0 : 1;
      const rightDefault = right.accountId === defaultId ? 0 : 1;
      return leftDefault - rightDefault;
    });

    for (const live of liveAccounts) {
      const accountId = typeof live.accountId === 'string' && live.accountId ? live.accountId : undefined;
      const key = deliveryTargetKey(channel, accountId);
      if (exclude.has(key) || _failedDeliveryTargets.has(key)) continue;

      const bound: BoundDeliveryTarget = accountId ? { channel, accountId } : { channel };
      if (
        _deliveryProbe?.resolved
        && _deliveryProbe.channel === channel
        && _deliveryProbe.accountId === accountId
      ) {
        return _deliveryProbe.to ? { ...bound, to: _deliveryProbe.to } : bound;
      }
      return { ...bound, toCandidates: await resolveToCandidates(channel, accountId) };
    }
  }

  return null;
}

/**
 * Walks the recipient candidates against the gateway's own delivery preview
 * until one resolves, using an already-registered monitor job as the probe.
 * The no-recipient case is tried first: channels that can synthesise their own
 * outbound target (and OpenClaw's own preferred shape) resolve without a `to`.
 */
async function probeDeliveryRecipient(
  bound: BoundDeliveryTarget,
  probeJobId: string,
  baseDelivery: Record<string, unknown>,
): Promise<DeliveryProbe> {
  const client = useGatewayStore.getState().client;
  const identity = { channel: bound.channel, accountId: bound.accountId };
  if (!client?.isConnected) return { ...identity, resolved: false, detail: 'gateway disconnected' };

  let detail = 'unresolved';
  for (const to of [undefined, ...(bound.toCandidates ?? []).slice(0, MAX_DELIVERY_RECIPIENT_PROBES)]) {
    const delivery = { ...baseDelivery, ...(to ? { to } : {}) };
    try {
      await client.request('cron.update', { id: probeJobId, patch: deliveryUpdatePatch(delivery) });
    } catch (err) {
      console.warn('[MonitorStore] delivery probe update failed:', err);
      continue;
    }
    detail = await readDeliveryPreviewDetail(probeJobId) ?? 'unresolved';
    if (detail === 'explicit') return { ...identity, to, resolved: true, detail };
  }
  return { ...identity, resolved: false, detail };
}

/**
 * Turns a full delivery block into a cron.update patch.
 *
 * Two contract details make the naive `{id, delivery}` call wrong. First,
 * cron.update takes `{id|jobId, patch:{...}}` — a bare `delivery` is rejected
 * with INVALID_REQUEST (`CronUpdateParamsSchema`, src-CgoRVpph.js:1883).
 * Second, `patch.delivery` MERGES rather than replaces
 * (`mergeCronDelivery`, jobs-BUelsOiC.js:900-927): a field the patch omits keeps
 * its old value. So a probe that tried recipient B after A could never clear A,
 * and an announce→none downgrade would leave `channel`/`to` behind on a job the
 * UI shows as silent. Recipient/account fields accept null, but the installed
 * OpenClaw 2026.6.1 schema rejects `delivery.channel:null`; callers must replace
 * the job rather than use this helper when the final mode is `none`.
 */
function deliveryUpdatePatch(delivery: Record<string, unknown>): Record<string, unknown> {
  if (delivery.mode === 'none') {
    throw new Error('delivery mode none requires cron job replacement');
  }
  return {
    delivery: {
      mode: delivery.mode,
      channel: delivery.channel,
      accountId: delivery.accountId ?? null,
      to: delivery.to ?? null,
      bestEffort: delivery.bestEffort === true,
    },
  };
}

/** The announce delivery for a target, ignoring any recipient. */
function announceBase(bound: BoundDeliveryTarget): Record<string, unknown> {
  const base: Record<string, unknown> = { mode: 'announce', channel: bound.channel, bestEffort: true };
  if (bound.accountId) base.accountId = bound.accountId;
  return base;
}

/**
 * Returns the delivery every announce job must carry, probing the gateway once
 * per session when the recipient is not known yet. `probeJobId` is an already
 * registered job used as the probe subject — the caller must write the returned
 * delivery back to it (and to any other announce job it owns).
 */
async function ensureProbedDelivery(
  bound: BoundDeliveryTarget,
  probeJobId: string,
): Promise<Record<string, unknown>> {
  const excluded = new Set<string>();
  let candidate: BoundDeliveryTarget | null = bound;
  let lastProbe: DeliveryProbe | null = null;

  for (let attempt = 0; candidate && attempt < MAX_DELIVERY_TARGET_PROBES; attempt += 1) {
    const base = announceBase(candidate);
    const memo = _deliveryProbe?.resolved
      && _deliveryProbe.channel === candidate.channel
      && _deliveryProbe.accountId === candidate.accountId
      ? _deliveryProbe
      : null;
    const probe = memo ?? await probeDeliveryRecipient(candidate, probeJobId, base);
    _deliveryProbe = probe;
    lastProbe = probe;
    if (probe.resolved) {
      return { ...base, ...(probe.to ? { to: probe.to } : {}) };
    }

    const key = deliveryTargetKey(candidate.channel, candidate.accountId);
    excluded.add(key);
    _failedDeliveryTargets.add(key);
    candidate = await resolveBoundDeliveryTarget(excluded);
  }

  if (lastProbe) {
    console.warn(
      `[MonitorStore] no routable delivery target after bounded probing (${lastProbe.detail}); `
      + 'monitors registered without push — dashboard alerts only',
    );
  }
  return { mode: 'none' };
}

/**
 * Builds the cron delivery config for a monitor given a pre-resolved bound
 * target. Pure so both registration and cronJobNeedsRefresh compare the same
 * shape (openclaw/packages/gateway-protocol/src/schema/cron.ts:285-293 accepts
 * announce { channel, accountId, bestEffort }).
 */
function buildMonitorDelivery(
  monitor: Monitor,
  bound: BoundDeliveryTarget | null,
): Record<string, unknown> {
  if (!monitor.notify) return { mode: 'none' };

  // No bound external channel, or the gateway already proved no recipient
  // resolves. announce/last here would register a job whose preview reads
  // "last -> no route, will fail-closed" and whose run drops the alert while the
  // UI shows push as armed. Register mode:'none' instead — cron.list stays clean
  // and the dashboard bell still fires.
  if (!bound || bound.unresolved) return { mode: 'none' };

  // Explicit target so the isolated cron run can resolve a real channel;
  // bestEffort keeps the run green if the send later fails
  // (openclaw/src/cron/isolated-agent/delivery-dispatch.ts:1067-1076,1212-1214).
  const delivery: Record<string, unknown> = { mode: 'announce', channel: bound.channel, bestEffort: true };
  if (bound.accountId) delivery.accountId = bound.accountId;
  if (bound.to) delivery.to = bound.to;
  return delivery;
}

function dateMs(value: string | null): number {
  if (!value) return 0;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isFailedCronRun(job: CronJobSnapshot): boolean {
  if (job.lastError) return true;
  return /error|failed|aborted|timeout/.test(job.lastStatus);
}

function formatCronRunError(job: CronJobSnapshot): string {
  const status = job.lastStatus || 'failed';
  const reason = typeof job.state.lastErrorReason === 'string' ? ` (${job.state.lastErrorReason})` : '';
  const detail = job.lastError ? `: ${job.lastError}` : '';
  return `Gateway cron run ${status}${reason}${detail}`.slice(0, 1000);
}

function buildMonitorCronMessage(monitor: Monitor): string {
  const header = [
    `[Research-Claw Monitor Scheduled Run]`,
    `MONITOR_ID: ${monitor.id}`,
    `MONITOR_NAME: ${monitor.name}`,
    `SOURCE_TYPE: ${monitor.source_type}`,
    `TARGET: ${monitor.target || '(none)'}`,
    '',
  ].join('\n');

  if (monitor.source_type === 'device') {
    // Device monitors: no EXECUTION PROTOCOL collector header.
    // The agent_prompt already contains the periph_camera_snap vision protocol
    // (stored via defaultAgentPrompt('device') in the plugin).
    // Dashboard replaces two classes of placeholders:
    //   {target}               → monitor.target (device id)
    //   {check_prompt ...}     → filters.check_prompt (non-empty) or template default
    const checkPrompt =
      typeof monitor.filters?.check_prompt === 'string' && monitor.filters.check_prompt.trim()
        ? monitor.filters.check_prompt.trim()
        : '描述画面中正在发生什么,判断是否存在异常。';

    const body = monitor.agent_prompt
      .replaceAll('{target}', monitor.target)
      .replaceAll('{monitor_id}', monitor.id)
      .replace(/\{check_prompt[^}]*\}/, checkPrompt);

    return header + body;
  }

  // report/reminder monitors: the seed prompts require workspace_save/task_list
  // (e.g. weekly-report writes outputs/reports/*.md), so the strict boundary that
  // bans workspace_*/task tools would forbid the monitor's own stored prompt.
  // Exemption implemented as a source_type branch, same approach as device (SPEC §13.4).
  const toolBoundary = monitor.source_type === 'report' || monitor.source_type === 'reminder'
    ? 'Tool boundary: use monitor_get_context, monitor_report, monitor_note, and send_notification for monitor bookkeeping. You may also call the workspace/task/library tools the stored monitor agent prompt requires (e.g. workspace_save, task_list). Do not call unrelated tools.'
    : 'Tool boundary: use monitor_get_context, monitor_collect_candidates, monitor_report, monitor_note, and send_notification only. Do not call read, task_flow_stage, workspace_* or other task/workspace tools for this scheduled monitor.';

  return header + [
    'You are executing a scheduled monitor. Follow this exact protocol:',
    toolBoundary,
    `1. CONTEXT: call monitor_get_context with {"monitor_id":"${monitor.id}"}.`,
    `2. COLLECT: call monitor_collect_candidates with {"monitor_id":"${monitor.id}"} to gather raw source candidates in the core collector layer.`,
    '3. ANALYZE: inspect/filter the collected candidates against the monitor goal. Only use browser/search if the collector reports errors or lacks enough context.',
    `4. REPORT: call monitor_report with monitor_id="${monitor.id}", final results, and the exact fingerprint values returned by monitor_collect_candidates for accepted candidates; do not invent date-based or summary-based fingerprints.`,
    `5. OBSERVE: call monitor_note with monitor_id="${monitor.id}" if source reliability, errors, or useful patterns should be remembered.`,
    '6. NOTIFY: if the context says notify=true and monitor_report found new items, call send_notification.',
    '',
    'Stored monitor agent prompt:',
    monitor.agent_prompt,
  ].join('\n');
}

async function registerMonitorCronJob(
  monitor: Monitor,
  bound?: BoundDeliveryTarget | null,
): Promise<string> {
  const client = useGatewayStore.getState().client;
  if (!client?.isConnected) throw new Error('gateway-not-connected');

  // Resolve the bound delivery target once per registration unless the caller
  // (reconcile) already resolved it for the whole pass. Skip the RPC entirely
  // for notify=false — those never announce.
  const target = monitor.notify
    ? (bound !== undefined ? bound : await resolveBoundDeliveryTarget())
    : null;

  const addJob = (delivery: Record<string, unknown>) => client.request<{ id: string }>('cron.add', {
    name: `[rc-monitor] ${monitor.name}`,
    description: `Monitor: ${monitor.id}`,
    schedule: { kind: 'cron' as const, expr: monitor.schedule },
    sessionKey: `cron:rc-monitor:${monitor.id}`,
    sessionTarget: 'isolated',
    payload: {
      kind: 'agentTurn',
      message: buildMonitorCronMessage(monitor),
      timeoutSeconds: 900,
    },
    delivery,
  });
  let cronResult = await addJob(buildMonitorDelivery(monitor, target));

  if (!cronResult?.id) throw new Error('cron-add-missing-id');

  // The job is on disk now but its recipient is still unverified, so use it as
  // the probe subject and write back whatever the gateway actually accepts.
  // Without this a monitor toggled on directly (not via reconcile) would keep a
  // delivery the gateway previews as "Delivering to <provider> requires target
  // …" — accepted by cron.add, dropped at every run.
  if (target?.toCandidates) {
    const verified = await ensureProbedDelivery(target, cronResult.id);
    if (verified.mode === 'none') {
      // cron.update merges delivery and OC rejects channel:null, so the only
      // contract-valid way to remove a stale announce route is replacement.
      try { await client.request('cron.remove', { id: cronResult.id }); } catch { /* best effort */ }
      cronResult = await addJob({ mode: 'none' });
      if (!cronResult?.id) throw new Error('cron-add-replacement-missing-id');
    } else {
      try {
        await client.request('cron.update', { id: cronResult.id, patch: deliveryUpdatePatch(verified) });
      } catch (err) {
        try { await client.request('cron.remove', { id: cronResult.id }); } catch { /* best effort */ }
        throw new Error(`delivery-update-failed: ${errorMessage(err)}`);
      }
    }
  }

  try {
    await client.request('rc.monitor.setJobId', { id: monitor.id, job_id: cronResult.id });
  } catch (err) {
    // The database still says enabled=true so reconnect/load can reconcile it,
    // but do not leave an unbound cron job behind after the binding write fails.
    try { await client.request('cron.remove', { id: cronResult.id }); } catch { /* best effort */ }
    throw new Error(`job-id-persist-failed: ${errorMessage(err)}`);
  }
  return cronResult.id;
}

function expectedMonitorSessionKey(monitor: Monitor): string {
  return `cron:rc-monitor:${monitor.id}`;
}

function expectedMonitorName(monitor: Monitor): string {
  return `[rc-monitor] ${monitor.name}`;
}

function cronJobMatchesMonitor(job: CronJobSnapshot, monitor: Monitor): boolean {
  if (job.sessionKey === expectedMonitorSessionKey(monitor)) return true;
  if (job.id === monitor.gateway_job_id) return true;
  return job.name === expectedMonitorName(monitor);
}

function deliveryFieldsMatch(
  stored: Record<string, unknown>,
  expected: Record<string, unknown>,
  opts?: { ignoreTo?: boolean },
): boolean {
  // Compare only the fields the dashboard writes (mode + channel + accountId +
  // to + bestEffort). A stored job may carry OC-added fields (e.g. threadId,
  // failureDestination) we never set; those must not force a needless refresh.
  //
  // `ignoreTo` covers the window before this session's probe has run: the
  // expected recipient is not known yet, so comparing it would tear down and
  // recreate a job that is already deliverable on every reconnect. The probe
  // writes the verified recipient to every announce job right after.
  const keys = opts?.ignoreTo
    ? (['mode', 'channel', 'accountId', 'bestEffort'] as const)
    : (['mode', 'channel', 'accountId', 'to', 'bestEffort'] as const);
  return keys.every((k) => (stored[k] ?? undefined) === (expected[k] ?? undefined));
}

function cronJobNeedsRefresh(
  monitor: Monitor,
  job: CronJobSnapshot,
  bound: BoundDeliveryTarget | null,
): boolean {
  if (job.sessionKey && job.sessionKey !== expectedMonitorSessionKey(monitor)) return true;
  const expectedMessage = buildMonitorCronMessage(monitor);
  if (Object.keys(job.payload).length > 0 && job.payload.kind !== 'agentTurn') return true;
  if (typeof job.payload.message === 'string' && job.payload.message !== expectedMessage) return true;
  if (Object.keys(job.payload).length > 0 && job.payload.timeoutSeconds !== 900) return true;

  // Self-heal jobs whose FULL delivery no longer matches (mode + channel +
  // accountId + bestEffort). Pre-F7 jobs used announce/last (or none/channel);
  // once an external channel is bound the target must upgrade to explicit, and
  // notify toggles flip mode. Only compare when the stored job actually carries
  // a delivery block (empty = shape unknown, avoid churn).
  if (Object.keys(job.delivery).length > 0) {
    const expectedDelivery = buildMonitorDelivery(monitor, bound);
    if (!deliveryFieldsMatch(job.delivery, expectedDelivery, { ignoreTo: !!bound?.toCandidates })) return true;
  }

  const schedule = job.schedule && typeof job.schedule === 'object'
    ? job.schedule as Record<string, unknown>
    : {};
  if (Object.keys(schedule).length > 0 && (schedule.kind !== 'cron' || schedule.expr !== monitor.schedule)) return true;

  return false;
}

async function syncMonitorRunErrors(
  monitors: Monitor[],
  cronJobs: Map<string, CronJobSnapshot> | null,
): Promise<boolean> {
  const client = useGatewayStore.getState().client;
  if (!client?.isConnected || !cronJobs) return false;

  let updated = false;
  for (const monitor of monitors) {
    if (!monitor.enabled || !monitor.gateway_job_id) continue;
    const job = cronJobs.get(monitor.gateway_job_id);
    if (!job || !isFailedCronRun(job)) continue;
    if (job.lastRunAtMs !== null && job.lastRunAtMs <= dateMs(monitor.last_check_at)) continue;

    try {
      await client.request('rc.monitor.reportError', {
        id: monitor.id,
        error: formatCronRunError(job),
      });
      updated = true;
    } catch (err) {
      console.warn(`[MonitorStore] failed to sync monitor cron error for ${monitor.id}:`, err);
    }
  }

  return updated;
}

async function reconcileEnabledMonitors(
  monitors: Monitor[],
  cronJobs?: Map<string, CronJobSnapshot> | null,
): Promise<{ verified: boolean; repaired: boolean }> {
  const client = useGatewayStore.getState().client;
  if (!client?.isConnected) return { verified: false, repaired: false };

  const jobs = cronJobs ?? await loadCronJobs();

  // Unknown cron.list shape. Avoid creating duplicates if we cannot verify.
  if (!jobs) return { verified: false, repaired: false };

  // Resolve the bound delivery target once for the whole pass so every
  // registration and refresh check compares against the same explicit channel
  // (F7). Skip the channels.status RPC when no enabled monitor announces.
  const needsDelivery = monitors.some((m) => m.enabled && m.notify);
  const bound = needsDelivery ? await resolveBoundDeliveryTarget() : null;

  let repaired = false;
  let repairFailed = false;
  // Jobs that must carry a routable delivery, collected for the probe below.
  const announceJobs: Array<{ id: string; monitor: Monitor }> = [];
  for (const monitor of monitors) {
    const matches = Array.from(jobs.values()).filter((job) => cronJobMatchesMonitor(job, monitor));

    if (!monitor.enabled) {
      if (_inflightOps.has(monitor.id)) continue;

      _inflightOps.add(monitor.id);
      try {
        for (const job of matches) {
          try { await client.request('cron.remove', { id: job.id }); } catch { /* stale job may already be gone */ }
        }
        if (monitor.gateway_job_id) {
          await client.request('rc.monitor.setJobId', { id: monitor.id, job_id: '' });
          repaired = true;
        }
      } catch (err) {
        console.warn(`[MonitorStore] disabled monitor cleanup failed for ${monitor.id}:`, err);
        repairFailed = true;
      } finally {
        _inflightOps.delete(monitor.id);
      }
      continue;
    }

    const liveJob = matches.find((job) => job.id === monitor.gateway_job_id && !cronJobNeedsRefresh(monitor, job, bound))
      ?? matches.find((job) => !cronJobNeedsRefresh(monitor, job, bound));
    const duplicates = matches.filter((job) => job.id !== liveJob?.id);

    if (monitor.notify && liveJob) announceJobs.push({ id: liveJob.id, monitor });

    if (duplicates.length === 0 && liveJob && liveJob.id === monitor.gateway_job_id) continue;
    if (_inflightOps.has(monitor.id)) continue;

    _inflightOps.add(monitor.id);
    try {
      for (const job of duplicates) {
        try { await client.request('cron.remove', { id: job.id }); } catch { /* stale job may already be gone */ }
      }

      if (liveJob) {
        if (liveJob.id !== monitor.gateway_job_id) {
          await client.request('rc.monitor.setJobId', { id: monitor.id, job_id: liveJob.id });
          repaired = true;
        }
        continue;
      }

      const jobId = await registerMonitorCronJob(monitor, bound);
      if (jobId) {
        repaired = true;
      } else {
        repairFailed = true;
      }
    } catch (err) {
      console.warn(`[MonitorStore] reconcile failed for ${monitor.id}:`, err);
      repairFailed = true;
    } finally {
      _inflightOps.delete(monitor.id);
    }
  }

  // Probe existing announce jobs once per gateway session, then write the
  // gateway-verified delivery to each one. Newly registered jobs are excluded:
  // registerMonitorCronJob already performs the same probe and replacement,
  // and processing them again would delete and recreate the fresh job twice.
  // Until this runs, existing jobs carry whatever recipient was already on
  // disk, which is why cronJobNeedsRefresh ignores `to` while toCandidates is
  // still set.
  if (bound?.toCandidates && announceJobs.length > 0) {
    const finalDelivery = await ensureProbedDelivery(bound, announceJobs[0].id);
    for (const { id: jobId, monitor } of announceJobs) {
      if (finalDelivery.mode === 'none') {
        try {
          await client.request('cron.remove', { id: jobId });
          const replacementId = await registerMonitorCronJob(monitor, null);
          if (!replacementId) throw new Error('cron replacement returned no id');
          repaired = true;
        } catch (err) {
          console.warn('[MonitorStore] replacing unroutable announce job failed:', err);
          repairFailed = true;
        }
      } else {
        try {
          await client.request('cron.update', { id: jobId, patch: deliveryUpdatePatch(finalDelivery) });
        } catch (err) {
          console.warn('[MonitorStore] applying probed delivery failed:', err);
          repairFailed = true;
        }
      }
    }
  }

  return { verified: !repairFailed, repaired };
}

export const useMonitorStore = create<MonitorState>()((set, get) => ({
  monitors: [],
  loading: false,
  loaded: false,
  error: null,

  loadMonitors: async () => {
    const client = useGatewayStore.getState().client;
    if (!client?.isConnected) return;
    if (get().loading) return;

    set({ loading: true });
    try {
      const result = await client.request<{ items: Monitor[]; total: number }>('rc.monitor.list', { limit: 100 });
      let items = result.items;
      const cronJobs = await loadCronJobs();

      // Reconcile once per gateway session, PLUS unconditionally whenever an
      // enabled monitor has no gateway job — agent-side monitor_update(enabled=true)
      // happens mid-session and would otherwise never get its cron registered
      // until a page refresh/reconnect (F1).
      const hasOrphanEnabled = result.items.some((m) => m.enabled && !m.gateway_job_id);

      // A mid-session notify flip (agent-side monitor_update, another client)
      // rewrites delivery.mode but leaves the cron job untouched, so the alert
      // silently never sends — or keeps sending after the user turned it off.
      // Detect the disagreement directly from the stored job (F7).
      const hasDeliveryDrift = result.items.some((m) => {
        if (!m.enabled || !m.gateway_job_id) return false;
        const job = cronJobs?.get(m.gateway_job_id);
        if (!job || Object.keys(job.delivery).length === 0) return false;
        const announces = job.delivery.mode === 'announce';
        if (!m.notify) return announces;
        // notify=true but the job stays silent. Skip when the gateway already
        // proved this channel has no routable target, otherwise every load
        // would trigger a reconcile that cannot change anything.
        return !announces && !(_deliveryProbe && !_deliveryProbe.resolved);
      });

      if (!_reconciled || hasOrphanEnabled || hasDeliveryDrift) {
        const outcome = await reconcileEnabledMonitors(result.items, cronJobs);
        _reconciled = outcome.verified;
        if (outcome.repaired) {
          const refreshed = await client.request<{ items: Monitor[]; total: number }>('rc.monitor.list', { limit: 100 });
          items = refreshed.items;
        }
      }

      if (await syncMonitorRunErrors(items, cronJobs)) {
        const refreshed = await client.request<{ items: Monitor[]; total: number }>('rc.monitor.list', { limit: 100 });
        items = refreshed.items;
      }

      set({ monitors: items, loaded: true });
    } catch (err) {
      console.warn('[MonitorStore] loadMonitors failed:', err);
    } finally {
      set({ loading: false });
    }
  },

  createMonitor: async (input: MonitorCreateInput): Promise<Monitor | null> => {
    const client = useGatewayStore.getState().client;
    if (!client?.isConnected) return null;

    try {
      // agent_prompt left empty → plugin calls defaultAgentPrompt(source_type, filters)
      const monitor = await client.request<Monitor>('rc.monitor.create', {
        ...input,
        enabled: input.enabled ?? false,
      });
      set((s) => ({ monitors: [...s.monitors, monitor] }));
      return monitor;
    } catch (err) {
      console.error('[MonitorStore] createMonitor failed:', err);
      return null;
    }
  },

  toggleMonitor: async (id: string, enabled: boolean): Promise<MonitorActionResult> => {
    if (_inflightOps.has(id)) return { ok: false, error: 'operation-in-progress' };
    const client = useGatewayStore.getState().client;
    if (!client?.isConnected) {
      set({ error: 'gateway-not-connected' });
      return { ok: false, error: 'gateway-not-connected' };
    }

    _inflightOps.add(id);
    set({ error: null });
    // Optimistic update
    set((s) => ({
      monitors: s.monitors.map((m) => (m.id === id ? { ...m, enabled } : m)),
    }));

    let persisted = false;
    try {
      // 1. Toggle in plugin DB
      const updated = await client.request<Monitor>('rc.monitor.toggle', { id, enabled });
      if (!updated || typeof updated !== 'object' || updated.id !== id) {
        throw new Error('monitor-toggle-invalid-response');
      }
      persisted = true;
      // Keep the authoritative DB state visible even if cron registration
      // fails. enabled=true without a job is intentionally retained so F1
      // reconnect/load reconciliation can repair it.
      set((s) => ({
        monitors: s.monitors.map((m) => (m.id === id ? updated : m)),
      }));

      if (enabled) {
        // 2a. Clean up any stale gateway job before creating new one
        if (updated.gateway_job_id) {
          try { await client.request('cron.remove', { id: updated.gateway_job_id }); } catch { /* */ }
        }

        // 2b/3. Create gateway cron job and store gateway job ID in plugin DB
        await registerMonitorCronJob(updated);
      } else {
        // 2b. Remove gateway cron job
        if (updated.gateway_job_id) {
          try {
            await client.request('cron.remove', { id: updated.gateway_job_id });
          } catch {
            // Job may not exist
          }
        }
        await client.request('rc.monitor.setJobId', { id, job_id: '' });
      }

      // 4. Reload to get consistent state
      await get().loadMonitors();
      set({ error: null });
      return { ok: true };
    } catch (err) {
      console.error('[MonitorStore] toggleMonitor failed:', err);
      const detail = errorMessage(err);
      const actionError = enabled && persisted
        ? `cron registration failed: ${detail}`
        : `monitor toggle failed: ${detail}`;
      set({ error: actionError });
      // Only roll back an optimistic state when the DB toggle itself failed.
      // Once enabled=true is persisted, reloading here could immediately
      // reconcile and mask the registration failure the initiating UI must show.
      if (!persisted) await get().loadMonitors();
      return { ok: false, error: actionError };
    } finally {
      _inflightOps.delete(id);
    }
  },

  deleteMonitor: async (id: string) => {
    const client = useGatewayStore.getState().client;
    if (!client?.isConnected) return;

    const monitor = get().monitors.find((m) => m.id === id);

    try {
      // 1. Remove gateway cron job if exists
      if (monitor?.gateway_job_id) {
        try {
          await client.request('cron.remove', { id: monitor.gateway_job_id });
        } catch {
          // Job may not exist
        }
      }

      // 2. Delete from plugin DB
      await client.request('rc.monitor.delete', { id });

      // 3. Optimistic remove + reload
      set((s) => ({
        monitors: s.monitors.filter((m) => m.id !== id),
      }));
    } catch (err) {
      console.error('[MonitorStore] deleteMonitor failed:', err);
      await get().loadMonitors();
    }
  },

  updateMonitor: async (id: string, patch: Partial<Monitor>) => {
    const client = useGatewayStore.getState().client;
    if (!client?.isConnected) return;

    try {
      const updated = await client.request<Monitor>('rc.monitor.update', { id, ...patch });

      // Re-register when the schedule OR the delivery shape changed. `notify`
      // decides delivery.mode, so flipping it without re-registering leaves the
      // cron job on the stale mode and the alert never reaches the user (F7).
      if ((patch.schedule || patch.notify !== undefined) && updated.enabled) {
        if (updated.gateway_job_id) {
          try {
            await client.request('cron.remove', { id: updated.gateway_job_id });
          } catch { /* */ }
        }

        // Create new and persist gateway job ID
        await registerMonitorCronJob(updated);
      }

      await get().loadMonitors();
    } catch (err) {
      console.error('[MonitorStore] updateMonitor failed:', err);
      await get().loadMonitors();
    }
  },

  runMonitor: async (id: string) => {
    const client = useGatewayStore.getState().client;
    if (!client?.isConnected) return;

    try {
      const monitor = get().monitors.find((m) => m.id === id);
      if (!monitor?.gateway_job_id) {
        console.warn('[MonitorStore] Cannot run monitor without gateway job. Enable it first.');
        return;
      }

      await client.request('cron.run', { id: monitor.gateway_job_id, mode: 'force' });
      await get().loadMonitors();
    } catch (err) {
      console.error('[MonitorStore] runMonitor failed:', err);
    }
  },
}));

export function resetMonitorReconciled(): void {
  _reconciled = false;
  // The probe is memoised per gateway session; a reconnect may bind a different
  // channel or a newly configured recipient, so it must be re-verified.
  _deliveryProbe = null;
  _failedDeliveryTargets.clear();
}

/**
 * Test-only export: exposes buildMonitorCronMessage for parity tests without
 * the need to restructure the module. Not intended for production use.
 * @internal
 */
export { buildMonitorCronMessage as testBuildMonitorCronMessage };

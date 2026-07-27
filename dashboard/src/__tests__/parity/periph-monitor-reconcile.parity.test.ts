/**
 * Behavioral Parity Tests: monitor store reconcile gating (F1) + cron delivery (F7)
 *
 * F1 — SPEC:320-324: an agent can flip enabled=true mid-session via monitor_update
 * (extensions/research-claw-core/src/monitor/tools.ts:191-223), but only the
 * dashboard registers cron jobs. The old module-level `_reconciled` gate ran
 * reconcile once per gateway session, so such monitors stayed enabled with
 * gateway_job_id=null until a page refresh. New contract (stores/monitor.ts
 * loadMonitors): reconcile also runs unconditionally whenever any monitor has
 * enabled===true && !gateway_job_id.
 *
 * F7 — SPEC:356-360: cron registration delivery is notify-aware AND resolves an
 * explicit target so isolated cron runs physically reach the user.
 *   notify=true  + bound external channel → { mode:'announce', channel:<id>,
 *                                             accountId:<id>, bestEffort:true }
 *   notify=true  + no bound channel       → { mode:'announce', channel:'last',
 *                                             bestEffort:true } (fail-closed)
 *   notify=false                          → { mode:'none' }
 * OC source verification:
 *   - channel='last' fail-closes in an isolated cron session with no prior route:
 *     "Channel is required when delivery.channel=last has no previous channel"
 *     (openclaw/src/cron/isolated-agent/delivery-target.ts:248-259); preview shows
 *     "last -> no route, will fail-closed" (delivery-preview.ts:24-32).
 *   - An EXPLICIT channel makes resolveDeliveryTarget fill the bound accountId
 *     (delivery-target.ts:234-241) and report "explicit" in the preview
 *     (delivery-preview.ts:34).
 *   - channels.status exposes accountId but NO recipient `to`
 *     (ChannelAccountSnapshotSchema, openclaw/packages/gateway-protocol/src/schema/
 *     channels.ts:646-684), so the dashboard derives { channel, accountId } only.
 *   - "webchat" is INTERNAL_MESSAGE_CHANNEL / non-delivery
 *     (openclaw/src/utils/message-channel-constants.ts:1,10) → excluded.
 *   - bestEffort keeps run status green when the send fails
 *     (openclaw/src/cron/isolated-agent/delivery-dispatch.ts:1067-1076,1212-1214).
 *   - cron.add delivery schema accepts announce { channel, accountId, bestEffort }:
 *     openclaw/packages/gateway-protocol/src/schema/cron.ts:79,260-266,285-293
 *   - cron.list response shape { jobs, total, offset, limit, hasMore, nextOffset,
 *     deliveryPreviews }: openclaw/src/cron/service/ops.ts:400-407 +
 *     openclaw/src/gateway/server-methods/cron.ts:314-319
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  useMonitorStore,
  resetMonitorReconciled,
  testBuildMonitorCronMessage,
  type Monitor,
} from '../../stores/monitor';
import {
  RC_MONITOR_LIST_EMPTY_RESPONSE,
  RC_MONITOR_LIST_ORPHAN_ENABLED_RESPONSE,
  RC_MONITOR_LIST_ORPHAN_REPAIRED_RESPONSE,
  RC_MONITOR_TOGGLE_ENABLED,
  RC_MONITOR_TOGGLE_ENABLED_NOTIFY_OFF,
  RC_MONITOR_SET_JOB_ID_RESPONSE,
  CRON_ADD_RESPONSE,
  CRON_LIST_EMPTY_RESPONSE,
  CHANNELS_STATUS_BOUND_WEIXIN,
  CHANNELS_STATUS_NO_BOUND,
  BOUND_DELIVERY,
  NO_CHANNEL_DELIVERY,
} from '../../__fixtures__/gateway-payloads/monitor-responses';

// ── Mock gateway store (same pattern as periph-store.parity.test.ts) ─────────
const mockGatewayClient = {
  isConnected: true,
  request: vi.fn(),
};

vi.mock('../../stores/gateway', () => ({
  useGatewayStore: {
    getState: () => ({ client: mockGatewayClient, state: 'connected' }),
    setState: vi.fn(),
    subscribe: vi.fn(),
  },
}));

// ── Route-table request mock with call recording ─────────────────────────────

type RecordedCall = { method: string; params: Record<string, unknown> };

function installRouter(routes: {
  monitorList: unknown[];               // consumed in order, last repeats
  cronList?: unknown;
  toggle?: unknown;
  channelsStatus?: unknown;             // F7: bound-channel derivation source
}): RecordedCall[] {
  const calls: RecordedCall[] = [];
  const listQueue = [...routes.monitorList];
  let currentDelivery: Record<string, unknown> = {};

  mockGatewayClient.request.mockImplementation(async (method: string, params: Record<string, unknown>) => {
    calls.push({ method, params });
    switch (method) {
      case 'rc.monitor.list':
        return listQueue.length > 1 ? listQueue.shift() : listQueue[0];
      case 'cron.list': {
        const base = (routes.cronList ?? CRON_LIST_EMPTY_RESPONSE) as Record<string, unknown>;
        if (typeof params.query === 'string') {
          return {
            ...base,
            deliveryPreviews: {
              [params.query]: {
                detail: currentDelivery.mode === 'announce' ? 'explicit' : 'not-requested',
              },
            },
          };
        }
        return base;
      }
      case 'cron.add':
        return CRON_ADD_RESPONSE;
      case 'cron.update':
        currentDelivery = ((params.patch as Record<string, unknown>)?.delivery ?? {}) as Record<string, unknown>;
        return { ok: true };
      case 'cron.remove':
        return { ok: true };
      case 'rc.monitor.toggle':
        return routes.toggle;
      case 'rc.monitor.setJobId':
        return RC_MONITOR_SET_JOB_ID_RESPONSE;
      case 'channels.status':
        // Default: no external channel bound (mode:none path).
        return routes.channelsStatus ?? CHANNELS_STATUS_NO_BOUND;
      case 'config.get':
        return { config: { channels: {} } };
      default:
        throw new Error(`unexpected RPC in test: ${method}`);
    }
  });

  return calls;
}

const methodsOf = (calls: RecordedCall[]) => calls.map((c) => c.method);

// ══════════════════════════════════════════════════════════════════════════
describe('monitor store reconcile gating (F1)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockGatewayClient.isConnected = true;
    resetMonitorReconciled();
    useMonitorStore.setState({ monitors: [], loading: false, loaded: false });
  });

  it('re-runs reconcile after the per-session gate when an enabled monitor has no gateway job', async () => {
    // Load 1: empty DB → reconcile runs over nothing, verified → _reconciled=true
    const warmupCalls = installRouter({ monitorList: [RC_MONITOR_LIST_EMPTY_RESPONSE] });
    await useMonitorStore.getState().loadMonitors();
    expect(methodsOf(warmupCalls)).not.toContain('cron.add');

    // Load 2: agent flipped enabled=true mid-session (fixture: enabled && gateway_job_id null).
    // Old gate would skip reconcile here — new contract must register the cron job.
    const calls = installRouter({
      monitorList: [
        RC_MONITOR_LIST_ORPHAN_ENABLED_RESPONSE,
        RC_MONITOR_LIST_ORPHAN_REPAIRED_RESPONSE, // refreshed list after repair
      ],
    });
    await useMonitorStore.getState().loadMonitors();

    const cronAdd = calls.find((c) => c.method === 'cron.add');
    expect(cronAdd).toBeDefined();
    // Registration parity: stores/monitor.ts registerMonitorCronJob
    expect(cronAdd!.params.name).toBe('[rc-monitor] Lab Camera Check');
    expect(cronAdd!.params.sessionKey).toBe('cron:rc-monitor:cam-orphan-001');
    expect(cronAdd!.params.sessionTarget).toBe('isolated');
    expect(cronAdd!.params.schedule).toEqual({ kind: 'cron', expr: '*/30 * * * *' });
    const payload = cronAdd!.params.payload as Record<string, unknown>;
    expect(payload.kind).toBe('agentTurn');
    expect(payload.timeoutSeconds).toBe(900);
    // Message is the exact device-branch cron message for this monitor
    expect(payload.message).toBe(
      testBuildMonitorCronMessage(RC_MONITOR_LIST_ORPHAN_ENABLED_RESPONSE.items[0]),
    );

    // Job ID persisted back into the plugin DB (monitor/rpc.ts:234-241)
    const setJobId = calls.find((c) => c.method === 'rc.monitor.setJobId');
    expect(setJobId?.params).toEqual({ id: 'cam-orphan-001', job_id: CRON_ADD_RESPONSE.id });

    // Store reflects the repaired binding without any page refresh
    const monitor = useMonitorStore.getState().monitors.find((m) => m.id === 'cam-orphan-001');
    expect(monitor?.gateway_job_id).toBe(CRON_ADD_RESPONSE.id);
  });

  it('still skips reconcile after the gate when all enabled monitors have gateway jobs', async () => {
    const warmupCalls = installRouter({ monitorList: [RC_MONITOR_LIST_EMPTY_RESPONSE] });
    await useMonitorStore.getState().loadMonitors();
    expect(methodsOf(warmupCalls)).not.toContain('cron.add');

    // All enabled monitors bound → no orphan → once-per-session gate applies
    const calls = installRouter({ monitorList: [RC_MONITOR_LIST_ORPHAN_REPAIRED_RESPONSE] });
    await useMonitorStore.getState().loadMonitors();

    expect(methodsOf(calls)).not.toContain('cron.add');
    expect(methodsOf(calls)).not.toContain('cron.remove');
  });
});

// ══════════════════════════════════════════════════════════════════════════
describe('cron delivery is notify-aware (F7)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockGatewayClient.isConnected = true;
    resetMonitorReconciled();
    useMonitorStore.setState({
      monitors: [{ ...RC_MONITOR_TOGGLE_ENABLED, enabled: false }],
      loading: false,
      loaded: true,
    });
  });

  it('notify=true monitor with a bound external channel registers an EXPLICIT delivery target', async () => {
    const calls = installRouter({
      monitorList: [RC_MONITOR_LIST_EMPTY_RESPONSE],
      toggle: RC_MONITOR_TOGGLE_ENABLED,          // notify: true (monitor-responses.ts)
      channelsStatus: CHANNELS_STATUS_BOUND_WEIXIN, // openclaw-weixin live, webchat internal, discord offline
    });

    await useMonitorStore.getState().toggleMonitor('github-releases', true);

    // The store must consult channels.status to derive a real target.
    expect(methodsOf(calls)).toContain('channels.status');

    const cronAdd = calls.find((c) => c.method === 'cron.add');
    expect(cronAdd).toBeDefined();
    // Explicit channel + bound accountId (never 'last', never 'webchat'): with a
    // concrete channel resolveDeliveryTarget fills the account and the preview
    // reports "explicit" (delivery-target.ts:234-241; delivery-preview.ts:34).
    // The recipient `to` is intentionally absent — channels.status has none.
    expect(cronAdd!.params.delivery).toEqual(BOUND_DELIVERY);
    expect(cronAdd!.params.delivery).not.toHaveProperty('to');
  });

  it('skips an unroutable first live channel and probes the next live channel', async () => {
    const calls: RecordedCall[] = [];
    let currentDelivery: Record<string, unknown> = {};
    const multiChannelStatus = {
      channelOrder: ['irc', 'openclaw-weixin'],
      channelAccounts: {
        irc: [{ accountId: 'irc-default', enabled: true, configured: true, connected: true, running: true }],
        'openclaw-weixin': [{ accountId: 'wx-primary', enabled: true, configured: true, connected: true, running: true }],
      },
      channelDefaultAccountId: {
        irc: 'irc-default',
        'openclaw-weixin': 'wx-primary',
      },
    };

    mockGatewayClient.request.mockImplementation(async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      switch (method) {
        case 'rc.monitor.toggle': return RC_MONITOR_TOGGLE_ENABLED;
        case 'channels.status': return multiChannelStatus;
        case 'config.get':
          return { config: { channels: { irc: { channels: ['#unroutable'] }, 'openclaw-weixin': {} } } };
        case 'cron.add': return CRON_ADD_RESPONSE;
        case 'cron.update':
          currentDelivery = ((params.patch as Record<string, unknown>)?.delivery ?? {}) as Record<string, unknown>;
          return { ok: true };
        case 'cron.list':
          return {
            ...CRON_LIST_EMPTY_RESPONSE,
            deliveryPreviews: {
              [CRON_ADD_RESPONSE.id]: {
                detail: currentDelivery.channel === 'openclaw-weixin'
                  ? 'explicit'
                  : 'Delivering to IRC requires target <#channel|nick>',
              },
            },
          };
        case 'rc.monitor.setJobId': return RC_MONITOR_SET_JOB_ID_RESPONSE;
        case 'rc.monitor.list':
          return {
            items: [{ ...RC_MONITOR_TOGGLE_ENABLED, gateway_job_id: CRON_ADD_RESPONSE.id }],
            total: 1,
          };
        default: throw new Error(`unexpected RPC in test: ${method}`);
      }
    });

    const result = await useMonitorStore.getState().toggleMonitor('github-releases', true);

    expect(result).toEqual({ ok: true });
    const deliveryUpdates = calls
      .filter((call) => call.method === 'cron.update')
      .map((call) => ((call.params.patch as Record<string, unknown>).delivery as Record<string, unknown>));
    expect(deliveryUpdates.some((delivery) => delivery.channel === 'irc')).toBe(true);
    expect(deliveryUpdates.some((delivery) => delivery.channel === 'openclaw-weixin')).toBe(true);
    expect(deliveryUpdates.at(-1)).toEqual({
      mode: 'announce',
      channel: 'openclaw-weixin',
      accountId: 'wx-primary',
      to: null,
      bestEffort: true,
    });
  });

  it('caps channel probing when every live target is unroutable', async () => {
    const channels = Array.from({ length: 40 }, (_, index) => `bad-${index}`);
    const status = {
      channelOrder: channels,
      channelAccounts: Object.fromEntries(
        channels.map((channel) => [
          channel,
          [{ accountId: 'default', enabled: true, configured: true, connected: true, running: true }],
        ]),
      ),
      channelDefaultAccountId: Object.fromEntries(channels.map((channel) => [channel, 'default'])),
    };
    const probedChannels: string[] = [];

    mockGatewayClient.request.mockImplementation(async (method: string, params: Record<string, unknown>) => {
      switch (method) {
        case 'rc.monitor.toggle': return RC_MONITOR_TOGGLE_ENABLED;
        case 'channels.status': return status;
        case 'config.get': return { config: { channels: {} } };
        case 'cron.add': return CRON_ADD_RESPONSE;
        case 'cron.update': {
          const delivery = ((params.patch as Record<string, unknown>).delivery ?? {}) as Record<string, unknown>;
          if (typeof delivery.channel === 'string') probedChannels.push(delivery.channel);
          return { ok: true };
        }
        case 'cron.list':
          return {
            ...CRON_LIST_EMPTY_RESPONSE,
            deliveryPreviews: {
              [CRON_ADD_RESPONSE.id]: { detail: 'unroutable' },
            },
          };
        case 'rc.monitor.setJobId': return RC_MONITOR_SET_JOB_ID_RESPONSE;
        case 'rc.monitor.list':
          return {
            items: [{ ...RC_MONITOR_TOGGLE_ENABLED, gateway_job_id: CRON_ADD_RESPONSE.id }],
            total: 1,
          };
        default: throw new Error(`unexpected RPC in test: ${method}`);
      }
    });

    const result = await useMonitorStore.getState().toggleMonitor('github-releases', true);

    expect(result).toEqual({ ok: true });
    expect(new Set(probedChannels).size).toBe(32);
    expect(probedChannels).not.toContain('bad-32');
  });

  it('notify=true monitor with NO bound external channel registers mode:none, never announce/last', async () => {
    const calls = installRouter({
      monitorList: [RC_MONITOR_LIST_EMPTY_RESPONSE],
      toggle: RC_MONITOR_TOGGLE_ENABLED,
      channelsStatus: CHANNELS_STATUS_NO_BOUND, // telegram offline, webchat internal → nothing bound
    });

    await useMonitorStore.getState().toggleMonitor('github-releases', true);

    const cronAdd = calls.find((c) => c.method === 'cron.add');
    expect(cronAdd).toBeDefined();
    // No resolvable channel → mode:none. announce/last here would register a job
    // the gateway previews as "last -> no route, will fail-closed" and silently
    // drops at every run while the UI shows push as armed; the dashboard bell is
    // the fallback instead.
    expect(cronAdd!.params.delivery).toEqual(NO_CHANNEL_DELIVERY);
  });

  it("notify=false monitor keeps delivery mode 'none' and never queries channels.status", async () => {
    const calls = installRouter({
      monitorList: [RC_MONITOR_LIST_EMPTY_RESPONSE],
      toggle: RC_MONITOR_TOGGLE_ENABLED_NOTIFY_OFF,
      channelsStatus: CHANNELS_STATUS_BOUND_WEIXIN, // present, but must NOT be consulted
    });

    await useMonitorStore.getState().toggleMonitor('github-releases', true);

    const cronAdd = calls.find((c) => c.method === 'cron.add');
    expect(cronAdd).toBeDefined();
    expect(cronAdd!.params.delivery).toEqual({ mode: 'none' });
    // notify=false never announces → no wasted channels.status round-trip.
    expect(methodsOf(calls)).not.toContain('channels.status');
  });

  it('reconcile self-heals a pre-upgrade job whose delivery mode contradicts notify', async () => {
    // Job registered by the pre-F7 dashboard: byte-identical payload/schedule but
    // delivery mode 'none' while the monitor has notify=true. Only the delivery
    // check in cronJobNeedsRefresh can flag this job for re-registration. No bound
    // channel here → the upgrade can only be mode:none.
    const monitor: Monitor = {
      ...RC_MONITOR_LIST_ORPHAN_ENABLED_RESPONSE.items[0],
      gateway_job_id: 'gw-job-legacy-001',
    };
    const legacyJob = {
      id: 'gw-job-legacy-001',
      name: '[rc-monitor] Lab Camera Check',
      sessionKey: 'cron:rc-monitor:cam-orphan-001',
      sessionTarget: 'isolated',
      schedule: { kind: 'cron', expr: monitor.schedule },
      payload: {
        kind: 'agentTurn',
        message: testBuildMonitorCronMessage(monitor),
        timeoutSeconds: 900,
      },
      delivery: { mode: 'none', channel: 'last' },
      state: {},
    };

    const calls = installRouter({
      monitorList: [
        { items: [monitor], total: 1 },
        RC_MONITOR_LIST_ORPHAN_REPAIRED_RESPONSE,
      ],
      cronList: { ...CRON_LIST_EMPTY_RESPONSE, jobs: [legacyJob], total: 1 },
      channelsStatus: CHANNELS_STATUS_NO_BOUND,
    });

    await useMonitorStore.getState().loadMonitors();

    // Stale job removed, replacement registered with the no-route-safe delivery.
    const cronRemove = calls.find((c) => c.method === 'cron.remove');
    expect(cronRemove?.params).toEqual({ id: 'gw-job-legacy-001' });
    const cronAdd = calls.find((c) => c.method === 'cron.add');
    expect(cronAdd!.params.delivery).toEqual(NO_CHANNEL_DELIVERY);
  });

  it('reconcile self-heals an announce/last job once an external channel becomes bound', async () => {
    // Pre-existing job used the announce/last fallback; now openclaw-weixin is
    // live, so the FULL-delivery comparison in cronJobNeedsRefresh (channel +
    // accountId) must flag it and re-register with the explicit target.
    const monitor: Monitor = {
      ...RC_MONITOR_LIST_ORPHAN_ENABLED_RESPONSE.items[0],
      gateway_job_id: 'gw-job-lastonly-001',
    };
    const lastOnlyJob = {
      id: 'gw-job-lastonly-001',
      name: '[rc-monitor] Lab Camera Check',
      sessionKey: 'cron:rc-monitor:cam-orphan-001',
      sessionTarget: 'isolated',
      schedule: { kind: 'cron', expr: monitor.schedule },
      payload: {
        kind: 'agentTurn',
        message: testBuildMonitorCronMessage(monitor),
        timeoutSeconds: 900,
      },
      delivery: { mode: 'announce', channel: 'last', bestEffort: true },
      state: {},
    };

    const calls = installRouter({
      monitorList: [
        { items: [monitor], total: 1 },
        RC_MONITOR_LIST_ORPHAN_REPAIRED_RESPONSE,
      ],
      cronList: { ...CRON_LIST_EMPTY_RESPONSE, jobs: [lastOnlyJob], total: 1 },
      channelsStatus: CHANNELS_STATUS_BOUND_WEIXIN,
    });

    await useMonitorStore.getState().loadMonitors();

    const cronRemove = calls.find((c) => c.method === 'cron.remove');
    expect(cronRemove?.params).toEqual({ id: 'gw-job-lastonly-001' });
    const cronAdd = calls.find((c) => c.method === 'cron.add');
    expect(cronAdd!.params.delivery).toEqual(BOUND_DELIVERY);
  });

  it('does NOT refresh an explicit-target job that already matches the bound channel', async () => {
    // Idempotency guard: a job already carrying the explicit weixin target must
    // not be needlessly torn down and re-added on every reconcile.
    const monitor: Monitor = {
      ...RC_MONITOR_LIST_ORPHAN_ENABLED_RESPONSE.items[0],
      gateway_job_id: 'gw-job-explicit-001',
    };
    const explicitJob = {
      id: 'gw-job-explicit-001',
      name: '[rc-monitor] Lab Camera Check',
      sessionKey: 'cron:rc-monitor:cam-orphan-001',
      sessionTarget: 'isolated',
      schedule: { kind: 'cron', expr: monitor.schedule },
      payload: {
        kind: 'agentTurn',
        message: testBuildMonitorCronMessage(monitor),
        timeoutSeconds: 900,
      },
      delivery: BOUND_DELIVERY,
      state: {},
    };

    const calls = installRouter({
      monitorList: [{ items: [monitor], total: 1 }],
      cronList: { ...CRON_LIST_EMPTY_RESPONSE, jobs: [explicitJob], total: 1 },
      channelsStatus: CHANNELS_STATUS_BOUND_WEIXIN,
    });

    await useMonitorStore.getState().loadMonitors();

    expect(methodsOf(calls)).not.toContain('cron.remove');
    expect(methodsOf(calls)).not.toContain('cron.add');
  });
});

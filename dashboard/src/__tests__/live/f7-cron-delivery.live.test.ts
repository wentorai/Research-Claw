/**
 * F7 真机验收 — cron 投递目标解析(SPEC §13 F7)
 *
 * 这个文件与其他 dashboard 测试的根本区别:**没有任何 mock**。
 * `useGatewayStore.getState().client` 被换成一条真正的 WebSocket 通道
 * (OpenClaw 官方 `callGatewayFromCli`),打到一个真在跑的 gateway 上。
 * 因此下面执行的是 monitor store 的**生产代码本体** —— resolveBoundDeliveryTarget()
 * 真的发 `channels.status`、registerMonitorCronJob() 真的发 `cron.add`、
 * 断言读的是 gateway 自己算出来的 `cron.list.deliveryPreviews`。
 *
 * 为什么必须这么测:F7 的缺陷形态是"单测全绿但真机 fail-closed"。
 * buildMonitorDelivery() 的纯函数单测无法证明 OpenClaw 认得这个 delivery 块 ——
 * 只有 gateway 的 delivery preview 从 `last -> no route, will fail-closed`
 * 变成 `explicit`,才算真的修好。
 *
 * 运行前置(缺任一即"外部条件阻塞",不是实现缺陷):
 *   - 一个隔离 gateway 在 RC_LIVE_WS_URL 上跑着(默认 ws://127.0.0.1:28799)
 *   - 该 gateway 绑定了至少一个可投递外部渠道(本用例用本地 ergo IRC)
 *   - OPENCLAW_CONFIG_PATH / OPENCLAW_STATE_DIR 指向隔离状态目录
 *
 * 用 `scripts/f7-live.sh` 拉起,不要直接 `vitest run` —— 那个脚本会做
 * 前置检查 + 日志硬校验(vitest 退出码 0 不等于用例真的跑过)。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { callGatewayFromCli } from 'openclaw/plugin-sdk/gateway-runtime';
import { useGatewayStore } from '../../stores/gateway';
import { useMonitorStore, type Monitor } from '../../stores/monitor';
import { usePeripheralsStore } from '../../stores/peripherals';
import type { GatewayClient } from '../../gateway/client';

const WS_URL = process.env.RC_LIVE_WS_URL ?? 'ws://127.0.0.1:28799';
const WS_TOKEN = process.env.RC_LIVE_WS_TOKEN ?? 'research-claw';
const EXPECT_CHANNEL = process.env.RC_LIVE_EXPECT_CHANNEL ?? 'irc';
const EXPECT_ACCOUNT = process.env.RC_LIVE_EXPECT_ACCOUNT ?? 'default';

/** 本次跑测创建的所有对象都带这个前缀,便于收尾清理且不误伤既有数据。 */
const TAG = 'rc-f7-live';

const ev = (...parts: unknown[]) => console.log('[F7-LIVE]', ...parts);

/**
 * 真通道:把 dashboard 的 client 接口桥到 OpenClaw 官方 CLI 调用路径。
 *
 * 为什么不用手搓 WebSocket:gateway 握手会从三个方向拒掉裸连接 ——
 * 浏览器 Origin 校验、control-ui 设备身份校验、以及未配对设备的 scope 清空。
 * `callGatewayFromCli` 是 OpenClaw 自己 CLI 走的那条路(公开子路径导出
 * `openclaw/plugin-sdk/gateway-runtime`),会加载/创建 ed25519 设备身份、
 * 完成本地回环配对、签名 connect challenge。
 */
function createLiveClient(): GatewayClient {
  const live = {
    isConnected: true,
    async request<T>(method: string, params?: unknown): Promise<T> {
      const res = await callGatewayFromCli(
        method,
        { url: WS_URL, token: WS_TOKEN, timeout: '60000' },
        params ?? {},
      );
      return res as T;
    },
  };
  return live as unknown as GatewayClient;
}

type CronJob = {
  id: string;
  name?: string;
  sessionKey?: string;
  delivery?: Record<string, unknown>;
  payload?: Record<string, unknown>;
};
type CronListResult = {
  jobs?: CronJob[];
  deliveryPreviews?: Record<string, { detail?: string } | undefined>;
  hasMore?: boolean;
  nextOffset?: number | null;
};

/** gateway 对分页 limit 的硬上限(超过直接报 `limit must be <= 100`)。 */
const PAGE_MAX = 100;

async function rpc<T>(method: string, params?: unknown): Promise<T> {
  return useGatewayStore.getState().client!.request<T>(method, params);
}

/**
 * 翻完所有页再返回。F7-D 断言的是"全量 cron.list 里没有任何 fail-closed 预览",
 * 只取第一页会让这个断言在 job 数超过一页时变成假阳性。
 */
async function cronList(): Promise<Required<Pick<CronListResult, 'jobs' | 'deliveryPreviews'>>> {
  const jobs: CronJob[] = [];
  const deliveryPreviews: Record<string, { detail?: string } | undefined> = {};
  let offset = 0;
  for (;;) {
    const page = await rpc<CronListResult>('cron.list', { limit: PAGE_MAX, offset });
    jobs.push(...(page.jobs ?? []));
    Object.assign(deliveryPreviews, page.deliveryPreviews ?? {});
    if (!page.hasMore || typeof page.nextOffset !== 'number' || page.nextOffset <= offset) break;
    offset = page.nextOffset;
  }
  return { jobs, deliveryPreviews };
}

/** 删掉本 TAG 名下的 monitor 与 cron job,让重复执行幂等。 */
async function purgeTagged(): Promise<void> {
  const { jobs = [] } = await cronList();
  for (const job of jobs) {
    if (job.name?.includes(TAG) || job.sessionKey?.includes(TAG)) {
      try { await rpc('cron.remove', { id: job.id }); } catch { /* 可能已被别处删掉 */ }
    }
  }
  const list = await rpc<{ items: Monitor[] }>('rc.monitor.list', { limit: PAGE_MAX });
  for (const m of list.items) {
    if (m.name.includes(TAG)) {
      try { await rpc('rc.monitor.delete', { id: m.id }); } catch { /* 同上 */ }
    }
  }
  const devs = await rpc<{ devices: { id: string; name: string }[] }>('rc.periph.devices.list', {});
  for (const d of devs.devices) {
    if (d.name.includes(TAG)) {
      try { await rpc('rc.periph.devices.delete', { id: d.id }); } catch { /* 同上 */ }
    }
  }
}

/**
 * 跑通一条 monitor 的完整启用链路,返回 gateway 侧的真实 job 快照 + 投递预览。
 * 走的是 store 的公开 action(createMonitor → toggleMonitor),不是内部函数,
 * 因此覆盖 registerMonitorCronJob + reconcileEnabledMonitors 两条注册路径。
 */
async function enableMonitorAndSnapshot(
  name: string,
  notify: boolean,
  deviceId: string,
): Promise<{ monitor: Monitor; job: CronJob; previewDetail: string }> {
  const store = useMonitorStore.getState();
  const created = await store.createMonitor({
    name,
    source_type: 'device',
    target: deviceId,
    schedule: '0 3 * * *',
    notify,
    enabled: false,
  });
  expect(created, 'createMonitor 应返回真实 monitor 行').not.toBeNull();

  await useMonitorStore.getState().toggleMonitor(created!.id, true);

  const after = await rpc<{ items: Monitor[] }>('rc.monitor.list', { limit: PAGE_MAX });
  const monitor = after.items.find((m) => m.id === created!.id);
  expect(monitor, 'toggle 后 monitor 应仍在 DB 中').toBeTruthy();
  expect(monitor!.gateway_job_id, 'toggle(true) 后必须写回 gateway_job_id').toBeTruthy();

  const { jobs = [], deliveryPreviews = {} } = await cronList();
  const job = jobs.find((j) => j.id === monitor!.gateway_job_id);
  expect(job, `cron.list 中必须存在 job ${monitor!.gateway_job_id}`).toBeTruthy();

  const previewDetail = String(deliveryPreviews[job!.id]?.detail ?? '');
  return { monitor: monitor!, job: job!, previewDetail };
}

describe('F7 real-machine: cron delivery target resolution', () => {
  beforeAll(async () => {
    useGatewayStore.setState({ client: createLiveClient() });
    // 真连通性 + 前置渠道断言:失败要在第一条用例前就炸,不要伪装成业务失败
    const status = await rpc<Record<string, unknown>>('channels.status', {});
    const accounts = (status.channelAccounts ?? {}) as Record<string, { accountId?: string; running?: boolean; configured?: boolean; enabled?: boolean }[]>;
    const live = (accounts[EXPECT_CHANNEL] ?? []).find((a) => a.enabled !== false && a.running === true && a.configured === true);
    expect(live, `前置条件:渠道 ${EXPECT_CHANNEL} 必须已绑定且 running(否则是外部条件阻塞,不是 F7 缺陷)`).toBeTruthy();
    ev(`gateway=${WS_URL} bound-channel=${EXPECT_CHANNEL}/${live!.accountId}`);
    await purgeTagged();
  }, 120_000);

  afterAll(async () => {
    if (useGatewayStore.getState().client) await purgeTagged();
  }, 120_000);

  it('[F7-A] notify=true 的 device monitor 注册出显式投递目标,gateway 预览为 explicit', async () => {
    const dev = await rpc<{ device: { id: string } }>('rc.periph.devices.create', {
      name: `${TAG} camera A`,
      kind: 'camera',
      driver: 'rtsp',
      config: { url: 'rtsp://127.0.0.1:18554/e2e' },
    });
    const { monitor, job, previewDetail } = await enableMonitorAndSnapshot(
      `${TAG} notify-on`, true, dev.device.id,
    );

    // 1) dashboard 写进去的 delivery 块必须是显式渠道 —— 不是 announce/last
    expect(job.delivery).toMatchObject({
      mode: 'announce',
      channel: EXPECT_CHANNEL,
      accountId: EXPECT_ACCOUNT,
      bestEffort: true,
    });
    expect(job.delivery?.channel, 'channel=last 就是 F7 的原始缺陷形态').not.toBe('last');

    // 2) gateway 自己算出来的投递预览必须是 explicit —— 这是 OpenClaw 认不认这个
    //    目标的唯一权威判据(cron-CTQOysZD.js:19-60 formatDeliveryDetail)
    expect(previewDetail).toBe('explicit');
    expect(previewDetail).not.toMatch(/no route/i);
    expect(previewDetail).not.toMatch(/fail-closed/i);

    ev(`A monitor=${monitor.id} job=${job.id} delivery=${JSON.stringify(job.delivery)} preview="${previewDetail}"`);
  }, 180_000);

  it('[F7-B] notify=false 的 monitor 注册为 mode=none,预览不含 fail-closed', async () => {
    const dev = await rpc<{ device: { id: string } }>('rc.periph.devices.create', {
      name: `${TAG} camera B`,
      kind: 'camera',
      driver: 'rtsp',
      config: { url: 'rtsp://127.0.0.1:18554/e2e' },
    });
    const { monitor, job, previewDetail } = await enableMonitorAndSnapshot(
      `${TAG} notify-off`, false, dev.device.id,
    );

    expect(job.delivery).toMatchObject({ mode: 'none' });
    expect(job.delivery?.channel, 'notify=false 不该带 channel').toBeUndefined();
    expect(previewDetail).not.toMatch(/no route/i);
    expect(previewDetail).not.toMatch(/fail-closed/i);

    ev(`B monitor=${monitor.id} job=${job.id} delivery=${JSON.stringify(job.delivery)} preview="${previewDetail}"`);
  }, 180_000);

  it('[F7-C] notify 从 false 翻到 true,reconcile 自愈把旧 job 升级为显式目标', async () => {
    const dev = await rpc<{ device: { id: string } }>('rc.periph.devices.create', {
      name: `${TAG} camera C`,
      kind: 'camera',
      driver: 'rtsp',
      config: { url: 'rtsp://127.0.0.1:18554/e2e' },
    });
    // 先以 notify=false 建起来,拿到一个 mode:none 的 job
    const before = await enableMonitorAndSnapshot(`${TAG} flip`, false, dev.device.id);
    expect(before.job.delivery).toMatchObject({ mode: 'none' });

    // 直接改 DB 里的 notify(模拟 agent 侧 monitor_update),不重建 job ——
    // 这正是 cronJobNeedsRefresh() 自愈路径要覆盖的场景
    await rpc('rc.monitor.update', { id: before.monitor.id, notify: true });
    await useMonitorStore.getState().loadMonitors();

    const after = await rpc<{ items: Monitor[] }>('rc.monitor.list', { limit: PAGE_MAX });
    const monitor = after.items.find((m) => m.id === before.monitor.id)!;
    const { jobs = [], deliveryPreviews = {} } = await cronList();
    const job = jobs.find((j) => j.id === monitor.gateway_job_id);
    expect(job, 'reconcile 后必须仍有一个绑定的 job').toBeTruthy();

    expect(job!.delivery).toMatchObject({
      mode: 'announce',
      channel: EXPECT_CHANNEL,
      accountId: EXPECT_ACCOUNT,
      bestEffort: true,
    });
    const detail = String(deliveryPreviews[job!.id]?.detail ?? '');
    expect(detail).toBe('explicit');

    // 自愈不能留下重复 job
    const dupes = jobs.filter((j) => j.sessionKey === `cron:rc-monitor:${monitor.id}`);
    expect(dupes.length, '自愈后同一 monitor 只能有一个 cron job').toBe(1);

    ev(`C monitor=${monitor.id} job=${job!.id} delivery=${JSON.stringify(job!.delivery)} preview="${detail}"`);
  }, 180_000);

  it('[F7-D] 全量 cron.list 中每个 announce job 的投递预览都是 explicit', async () => {
    const { jobs = [], deliveryPreviews = {} } = await cronList();

    // 不能只用 /no route|fail-closed/ 匹配:gateway 对"缺收件人"给出的 detail 是
    // "Delivering to IRC requires target <#channel|nick>",不含这两个词,却同样
    // 投递不出去 —— 这正是 F7-A 暴露的缺陷,旧断言会把它判成通过。OC 只在真正
    // 解析成功时返回 "explicit"(delivery-preview.ts:34),所以直接对齐该口径。
    const announceJobs = jobs.filter((j) => j.delivery?.mode === 'announce');
    // 没有 announce job 时,"全部 explicit" 是空真 —— 会把"一条都没注册上"误判成
    // 通过。A/C 各注册了一条 notify=true 的 monitor,所以这里必须至少有两条。
    expect(announceJobs.length, 'announce job 为 0,该用例退化成空断言').toBeGreaterThanOrEqual(2);

    const bad = announceJobs
      .filter((j) => deliveryPreviews[j.id]?.detail !== 'explicit')
      .map((j) => `${j.id} (${j.name}): ${deliveryPreviews[j.id]?.detail ?? '<无预览>'}`);

    ev(`D jobs=${jobs.length} announce=${announceJobs.length} bad=${bad.length}`);
    expect(bad, `以下 announce job 的投递目标解析不了:\n${bad.join('\n')}`).toEqual([]);

    // 任何 job(含非 announce)都不允许留下 last -> no route。
    const failClosed = Object.entries(deliveryPreviews)
      .filter(([, p]) => /no route|fail-closed/i.test(String(p?.detail ?? '')))
      .map(([id, p]) => `${id}: ${p?.detail}`);
    expect(failClosed, `以下 job 仍会 fail-closed:\n${failClosed.join('\n')}`).toEqual([]);
  }, 120_000);

});

describe('I3 real-machine: device deletion cascade', () => {
  beforeAll(async () => {
    useGatewayStore.setState({ client: createLiveClient() });
    await purgeTagged();
  }, 120_000);

  afterAll(async () => {
    if (useGatewayStore.getState().client) await purgeTagged();
  }, 120_000);

  it('[I3] 删除设备同时清理观测、device monitor 与真实 gateway cron job', async () => {
    const device = await usePeripheralsStore.getState().createDevice({
      name: `${TAG} cascade`,
      kind: 'camera',
      driver: 'rtsp',
      config: { url: 'rtsp://127.0.0.1:18554/e2e' },
    });
    expect(device, '设备必须经 dashboard store 写入真网关').not.toBeNull();

    await rpc('rc.periph.observations.create', {
      device_id: device!.id,
      kind: 'note',
      verdict: 'info',
      summary: 'I3 cascade probe',
    });
    const before = await enableMonitorAndSnapshot(`${TAG} cascade monitor`, false, device!.id);
    const beforeJobs = await cronList();
    expect(beforeJobs.jobs.some((job) => job.id === before.job.id)).toBe(true);

    await usePeripheralsStore.getState().deleteDevice(device!.id);
    expect(usePeripheralsStore.getState().error).toBeNull();

    const devicesAfter = await rpc<{ devices: Array<{ id: string }> }>('rc.periph.devices.list', {});
    const monitorsAfter = await rpc<{ items: Monitor[] }>('rc.monitor.list', { limit: PAGE_MAX });
    const observationsAfter = await rpc<{ observations: unknown[] }>(
      'rc.periph.observations.list',
      { device_id: device!.id, limit: 10 },
    );
    const jobsAfter = await cronList();

    expect(devicesAfter.devices.some((row) => row.id === device!.id)).toBe(false);
    expect(monitorsAfter.items.some((row) => row.id === before.monitor.id)).toBe(false);
    expect(observationsAfter.observations).toEqual([]);
    expect(jobsAfter.jobs.some((job) => job.id === before.job.id)).toBe(false);

    ev(
      `I3 device=${device!.id} monitor=${before.monitor.id} cron=${before.job.id} ` +
        'deviceGone=true monitorGone=true observations=0 cronGone=true',
    );
  }, 120_000);
});

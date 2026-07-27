#!/usr/bin/env node
/**
 * F7 三路投递实测 —— "notify=true 告警推送 / 正常轮不打扰 / notify=false 不推送"。
 *
 * f7-live.sh 验的是**目标解析**(job 上有没有一个 OpenClaw 真能解析的投递目标)。
 * 那一层通过之后仍然有一个没验的问题:消息到底有没有真的发出去、该静音的轮次是不是
 * 真的静音了。本脚本补的就是这一段,用真 gateway + 真 cron 运行 + 独立 IRC 旁听端。
 *
 * 判据分两层,缺一不可:
 *   1) gateway 自述:cron.runs 的 delivered / deliveryStatus
 *   2) 第三方观测:IRC 旁听端日志里有没有出现本轮的唯一 token
 * 只看 (1) 等于让被测系统给自己打分;只看 (2) 分不清"没发"和"发了但没到"。
 *
 * 四条路由:
 *   R1 alert      非空正文 + announce 投递  → 必须送达
 *   R2 empty      空正文   + announce 投递  → RC 设备提示词第 8 步的字面契约("必须留空")
 *   R3 no_reply   NO_REPLY + announce 投递  → OC 官方静音语义(normalizeSilentReplyText)
 *   R4 notify_off 非空正文 + mode:none      → 关推送时,即使有正文也不能出现在渠道
 * R2/R3 并列跑是刻意的:两者都"应该"静音,但只有实测能说明 RC 的提示词该写哪一种。
 *
 * 环境变量:
 *   F7_GW_URL / F7_GW_TOKEN   gateway 地址与令牌
 *   F7_IRC_CHANNEL            投递目标频道(默认 #rc-f7)
 *   F7_REPLY_FILE             假模型的回复文件(默认 /tmp/rc-f7-fake-reply.txt)
 *   F7_IRC_LOG                旁听端日志(默认 /tmp/rc-f7-irc-observed.log)
 *
 * 退出码:0 全部通过;1 有路由未通过。
 */

import fs from "node:fs";

const GW_URL = process.env.F7_GW_URL ?? "ws://127.0.0.1:28802";
const GW_TOKEN = process.env.F7_GW_TOKEN ?? "research-claw";
const CHANNEL = process.env.F7_IRC_CHANNEL ?? "#rc-f7";
const REPLY_FILE = process.env.F7_REPLY_FILE ?? "/tmp/rc-f7-fake-reply.txt";
const IRC_LOG = process.env.F7_IRC_LOG ?? "/tmp/rc-f7-irc-observed.log";

const { callGatewayFromCli } = await import("openclaw/plugin-sdk/gateway-runtime");

const rpc = (method, params) =>
  callGatewayFromCli(method, { url: GW_URL, token: GW_TOKEN, timeout: "120000" }, params);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readObserved = () => {
  try {
    return fs.readFileSync(IRC_LOG, "utf8");
  } catch {
    return "";
  }
};

const ANNOUNCE = {
  mode: "announce",
  channel: "irc",
  accountId: "default",
  to: CHANNEL,
  bestEffort: true,
};

/**
 * 每条路由:写回复文件 → 建 job → 强制跑一轮 → 取 run 记录 → 取旁听增量。
 * schedule 用一个不会自然触发的表达式,保证这轮运行只可能来自 cron.run force。
 */
async function runRoute({ tag, reply, delivery }) {
  fs.writeFileSync(REPLY_FILE, reply);
  const observedBefore = readObserved().length;

  const job = await rpc("cron.add", {
    name: `[f7-route] ${tag}`,
    schedule: { kind: "cron", expr: "0 4 1 1 *" },
    sessionTarget: "isolated",
    wakeMode: "always",
    payload: { kind: "agentTurn", message: `f7 route ${tag}` },
    ...(delivery ? { delivery } : {}),
  });
  const jobId = job?.id;
  if (!jobId) throw new Error(`${tag}: cron.add 未返回 job id`);

  await rpc("cron.run", { id: jobId, mode: "force" });

  // run 记录是异步落盘的,轮询到 action=finished 为止。
  let record = null;
  for (let i = 0; i < 120; i++) {
    await sleep(1000);
    const runs = await rpc("cron.runs", { scope: "job", id: jobId, limit: 5 });
    const entries = runs?.runs ?? runs?.entries ?? runs?.items ?? [];
    record = entries.find((e) => e.action === "finished") ?? null;
    if (record) break;
  }
  if (!record) throw new Error(`${tag}: 120s 内没有等到 run 记录`);

  // 投递是 fire-and-forget,run 记录落盘后再给 IRC 一点时间。
  await sleep(4000);
  const observedDelta = readObserved().slice(observedBefore);

  return { tag, jobId, record, observedDelta };
}

const TOKEN_ALERT = "F7-ROUTE-ALERT-4471";
const TOKEN_SILENT = "F7-ROUTE-NOTIFYOFF-8823";

const ROUTES = [
  { tag: "R1_alert", reply: `实验台出现异常 ${TOKEN_ALERT}`, delivery: ANNOUNCE, expectDelivered: true, token: TOKEN_ALERT },
  { tag: "R2_empty", reply: "", delivery: ANNOUNCE, expectDelivered: false, token: null },
  { tag: "R3_no_reply", reply: "NO_REPLY", delivery: ANNOUNCE, expectDelivered: false, token: null },
  { tag: "R4_notify_off", reply: `一切正常 ${TOKEN_SILENT}`, delivery: { mode: "none" }, expectDelivered: false, token: TOKEN_SILENT },
];

let failed = 0;
for (const route of ROUTES) {
  let result;
  try {
    result = await runRoute(route);
  } catch (err) {
    console.log(`[F7-ROUTE] ${route.tag} 未通过 —— ${err.message}`);
    failed++;
    continue;
  }

  const { record, observedDelta, jobId } = result;
  const delivered = record.delivered === true;
  const hitChannel = route.token ? observedDelta.includes(route.token) : false;
  // token 为 null 的静音路由:频道里出现**任何**新消息都算漏音。
  const anyChannelTraffic = observedDelta.trim().length > 0;

  console.log(
    `[F7-ROUTE] ${route.tag} job=${jobId} status=${record.status} delivered=${record.delivered} `
    + `deliveryStatus=${record.deliveryStatus ?? "-"} deliveryError=${JSON.stringify(record.deliveryError ?? null)} `
    + `summary=${JSON.stringify((record.summary ?? "").slice(0, 120))} `
    + `ircDelta=${JSON.stringify(observedDelta.trim().slice(0, 200))}`,
  );

  const problems = [];
  if (delivered !== route.expectDelivered) {
    problems.push(`delivered 期望 ${route.expectDelivered} 实得 ${record.delivered}`);
  }
  if (route.expectDelivered) {
    if (!hitChannel) problems.push(`IRC 频道未收到 token ${route.token}`);
  } else if (anyChannelTraffic) {
    problems.push(`静音路由却在 IRC 频道产生了消息: ${observedDelta.trim().slice(0, 200)}`);
  }

  if (problems.length > 0) {
    console.log(`[F7-ROUTE] ${route.tag} 未通过 —— ${problems.join("; ")}`);
    failed++;
  } else {
    console.log(`[F7-ROUTE] ${route.tag} 通过`);
  }
}

console.log(failed === 0 ? "[F7-ROUTE] 全部通过" : `[F7-ROUTE] ${failed} 条路由未通过`);
process.exit(failed === 0 ? 0 : 1);

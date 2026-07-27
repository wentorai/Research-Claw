#!/usr/bin/env node
/**
 * 场景 A 真机验收驱动 —— "设备定时查证" 的提示词身份与旧行迁移。
 *
 * 分工:投递腿(告警真到达 / 静音真静音)已由 f7-delivery-routes 实测,目标解析
 * 已由 f7-live 实测。本驱动补的是这两者都没覆盖的一段:**真网关上下发给 agent 的
 * 提示词到底长什么样,以及历史遗留行在网关重启时会不会真被改写**。
 *
 * 单测能证明 repairLegacyDefaultPrompts() 的纯函数行为,但证明不了:
 *   - 插件在真网关启动序列里确实调到了它(index.ts:1088 那一行是否真跑)
 *   - 真 SQLite 上的旧行(v1 / v2 两种历史形态)会不会被真的改写回来
 * 这两点只有"写坏一行 → 重启真网关 → 再读"能证明。
 *
 * 三个阶段由 periph-scenario-a.sh 串起来(中间要停/起网关,不能塞进一个进程):
 *   phase1  真网关上建设备 + 建 device monitor,断言落库提示词是当前模板(NO_REPLY)
 *   seed    停机后直接改 SQLite,把两行分别写成 v1 / v2 历史形态
 *   phase2  重启后断言两行都被改写回 NO_REPLY,且网关日志有 repaired 记录
 *
 * 退出码:0 通过;1 未通过。
 */

import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

const PHASE = process.argv[2];
const GW_URL = process.env.SA_GW_URL ?? "ws://127.0.0.1:28803";
const GW_TOKEN = process.env.SA_GW_TOKEN ?? "research-claw";
const DB_PATH = process.env.SA_DB_PATH ?? "/tmp/rc-sa-state/library.db";
const HANDOFF = process.env.SA_HANDOFF ?? "/tmp/rc-sa-handoff.json";
const GW_LOG = process.env.SA_GW_LOG ?? "/tmp/rc-sa-gateway.log";

const TAG = "rc-scenario-a";
const ev = (...p) => console.log("[SCEN-A]", ...p);

let failed = 0;
function check(ok, label, detail = "") {
  if (ok) {
    ev(`✓ ${label}${detail ? " — " + detail : ""}`);
  } else {
    ev(`✗ ${label}${detail ? " — " + detail : ""}`);
    failed++;
  }
}

async function rpc(method, params) {
  const { callGatewayFromCli } = await import("openclaw/plugin-sdk/gateway-runtime");
  return callGatewayFromCli(method, { url: GW_URL, token: GW_TOKEN, timeout: "60000" }, params ?? {});
}

/**
 * v1 历史形态 —— 逐字取自 git HEAD 的 defaultAgentPrompt('device') 分支
 * (extensions/research-claw-core/src/monitor/service.ts,commit b9deba9 时的样子)。
 * 不是照着描述重写的近似品:第 5 步 "monitor_report 上报本轮结果(title=" 正是
 * isLegacyDeviceAgentPrompt 的 v1 判据,写错一个字这条用例就失去意义。
 */
function v1Prompt(target, checkPrompt) {
  return (
    "你是外设定时查证代理。目标设备 ID: " + target + "。\n" +
    '1. 调用 periph_camera_snap({"device_id": "' + target + '", "purpose": "scheduled check"}) 抓取当前帧。\n' +
    "2. 若抓帧失败(missed/error):调用 periph_observe 记录 kind='check'、verdict='missed'、summary=失败原因,然后 monitor_report 上报空结果,结束。\n" +
    '3. 若抓帧成功:根据下方"查证要求"分析画面(若你无法直接看到图像,调用 image 工具读取 frame_path 获取画面描述后再分析)。\n' +
    "4. 调用 periph_observe 记录 kind='check':一切正常 verdict='ok';发现异常 verdict='alert';无法判断 verdict='unverified'。summary 用一句话中文写明结论,frame_path 传抓到的帧。\n" +
    "5. monitor_report 上报本轮结果(title=结论一句话)。\n" +
    "6. 仅当 verdict='alert' 时调用 send_notification 通知用户,内容含设备名与异常描述。\n" +
    "查证要求: " + (checkPrompt || '描述画面中正在发生什么,判断是否存在异常。')
  );
}

/**
 * v2 历史形态 —— 与 v1 的差别只在第 8 步:v2 已经用上了正确的 monitor_report
 * schema,所以 v1 的判据抓不到它。它的病在于让 agent 用**空正文**表示静音,而
 * OpenClaw 把空正文判成失败轮次(实测见 f7-delivery-routes 的 R2)。
 * 构造方式与 monitor.test.ts 的 v2 用例一致:拿当前模板换掉第 8 步。
 */
function toV2(currentPrompt) {
  return currentPrompt.replace(
    /8\..*?\n/s,
    "8. 最终回复(本轮最后一条消息的正文)决定是否推送到通知渠道——只有非空正文会被推送。" +
    "**仅当本轮 verdict='alert' 时**,输出一句简短中文异常说明作为最终回复;" +
    "其余情况(ok/unverified/missed)最终回复**必须留空**,不要输出任何总结、确认或客套话。\n",
  );
}

// ── phase1:真网关上建设备 + 建 monitor,断言下发的是当前模板 ──────────────────
async function phase1() {
  // 幂等:先清掉上一次跑测留下的同名对象
  const devs = await rpc("rc.periph.devices.list", {});
  for (const d of devs.devices ?? []) {
    if (d.name?.includes(TAG)) { try { await rpc("rc.periph.devices.delete", { id: d.id }); } catch { /* 可能已不在 */ } }
  }
  const mons = await rpc("rc.monitor.list", { limit: 100 });
  for (const m of mons.items ?? []) {
    if (m.name?.includes(TAG)) { try { await rpc("rc.monitor.delete", { id: m.id }); } catch { /* 同上 */ } }
  }

  const cam = await rpc("rc.periph.devices.create", {
    name: `${TAG} camera`, kind: "camera", driver: "browser-camera",
    check_prompt: "确认实验台上的加热套是否仍在运行。",
  });
  const rec = await rpc("rc.periph.devices.create", {
    name: `${TAG} recorder`, kind: "audio-recorder", driver: "mcp-plaud",
  });
  const camId = cam.device?.id, recId = rec.device?.id;
  check(Boolean(camId && recId), "两台设备在真网关上注册成功", `camera=${camId} recorder=${recId}`);
  if (!camId || !recId) return;

  // filters.check_prompt 是 DeviceMonitors 创建表单真正写入的字段
  // (DeviceMonitors.tsx:144);设备行上的 check_prompt 是手动抓帧用的另一份默认值,
  // 两者刻意不共用 —— 这里按真实创建形态传 filters。
  const camMon = await rpc("rc.monitor.create", {
    name: `${TAG} 摄像头查证`, source_type: "device", target: camId,
    schedule: "0 3 * * *", notify: true, enabled: false,
    filters: { check_prompt: "确认实验台上的加热套是否仍在运行。" },
  });
  const recMon = await rpc("rc.monitor.create", {
    name: `${TAG} 录音日报`, source_type: "device", target: recId,
    schedule: "0 9 * * *", notify: true, enabled: false,
  });

  const camPrompt = String(camMon.agent_prompt ?? "");
  const recPrompt = String(recMon.agent_prompt ?? "");

  // A1:摄像头模板必须是当前版本 —— 静音语义用 NO_REPLY,不是空正文
  check(camPrompt.includes("你是外设定时查证代理"), "A1 摄像头 monitor 用 device 模板族");
  check(camPrompt.includes("必须且只能是 NO_REPLY"), "A1 第 8 步静音语义为 NO_REPLY");
  check(!camPrompt.includes("必须留空"), "A1 不再出现 v2 的空正文指令");
  check(camPrompt.includes("periph_camera_snap"), "A1 摄像头模板调 periph_camera_snap");
  // 落库的是**带占位符的模板**,由 dashboard 在发 cron payload 时替换
  // (stores/monitor.ts:529-532:{target}/{monitor_id}/{check_prompt …})。
  // 这三个占位符必须原样保留 —— 少一个,真机上 agent 拿到的就是字面量。
  // 替换后不残留占位符由 parity 用例覆盖(periph-monitor-message.parity.test.ts:128)。
  for (const ph of ["{target}", "{monitor_id}", "{check_prompt"]) {
    check(camPrompt.includes(ph), `A1 模板保留占位符 ${ph}`);
  }

  // A2:录音设备走另一支模板族(kind 决定),证明 periphDeviceKind 在真网关上生效。
  // 注意不能用 "不含 periph_camera_snap" 判定 —— plaud 模板里有一句显式禁令
  // "不要调用 periph_camera_snap(该设备不是摄像头)",按名字反查会误判。
  check(recPrompt.includes("你是录音笔定时汇总代理"), "A2 录音设备走 plaud 汇总模板族");
  check(recPrompt.includes("plaud__list_files"), "A2 录音模板调 plaud MCP 工具");
  check(!recPrompt.includes("你是外设定时查证代理"), "A2 录音设备不走摄像头模板");

  fs.writeFileSync(HANDOFF, JSON.stringify({ camId, recId, camMonId: camMon.id, recMonId: recMon.id }, null, 2));
  ev(`handoff → ${HANDOFF}`);
}

// ── seed:停机后把两行改写成历史形态 ─────────────────────────────────────────
function seed() {
  const h = JSON.parse(fs.readFileSync(HANDOFF, "utf8"));
  const db = new DatabaseSync(DB_PATH);
  const read = db.prepare("SELECT agent_prompt FROM rc_monitors WHERE id = ?");
  const write = db.prepare("UPDATE rc_monitors SET agent_prompt = ? WHERE id = ?");

  const camNow = read.get(h.camMonId)?.agent_prompt ?? "";
  const v2 = toV2(String(camNow));
  write.run(v2, h.camMonId);
  write.run(v1Prompt(h.recId, ""), h.recMonId);

  const camAfter = String(read.get(h.camMonId)?.agent_prompt ?? "");
  const recAfter = String(read.get(h.recMonId)?.agent_prompt ?? "");
  db.close();

  check(camAfter.includes("必须留空") && !camAfter.includes("NO_REPLY"), "seed 摄像头行已退回 v2 形态");
  check(recAfter.includes("monitor_report 上报本轮结果(title="), "seed 录音行已退回 v1 形态");
}

// ── phase2:重启后断言自愈真的发生了 ────────────────────────────────────────
async function phase2() {
  const h = JSON.parse(fs.readFileSync(HANDOFF, "utf8"));

  // 证据一:网关日志里插件自述改了几行(index.ts:1088-1090)
  let log = "";
  try { log = fs.readFileSync(GW_LOG, "utf8"); } catch { /* 没日志就只靠 DB 证据 */ }
  const m = /repaired (\d+) legacy default prompt\(s\)/.exec(log);
  check(Boolean(m), "A3 网关启动日志出现 monitor 提示词自愈记录", m ? `repaired=${m[1]}` : "未找到该行");
  if (m) check(Number(m[1]) >= 2, "A3 自愈条数覆盖两行", `repaired=${m[1]}`);

  // 证据二:从 RPC 读回来的真行内容(不看插件自述,看落库结果)
  const cam = await rpc("rc.monitor.get", { id: h.camMonId });
  const rec = await rpc("rc.monitor.get", { id: h.recMonId });
  const camPrompt = String(cam.agent_prompt ?? cam.monitor?.agent_prompt ?? "");
  const recPrompt = String(rec.agent_prompt ?? rec.monitor?.agent_prompt ?? "");

  check(camPrompt.includes("必须且只能是 NO_REPLY"), "A3 v2 行已迁到 NO_REPLY");
  check(!camPrompt.includes("必须留空"), "A3 v2 行不再残留空正文指令");
  check(camPrompt.includes("periph_camera_snap"), "A3 v2 行仍是摄像头模板(kind 未被弄丢)");

  check(!recPrompt.includes("monitor_report 上报本轮结果(title="), "A3 v1 行的错误 schema 行已消失");
  check(recPrompt.includes("你是录音笔定时汇总代理"), "A3 v1 行按 kind=audio-recorder 重生成,未误判成摄像头");
  check(recPrompt.includes("plaud__list_files"), "A3 重生成的录音模板仍调 plaud MCP 工具");
}

const run = { phase1, seed, phase2 }[PHASE];
if (!run) { console.error(`用法: periph-scenario-a.mjs <phase1|seed|phase2>`); process.exit(1); }
await run();
console.log(failed === 0 ? `[SCEN-A] ${PHASE} 全部通过` : `[SCEN-A] ${PHASE} ${failed} 项未通过`);
process.exit(failed === 0 ? 0 : 1);

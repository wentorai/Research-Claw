#!/usr/bin/env bash
#
# 场景 A 真机验收 harness —— 设备定时查证的提示词身份 + 旧行启动自愈
#
# 与另外两个 harness 的分工:
#   f7-live.sh             → job 上有 OpenClaw 真能解析的投递目标(preview=explicit)
#   f7-delivery-routes.sh  → 消息真发出去了 / 该静音的轮次真静音了(IRC 第三方旁听)
#   本脚本                  → 下发给 agent 的提示词是当前模板;历史遗留行在**真网关
#                            重启**时被真的改写回来(单测只能证明纯函数,证明不了
#                            index.ts 的启动序列真调到了它、真 SQLite 真被改写)
#
# 不需要 docker、不需要模型服务:全程只有 RPC 与网关重启,没有 agent turn。
# 隔离性同前两者:独立端口 / 独立 STATE_DIR / 独立 SQLite / 现生成的无凭据配置,
# 全程不碰 ~/.openclaw、不碰 ~/.research-claw、不碰用户 28789 上的开发网关。
#
# 用法:
#   ./scripts/periph-scenario-a.sh
#   RC_SA_KEEP=1 ./scripts/periph-scenario-a.sh   # 跑完保留网关便于排查
#
# 退出码:0 通过 / 1 未通过 / 2 外部条件阻塞
#
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

GW_PORT="${RC_SA_GW_PORT:-28803}"
STATE_DIR="${RC_SA_STATE_DIR:-/tmp/rc-sa-state}"
CONF_DIR="${RC_SA_CONF_DIR:-/tmp/rc-sa-config}"
CONF="$CONF_DIR/openclaw.json"
DB_PATH="$STATE_DIR/library.db"
LOG="${RC_SA_LOG:-/tmp/rc-sa.log}"
GW_LOG="${RC_SA_GW_LOG:-/tmp/rc-sa-gateway.log}"
HANDOFF="${RC_SA_HANDOFF:-/tmp/rc-sa-handoff.json}"

GW_PID=""

cleanup() {
  local rc=$?
  if [ "${RC_SA_KEEP:-}" != "1" ]; then
    [ -n "$GW_PID" ] && kill "$GW_PID" >/dev/null 2>&1
  else
    echo "RC_SA_KEEP=1 —— 保留 gateway(pid=$GW_PID, :$GW_PORT),状态目录 $STATE_DIR"
  fi
  return $rc
}
trap cleanup EXIT INT TERM

blocked() { echo "外部条件阻塞: $1" >&2; exit 2; }

echo "=== 场景 A:设备定时查证提示词 + 启动自愈真机验收 ===" | tee "$LOG"

command -v node >/dev/null 2>&1 || blocked "未找到 node"
if lsof -nP -iTCP:"$GW_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  blocked "端口 $GW_PORT 已被占用"
fi

# 每次跑测都从干净状态开始:自愈只在"有旧行"时才有观测意义,残留会污染计数
rm -rf "$STATE_DIR" "$CONF_DIR" "$HANDOFF"
mkdir -p "$CONF_DIR" "$STATE_DIR"

# ── 1. 隔离配置(无渠道、无模型服务:本场景不跑 agent turn)────────────────────
PROJECT_ROOT="$PROJECT_ROOT" STATE_DIR="$STATE_DIR" GW_PORT="$GW_PORT" CONF="$CONF" node -e '
const fs = require("node:fs");
const R = process.env.PROJECT_ROOT, S = process.env.STATE_DIR;
fs.writeFileSync(process.env.CONF, JSON.stringify({
  agents: { defaults: { workspace: `${R}/workspace`, skipBootstrap: true, sandbox: { mode: "off" } } },
  gateway: {
    port: Number(process.env.GW_PORT), mode: "local", bind: "loopback",
    auth: { mode: "none", token: "research-claw" },
  },
  cron: { enabled: true },
  plugins: {
    enabled: true,
    allow: ["research-claw-core"],
    load: { paths: [`${R}/extensions/research-claw-core`] },
    entries: { "research-claw-core": { enabled: true, config: { dbPath: `${S}/library.db` } } },
    bundledDiscovery: "compat",
  },
}, null, 2));
' || blocked "生成隔离配置失败"

export OPENCLAW_CONFIG_PATH="$CONF"
export OPENCLAW_STATE_DIR="$STATE_DIR"

node "$PROJECT_ROOT/node_modules/openclaw/dist/entry.js" config validate >>"$LOG" 2>&1 \
  || blocked "隔离配置未通过 openclaw config validate(见 $LOG)"

start_gateway() {
  : > "$GW_LOG"
  node "$PROJECT_ROOT/node_modules/openclaw/dist/entry.js" gateway run \
    --allow-unconfigured --auth token --port "$GW_PORT" --force >"$GW_LOG" 2>&1 &
  GW_PID=$!
  for _ in $(seq 1 60); do grep -q "ready" "$GW_LOG" 2>/dev/null && return 0; sleep 1; done
  return 1
}

stop_gateway() {
  [ -n "$GW_PID" ] || return 0
  kill "$GW_PID" >/dev/null 2>&1
  for _ in $(seq 1 20); do lsof -nP -iTCP:"$GW_PORT" -sTCP:LISTEN >/dev/null 2>&1 || return 0; sleep 1; done
  return 0
}

echo "--- 启动隔离 gateway(:$GW_PORT)---" | tee -a "$LOG"
start_gateway || { tail -30 "$GW_LOG" | tee -a "$LOG"; blocked "gateway 未能就绪"; }

# ── 2. 设备配对授权(等价于人在 dashboard 点"批准")───────────────────────────
# 首连的 CLI 设备只拿到 operator.read,而 rc.periph.* / rc.monitor.* 写操作需要写权限。
( cd "$PROJECT_ROOT" && GW_PORT="$GW_PORT" node --input-type=module -e '
const { callGatewayFromCli } = await import("openclaw/plugin-sdk/gateway-runtime");
try { await callGatewayFromCli("cron.list", { url: `ws://127.0.0.1:${process.env.GW_PORT}`, token: "research-claw", timeout: "30000" }, { limit: 1 }); } catch {}
' ) >/dev/null 2>&1 || true

STATE_DIR="$STATE_DIR" node -e '
const fs = require("node:fs"), S = process.env.STATE_DIR;
const FULL = ["operator.read", "operator.write", "operator.admin", "operator.approvals", "operator.pairing", "operator.talk.secrets"];
const patch = (p, fn) => { if (!fs.existsSync(p)) return false; const d = JSON.parse(fs.readFileSync(p, "utf8")); fn(d); fs.writeFileSync(p, JSON.stringify(d, null, 2)); return true; };
const paired = `${S}/devices/paired.json`;
if (!patch(paired, (d) => { for (const dev of Object.values(d)) { dev.scopes = FULL; dev.approvedScopes = FULL; for (const t of Object.values(dev.tokens ?? {})) t.scopes = FULL; } })) {
  console.error("设备配对表不存在:" + paired); process.exit(1);
}
patch(`${S}/identity/device-auth.json`, (d) => { for (const t of Object.values(d.tokens ?? {})) t.scopes = FULL; });
try { fs.writeFileSync(`${S}/devices/pending.json`, "{}"); } catch {}
const after = JSON.parse(fs.readFileSync(paired, "utf8"));
if (!Object.values(after).some((dev) => (dev.approvedScopes ?? []).includes("operator.admin"))) { console.error("授权补丁未生效"); process.exit(1); }
' || blocked "配对表授权失败"

stop_gateway
start_gateway || { tail -30 "$GW_LOG" | tee -a "$LOG"; blocked "gateway 重启后未能就绪"; }
echo "gateway 就绪(pid=$GW_PID)" | tee -a "$LOG"

# ── 3. phase1:建设备 + 建 monitor,断言提示词身份 ───────────────────────────
echo "--- phase1:提示词身份 ---" | tee -a "$LOG"
(
  cd "$PROJECT_ROOT" || exit 66
  SA_GW_URL="ws://127.0.0.1:$GW_PORT" SA_DB_PATH="$DB_PATH" SA_HANDOFF="$HANDOFF" SA_GW_LOG="$GW_LOG" \
    node "$SCRIPT_DIR/periph-scenario-a.mjs" phase1 2>&1
) | tee -a "$LOG"
[ "${PIPESTATUS[0]}" -eq 0 ] || { echo "  ✗ 场景 A: phase1 未通过" | tee -a "$LOG"; exit 1; }

# ── 4. seed:停机后把两行写回 v1 / v2 历史形态 ───────────────────────────────
echo "--- seed:注入历史形态旧行 ---" | tee -a "$LOG"
stop_gateway
(
  cd "$PROJECT_ROOT" || exit 66
  SA_DB_PATH="$DB_PATH" SA_HANDOFF="$HANDOFF" \
    node "$SCRIPT_DIR/periph-scenario-a.mjs" seed 2>&1
) | tee -a "$LOG"
[ "${PIPESTATUS[0]}" -eq 0 ] || { echo "  ✗ 场景 A: seed 未通过" | tee -a "$LOG"; exit 1; }

# ── 5. phase2:重启网关,断言自愈真的发生 ────────────────────────────────────
echo "--- phase2:重启后断言自愈 ---" | tee -a "$LOG"
start_gateway || { tail -30 "$GW_LOG" | tee -a "$LOG"; blocked "gateway 第三次启动未能就绪"; }
(
  cd "$PROJECT_ROOT" || exit 66
  SA_GW_URL="ws://127.0.0.1:$GW_PORT" SA_DB_PATH="$DB_PATH" SA_HANDOFF="$HANDOFF" SA_GW_LOG="$GW_LOG" \
    node "$SCRIPT_DIR/periph-scenario-a.mjs" phase2 2>&1
) | tee -a "$LOG"
RC=${PIPESTATUS[0]}

# ── 6. 硬校验:退出码 0 ≠ 断言真的跑过 ──────────────────────────────────────
for tag in "A1 第 8 步静音语义为 NO_REPLY" "A1 模板保留占位符 {target}" "A2 录音设备走 plaud 汇总模板族" "A3 v2 行已迁到 NO_REPLY" "A3 v1 行的错误 schema 行已消失"; do
  grep -q "✓ $tag" "$LOG" || {
    echo "  ✗ 场景 A: 缺少证据行「$tag」—— 判未通过" | tee -a "$LOG"; exit 1; }
done
if [ "$RC" -ne 0 ]; then
  echo "  ✗ 场景 A: phase2 有断言未通过(exit=$RC)" | tee -a "$LOG"; exit 1
fi

echo "" | tee -a "$LOG"
echo "  ✓ 场景 A: 通过(真网关提示词身份 + v1/v2 旧行启动自愈,双证据:网关日志 + 落库内容)" | tee -a "$LOG"
echo "证据日志: $LOG" | tee -a "$LOG"
exit 0

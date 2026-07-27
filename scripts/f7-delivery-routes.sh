#!/usr/bin/env bash
#
# F7 三路投递真机验收 harness(SPEC §13 F7 的第二段)
#
# f7-live.sh 证明的是"job 上有 OpenClaw 真能解析的投递目标";本脚本证明的是
# "消息真的发出去了 / 该静音的轮次真的静音了"。两段合起来才是 F7 的完整验收。
#
# 组成:
#   - 本地 ergo IRC(可投递渠道,离线、无凭据、无外部账号)
#   - 本地假模型 scripts/f7-fake-model.mjs(回复内容由文件决定,确定性、零成本)
#   - 独立 IRC 旁听端 scripts/f7-irc-observer.mjs(第三方证据,不信 gateway 自述)
#   - 隔离 gateway(独立端口 / 独立 STATE_DIR / 独立 SQLite / 现生成的无凭据配置)
#
# 隔离性同 f7-live.sh:全程不碰 ~/.openclaw、不碰 ~/.research-claw、不写任何真实凭据。
# 端口刻意与 f7-live.sh 错开,两个 harness 可以并存。
#
# 用法:
#   ./scripts/f7-delivery-routes.sh
#   RC_F7_KEEP=1 ./scripts/f7-delivery-routes.sh   # 跑完保留进程便于排查
#
# 退出码:0 通过 / 1 未通过 / 2 外部条件阻塞
#
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

GW_PORT="${RC_F7R_GW_PORT:-28802}"
IRC_PORT="${RC_F7R_IRC_PORT:-16668}"
MODEL_PORT="${RC_F7R_MODEL_PORT:-18902}"
IRC_NAME="${RC_F7R_IRC_NAME:-rc-f7-routes-ircd}"
IRC_IMAGE="${RC_F7_IRC_IMAGE:-ghcr.io/ergochat/ergo:stable}"
IRC_CHANNEL="${RC_F7R_IRC_CHANNEL:-#rc-f7}"
STATE_DIR="${RC_F7R_STATE_DIR:-/tmp/rc-f7-routes-state}"
CONF_DIR="${RC_F7R_CONF_DIR:-/tmp/rc-f7-routes-config}"
CONF="$CONF_DIR/openclaw.json"
LOG="${RC_F7R_LOG:-/tmp/rc-f7-routes.log}"
GW_LOG="${RC_F7R_GW_LOG:-/tmp/rc-f7-routes-gateway.log}"
REPLY_FILE="${RC_F7R_REPLY_FILE:-/tmp/rc-f7-routes-reply.txt}"
IRC_OBS_LOG="${RC_F7R_IRC_OBS_LOG:-/tmp/rc-f7-routes-irc-observed.log}"
MODEL_LOG="${RC_F7R_MODEL_LOG:-/tmp/rc-f7-routes-model.log}"
DOCKER_BIN="${RC_DOCKER_PATH:-$(command -v docker || true)}"

GW_PID=""
MODEL_PID=""
OBS_PID=""

cleanup() {
  local rc=$?
  if [ "${RC_F7_KEEP:-}" != "1" ]; then
    [ -n "$OBS_PID" ] && kill "$OBS_PID" >/dev/null 2>&1
    [ -n "$MODEL_PID" ] && kill "$MODEL_PID" >/dev/null 2>&1
    [ -n "$GW_PID" ] && kill "$GW_PID" >/dev/null 2>&1
    [ -n "$DOCKER_BIN" ] && "$DOCKER_BIN" rm -f "$IRC_NAME" >/dev/null 2>&1
  else
    echo "RC_F7_KEEP=1 —— 保留 gateway(pid=$GW_PID, :$GW_PORT)/假模型(pid=$MODEL_PID)/旁听端(pid=$OBS_PID)/容器 $IRC_NAME"
  fi
  return $rc
}
trap cleanup EXIT INT TERM

blocked() { echo "外部条件阻塞: $1" >&2; exit 2; }

echo "=== F7 三路投递真机验收 ===" | tee "$LOG"

# ── 前置条件 ────────────────────────────────────────────────────────────────
[ -n "$DOCKER_BIN" ] || blocked "未找到 docker"
"$DOCKER_BIN" info >/dev/null 2>&1 || blocked "docker 守护进程未运行"
command -v node >/dev/null 2>&1 || blocked "未找到 node"
for p in "$GW_PORT" "$MODEL_PORT"; do
  if lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then
    blocked "端口 $p 已被占用"
  fi
done

# ── 1. 本地 IRC ─────────────────────────────────────────────────────────────
echo "--- 启动本地 IRC(:$IRC_PORT)---" | tee -a "$LOG"
"$DOCKER_BIN" rm -f "$IRC_NAME" >/dev/null 2>&1
"$DOCKER_BIN" run -d --name "$IRC_NAME" -p "$IRC_PORT":6667 "$IRC_IMAGE" >>"$LOG" 2>&1 \
  || blocked "无法启动 IRC 容器 $IRC_IMAGE"
for _ in $(seq 1 30); do nc -z 127.0.0.1 "$IRC_PORT" >/dev/null 2>&1 && break; sleep 1; done
nc -z 127.0.0.1 "$IRC_PORT" >/dev/null 2>&1 || blocked "IRC 端口 $IRC_PORT 未就绪"

# ── 2. 假模型 ───────────────────────────────────────────────────────────────
echo "--- 启动假模型(:$MODEL_PORT)---" | tee -a "$LOG"
: > "$REPLY_FILE"
: > "$MODEL_LOG"
FAKE_MODEL_PORT="$MODEL_PORT" FAKE_MODEL_REPLY_FILE="$REPLY_FILE" FAKE_MODEL_LOG_FILE="$MODEL_LOG" \
  node "$SCRIPT_DIR/f7-fake-model.mjs" >>"$LOG" 2>&1 &
MODEL_PID=$!
for _ in $(seq 1 20); do nc -z 127.0.0.1 "$MODEL_PORT" >/dev/null 2>&1 && break; sleep 1; done
nc -z 127.0.0.1 "$MODEL_PORT" >/dev/null 2>&1 || blocked "假模型端口 $MODEL_PORT 未就绪"

# ── 3. 隔离配置(无任何真实凭据)────────────────────────────────────────────
mkdir -p "$CONF_DIR" "$STATE_DIR"
PROJECT_ROOT="$PROJECT_ROOT" STATE_DIR="$STATE_DIR" GW_PORT="$GW_PORT" MODEL_PORT="$MODEL_PORT" \
IRC_PORT="$IRC_PORT" IRC_CHANNEL="$IRC_CHANNEL" CONF="$CONF" node -e '
const fs = require("node:fs");
const R = process.env.PROJECT_ROOT, S = process.env.STATE_DIR;
fs.writeFileSync(process.env.CONF, JSON.stringify({
  agents: { defaults: {
    workspace: `${R}/workspace`, skipBootstrap: true, sandbox: { mode: "off" },
    model: "f7fake/fake-echo",
  } },
  models: { providers: { f7fake: {
    baseUrl: `http://127.0.0.1:${process.env.MODEL_PORT}/v1`,
    apiKey: "fake-local-no-auth",
    api: "openai-completions",
    models: [{
      id: "fake-echo", name: "F7 Fake Echo", reasoning: false, input: ["text"],
      contextWindow: 128000, maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }],
  } } },
  gateway: {
    port: Number(process.env.GW_PORT), mode: "local", bind: "loopback",
    auth: { mode: "none", token: "research-claw" },
  },
  cron: { enabled: true },
  channels: {
    irc: {
      enabled: true, host: "127.0.0.1", port: Number(process.env.IRC_PORT), tls: false,
      nick: "rcbot", username: "rcbot", realname: "Research Claw F7 routes",
      channels: [process.env.IRC_CHANNEL],
      dmPolicy: "pairing", groupPolicy: "allowlist",
      groups: { [process.env.IRC_CHANNEL]: { requireMention: false } },
    },
  },
  plugins: {
    enabled: true,
    allow: ["research-claw-core", "irc"],
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

echo "--- 启动隔离 gateway(:$GW_PORT)---" | tee -a "$LOG"
start_gateway || { tail -30 "$GW_LOG" | tee -a "$LOG"; blocked "gateway 未能就绪"; }

# ── 4. 设备身份配对(等价于人在 dashboard 点"批准")─────────────────────────
# cron.add / cron.run 需要写权限;agentTurn 还需要 operator.write 与 talk.secrets。
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

kill "$GW_PID" >/dev/null 2>&1
for _ in $(seq 1 20); do lsof -nP -iTCP:"$GW_PORT" -sTCP:LISTEN >/dev/null 2>&1 || break; sleep 1; done
start_gateway || { tail -30 "$GW_LOG" | tee -a "$LOG"; blocked "gateway 重启后未能就绪"; }
echo "gateway 就绪(pid=$GW_PID)" | tee -a "$LOG"
grep -E "agent model|irc" "$GW_LOG" | tail -5 | tee -a "$LOG"

# ── 5. IRC 旁听端 ───────────────────────────────────────────────────────────
echo "--- 启动 IRC 旁听端 ---" | tee -a "$LOG"
F7_IRC_PORT="$IRC_PORT" F7_IRC_CHANNEL="$IRC_CHANNEL" F7_IRC_LOG="$IRC_OBS_LOG" \
  node "$SCRIPT_DIR/f7-irc-observer.mjs" >>"$LOG" 2>&1 &
OBS_PID=$!
for _ in $(seq 1 20); do grep -q "READY" "$LOG" 2>/dev/null && break; sleep 1; done
grep -q "READY" "$LOG" 2>/dev/null || blocked "IRC 旁听端未能加入 $IRC_CHANNEL"
echo "旁听端已加入 $IRC_CHANNEL" | tee -a "$LOG"

# ── 6. 四条路由 ─────────────────────────────────────────────────────────────
echo "--- 执行投递路由 ---" | tee -a "$LOG"
(
  cd "$PROJECT_ROOT" || exit 66
  F7_GW_URL="ws://127.0.0.1:$GW_PORT" F7_GW_TOKEN="research-claw" \
  F7_IRC_CHANNEL="$IRC_CHANNEL" F7_REPLY_FILE="$REPLY_FILE" F7_IRC_LOG="$IRC_OBS_LOG" \
  node "$SCRIPT_DIR/f7-delivery-routes.mjs" 2>&1
) | tee -a "$LOG"
RC=${PIPESTATUS[0]}

# ── 7. 硬校验:退出码 0 ≠ 路由真的跑过 ──────────────────────────────────────
for tag in R1_alert R2_empty R3_no_reply R4_notify_off; do
  grep -q "\[F7-ROUTE\] $tag job=" "$LOG" || {
    echo "  ✗ F7-ROUTE: 缺少 $tag 证据行 —— 判未通过" | tee -a "$LOG"; exit 1; }
done
if [ "$RC" -ne 0 ]; then
  echo "  ✗ F7-ROUTE: 有路由未通过(exit=$RC)" | tee -a "$LOG"; exit 1
fi

echo "" | tee -a "$LOG"
echo "  ✓ F7-ROUTE: 四条路由全部通过(gateway 自述 + IRC 第三方观测双证据)" | tee -a "$LOG"
echo "证据日志: $LOG" | tee -a "$LOG"
echo "旁听端日志: $IRC_OBS_LOG" | tee -a "$LOG"
exit 0

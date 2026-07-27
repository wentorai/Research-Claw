#!/usr/bin/env bash
#
# F7 真机验收 harness(SPEC §13 F7)—— cron 投递目标解析
#
# 验的是什么:notify=true 的 monitor 注册的 cron job,OpenClaw 必须能真正解析出
# 一个投递目标。缺陷形态是 delivery.channel='last' —— 隔离 cron 会话没有历史出站
# 渠道,gateway 的投递预览会显示 "last -> no route, will fail-closed",告警永远
# 发不出去。纯函数单测证明不了这一点,只有真 gateway 算出来的 deliveryPreviews
# 变成 "explicit" 才算数。
#
# 为什么用本地 IRC:验证"渠道绑定 → 显式投递目标"这条链路不需要真实社交账号。
# 本脚本拉一个本地 ergo IRC 服务端当可投递渠道,全程离线、无凭据、无外部账号。
# 真实微信/Telegram 送达属于另一层(账号可用性),不在本脚本范围。
#
# 隔离性(重要):本脚本**不碰**你的真实环境 ——
#   - 独立端口 28799(不是 RC 常规的 28789)
#   - 独立 OPENCLAW_STATE_DIR=/tmp/rc-f7-state(不写 ~/.openclaw 的 cron/设备表)
#   - 独立 SQLite /tmp/rc-f7-state/library.db(不写 ~/.research-claw/library.db)
#   - 自动生成的最小配置,**不含任何 API key / 凭据**(用例不跑 agent turn)
# 这条隔离是硬要求:monitor store 的 reconcile 会遍历**所有** monitor,若共用
# 真实状态目录,会把你真实的 cron job 重指向这个临时 IRC 渠道。
#
# 用法:
#   ./scripts/f7-live.sh              # 全自动:起 IRC + 起 gateway + 跑用例 + 清理
#   RC_F7_KEEP=1 ./scripts/f7-live.sh # 跑完保留 gateway/容器,便于手工排查
#
# 产物:/tmp/rc-f7-live.log(完整终端输出,可直接贴进证据包)
#
# 退出码:
#   0  通过
#   1  未通过(用例失败,或"零个用例真正执行")
#   2  外部条件阻塞(docker 不可用 / 端口被占 / IRC 起不来 / gateway 起不来)
#
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

GW_PORT="${RC_F7_GW_PORT:-28799}"
IRC_PORT="${RC_F7_IRC_PORT:-16667}"
IRC_NAME="${RC_F7_IRC_NAME:-rc-f7-ircd}"
IRC_IMAGE="${RC_F7_IRC_IMAGE:-ghcr.io/ergochat/ergo:stable}"
IRC_CHANNEL="${RC_F7_IRC_CHANNEL:-#rc-f7}"
STATE_DIR="${RC_F7_STATE_DIR:-/tmp/rc-f7-state}"
CONF_DIR="${RC_F7_CONF_DIR:-/tmp/rc-f7-config}"
CONF="$CONF_DIR/openclaw.json"
LOG="${RC_F7_LOG:-/tmp/rc-f7-live.log}"
GW_LOG="${RC_F7_GW_LOG:-/tmp/rc-f7-gateway.log}"
DOCKER_BIN="${RC_DOCKER_PATH:-$(command -v docker || true)}"

GW_PID=""

cleanup() {
  local rc=$?
  if [ "${RC_F7_KEEP:-}" != "1" ]; then
    [ -n "$GW_PID" ] && kill "$GW_PID" >/dev/null 2>&1
    [ -n "$DOCKER_BIN" ] && "$DOCKER_BIN" rm -f "$IRC_NAME" >/dev/null 2>&1
  else
    echo "RC_F7_KEEP=1 —— 保留 gateway(pid=$GW_PID, :$GW_PORT)与容器 $IRC_NAME"
  fi
  return $rc
}
trap cleanup EXIT INT TERM

blocked() { echo "外部条件阻塞: $1" >&2; exit 2; }

echo "=== F7 真机验收(cron 投递目标解析)===" | tee "$LOG"
echo "项目根: $PROJECT_ROOT" | tee -a "$LOG"

# ── 前置条件 ────────────────────────────────────────────────────────────────
[ -n "$DOCKER_BIN" ] || blocked "未找到 docker(本地 IRC 渠道需要容器)"
"$DOCKER_BIN" info >/dev/null 2>&1 || blocked "docker 守护进程未运行"
command -v node >/dev/null 2>&1 || blocked "未找到 node"

# 端口占用:gateway 端口被占会静默连到别人的 gateway 上,必须硬拦。
if lsof -nP -iTCP:"$GW_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  blocked "端口 $GW_PORT 已被占用(可能是另一个 gateway),请释放或设置 RC_F7_GW_PORT"
fi

# ── 1. 本地 IRC 服务端 ──────────────────────────────────────────────────────
echo "--- 启动本地 IRC($IRC_IMAGE :$IRC_PORT)---" | tee -a "$LOG"
"$DOCKER_BIN" rm -f "$IRC_NAME" >/dev/null 2>&1
"$DOCKER_BIN" run -d --name "$IRC_NAME" -p "$IRC_PORT":6667 "$IRC_IMAGE" >>"$LOG" 2>&1 \
  || blocked "无法启动 IRC 容器 $IRC_IMAGE(网络/镜像源)"
for _ in $(seq 1 30); do
  nc -z 127.0.0.1 "$IRC_PORT" >/dev/null 2>&1 && break
  sleep 1
done
nc -z 127.0.0.1 "$IRC_PORT" >/dev/null 2>&1 || blocked "IRC 端口 $IRC_PORT 未就绪"
echo "IRC 就绪: 127.0.0.1:$IRC_PORT" | tee -a "$LOG"

# ── 2. 隔离配置(现生成,不含任何凭据)──────────────────────────────────────
# 刻意不复制 config/openclaw.json:那份带真实 API key,复制过来既会把凭据写进
# /tmp,也会让"隔离"名存实亡。用例不跑 agent turn,所以不需要任何模型凭据。
mkdir -p "$CONF_DIR" "$STATE_DIR"
PROJECT_ROOT="$PROJECT_ROOT" STATE_DIR="$STATE_DIR" GW_PORT="$GW_PORT" \
IRC_PORT="$IRC_PORT" IRC_CHANNEL="$IRC_CHANNEL" CONF="$CONF" node -e '
const fs = require("node:fs");
const R = process.env.PROJECT_ROOT, S = process.env.STATE_DIR;
fs.writeFileSync(process.env.CONF, JSON.stringify({
  agents: { defaults: { workspace: `${R}/workspace`, skipBootstrap: true, sandbox: { mode: "off" } } },
  gateway: {
    port: Number(process.env.GW_PORT), mode: "local", bind: "loopback",
    auth: { mode: "none", token: "research-claw" },
  },
  cron: { enabled: true },
  channels: {
    irc: {
      enabled: true, host: "127.0.0.1", port: Number(process.env.IRC_PORT), tls: false,
      nick: "rcbot", username: "rcbot", realname: "Research Claw F7 probe",
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
echo "隔离配置已生成并通过校验: $CONF" | tee -a "$LOG"

# ── 3. 隔离 gateway ─────────────────────────────────────────────────────────
echo "--- 启动隔离 gateway(:$GW_PORT, state=$STATE_DIR)---" | tee -a "$LOG"
: > "$GW_LOG"
node "$PROJECT_ROOT/node_modules/openclaw/dist/entry.js" gateway run \
  --allow-unconfigured --auth token --port "$GW_PORT" --force >"$GW_LOG" 2>&1 &
GW_PID=$!
for _ in $(seq 1 60); do
  grep -q "ready" "$GW_LOG" 2>/dev/null && break
  sleep 1
done
grep -q "ready" "$GW_LOG" 2>/dev/null || { tail -30 "$GW_LOG" | tee -a "$LOG"; blocked "gateway 未能就绪(见 $GW_LOG)"; }
grep -E "irc|Research-Claw Core registered" "$GW_LOG" | tail -3 | tee -a "$LOG"

# ── 4. 设备身份配对(等价于人在 dashboard 上点"批准")─────────────────────
# 首连时 CLI 设备只拿到 operator.read,而 cron.add / rc.monitor.* 需要写权限。
# 真实使用里这一步是人在 UI 上批准配对;无人值守场景下直接在**隔离**配对表里
# 授予完整 operator scope。只写 $STATE_DIR,不碰 ~/.openclaw。
# gateway-runtime 是 ESM-only 子路径导出,必须 import() 而不是 require();而且
# PROJECT_ROOT/GW_PORT 必须显式传进子进程 —— 早期版本两条都错,这一步静默失败
# 导致设备身份根本没建,后面的授权补丁 patch 到不存在的文件上也静默跳过,
# 最终 vitest 自己首连拿到 operator.read 并挂起一个 scope 升级请求,把整个套件卡死。
( cd "$PROJECT_ROOT" && GW_PORT="$GW_PORT" node --input-type=module -e '
const { callGatewayFromCli } = await import("openclaw/plugin-sdk/gateway-runtime");
try {
  await callGatewayFromCli("cron.list", { url: `ws://127.0.0.1:${process.env.GW_PORT}`, token: "research-claw", timeout: "30000" }, {});
} catch { /* 首连只要建立了设备身份就够了,拿不拿得到结果无所谓 */ }
' ) >/dev/null 2>&1 || true

STATE_DIR="$STATE_DIR" node -e '
const fs = require("node:fs"), S = process.env.STATE_DIR;
const FULL = ["operator.read", "operator.admin", "operator.approvals", "operator.pairing"];
const patch = (p, fn) => { if (!fs.existsSync(p)) return false; const d = JSON.parse(fs.readFileSync(p, "utf8")); fn(d); fs.writeFileSync(p, JSON.stringify(d, null, 2)); return true; };
const paired = `${S}/devices/paired.json`;
if (!patch(paired, (d) => { for (const dev of Object.values(d)) { dev.scopes = FULL; dev.approvedScopes = FULL; for (const t of Object.values(dev.tokens ?? {})) t.scopes = FULL; } })) {
  console.error("设备配对表不存在:" + paired);
  process.exit(1);
}
patch(`${S}/identity/device-auth.json`, (d) => { for (const t of Object.values(d.tokens ?? {})) t.scopes = FULL; });
// 挂起的 scope 升级请求会让之后每一次调用都被 1008 拒掉,必须一并清掉。
try { fs.writeFileSync(`${S}/devices/pending.json`, "{}"); } catch { /* 没有就算了 */ }

// 自校验:补丁必须真的落到盘上,否则后面所有失败都会被误读成产品缺陷。
const after = JSON.parse(fs.readFileSync(paired, "utf8"));
const ok = Object.values(after).some((dev) => (dev.approvedScopes ?? []).includes("operator.admin"));
if (!ok) { console.error("授权补丁未生效"); process.exit(1); }
' || blocked "配对表授权失败(见上一行)"

# 授权要在 gateway 重启后才生效(配对表在启动时读入内存)
kill "$GW_PID" >/dev/null 2>&1
for _ in $(seq 1 20); do lsof -nP -iTCP:"$GW_PORT" -sTCP:LISTEN >/dev/null 2>&1 || break; sleep 1; done
: > "$GW_LOG"
node "$PROJECT_ROOT/node_modules/openclaw/dist/entry.js" gateway run \
  --allow-unconfigured --auth token --port "$GW_PORT" --force >"$GW_LOG" 2>&1 &
GW_PID=$!
for _ in $(seq 1 60); do
  grep -q "ready" "$GW_LOG" 2>/dev/null && break
  sleep 1
done
grep -q "ready" "$GW_LOG" 2>/dev/null || { tail -30 "$GW_LOG" | tee -a "$LOG"; blocked "gateway 重启后未能就绪(见 $GW_LOG)"; }
echo "gateway 就绪(pid=$GW_PID)" | tee -a "$LOG"

# ── 5. 跑真机用例 ───────────────────────────────────────────────────────────
echo "--- 执行 live 用例 ---" | tee -a "$LOG"
(
  cd "$PROJECT_ROOT/dashboard" || exit 66
  RC_LIVE_WS_URL="ws://127.0.0.1:$GW_PORT" \
  RC_LIVE_WS_TOKEN="research-claw" \
  RC_LIVE_EXPECT_CHANNEL="irc" \
  RC_LIVE_EXPECT_ACCOUNT="default" \
  npx vitest run -c vitest.live.config.ts 2>&1
) | tee -a "$LOG"
RC=${PIPESTATUS[0]}

# ── 6. 硬校验:退出码 0 ≠ 用例真的跑过 ──────────────────────────────────────
# 实测过的坑:文件被 include 规则漏掉 / 整个 describe 被 skip,vitest 都会
# exit 0 且报 "Tests 0 passed"。所以退出码之外还要正向校验证据行。
if [ "$RC" -ne 0 ]; then
  echo "  ✗ F7: 用例失败(vitest exit=$RC)" | tee -a "$LOG"
  exit 1
fi
if grep -Eq '^[[:space:]]*Test Files[[:space:]]+[0-9]+ skipped' "$LOG"; then
  echo "  ✗ F7: 测试文件被 skip —— 判未通过" | tee -a "$LOG"; exit 1
fi
if ! grep -Eq 'Tests[[:space:]]+[1-9][0-9]* passed' "$LOG"; then
  echo "  ✗ F7: 零个用例真正执行 —— 判未通过" | tee -a "$LOG"; exit 1
fi
for tag in A B C D; do
  grep -q "\[F7-LIVE\] $tag " "$LOG" || {
    echo "  ✗ F7: 缺少 [F7-LIVE] $tag 证据行 —— 判未通过" | tee -a "$LOG"; exit 1; }
done
if grep -Eq 'no route|fail-closed' "$LOG"; then
  # 用例断言里带这两个词做否定匹配,只有出现在证据行(preview="...")里才算真失败
  if grep -E 'preview="' "$LOG" | grep -Eq 'no route|fail-closed'; then
    echo "  ✗ F7: 投递预览仍为 no route / fail-closed —— 判未通过" | tee -a "$LOG"; exit 1
  fi
fi

echo "" | tee -a "$LOG"
echo "  ✓ F7: 通过(证据行 + passed 计数 + 预览非 fail-closed 均已核验)" | tee -a "$LOG"
echo "证据日志: $LOG" | tee -a "$LOG"
exit 0

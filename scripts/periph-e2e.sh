#!/usr/bin/env bash
#
# 外设子系统三场景真实端到端验收 harness(SPEC §15 v1.3)
#
#   场景① IP 摄像头(RTSP)   : 工具 → PeriphService → SQLite → 真 JPEG 帧文件
#   场景② USB webcam         : 真实 ffmpeg 设备枚举 + local-camera driver 全链路
#   场景③ 浏览器播放(HLS)   : RTSP→ffmpeg transmux→真 http.Server→ffprobe 验真视频
#
# 一键跑法:
#   ./scripts/periph-e2e.sh            # 三场景全跑
#   ./scripts/periph-e2e.sh s1         # 只跑场景①(s1 / s2 / s3 可组合)
#   ./scripts/periph-e2e.sh s1 s3
#
# 产物(每场景一份完整终端输出,可直接贴进证据包):
#   /tmp/periph-e2e-s1.log
#   /tmp/periph-e2e-s2.log
#   /tmp/periph-e2e-s3.log
#
# 特性:
#   - 幂等:每次开跑前先 docker rm -f 掉同名残留容器,重复执行不会互相污染
#   - 无论成功/失败/Ctrl-C(trap EXIT INT TERM)都会清理 MediaMTX 容器
#   - 只读环境探测,不改任何仓库文件
#   - “通过”必须等于“真跑过”:每个场景跑完对日志做硬校验(证据行 + passed 计数
#     + 反向拦截整文件 skip),光靠 vitest 退出码 0 不算数
#
# 退出码:
#   0  全部场景通过
#   1  存在未通过的场景(含“零个用例真正执行”)
#   2  前置条件不满足(docker/ffmpeg/ffprobe/端口)—— 外部条件阻塞
#   3  无失败,但存在外部条件阻塞的场景(如场景② macOS TCC 未授权)
#
# 前置条件(缺任一 → 退出码 2,判定为“外部条件阻塞”,不是实现缺陷):
#   - docker 守护进程可用(拉起 bluenviron/mediamtx 作为 RTSP 源)
#   - ffmpeg / ffprobe 可执行
#   - 场景②需要 OS 摄像头授权(macOS TCC)。未授权时用例默认**失败**;确认确属
#     外部条件后,用 RC_PERIPH_E2E_ALLOW_BLOCKED=1 重跑,收敛为退出码 3。
#     该分支只接受 timeout 一个 token —— device-not-found / capture-failed /
#     ffmpeg-missing / unsupported-platform 都是实现缺陷,一律判失败,不许洗成阻塞。
#
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
TEST_FILE="extensions/research-claw-core/src/__tests__/periph-three-scenario-e2e.test.ts"

# ---- 可覆盖配置 -------------------------------------------------------------
FFMPEG_BIN="${RC_FFMPEG_PATH:-$(command -v ffmpeg || true)}"
FFPROBE_BIN="${RC_FFPROBE_PATH:-$(command -v ffprobe || true)}"
DOCKER_BIN="${RC_DOCKER_PATH:-$(command -v docker || true)}"
MTX_IMAGE="${RC_PERIPH_E2E_MTX_IMAGE:-bluenviron/mediamtx:latest}"
MTX_NAME="${RC_PERIPH_E2E_MTX_NAME:-rc-periph-e2e-mtx}"
RTSP_PORT="${RC_PERIPH_E2E_RTSP_PORT:-18554}"
LOG_PREFIX="${RC_PERIPH_E2E_LOG_PREFIX:-/tmp/periph-e2e-}"

# ---- 清理:成功/失败/中断都走这里 ------------------------------------------
cleanup() {
  local rc=$?
  if [ -n "$DOCKER_BIN" ]; then
    "$DOCKER_BIN" rm -f "$MTX_NAME" >/dev/null 2>&1 || true
  fi
  # 兜底:回收可能残留的推流 ffmpeg(容器已删,推流端会自然退出,这里只是保险)
  pkill -f "rtsp://.*:${RTSP_PORT}/e2e" >/dev/null 2>&1 || true
  return $rc
}
trap cleanup EXIT INT TERM

fail_precondition() {
  echo "外部条件阻塞: $1" >&2
  exit 2
}

echo "=== 外设三场景真实端到端验收 ==="
echo "项目根:   $PROJECT_ROOT"
echo "用例文件: $TEST_FILE"

# ---- 前置条件检查 -----------------------------------------------------------
[ -n "$DOCKER_BIN" ]  || fail_precondition "未找到 docker(RTSP 源需要 MediaMTX 容器)"
[ -n "$FFMPEG_BIN" ]  || fail_precondition "未找到 ffmpeg(设置 RC_FFMPEG_PATH 指定绝对路径)"
[ -n "$FFPROBE_BIN" ] || fail_precondition "未找到 ffprobe(设置 RC_FFPROBE_PATH 指定绝对路径)"
"$DOCKER_BIN" info >/dev/null 2>&1 || fail_precondition "docker 守护进程未运行"

echo "docker:   $DOCKER_BIN"
echo "ffmpeg:   $FFMPEG_BIN ($("$FFMPEG_BIN" -version 2>/dev/null | head -1))"
echo "ffprobe:  $FFPROBE_BIN"
echo "RTSP 端口: $RTSP_PORT   容器名: $MTX_NAME   镜像: $MTX_IMAGE"

# 先把镜像准备好,避免首跑时 docker pull 撞上用例内 30s 端口等待窗口
if ! "$DOCKER_BIN" image inspect "$MTX_IMAGE" >/dev/null 2>&1; then
  echo "本地无镜像,预拉取 $MTX_IMAGE ..."
  "$DOCKER_BIN" pull "$MTX_IMAGE" || fail_precondition "docker pull $MTX_IMAGE 失败(网络/镜像源)"
fi

# 幂等:清掉上一轮可能残留的同名容器
"$DOCKER_BIN" rm -f "$MTX_NAME" >/dev/null 2>&1 || true

# 端口占用检查(被别的进程占着会让用例假失败)
if lsof -nP -iTCP:"$RTSP_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  fail_precondition "端口 $RTSP_PORT 已被占用,请释放或设置 RC_PERIPH_E2E_RTSP_PORT"
fi

# ---- 场景选择 ---------------------------------------------------------------
SCENARIOS=("$@")
if [ ${#SCENARIOS[@]} -eq 0 ]; then
  SCENARIOS=(s1 s2 s3)
fi

run_scenario() {
  local key="$1"
  local tag pattern log
  case "$key" in
    s1|S1) tag="S1"; pattern='\[E2E-S1\]' ;;
    s2|S2) tag="S2"; pattern='\[E2E-S2\]' ;;
    s3|S3) tag="S3"; pattern='\[E2E-S3\]' ;;
    *) echo "未知场景: $key(可用: s1 s2 s3)" >&2; return 64 ;;
  esac
  log="${LOG_PREFIX}$(echo "$tag" | tr 'A-Z' 'a-z').log"

  echo ""
  echo "--- 场景 $tag  →  $log ---"
  # 幂等:每个场景开跑前都确保没有残留容器
  "$DOCKER_BIN" rm -f "$MTX_NAME" >/dev/null 2>&1 || true
  : > "$log"

  (
    cd "$PROJECT_ROOT" || exit 66
    RC_PERIPH_E2E=1 \
    RC_PERIPH_E2E_ALLOW_BLOCKED="${RC_PERIPH_E2E_ALLOW_BLOCKED:-}" \
    RC_FFMPEG_PATH="$FFMPEG_BIN" \
    RC_FFPROBE_PATH="$FFPROBE_BIN" \
    RC_DOCKER_PATH="$DOCKER_BIN" \
    RC_PERIPH_E2E_MTX_IMAGE="$MTX_IMAGE" \
    RC_PERIPH_E2E_MTX_NAME="$MTX_NAME" \
    RC_PERIPH_E2E_RTSP_PORT="$RTSP_PORT" \
    npx vitest run "$TEST_FILE" -t "$pattern" 2>&1
  ) | tee -a "$log"
  local rc=${PIPESTATUS[0]}

  # 场景之间不留容器,避免相互污染
  "$DOCKER_BIN" rm -f "$MTX_NAME" >/dev/null 2>&1 || true

  # ── 硬校验:vitest 退出码 0 ≠「用例真跑过」───────────────────────────────
  # 实测:`RC_PERIPH_E2E=1 npx vitest run <file> -t 'NOSUCHPATTERNXYZ'`
  #        → "Tests 5 skipped (5)" 且 exit=0。
  # 也就是说 describe 标题改名导致 -t 匹配不上、RC_PERIPH_E2E 传丢、整个文件被
  # gate skip —— 这三种「零个用例执行」的情况,光看退出码全都会被误判成通过。
  # 所以退出码之外,还必须对日志做三项正向/反向校验。
  if [ "$rc" -ne 0 ]; then
    echo "  ✗ 场景 $tag: 用例失败(vitest exit=$rc)"
    return 1
  fi
  if grep -Eq '^[[:space:]]*Test Files[[:space:]]+[0-9]+ skipped' "$log"; then
    echo "  ✗ 场景 $tag: 整个测试文件被 skip(RC_PERIPH_E2E 未生效?)—— 判未通过"
    return 4
  fi
  if ! grep -Eq 'Tests[[:space:]]+[1-9][0-9]* passed' "$log"; then
    echo "  ✗ 场景 $tag: 零个用例真正执行(-t '$pattern' 未匹配到?)—— 判未通过"
    return 4
  fi
  if ! grep -q "\[E2E-$tag\]" "$log"; then
    echo "  ✗ 场景 $tag: 日志缺少 [E2E-$tag] 证据行 —— 判未通过"
    return 4
  fi

  # ── 外部条件阻塞与「通过」严格分开 ──────────────────────────────────────
  # 场景②在 macOS TCC 未授权时(且跑测者显式带了 RC_PERIPH_E2E_ALLOW_BLOCKED=1)
  # 会打印 [E2E-S2] BLOCKED 证据行。这种情况用例是 PASS 的,但结论口径必须是
  # 「外部条件阻塞」,不能和真正跑通的「通过」共用退出码 0。
  if grep -q "\[E2E-$tag\] BLOCKED" "$log"; then
    echo "  ⚠ 场景 $tag: 外部条件阻塞(见日志中的 BLOCKED 证据行)"
    return 3
  fi

  echo "  ✓ 场景 $tag: 通过(证据行 + passed 计数均已核验)"
  return 0
}

OVERALL=0
BLOCKED_SEEN=0
RESULTS=()
for s in "${SCENARIOS[@]}"; do
  run_scenario "$s"
  rc=$?
  if [ $rc -eq 0 ]; then
    RESULTS+=("$s: 通过")
  elif [ $rc -eq 3 ]; then
    RESULTS+=("$s: 外部条件阻塞")
    BLOCKED_SEEN=1
  else
    RESULTS+=("$s: 未通过 (exit=$rc)")
    OVERALL=1
  fi
done

echo ""
echo "=== 汇总 ==="
for r in "${RESULTS[@]}"; do echo "  $r"; done
echo ""
echo "证据日志:"
for s in "${SCENARIOS[@]}"; do
  echo "  ${LOG_PREFIX}$(echo "$s" | tr 'A-Z' 'a-z').log"
done

# 退出码:0=全部通过  1=有未通过  3=无失败但存在外部条件阻塞
if [ $OVERALL -ne 0 ]; then
  exit 1
fi
if [ $BLOCKED_SEEN -ne 0 ]; then
  exit 3
fi
exit 0

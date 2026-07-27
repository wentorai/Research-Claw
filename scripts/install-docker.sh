#!/usr/bin/env bash
# ============================================================================
# Research-Claw (科研龙虾) — Docker One-Click Install / Update
# Hosted at: https://wentor.ai/docker-install.sh
#
# Usage:
#   curl -fsSL https://wentor.ai/docker-install.sh | bash
#
# Idempotent: safe to re-run for updates (stop → rm → pull → run).
# Data persists in Docker named volumes across container recreation.
#
# ── Volume Architecture (CRITICAL — do NOT remove any volume) ──────────
# The install script destroys and recreates the container on every run.
# ALL persistent data MUST be on named volumes, or it will be lost.
#
#   rc-config    → /app/config            API keys, gateway config
#   rc-data      → /app/.research-claw    RC plugin SQLite DB (library, tasks, monitors)
#   rc-workspace → /app/workspace         Agent workspace files (MEMORY.md, USER.md)
#   rc-state     → /root/.openclaw        OC state: sessions (chat history!), logs, plugins
#
# v0.5.2 bug: rc-state was missing → chat history lost on every update.
# v0.5.3 fix: added rc-state volume. This is the root cause of all
#             "history disappeared after update" reports.
#
# ── Environment Variables ──────────────────────────────────────────────
#   MIRROR   Alternative registry (e.g. registry.cn-hangzhou.aliyuncs.com/wentorai/research-claw)
#            Default: ACR (China), fallback: GHCR
# ============================================================================
set -euo pipefail

# ── Mirror / image configuration ──────────────────────────────────────
# Default: Alibaba Cloud ACR (China mainland accessible, no proxy needed).
# Fallback: GHCR (requires proxy in mainland China).
# Override: MIRROR=your-registry/org/repo curl -fsSL ... | bash
ACR_REPO="crpi-i37tqr5mfyhrq1z0.cn-hangzhou.personal.cr.aliyuncs.com/wentorai/research-claw"
GHCR_REPO="ghcr.io/wentorai/research-claw"
IMAGE_REPO="${MIRROR:-$ACR_REPO}"
IMAGE="${IMAGE_REPO}:latest"
CONTAINER="research-claw"
PORT=28789
HEALTH_TIMEOUT=60

# ── Colors (disabled in pipes) ────────────────────────────────────────
if [ -t 1 ] && [ -t 2 ]; then
  R='\033[38;2;239;68;68m' G='\033[38;2;34;197;94m' C='\033[38;2;34;211;238m'
  Y='\033[38;2;250;204;21m' B='\033[1m' D='\033[2m' N='\033[0m'
else
  R='' G='' C='' Y='' B='' D='' N=''
fi
ok()   { printf "${G}  ✓${N} %s\n" "$1"; }
info() { printf "${C}  ▸${N} %s\n" "$1"; }
warn() { printf "${Y}  ⚠${N} %s\n" "$1"; }
err()  { printf "${R}  ✗ %s${N}\n" "$1" >&2; }

# ── Diagnostic breadcrumb log ─────────────────────────────────────────
# Key decisions and failure details are appended here so a failed install
# has an attachable log for bug reports. Screen output stays untouched
# (tee-ing everything would break TTY detection and progress rendering).
RC_LOG="${TMPDIR:-/tmp}/rc-docker-install-$(date +%Y%m%d-%H%M%S).log"
rclog() { printf '%s %s\n' "$(date '+%H:%M:%S')" "$*" >>"$RC_LOG" 2>/dev/null || true; }
rclog "docker-install start: $(uname -a)"

INSTALL_START_TS=$(date +%s)
_elapsed() {
  local _s=$(( $(date +%s) - INSTALL_START_TS ))
  printf '%dm%02ds' $((_s / 60)) $((_s % 60))
}

# Interrupted installs are fully resumable — say so instead of dying silently.
trap 'printf "\n${Y}  ⚠ Interrupted.${N} Nothing is broken — this installer is resumable.\n  Re-run the same command to continue where it left off:\n    ${B}curl -fsSL https://wentor.ai/docker-install.sh | bash${N}\n  ${D}Diagnostic log: ${RC_LOG}${N}\n\n"; exit 130' INT TERM

step() { printf "\n${C}  ▸ [%s/5]${N} ${B}%s${N}\n" "$1" "$2"; rclog "step $1/5: $2"; }

# ── Banner ────────────────────────────────────────────────────────────
printf "\n${R}"
cat <<'ART'
    ____                              _        ____ _
   |  _ \ ___  ___  ___  __ _ _ __ ___| |__    / ___| | __ ___      __
   | |_) / _ \/ __|/ _ \/ _` | '__/ __| '_ \  | |   | |/ _` \ \ /\ / /
   |  _ <  __/\__ \  __/ (_| | | | (__| | | | | |___| | (_| |\ V  V /
   |_| \_\___||___/\___|\__,_|_|  \___|_| |_|  \____|_|\__,_| \_/\_/
ART
printf "${N}\n  ${B}Docker One-Click Install${N}\n"
printf "  ${D}https://wentor.ai${N}\n\n"
printf "  ${D}5 steps · first install ~3-10 min (mostly image download) · re-run ~30s${N}\n"
printf "  ${D}Safe to interrupt: re-running resumes where it left off${N}\n"

# ── 1. Check Docker (with daemon startup wait) ────────────────────────
step 1 "Docker environment"
if ! command -v docker &>/dev/null; then
  err "Docker not found."
  echo ""
  echo "  Install Docker Desktop first:"
  echo "    macOS:   https://docs.docker.com/desktop/setup/install/mac-install/"
  echo "    Linux:   https://docs.docker.com/engine/install/"
  echo ""
  exit 1
fi

# Docker daemon may still be starting (especially on macOS after reboot).
# Wait up to 30s for it to become ready.
if ! docker info >/dev/null 2>&1; then
  if pgrep -qf "Docker Desktop|com.docker" 2>/dev/null; then
    info "Docker Desktop is starting, waiting for daemon..."
    _daemon_ok=false
    for _i in $(seq 1 15); do
      sleep 2
      if docker info >/dev/null 2>&1; then _daemon_ok=true; break; fi
    done
    if [ "$_daemon_ok" = false ]; then
      err "Docker daemon not ready after 30s."
      echo "  Start Docker Desktop and wait for it to finish loading, then try again."
      exit 1
    fi
  else
    err "Docker daemon is not running."
    echo "  Start Docker Desktop and try again."
    exit 1
  fi
fi

ok "Docker $(docker --version | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')"
rclog "docker: $(docker --version 2>/dev/null)"

step 2 "Preflight checks"

# ── 1b. Disk space (image needs ~7 GB unpacked; fail at 95% is the worst UX) ──
_avail_gb=$(df -g / 2>/dev/null | awk 'NR==2 {print $4}' || df -BG / 2>/dev/null | awk 'NR==2 {gsub("G","",$4); print $4}')
if [ -n "${_avail_gb:-}" ] && [ "$_avail_gb" -lt 10 ] 2>/dev/null; then
  warn "Low disk space: ${_avail_gb} GB free. The image needs ~7 GB unpacked."
  echo "    If the pull fails with 'no space left on device', free up space and re-run."
  rclog "low disk: ${_avail_gb}GB"
fi

# ── 1b. WSL2 proxy diagnostics (if running inside WSL) ────────────────
# When this script runs inside WSL2 (e.g. via Windows Terminal + WSL),
# the same localhost proxy issue applies as docker-install.ps1.
WSL_PROXY_ISSUE=false
if grep -qi microsoft /proc/version 2>/dev/null; then
  # Running inside WSL2
  _has_mirrored=false
  _wslconfig=""
  for _dir in "/mnt/c/Users/"*/; do
    if [ -f "${_dir}.wslconfig" ]; then
      _wslconfig="${_dir}.wslconfig"
      if grep -qi 'networkingMode.*=.*mirrored' "$_wslconfig" 2>/dev/null; then
        _has_mirrored=true
      fi
      break
    fi
  done

  if [ "$_has_mirrored" = false ]; then
    for _proxy_var in "${HTTP_PROXY:-}" "${HTTPS_PROXY:-}" "${http_proxy:-}" "${https_proxy:-}"; do
      if echo "$_proxy_var" | grep -qE '(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])' 2>/dev/null; then
        WSL_PROXY_ISSUE=true
        break
      fi
    done
  fi

  if [ "$WSL_PROXY_ISSUE" = true ]; then
    warn "Detected localhost proxy + WSL2 NAT mode"
    echo "    Docker runs inside WSL2, which CANNOT reach Windows' localhost in NAT mode."
    echo "    This will cause 'docker pull' to fail even though your proxy is running."
    echo ""
    echo "    Fix (choose one):"
    echo "      1. Enable WSL2 mirrored networking (recommended):"
    echo "         Edit %USERPROFILE%\\.wslconfig, add:"
    echo "           [wsl2]"
    echo "           networkingMode=mirrored"
    echo "         Then: wsl --shutdown && restart Docker Desktop"
    echo ""
    echo "      2. Configure Docker proxy with host.docker.internal:"
    echo "         Docker Desktop → Settings → Resources → Proxies:"
    echo "           HTTP:  http://host.docker.internal:<your-proxy-port>"
    echo "           HTTPS: http://host.docker.internal:<your-proxy-port>"
    echo ""
  fi
fi

# ── 2. Stop + Remove existing container ───────────────────────────────
if docker ps -a --format '{{.Names}}' | grep -qx "${CONTAINER}"; then
  info "Found existing container '${CONTAINER}' — stopping and removing..."
  docker stop "$CONTAINER" >/dev/null 2>&1 || true
  docker rm "$CONTAINER" >/dev/null 2>&1 || true
  ok "Old container removed"
fi

# ── 3. Free port (may be held by a non-Docker process) ────────────────
if command -v lsof &>/dev/null; then
  EXISTING_PIDS=$(lsof -ti :"$PORT" 2>/dev/null || true)
  if [ -n "$EXISTING_PIDS" ]; then
    info "Port ${PORT} still in use by another process — stopping..."
    echo "$EXISTING_PIDS" | xargs kill 2>/dev/null || true
    sleep 1
    ok "Port ${PORT} freed"
  fi
fi

# ── 4. Pre-flight: test registry connectivity ─────────────────────────
# Quick check before entering the retry loop. If registry is unreachable,
# give specific guidance immediately instead of waiting through 3 retries.
REGISTRY=$(echo "$IMAGE_REPO" | cut -d'/' -f1)
REGISTRY_OK=false
_http_code=$(curl -sf --connect-timeout 5 -o /dev/null -w "%{http_code}" "https://${REGISTRY}/v2/" 2>/dev/null || true)
if [ "$_http_code" = "200" ] || [ "$_http_code" = "401" ] || [ "$_http_code" = "403" ]; then
  # 401/403 = auth required = registry IS reachable
  REGISTRY_OK=true
fi

if [ "$REGISTRY_OK" = false ]; then
  warn "Registry '${REGISTRY}' is not reachable."
  if [ "$REGISTRY" = "ghcr.io" ]; then
    echo "    ghcr.io is blocked in mainland China without proxy."
    echo ""
    echo "    Solutions:"
    echo "      1. Configure Docker proxy:"
    if [ "$(uname)" = "Darwin" ]; then
      echo "         Docker Desktop → Settings → Resources → Proxies"
      echo "         HTTP/HTTPS: http://host.docker.internal:<proxy-port>"
    else
      echo "         Create/edit /etc/docker/daemon.json:"
      echo '         { "proxies": { "http-proxy": "http://PROXY:PORT", "https-proxy": "http://PROXY:PORT" } }'
      echo "         Then: sudo systemctl restart docker"
    fi
    echo ""
    echo "      2. Use a mirror registry:"
    echo '         MIRROR=your-mirror/wentorai/research-claw \'
    echo "           curl -fsSL https://wentor.ai/docker-install.sh | bash"
    echo ""
    echo "      3. Build locally (no proxy needed, uses China mirrors):"
    echo "         git clone https://github.com/wentorai/Research-Claw.git"
    echo "         cd Research-Claw && docker compose up -d --build"
    echo ""
  else
    echo "    Check that the mirror registry '${REGISTRY}' is accessible."
  fi
  echo "    Continuing with pull attempt anyway..."
  echo ""
fi

# ── 4b. Pull latest image (with retry + automatic GHCR fallback) ──────
# Fast reachability probe: a dead proxy or blocked registry makes `docker pull`
# hang for minutes per attempt with zero output. Probe the registry's /v2/
# endpoint first (any HTTP response — incl. 401 — proves reachability; only
# connection-level failure counts as unreachable) so we fail over in seconds.
# NOTE: probe failure does NOT skip pulling entirely — the Docker daemon may
# have its own working proxy (common on WSL2/Docker Desktop) — it just cuts
# the blind retries from 3 to 1.
_registry_reachable() {
  local _code
  _code="$(curl -s -o /dev/null --connect-timeout 5 --max-time 10 -w '%{http_code}' "https://$1/v2/" 2>/dev/null || true)"
  [ -n "$_code" ] && [ "$_code" != "000" ]
}

# Layer-count progress bar for docker pull. With the containerd image store
# (Docker Desktop default since 4.3x) the CLI prints only status transitions —
# a multi-minute big-layer download shows ZERO output and is indistinguishable
# from a hang. Byte-level progress is not available at all (verified: the
# /images/create event stream carries no progressDetail under containerd
# store), so we render the finest granularity that exists: completed layers +
# an elapsed tick every second as the liveness signal. Full docker output is
# kept in a log and dumped on failure.
_pull_with_progress() {
  local _img="$1" _log _pid _rc=0 _t=0 _total _done _bar _pct _w=30
  _log="$(mktemp)"
  docker pull "$_img" >"$_log" 2>&1 &
  _pid=$!
  while kill -0 "$_pid" 2>/dev/null; do
    sleep 1; _t=$((_t + 1))
    _total=$(grep -oE '^[0-9a-f]{12}:' "$_log" | sort -u | wc -l | tr -d ' ')
    _done=$(grep -cE '^[0-9a-f]{12}: (Pull complete|Already exists)' "$_log" | tr -d ' ')
    if [ "$_total" -gt 0 ]; then
      _pct=$((_done * _w / _total))
      _bar=$(printf '%*s' "$_pct" '' | tr ' ' '=')
      if [ -t 1 ]; then
        printf '\r  ▸ Pulling image [%-*s] %s/%s layers · %ss ' "$_w" "$_bar" "$_done" "$_total" "$_t"
      elif [ $((_t % 15)) -eq 0 ]; then
        printf '  ▸ Pulling image %s/%s layers · %ss elapsed\n' "$_done" "$_total" "$_t"
      fi
    fi
  done
  wait "$_pid" || _rc=$?
  [ -t 1 ] && printf '\r\033[2K'
  if [ "$_rc" -ne 0 ] && [ -s "$_log" ]; then
    warn "Pull failed. Last output:"
    tail -3 "$_log" | sed 's/^/      /'
    { echo "--- docker pull $_img (rc=$_rc) ---"; cat "$_log"; } >>"$RC_LOG" 2>/dev/null || true
  fi
  rm -f "$_log"
  return "$_rc"
}

_pull_with_retry() {
  local _img="$1"
  local _registry="${_img%%/*}"
  local _max=3
  if ! _registry_reachable "$_registry"; then
    warn "Registry ${_registry} not reachable from this shell (5s probe)."
    echo "    Docker's daemon may still reach it through its own proxy — trying once."
    _max=1
  fi
  for _attempt in $(seq 1 "$_max"); do
    info "Pulling ${_img} (attempt ${_attempt}/${_max})"
    printf "    ${D}First install downloads ~2 GB — typically 3-10 min depending on network.${N}\n"
    printf "    ${D}Layer count below advances per finished layer; the seconds tick proves it's alive.${N}\n"
    if _pull_with_progress "$_img"; then
      return 0
    fi
    if [ "$_attempt" -lt "$_max" ]; then
      _backoff=$((_attempt * 5))
      warn "Pull failed — retrying in ${_backoff}s..."
      sleep "$_backoff"
    fi
  done
  return 1
}

step 3 "Pull image"

PULL_OK=false
if _pull_with_retry "$IMAGE"; then
  PULL_OK=true
elif [ -z "${MIRROR:-}" ] && [ "$IMAGE_REPO" = "$ACR_REPO" ]; then
  # ACR failed and user didn't explicitly set MIRROR — try GHCR as fallback
  warn "China mirror (ACR) unreachable — trying GHCR fallback..."
  IMAGE="${GHCR_REPO}:latest"
  IMAGE_REPO="$GHCR_REPO"
  if _pull_with_retry "$IMAGE"; then
    PULL_OK=true
  fi
fi

if [ "$PULL_OK" = false ]; then
  err "Failed to pull image from both ACR and GHCR."
  echo ""

  # Check if an older local image exists — offer to use it
  LOCAL_IMAGE=$(docker images --format '{{.Repository}}:{{.Tag}}' 2>/dev/null | grep -Fm1 "${IMAGE_REPO}" || true)
  if [ -n "$LOCAL_IMAGE" ]; then
    warn "Found local image: ${LOCAL_IMAGE}"
    echo "    The pull failed but you have a previously downloaded version."
    echo "    To start it manually:"
    echo "      docker run -d --name ${CONTAINER} -p 127.0.0.1:${PORT}:${PORT} \\"
    echo "        -v rc-config:/app/config -v rc-data:/app/.research-claw \\"
    echo "        -v rc-workspace:/app/workspace -v rc-state:/root/.openclaw \\"
    echo "        --restart unless-stopped ${LOCAL_IMAGE}"
    echo ""
  fi

  # Provide targeted diagnostics
  if [ "$WSL_PROXY_ISSUE" = true ]; then
    err "DIAGNOSIS: WSL2 localhost proxy issue detected (see warning above)."
    echo "  Your proxy is running, but Docker (inside WSL2) cannot reach it via localhost."
    echo ""
    echo "  Quickest fix:"
    echo "    1. Edit %USERPROFILE%\\.wslconfig (or create it), add:"
    echo "         [wsl2]"
    echo "         networkingMode=mirrored"
    echo "    2. Run: wsl --shutdown"
    echo "    3. Restart Docker Desktop"
    echo "    4. Re-run: curl -fsSL https://wentor.ai/docker-install.sh | bash"
  else
    echo "  Possible causes:"
    echo "    - No internet connection"
    echo "    - GHCR transient error (retry later)"
    echo "    - GHCR blocked (mainland China)"
    echo ""
    echo "  Solutions:"
    if [ "$(uname)" = "Darwin" ]; then
      echo "    1. Configure Docker proxy:"
      echo "       Docker Desktop → Settings → Resources → Proxies"
      echo "       HTTP/HTTPS: http://host.docker.internal:<proxy-port>"
      echo "       (Use host.docker.internal, NOT localhost)"
    else
      echo "    1. Configure Docker proxy:"
      echo "       Edit /etc/docker/daemon.json:"
      echo '       { "proxies": { "http-proxy": "http://PROXY:PORT", "https-proxy": "http://PROXY:PORT" } }'
      echo "       Then: sudo systemctl restart docker"
    fi
    echo ""
    echo '    2. Use a mirror: MIRROR=your-mirror/org/repo curl ... | bash'
    echo ""
    echo "    3. Build locally:"
    echo "       git clone https://github.com/wentorai/Research-Claw.git"
    echo "       cd Research-Claw && docker compose up -d --build"
  fi
  echo ""
  echo "  See: https://github.com/wentorai/Research-Claw#手动安装--大陆网络--故障排查"
  echo "  Diagnostic log (attach to bug reports): $RC_LOG"
  exit 1
fi
ok "Image pulled"

# ── 4c. Clean up dangling images (old versions left by previous pulls) ─
PRUNED=$(docker image prune -f 2>/dev/null || true)
RECLAIMED=$(echo "$PRUNED" | sed -n 's/.*reclaimed space: *//p' 2>/dev/null || true)
if [ -n "$RECLAIMED" ] && ! echo "$RECLAIMED" | grep -qE '^0 *B$'; then
  ok "Cleaned up old images ($RECLAIMED)"
fi

# ── 5. Start container ────────────────────────────────────────────────
step 4 "Start container"
info "Starting container..."
if ! docker run -d \
  --name "$CONTAINER" \
  -p "127.0.0.1:${PORT}:${PORT}" \
  -v rc-config:/app/config \
  -v rc-data:/app/.research-claw \
  -v rc-workspace:/app/workspace \
  -v rc-state:/root/.openclaw \
  --restart unless-stopped \
  "$IMAGE" >/dev/null; then
  err "Failed to start container. Possible causes:"
  echo "  - Port ${PORT} already in use (run: lsof -ti :${PORT})"
  echo "  - Container name conflict (run: docker rm ${CONTAINER})"
  echo "  Diagnostic log: $RC_LOG"
  exit 1
fi

# ── 5b. Verify container is actually running (not crash-looping) ──────
sleep 2
CONTAINER_RUNNING=$(docker inspect --format '{{.State.Running}}' "$CONTAINER" 2>/dev/null || true)
if [ "$CONTAINER_RUNNING" != "true" ]; then
  warn "Container started but exited immediately."
  echo "    Check logs: docker logs ${CONTAINER}"
  echo "    Common fix: docker volume rm rc-config && re-run this script"
  echo "    (This resets config only — chat history and data are preserved)"
  docker logs --tail 30 "$CONTAINER" >>"$RC_LOG" 2>&1 || true
  echo "    Diagnostic log: $RC_LOG"
  exit 1
fi

# ── 6. Wait for health ────────────────────────────────────────────────
step 5 "Wait for gateway"
info "First boot initializes OpenClaw inside the container — typically 20-40s."
READY=false
_hw=0
while [ "$_hw" -lt "$HEALTH_TIMEOUT" ]; do
  if curl -sf --noproxy '*' "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1; then
    READY=true
    break
  fi
  sleep 2; _hw=$((_hw + 2))
  if [ -t 1 ]; then
    printf '\r  ▸ Waiting for gateway... %ss / %ss ' "$_hw" "$HEALTH_TIMEOUT"
  elif [ $((_hw % 10)) -eq 0 ]; then
    printf '  ▸ Waiting for gateway... %ss / %ss\n' "$_hw" "$HEALTH_TIMEOUT"
  fi
done
[ -t 1 ] && printf '\r\033[2K'

if [ "$READY" = false ]; then
  warn "Gateway not ready after ${HEALTH_TIMEOUT}s — it may still be starting (slow disks need longer)."
  echo "  Watch it come up:  docker logs -f ${CONTAINER}"
  echo "  Then open:         http://127.0.0.1:${PORT}/"
  rclog "health timeout after ${HEALTH_TIMEOUT}s"
fi

# ── 7. Done ───────────────────────────────────────────────────────────
URL="http://127.0.0.1:${PORT}/"

printf "\n  ${G}${B}Ready!${N}  ${D}(total $(_elapsed))${N}\n\n"
printf "  ${B}Dashboard:${N}  ${C}${URL}${N}\n"
printf "  ${B}Logs:${N}       docker logs -f ${CONTAINER}\n"
printf "  ${B}Stop:${N}       docker stop ${CONTAINER}\n"
printf "  ${B}Start:${N}      docker start ${CONTAINER}\n"
printf "  ${B}Update:${N}     curl -fsSL https://wentor.ai/docker-install.sh | bash\n\n"
printf "  ${Y}TIP:${N}  First time? Open the Dashboard → ${B}Setup Wizard${N} → enter your API Key.\n\n"

# Open browser
if command -v xdg-open &>/dev/null; then
  xdg-open "$URL" 2>/dev/null &
elif command -v open &>/dev/null; then
  open "$URL" 2>/dev/null &
fi

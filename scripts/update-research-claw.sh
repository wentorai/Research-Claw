#!/usr/bin/env bash
# Research-Claw: pull latest from origin (ff-only), install deps, rebuild dashboard + extensions.
# Invoked by Settings → About → "Apply update" (rc.app.apply_update) or run manually from repo root.
#
# Dual-remote fallback: if the default remote (often Gitee) has no new commits,
# automatically tries GitHub. Mirrors install.sh's Gitee→GitHub pattern.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
if [[ ! -d .git ]]; then
  echo "Error: not a git repository. Clone https://github.com/wentorai/Research-Claw to use this script." >&2
  exit 1
fi
export PATH="$ROOT/node_modules/.bin:$PATH"

# Never block on an interactive git credential prompt. The default remote is a
# Gitee mirror that intermittently 401s for anonymous fetch; without this guard
# `git pull` hangs on "Username for 'https://gitee.com':" instead of fast-failing
# into the GitHub fallback below.
export GIT_TERMINAL_PROMPT=0
export GCM_INTERACTIVE=Never
export GIT_ASKPASS=true

GITHUB_REPO="https://github.com/wentorai/Research-Claw.git"

# Heartbeat wrapper: capture output to a log and print a liveness line every
# 15s. This script usually runs non-interactively (dashboard "Apply update"),
# where a silent slow `git pull` is indistinguishable from a hang.
run_with_heartbeat() {
  local _label="$1"; shift
  local _log _pid _rc=0 _t=0
  _log="$(mktemp)"
  "$@" >"$_log" 2>&1 &
  _pid=$!
  while kill -0 "$_pid" 2>/dev/null; do
    sleep 1
    _t=$((_t + 1))
    if [ -t 1 ]; then
      printf "\r[update-research-claw] %s... %ss" "$_label" "$_t"
    elif [ $((_t % 15)) -eq 0 ]; then
      printf "[update-research-claw] %s... %ss elapsed\n" "$_label" "$_t"
    fi
  done
  wait "$_pid" || _rc=$?
  if [ -t 1 ] && [ "$_t" -gt 0 ]; then printf "\r\033[2K"; fi
  rm -f "$_log"
  return "$_rc"
}

OLD_HEAD=$(git rev-parse HEAD)
run_with_heartbeat "pulling from origin" git pull --ff-only || true

# If default remote had no new commits (Gitee may lag behind GitHub), try GitHub
if [ "$(git rev-parse HEAD)" = "$OLD_HEAD" ]; then
  git remote set-url github "$GITHUB_REPO" 2>/dev/null \
    || git remote add github "$GITHUB_REPO" 2>/dev/null \
    || true
  if run_with_heartbeat "fetching github/main" git fetch github main; then
    git merge --ff-only github/main 2>/dev/null || true
  fi
fi

pnpm install
pnpm build

# Finish the same idempotent config migration used by install/startup before
# claiming the update succeeded. The next restart therefore never sees a
# half-upgraded config, and re-running this update remains byte-idempotent.
CONFIG_PATHS=()
[ -f "$ROOT/config/openclaw.json" ] && CONFIG_PATHS+=("$ROOT/config/openclaw.json")
[ -f "$HOME/.openclaw/openclaw.json" ] && CONFIG_PATHS+=("$HOME/.openclaw/openclaw.json")
if [ "${#CONFIG_PATHS[@]}" -gt 0 ]; then
  node "$ROOT/scripts/ensure-config.cjs" "${CONFIG_PATHS[@]}"
fi

node "$ROOT/scripts/version-info.cjs" --root "$ROOT"

# Update research-plugins (skills + agent tools)
PLUGIN_DIR="$HOME/.openclaw/extensions/research-plugins"
if [ -d "$PLUGIN_DIR" ]; then
  RP_LOG="$(mktemp)"
  echo "[update-research-claw] Updating research-plugins..."
  TMP_CFG="$(mktemp)"; echo '{}' > "$TMP_CFG"
  if OPENCLAW_CONFIG_PATH="$TMP_CFG" node ./node_modules/openclaw/dist/entry.js plugins install @wentorai/research-plugins >"$RP_LOG" 2>&1; then
    NEW_VER=$(node -e "console.log(require('$PLUGIN_DIR/package.json').version)" 2>/dev/null || echo "unknown")
    echo "[update-research-claw] research-plugins → v${NEW_VER}"
  else
    echo "[update-research-claw] research-plugins update failed (non-critical). Details:" >&2
    tail -3 "$RP_LOG" >&2
  fi
  rm -f "$TMP_CFG" "$RP_LOG"
fi

echo "[update-research-claw] Done. Restart the gateway (Settings → Restart or scripts/run.sh)."

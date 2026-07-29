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
ORIGIN_PULL_SUCCEEDED=false
GITHUB_FETCH_SUCCEEDED=false
if run_with_heartbeat "pulling from origin" git pull --ff-only; then
  ORIGIN_PULL_SUCCEEDED=true
else
  echo "[update-research-claw] Origin could not be checked; trying GitHub." >&2
fi

# If default remote had no new commits (Gitee may lag behind GitHub), try GitHub
if [ "$(git rev-parse HEAD)" = "$OLD_HEAD" ]; then
  git remote set-url github "$GITHUB_REPO" 2>/dev/null \
    || git remote add github "$GITHUB_REPO" 2>/dev/null \
    || true
  if run_with_heartbeat "fetching github/main" git fetch github main; then
    GITHUB_FETCH_SUCCEEDED=true
    if ! git merge --ff-only github/main 2>/dev/null; then
      echo "[update-research-claw] Update was not completed: GitHub changes could not be fast-forwarded." >&2
      exit 1
    fi
  elif ! $ORIGIN_PULL_SUCCEEDED; then
    echo "[update-research-claw] Update was not completed: neither origin nor GitHub could be checked." >&2
    echo "[update-research-claw] The existing installation was kept. Re-run this updater when the network is available." >&2
    exit 1
  else
    echo "[update-research-claw] Origin was checked successfully; GitHub was unavailable, so the origin result is being used." >&2
  fi
fi

# A failed pull must never fall through to a build unless the GitHub fallback
# was fetched and fast-forwarded successfully.
if ! $ORIGIN_PULL_SUCCEEDED && ! $GITHUB_FETCH_SUCCEEDED; then
  echo "[update-research-claw] Update was not completed; the existing installation was kept." >&2
  exit 1
fi

node "$ROOT/scripts/run-pnpm.cjs" install
node "$ROOT/scripts/run-pnpm.cjs" build

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

# Install or update research-plugins (skills + agent tools) in the one
# canonical directory used by both plugin discovery and SkillSearch.
PLUGIN_DIR="$HOME/.openclaw/extensions/research-plugins"
RP_LOG="$(mktemp)"
echo "[update-research-claw] Updating research plugins..."
if node "$ROOT/scripts/install-research-plugins.cjs" \
    --target "$PLUGIN_DIR" >"$RP_LOG" 2>&1; then
  NEW_VER=$(node -e 'console.log(require(process.argv[1]).version)' \
    "$PLUGIN_DIR/package.json" 2>/dev/null || echo "unknown")
  echo "[update-research-claw] Research plugins → v${NEW_VER}"
elif node "$ROOT/scripts/install-research-plugins.cjs" \
    --check --quiet --target "$PLUGIN_DIR" 2>/dev/null; then
  echo "[update-research-claw] Research plugins were not updated; the existing version was kept." >&2
  tail -3 "$RP_LOG" >&2
else
  echo "[update-research-claw] Research features are temporarily unavailable; the core assistant remains available." >&2
  echo "[update-research-claw] Run this updater again to restore research features." >&2
  tail -3 "$RP_LOG" >&2
fi
rm -f "$RP_LOG"

# Reconcile after the optional plugin update. A failed/partial install must not
# leave an invalid load path; a usable install is restored on the next pass.
if [ "${#CONFIG_PATHS[@]}" -gt 0 ]; then
  node "$ROOT/scripts/ensure-config.cjs" "${CONFIG_PATHS[@]}"
fi
if [ -f "$ROOT/config/openclaw.json" ]; then
  if ! OPENCLAW_CONFIG_PATH="$ROOT/config/openclaw.json" \
    "$ROOT/node_modules/.bin/openclaw" config validate --json >/dev/null
  then
    echo "[update-research-claw] Configuration validation failed; update was not completed." >&2
    OPENCLAW_CONFIG_PATH="$ROOT/config/openclaw.json" \
      "$ROOT/node_modules/.bin/openclaw" config validate --json >&2 || true
    exit 1
  fi
fi

echo "[update-research-claw] Done. Restart the gateway (Settings → Restart or scripts/run.sh)."

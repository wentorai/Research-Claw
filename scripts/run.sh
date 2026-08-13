#!/usr/bin/env bash
# Auto-restart wrapper for Research-Claw gateway.
# The gateway sends itself SIGUSR1 after config changes (API key, model, etc.)
# and exits, expecting an external supervisor to restart it.
#
# Usage:  ./scripts/run.sh          (or: pnpm serve)
# Stop:   Ctrl+C

cd "$(dirname "$0")/.."

PORT="${PORT:-28789}"

# --- Resolve native user / developer / one-shot support log semantics ---
# A managed installer writes a gitignored marker. Source worktrees have no
# marker and therefore default to developer debug. RC_LOG_PROFILE is the
# explicit, stable override; OPENCLAW_LOG_LEVEL remains an expert override and
# is never downgraded by RC_VERBOSE.
if ! _RC_PROFILE_SHELL=$(node ./scripts/log-profile.cjs resolve \
    --root "$(pwd)" \
    ${RC_LOG_MARKER_PATH:+--marker "$RC_LOG_MARKER_PATH"} \
    --shell); then
  echo "[run] ERROR: Could not resolve RC_LOG_PROFILE. Use user, developer, or support." >&2
  exit 64
fi
eval "$_RC_PROFILE_SHELL"
unset _RC_PROFILE_SHELL
if [ "${RC_LOG_PROFILE_CHECK:-}" = "1" ]; then
  node ./scripts/log-profile.cjs resolve \
    --root "$(pwd)" \
    ${RC_LOG_MARKER_PATH:+--marker "$RC_LOG_MARKER_PATH"}
  exit $?
fi
if [ -n "$RC_PROFILE_GATEWAY_LOG_LEVEL" ] && [ -z "${OPENCLAW_LOG_LEVEL:-}" ]; then
  export OPENCLAW_LOG_LEVEL="$RC_PROFILE_GATEWAY_LOG_LEVEL"
fi

# --- Single-owner lock: a second launcher reuses the live instance ---
source "./scripts/run-lock.sh"
if acquire_run_lock; then
  trap release_run_lock EXIT
else
  exit $?
fi

# Run start time — consumed by the exit farewell screen (this-run usage + duration).
export RC_RUN_START_EPOCH=$(date +%s)

# --- Banner ---
if [ -t 1 ]; then
  R='\033[38;2;239;68;68m' B='\033[1m' D='\033[2m' N='\033[0m'
else
  R='' B='' D='' N=''
fi
printf "\n${R}"
cat <<'ART'
    ____                              _        ____ _
   |  _ \ ___  ___  ___  __ _ _ __ ___| |__    / ___| | __ ___      __
   | |_) / _ \/ __|/ _ \/ _` | '__/ __| '_ \  | |   | |/ _` \ \ /\ / /
   |  _ <  __/\__ \  __/ (_| | | | (__| | | | | |___| | (_| |\ V  V /
   |_| \_\___||___/\___|\__,_|_|  \___|_| |_|  \____|_|\__,_| \_/\_/
ART
printf "${N}\n  ${B}科研龙虾 — AI-Powered Local Research Assistant${N}\n"
printf "  ${D}https://wentor.ai${N}\n\n"
node "$(dirname "$0")/version-info.cjs" --root "$(pwd)" 2>/dev/null \
  | sed 's/^/  /' || true
printf "\n"

# --- Output discipline (P1/P2 noise off by default; full detail lands in files) ---
# Managed-user terminal shows only what a user can act on. The gateway's own
# chatter is quieted via logging.consoleLevel=error (set by ensure-config); its
# full log lives in ~/.research-claw/logs/openclaw.log. run.sh's own step log
# lands in run-latest.log (previous run kept as run-prev.log).
# Source worktrees default to developer/debug. RC_VERBOSE=1 remains a compatible
# user-mode info shortcut but never overwrites OPENCLAW_LOG_LEVEL=debug/trace.
RC_LOG_DIR="$HOME/.research-claw/logs"
mkdir -p "$RC_LOG_DIR" 2>/dev/null || true
RC_RUN_LOG="$RC_LOG_DIR/run-latest.log"
[ -f "$RC_RUN_LOG" ] && mv -f "$RC_RUN_LOG" "$RC_LOG_DIR/run-prev.log" 2>/dev/null || true
: > "$RC_RUN_LOG" 2>/dev/null || true
rclog() { printf '%s %s\n' "$(date '+%H:%M:%S')" "$*" >>"$RC_RUN_LOG" 2>/dev/null || true; }
say()   { printf "  %s\n" "$*"; rclog "$*"; }                                   # always shown
dbg()   { rclog "$*"; [ -n "$RC_LAUNCHER_VERBOSE" ] && printf "  ${D}%s${N}\n" "$*" || true; }  # verbose only
rclog "Log profile: $RC_RESOLVED_LOG_PROFILE ($RC_PROFILE_SOURCE)"
dbg "Log profile: $RC_RESOLVED_LOG_PROFILE"

# --- Ensure project config exists ---
# RC project config contains plugin paths, tool whitelist, dashboard root, port 28789.
# Global ~/.openclaw/openclaw.json is vanilla OpenClaw and MUST NOT override these.
if [ ! -f config/openclaw.json ]; then
  if [ -f config/openclaw.example.json ]; then
    cp config/openclaw.example.json config/openclaw.json
    dbg "Config bootstrapped from template"
  else
    echo "[run] ERROR: config/openclaw.example.json not found" >&2
    exit 1
  fi
fi

# Always point OpenClaw to the project config.
# Without this, it reads ~/.openclaw/openclaw.json which has no RC settings.
export OPENCLAW_CONFIG_PATH="$(pwd)/config/openclaw.json"

# --- Migrate legacy project data dir to ~/.research-claw ---
node "$(dirname "$0")/migrate-rc-data-dir.cjs" 2>/dev/null || true

# Token auth — config file is the source of truth.
# Default 'research-claw' matches Dashboard's DEFAULT_TOKEN for zero-config local use.
# Custom token: set gateway.auth.token in config/openclaw.json (persists across restarts).
# Env override: export OPENCLAW_GATEWAY_TOKEN=my-secret (before pnpm serve)
# Docker: docker run -e OPENCLAW_GATEWAY_TOKEN=my-secret ...
if [ -z "$OPENCLAW_GATEWAY_TOKEN" ]; then
  # Read from config first — respects user-customized tokens for remote deployments
  OPENCLAW_GATEWAY_TOKEN=$(node -e "
    try { const c = JSON.parse(require('fs').readFileSync('$(pwd)/config/openclaw.json', 'utf8'));
      if (c.gateway?.auth?.token) console.log(c.gateway.auth.token);
    } catch {}
  " 2>/dev/null)
  export OPENCLAW_GATEWAY_TOKEN="${OPENCLAW_GATEWAY_TOKEN:-research-claw}"
fi

# --- Ensure config has all OC 2026.6.1+ required fields ---
# MUST run BEFORE path resolution so that newly added relative paths
# (e.g. ./extensions/openclaw-weixin) get converted to absolute below.
GLOBAL_CFG="$HOME/.openclaw/openclaw.json"
if ! node "$(dirname "$0")/ensure-config.cjs" \
    "$OPENCLAW_CONFIG_PATH" ${GLOBAL_CFG:+"$GLOBAL_CFG"} \
    >>"$RC_RUN_LOG" 2>&1
then
  say "✗ Configuration migration failed. Research-Claw was not started."
  say "  Details: $RC_RUN_LOG"
  exit 1
fi

# --- Resolve relative paths in config to absolute ---
# OpenClaw's agent runner calls process.chdir(workspace/) during runs (attempt.ts:774).
# config.get re-reads config from disk and validates paths relative to CWD.
# If CWD has drifted, relative paths like ./extensions/... resolve wrong → valid:false
# → security gate wipes config → dashboard can't boot.
# Fix: resolve all RC-specific relative paths to absolute at startup (CWD is correct here).
node -e "
const fs = require('fs'), path = require('path');
const f = process.env.OPENCLAW_CONFIG_PATH;
const cfg = JSON.parse(fs.readFileSync(f, 'utf8'));
const root = process.cwd();
const abs = p => path.isAbsolute(p) ? p : path.resolve(root, p);
// Re-root stale absolute paths from a different machine/user.
// Strip path segments from the left until the remainder exists under root.
const reroot = p => {
  if (!path.isAbsolute(p)) return path.resolve(root, p);
  if (p.startsWith(root + '/') || p === root) return p;
  const segs = p.split(path.sep).filter(Boolean);
  for (let i = 1; i < segs.length; i++) {
    const suffix = segs.slice(i).join(path.sep);
    const candidate = path.join(root, suffix);
    if (fs.existsSync(candidate)) return candidate;
  }
  return abs(p); // fallback: at least make it absolute
};
const dedup = arr => [...new Set(arr)];
let changed = false;
if (cfg.plugins?.load?.paths) {
  const fixed = dedup(cfg.plugins.load.paths.map(reroot));
  if (JSON.stringify(fixed) !== JSON.stringify(cfg.plugins.load.paths)) {
    cfg.plugins.load.paths = fixed; changed = true;
  }
}
if (cfg.skills?.load?.extraDirs) {
  const fixed = dedup(cfg.skills.load.extraDirs.map(reroot));
  if (JSON.stringify(fixed) !== JSON.stringify(cfg.skills.load.extraDirs)) {
    cfg.skills.load.extraDirs = fixed; changed = true;
  }
}
if (cfg.gateway?.controlUi?.root) {
  const fixed = reroot(cfg.gateway.controlUi.root);
  if (fixed !== cfg.gateway.controlUi.root) { cfg.gateway.controlUi.root = fixed; changed = true; }
}
if (cfg.agents?.defaults?.workspace) {
  const fixed = reroot(cfg.agents.defaults.workspace);
  if (fixed !== cfg.agents.defaults.workspace) { cfg.agents.defaults.workspace = fixed; changed = true; }
}
if (changed) { const o=JSON.stringify(cfg,null,2)+'\n',t=f+'.tmp.'+process.pid; fs.writeFileSync(t,o); fs.renameSync(t,f); console.error('[run] Config paths resolved to absolute'); }
" 2>>"$RC_RUN_LOG"

# --- Resolve the one supported gateway/build runtime (Node 22) ---
# The same resolver is used by `pnpm build`; this prevents a native dependency
# installed under one Node ABI from being loaded by a different Gateway ABI.
if ! _RC_NODE_SHELL=$(node ./scripts/node-runtime.cjs resolve --shell); then
  say "✗ Node.js 22.16+ is required. Research-Claw was not started."
  say "  Fix: fnm install 22 && fnm use 22 && fnm default 22"
  exit 78
fi
eval "$_RC_NODE_SHELL"
unset _RC_NODE_SHELL
GW_NODE="$RC_NODE_PATH"
export PATH="$RC_NODE_DIR:$PATH"

dbg "Using Node: $GW_NODE (v$RC_NODE_VERSION, ABI $RC_NODE_ABI)"
dbg "Config: $OPENCLAW_CONFIG_PATH"
export RESEARCH_CLAW_UI_VERSION="$("$GW_NODE" -p "require('./package.json').version" 2>/dev/null)"

# Fail before any migration or port binding when the final Gateway runtime
# cannot load Core's native dependency or read the user's existing database.
if ! "$GW_NODE" ./scripts/runtime-preflight.cjs \
    --root "$(pwd)" --config "$OPENCLAW_CONFIG_PATH" >>"$RC_RUN_LOG" 2>&1; then
  say "✗ Research-Claw Core runtime preflight failed. Nothing was started or modified."
  say "  Details: $RC_RUN_LOG"
  say "  Common fix: fnm use 22 && pnpm rebuild better-sqlite3"
  exit 78
fi

# Refuse to launch on a configuration that the exact bundled OpenClaw runtime
# rejects. In particular, a missing or partial optional research plugin must be
# removed by the migration above instead of becoming a fatal load path.
if ! "$GW_NODE" ./node_modules/openclaw/dist/entry.js \
    config validate --json >>"$RC_RUN_LOG" 2>&1
then
  say "✗ Configuration validation failed. Research-Claw was not started."
  say "  Details: $RC_RUN_LOG"
  exit 1
fi
if ! "$GW_NODE" ./scripts/install-research-plugins.cjs \
    --check --quiet \
    --target "$HOME/.openclaw/extensions/research-plugins" 2>/dev/null
then
  say "⚠ Research features are temporarily unavailable; the core assistant will still start."
  say "  Run the installer again to restore research features."
fi

# Repair stale RC preset jobs before OpenClaw opens the cron JSON store.
if ! "$GW_NODE" "$(dirname "$0")/reconcile-cron-upgrade.cjs" \
  --config "$OPENCLAW_CONFIG_PATH" \
  --state "${OPENCLAW_STATE_DIR:-$HOME/.openclaw}" >>"$RC_RUN_LOG" 2>&1; then
  say "⚠ Could not check old scheduled tasks. Research-Claw will still start; see $RC_RUN_LOG."
fi

# Stop macOS LaunchAgent gateway (installed by `openclaw doctor`) — it binds 28789.
LAUNCH_AGENT="$HOME/Library/LaunchAgents/ai.openclaw.gateway.plist"
if [ -f "$LAUNCH_AGENT" ]; then
  launchctl bootout "gui/$(id -u)" "$LAUNCH_AGENT" 2>/dev/null \
    || launchctl unload "$LAUNCH_AGENT" 2>/dev/null || true
  dbg "Stopped LaunchAgent ai.openclaw.gateway (use pnpm serve OR LaunchAgent, not both)"
fi
if command -v lsof >/dev/null 2>&1 \
  && lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t >/dev/null 2>&1; then
  say "✗ Port $PORT is already in use. Research-Claw did not terminate that process."
  say "  Stop the existing gateway first, then run pnpm serve again."
  exit 75
fi

# Sync RC settings → ~/.openclaw/openclaw.json so the OpenClaw gateway also works.
# Direction: RC project config → global config (preserves user-only keys in global).
# Strips invalid channels.*.commands for OC 2026.6.1+.
"$GW_NODE" "$(dirname "$0")/sync-global-config.cjs" 2>/dev/null || true

# --- Sync HEARTBEAT.md to workspace root ---
# OC's heartbeat system reads workspace/HEARTBEAT.md directly (not .ResearchClaw/).
# The pnpm patch covers loadWorkspaceBootstrapFiles but not resolveHeartbeatPreflight
# in health-DSTtGBUV.js. Syncing on every startup keeps both locations fresh.
# NOTE: HEARTBEAT.md is excluded from RELOCATABLE_PROMPT_FILES in service.ts
# so that migratePromptFiles() does not rename this root copy to .bak.
# The other relocatable files (AGENTS/SOUL/TOOLS/IDENTITY/USER/BOOTSTRAP) get a
# workspace-root SYMLINK created by migratePromptFiles() — do NOT cp them here,
# or cp would copy the .ResearchClaw/ source onto its own symlink target.
RC_DIR="workspace/.ResearchClaw"
[ -f "$RC_DIR/HEARTBEAT.md" ] && cp "$RC_DIR/HEARTBEAT.md" "workspace/HEARTBEAT.md"

# --- Initialize L2/L3 bootstrap runtime files from .example templates ---
# L1 (AGENTS, HEARTBEAT) are synced above.
# L3 (SOUL, IDENTITY, TOOLS, USER) and L2 (BOOTSTRAP) are gitignored — only copy if missing.
for f in SOUL.md IDENTITY.md TOOLS.md USER.md; do
  [ ! -f "$RC_DIR/$f" ] && [ -f "$RC_DIR/$f.example" ] && \
    cp "$RC_DIR/$f.example" "$RC_DIR/$f" && dbg "$f initialized from template"
done
[ ! -f "workspace/MEMORY.md" ] && [ -f "workspace/MEMORY.md.example" ] && \
  cp "workspace/MEMORY.md.example" "workspace/MEMORY.md" && dbg "MEMORY.md initialized from template"
# NOTE: do NOT seed a root workspace/USER.md here. USER.md is relocatable —
# migratePromptFiles() seeds .ResearchClaw/USER.md (above) and leaves a root
# symlink pointing to it. Seeding a real root file would only get renamed to
# .bak by the migration, leaving a confusing remnant.
# BOOTSTRAP.md: only create if onboarding not yet completed (.done doesn't exist)
[ ! -f "$RC_DIR/BOOTSTRAP.md" ] && [ ! -f "$RC_DIR/BOOTSTRAP.md.done" ] && [ -f "$RC_DIR/BOOTSTRAP.md.example" ] && \
  cp "$RC_DIR/BOOTSTRAP.md.example" "$RC_DIR/BOOTSTRAP.md" && dbg "BOOTSTRAP.md initialized (first run)"

# Ensure `openclaw` CLI is available to agent's system.run commands.
# Without this, agent diagnostics (`openclaw doctor`, `openclaw plugins list`) fail
# with "command not found" because node_modules/.bin is not in PATH.
export PATH="$(pwd)/node_modules/.bin:$PATH"

# Rebuild RC extensions so gateway loads latest RPC (rc.ws.exists, review failed status, etc.).
if command -v pnpm >/dev/null 2>&1; then
  _BUILD_LOG=$(mktemp 2>/dev/null || echo "$RC_LOG_DIR/build-extensions.log")
  _T0=$(date +%s)
  if pnpm build:extensions >"$_BUILD_LOG" 2>&1; then
    say "✓ Extensions built ($(( $(date +%s) - _T0 ))s)"
    cat "$_BUILD_LOG" >>"$RC_RUN_LOG" 2>/dev/null || true
  else
    say "✗ Extension build failed — last 20 lines (full log: $RC_RUN_LOG):"
    cat "$_BUILD_LOG" >>"$RC_RUN_LOG" 2>/dev/null || true
    tail -20 "$_BUILD_LOG"
    rm -f "$_BUILD_LOG" 2>/dev/null || true
    exit 78
  fi
  rm -f "$_BUILD_LOG" 2>/dev/null || true
fi

if ! "$GW_NODE" ./scripts/runtime-preflight.cjs \
    --root "$(pwd)" --config "$OPENCLAW_CONFIG_PATH" --require-build \
    >>"$RC_RUN_LOG" 2>&1; then
  say "✗ Research-Claw Core build is not startable. Gateway was not launched."
  say "  Details: $RC_RUN_LOG"
  exit 78
fi

STOP=false
trap 'STOP=true' INT TERM

# Print access + log info ONCE up front. The gateway's own "ready / dashboard
# URL" lines are INFO level and hidden by consoleLevel=warn, so surface them here.
printf "\n  ${B}Dashboard:${N} http://127.0.0.1:$PORT/\n"
say "Logs: profile=$RC_RESOLVED_LOG_PROFILE · gateway file ~/.research-claw/logs/openclaw.log · startup $RC_RUN_LOG"
if [ "$RC_RESOLVED_LOG_PROFILE" = "user" ] && [ -z "$RC_LAUNCHER_VERBOSE" ]; then
  printf "  ${D}One-time debug: pnpm support${N}\n"
elif [ "$RC_RESOLVED_LOG_PROFILE" = "support" ]; then
  say "Support debug is temporary. Stop with Ctrl+C to create a redacted diagnostic bundle."
fi
printf "\n"

while true; do
  dbg "Starting Research-Claw gateway..."

  # Export HTTP(S)_PROXY from OpenClaw config so child processes (minimax-oauth-proxy)
  # can tunnel through the user's proxy (typically Clash at :7890).
  # The proxy uses HTTP CONNECT tunnels — Node's native https.request() ignores env vars,
  # but our proxy reads them explicitly.
  _PROXY_VAL=$("$GW_NODE" -e "
    try {
      const c = JSON.parse(require('fs').readFileSync(process.env.OPENCLAW_CONFIG_PATH, 'utf8'));
      const p = c?.env?.HTTPS_PROXY || c?.env?.HTTP_PROXY || c?.env?.vars?.HTTPS_PROXY || c?.env?.vars?.HTTP_PROXY || '';
      if (p) process.stdout.write(p);
    } catch {}
  " 2>/dev/null)
  if [ -n "$_PROXY_VAL" ]; then
    export HTTP_PROXY="$_PROXY_VAL"
    export HTTPS_PROXY="$_PROXY_VAL"
    # Never persist proxy userinfo in run-latest.log. Keep only scheme+host+port;
    # invalid/non-URL proxy forms are represented as "[configured]".
    _PROXY_SAFE=$(printf '%s' "$_PROXY_VAL" | \
      "$GW_NODE" ./scripts/diag-redact.mjs proxy - - 2>/dev/null)
    [ -n "$_PROXY_SAFE" ] || _PROXY_SAFE="[configured]"
    dbg "Proxy: $_PROXY_SAFE"
  fi

  # MiniMax OAuth (sk-cp-...) compatibility:
  # Start a local proxy that forwards requests to MiniMax with Authorization: Bearer <token>.
  # It is a no-op unless models.providers.minimax.apiKey starts with "sk-cp-".
  "$GW_NODE" ./scripts/minimax-oauth-proxy.mjs >/tmp/research-claw-minimax-oauth-proxy.log 2>&1 &
  PROXY_PID=$!

  "$GW_NODE" ./node_modules/openclaw/dist/entry.js \
    gateway run --allow-unconfigured --auth token --port "$PORT"
  CODE=$?

  # Stop proxy when gateway exits (gateway restart loop).
  kill "$PROXY_PID" >/dev/null 2>&1 || true

  if $STOP; then
    RC_NODE="$GW_NODE" bash "$(dirname "$0")/farewell.sh" || true
    if [ "$RC_RESOLVED_LOG_PROFILE" = "support" ]; then
      say "Creating redacted diagnostic bundle..."
      RC_NODE="$GW_NODE" bash "$(dirname "$0")/diag.sh" || \
        say "✗ Diagnostic bundle failed. Run: bash scripts/diag.sh"
    fi
    exit 0
  fi

  # Non-zero, non-signal exit is a crash — point the user at the logs to send us.
  if [ "$CODE" -ne 0 ]; then
    say "✗ Gateway exited (code $CODE). If it keeps failing, run:"
    say "    bash scripts/diag.sh          # bundles logs + redacted config to send us"
    say "    Direct logs: ~/.research-claw/logs/openclaw.log · Weixin legacy: /tmp/openclaw/openclaw-YYYY-MM-DD.log"
  fi
  say "Restarting in 3s..."
  sleep 3
done

#!/usr/bin/env bash
# Auto-restart wrapper for Research-Claw gateway.
# The gateway sends itself SIGUSR1 after config changes (API key, model, etc.)
# and exits, expecting an external supervisor to restart it.
#
# Usage:  ./scripts/run.sh          (or: pnpm serve)
# Stop:   Ctrl+C

cd "$(dirname "$0")/.."

# --- PID lock: prevent multiple run.sh instances from fighting ---
PIDFILE="/tmp/research-claw-gateway.pid"
if [ -f "$PIDFILE" ]; then
  OLD_PID=$(cat "$PIDFILE" 2>/dev/null)
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "[run] Another run.sh is already running (PID $OLD_PID). Stopping it first..."
    kill "$OLD_PID" 2>/dev/null || true
    # Give the gateway enough time for clean shutdown (WAL checkpoint, WS drain)
    # before forced kill. 10s is sufficient for the full close sequence.
    sleep 10
    kill -9 "$OLD_PID" 2>/dev/null || true
  fi
fi
echo $$ > "$PIDFILE"
cleanup_pid() { rm -f "$PIDFILE"; }
trap cleanup_pid EXIT

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

# --- Ensure project config exists ---
# RC project config contains plugin paths, tool whitelist, dashboard root, port 28789.
# Global ~/.openclaw/openclaw.json is vanilla OpenClaw and MUST NOT override these.
if [ ! -f config/openclaw.json ]; then
  if [ -f config/openclaw.example.json ]; then
    cp config/openclaw.example.json config/openclaw.json
    echo "[run] Config bootstrapped from template"
  else
    echo "[run] ERROR: config/openclaw.example.json not found" >&2
    exit 1
  fi
fi

# Always point OpenClaw to the project config.
# Without this, it reads ~/.openclaw/openclaw.json which has no RC settings.
export OPENCLAW_CONFIG_PATH="$(pwd)/config/openclaw.json"

# Token auth — must be set BEFORE ensure-config so it can align config to this value.
# Default 'research-claw' matches Dashboard's DEFAULT_TOKEN for zero-config local use.
# Remote users override via: export OPENCLAW_GATEWAY_TOKEN=my-secret (before pnpm serve)
# Docker users override via: docker run -e OPENCLAW_GATEWAY_TOKEN=my-secret ...
if [ -z "$OPENCLAW_GATEWAY_TOKEN" ]; then
  export OPENCLAW_GATEWAY_TOKEN=research-claw
fi

# --- Ensure config has all OC 2026.3.13+ required fields ---
# MUST run BEFORE path resolution so that newly added relative paths
# (e.g. ./extensions/openclaw-weixin) get converted to absolute below.
GLOBAL_CFG="$HOME/.openclaw/openclaw.json"
node "$(dirname "$0")/ensure-config.cjs" "$OPENCLAW_CONFIG_PATH" ${GLOBAL_CFG:+"$GLOBAL_CFG"} 2>/dev/null || true

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
if (changed) { const o=JSON.stringify(cfg,null,2)+'\n',t=f+'.tmp.'+process.pid; fs.writeFileSync(t,o); fs.renameSync(t,f); console.log('[run] Config paths resolved to absolute'); }
"

# --- Detect the correct Node for the gateway ---
# Priority: conda openclaw env (has matching ABI for better-sqlite3) → system node
GW_NODE="node"
if command -v conda &>/dev/null; then
  CONDA_OC_PREFIX="$(conda env list 2>/dev/null | grep "^openclaw " | awk '{print $NF}')"
  if [ -n "$CONDA_OC_PREFIX" ] && [ -x "$CONDA_OC_PREFIX/bin/node" ]; then
    GW_NODE="$CONDA_OC_PREFIX/bin/node"
  fi
fi

echo "[run] Using Node: $GW_NODE ($("$GW_NODE" -v))"
echo "[run] Config: $OPENCLAW_CONFIG_PATH"

# Sync RC settings → ~/.openclaw/openclaw.json so `openclaw gateway --force` also works.
# Direction: RC project config → global config (preserves user-only keys in global).
# Also fixes channels.*.commands.native=false (529 cmd limit).
"$GW_NODE" "$(dirname "$0")/sync-global-config.cjs" 2>/dev/null || true

# --- Initialize L2/L3 bootstrap runtime files from .example templates ---
# L1 (AGENTS, HEARTBEAT) are git-tracked and always up-to-date.
# L3 (SOUL, IDENTITY, TOOLS, USER) and L2 (BOOTSTRAP) are gitignored — only copy if missing.
RC_DIR="workspace/.ResearchClaw"
for f in SOUL.md IDENTITY.md TOOLS.md USER.md; do
  [ ! -f "$RC_DIR/$f" ] && [ -f "$RC_DIR/$f.example" ] && \
    cp "$RC_DIR/$f.example" "$RC_DIR/$f" && echo "[run] $f initialized from template"
done
[ ! -f "workspace/MEMORY.md" ] && [ -f "workspace/MEMORY.md.example" ] && \
  cp "workspace/MEMORY.md.example" "workspace/MEMORY.md" && echo "[run] MEMORY.md initialized from template"
[ ! -f "workspace/USER.md" ] && [ -f "workspace/USER.md.example" ] && \
  cp "workspace/USER.md.example" "workspace/USER.md" && echo "[run] USER.md initialized from template"
# BOOTSTRAP.md: only create if onboarding not yet completed (.done doesn't exist)
[ ! -f "$RC_DIR/BOOTSTRAP.md" ] && [ ! -f "$RC_DIR/BOOTSTRAP.md.done" ] && [ -f "$RC_DIR/BOOTSTRAP.md.example" ] && \
  cp "$RC_DIR/BOOTSTRAP.md.example" "$RC_DIR/BOOTSTRAP.md" && echo "[run] BOOTSTRAP.md initialized (first run)"

# Ensure `openclaw` CLI is available to agent's system.run commands.
# Without this, agent diagnostics (`openclaw doctor`, `openclaw plugins list`) fail
# with "command not found" because node_modules/.bin is not in PATH.
export PATH="$(pwd)/node_modules/.bin:$PATH"

STOP=false
trap 'STOP=true' INT TERM

while true; do
  # Token drift guard: if openclaw setup or manual edit changed the config token,
  # realign it to the env var. Only touches gateway.auth.token — no paths, no prefs.
  "$GW_NODE" -e "
    const fs=require('fs'),f=process.env.OPENCLAW_CONFIG_PATH;
    const e=process.env.OPENCLAW_GATEWAY_TOKEN||'research-claw';
    try{const c=JSON.parse(fs.readFileSync(f,'utf8'));
    if(c.gateway?.auth?.token&&c.gateway.auth.token!==e){
      c.gateway.auth.token=e;const t=f+'.tmp.'+process.pid;
      fs.writeFileSync(t,JSON.stringify(c,null,2)+'\n');fs.renameSync(t,f);
      console.log('[run] Token realigned to expected value');
    }}catch{}
  " 2>/dev/null || true

  echo "[run] Starting Research-Claw gateway..."

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
    echo "[run] Proxy: $HTTPS_PROXY"
  fi

  # MiniMax OAuth (sk-cp-...) compatibility:
  # Start a local proxy that forwards requests to MiniMax with Authorization: Bearer <token>.
  # It is a no-op unless models.providers.minimax.apiKey starts with "sk-cp-".
  "$GW_NODE" ./scripts/minimax-oauth-proxy.mjs >/tmp/research-claw-minimax-oauth-proxy.log 2>&1 &
  PROXY_PID=$!

  "$GW_NODE" ./node_modules/openclaw/dist/entry.js \
    gateway run --allow-unconfigured --auth token --port 28789 --force
  CODE=$?

  # Stop proxy when gateway exits (gateway restart loop).
  kill "$PROXY_PID" >/dev/null 2>&1 || true

  if $STOP; then
    echo "[run] Stopped."
    exit 0
  fi

  echo "[run] Gateway exited (code $CODE) — restarting in 3s..."
  sleep 3
done

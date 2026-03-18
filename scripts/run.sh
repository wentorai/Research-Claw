#!/usr/bin/env bash
# Auto-restart wrapper for Research-Claw gateway.
# The gateway sends itself SIGUSR1 after config changes (API key, model, etc.)
# and exits, expecting an external supervisor to restart it.
#
# Usage:  ./scripts/run.sh          (or: pnpm serve)
# Stop:   Ctrl+C

cd "$(dirname "$0")/.."

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
let changed = false;
if (cfg.plugins?.load?.paths?.some(p => !path.isAbsolute(p))) {
  cfg.plugins.load.paths = cfg.plugins.load.paths.map(abs); changed = true;
}
if (cfg.skills?.load?.extraDirs?.some(p => !path.isAbsolute(p))) {
  cfg.skills.load.extraDirs = cfg.skills.load.extraDirs.map(abs); changed = true;
}
if (cfg.gateway?.controlUi?.root && !path.isAbsolute(cfg.gateway.controlUi.root)) {
  cfg.gateway.controlUi.root = abs(cfg.gateway.controlUi.root); changed = true;
}
if (cfg.agents?.defaults?.workspace && !path.isAbsolute(cfg.agents.defaults.workspace)) {
  cfg.agents.defaults.workspace = abs(cfg.agents.defaults.workspace); changed = true;
}
if (changed) { fs.writeFileSync(f, JSON.stringify(cfg, null, 2) + '\n'); console.log('[run] Config paths resolved to absolute'); }
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

# --- Initialize L2/L3 bootstrap runtime files from .example templates ---
# L1 (AGENTS, SOUL, TOOLS, IDENTITY, HEARTBEAT) are git-tracked and always up-to-date.
# L2 (BOOTSTRAP.md) and L3 (USER.md, MEMORY.md) are gitignored — only copy if missing.
RC_DIR="workspace/.ResearchClaw"
[ ! -f "$RC_DIR/USER.md" ] && [ -f "$RC_DIR/USER.md.example" ] && \
  cp "$RC_DIR/USER.md.example" "$RC_DIR/USER.md" && echo "[run] USER.md initialized from template"
[ ! -f "workspace/MEMORY.md" ] && [ -f "workspace/MEMORY.md.example" ] && \
  cp "workspace/MEMORY.md.example" "workspace/MEMORY.md" && echo "[run] MEMORY.md initialized from template"
[ ! -f "workspace/USER.md" ] && [ -f "workspace/USER.md.example" ] && \
  cp "workspace/USER.md.example" "workspace/USER.md" && echo "[run] USER.md initialized from template"
# BOOTSTRAP.md: only create if onboarding not yet completed (.done doesn't exist)
[ ! -f "$RC_DIR/BOOTSTRAP.md" ] && [ ! -f "$RC_DIR/BOOTSTRAP.md.done" ] && [ -f "$RC_DIR/BOOTSTRAP.md.example" ] && \
  cp "$RC_DIR/BOOTSTRAP.md.example" "$RC_DIR/BOOTSTRAP.md" && echo "[run] BOOTSTRAP.md initialized (first run)"

# Token auth — matches Dashboard's DEFAULT_TOKEN ('research-claw').
export OPENCLAW_GATEWAY_TOKEN=research-claw

STOP=false
trap 'STOP=true' INT TERM

while true; do
  echo "[run] Starting Research-Claw gateway..."
  "$GW_NODE" ./node_modules/openclaw/dist/entry.js \
    gateway run --allow-unconfigured --auth token --port 28789 --force
  CODE=$?

  if $STOP; then
    echo "[run] Stopped."
    exit 0
  fi

  echo "[run] Gateway exited (code $CODE) — restarting in 3s..."
  sleep 3
done

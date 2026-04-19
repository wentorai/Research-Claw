#!/bin/sh
# Research-Claw Docker entrypoint with auto-restart.
# Gateway exits on SIGUSR1 after config save — this loop restarts it.

CONFIG_DIR=/app/config
CONFIG_FILE=$CONFIG_DIR/openclaw.json
CONFIG_VERSION_FILE=$CONFIG_DIR/.config-version
IMAGE_VERSION="0.6.3"
PORT=${PORT:-28789}

# --- One-time migration: v0.5.3 fixed volume mount from /root → /app ---
# Earlier versions mounted rc-data at /root/.research-claw but the plugin
# resolves dbPath to /app/.research-claw. Copy data to the correct path.
#
# Atomicity: copy to .migrating/ staging dir first, validate, then mv.
# If interrupted mid-copy, .migrating/ is cleaned up on next boot and
# migration retries (source still intact at /root/.research-claw).
if [ -f "/root/.research-claw/library.db" ] && [ ! -f "/app/.research-claw/library.db" ]; then
  MIGRATE_STAGING="/app/.research-claw.migrating"
  rm -rf "$MIGRATE_STAGING"
  mkdir -p "$MIGRATE_STAGING"
  if cp -a /root/.research-claw/* "$MIGRATE_STAGING/" 2>/dev/null && [ -f "$MIGRATE_STAGING/library.db" ]; then
    # Staging complete and validated — atomic move to final location
    mkdir -p /app/.research-claw
    mv "$MIGRATE_STAGING"/* /app/.research-claw/ 2>/dev/null
    rm -rf "$MIGRATE_STAGING"
    echo "[research-claw] Migrated database from /root/.research-claw → /app/.research-claw"
  else
    rm -rf "$MIGRATE_STAGING"
    echo "[research-claw] ERROR: Database migration failed — data preserved at /root/.research-claw"
    echo "[research-claw] Check disk space: df -h /app"
  fi
fi

# Seed config on fresh install; preserve user config on upgrade
mkdir -p "$CONFIG_DIR"
CURRENT_VERSION=""
if [ -f "$CONFIG_VERSION_FILE" ]; then
  CURRENT_VERSION=$(cat "$CONFIG_VERSION_FILE")
fi

if [ ! -f "$CONFIG_FILE" ]; then
  # Fresh install: seed from template
  cp /defaults/openclaw.example.json "$CONFIG_FILE"
  echo "$IMAGE_VERSION" > "$CONFIG_VERSION_FILE"
  echo "[research-claw] Config initialized for v$IMAGE_VERSION"
elif [ "$CURRENT_VERSION" != "$IMAGE_VERSION" ]; then
  # Upgrade: update version tracker but DON'T overwrite user config.
  # Docker-specific overrides + stale cleanup (below) handle migration.
  echo "$IMAGE_VERSION" > "$CONFIG_VERSION_FILE"
  echo "[research-claw] Upgraded to v$IMAGE_VERSION (config preserved)"
fi

# --- Migrate user settings from existing global OpenClaw config ---
# Docker mounts rc-state:/root/.openclaw which may contain a global
# openclaw.json from a previous vanilla OC Docker deployment.
# Same heuristic as native install.sh: only migrates if project config
# has NO model configured but global config DOES.
GLOBAL_CONFIG=/root/.openclaw/openclaw.json
if [ -f "$GLOBAL_CONFIG" ] && [ -f "$CONFIG_FILE" ]; then
  node -e "
    const fs = require('fs');
    const globalPath = '$GLOBAL_CONFIG';
    const projectPath = '$CONFIG_FILE';
    let g, p;
    try { g = JSON.parse(fs.readFileSync(globalPath, 'utf8')); } catch { process.exit(0); }
    try { p = JSON.parse(fs.readFileSync(projectPath, 'utf8')); } catch { process.exit(0); }

    const pModel = p.agents?.defaults?.model;
    const hasProjectModel = pModel && (typeof pModel === 'string' ? pModel.trim() : pModel.primary?.trim());
    if (hasProjectModel) process.exit(0);

    const gModel = g.agents?.defaults?.model;
    const hasGlobalModel = gModel && (typeof gModel === 'string' ? gModel.trim() : gModel.primary?.trim());
    const hasGlobalProviders = g.models?.providers && Object.keys(g.models.providers).length > 0;
    const hasGlobalChannels = g.channels && Object.keys(g.channels).length > 0;
    const hasGlobalProxy = g.env && (g.env.HTTP_PROXY || g.env.HTTPS_PROXY);
    if (!hasGlobalModel && !hasGlobalProviders && !hasGlobalChannels && !hasGlobalProxy) process.exit(0);

    let migrated = false;
    if (hasGlobalProviders) { if (!p.models) p.models = {}; p.models.providers = g.models.providers; migrated = true; }
    const gDefaults = g.agents?.defaults;
    if (hasGlobalModel) {
      if (!p.agents) p.agents = {}; if (!p.agents.defaults) p.agents.defaults = {};
      p.agents.defaults.model = gDefaults.model;
      if (gDefaults.imageModel) p.agents.defaults.imageModel = gDefaults.imageModel;
      migrated = true;
    }
    if (hasGlobalChannels) {
      const merged = { ...g.channels };
      if (p.channels) { for (const [k, v] of Object.entries(p.channels)) merged[k] = v; }
      const s = v => typeof v === 'string' && v.trim().length > 0 && !v.includes('<') && !v.includes('YOUR_');
      const hasCredential = (n, c) => {
        if (n === 'defaults' || typeof c !== 'object' || c === null) return true;
        if (n === 'telegram') return s(c.token) || s(c.botToken);
        if (n === 'discord') return s(c.token);
        if (n === 'feishu') return Object.values(c.accounts||{}).some(a => a && s(a.appId));
        if (n === 'slack') return s(c.token) || s(c.appToken);
        return true;
      };
      for (const [name, ch] of Object.entries(merged)) {
        if (!hasCredential(name, ch)) { delete merged[name]; continue; }
        if (name === 'defaults' || typeof ch !== 'object' || ch === null) continue;
        if (!ch.commands) ch.commands = {}; ch.commands.native = false;
      }
      if (Object.keys(merged).length > 0) { p.channels = merged; migrated = true; }
    }
    if (hasGlobalProxy || (g.env?.vars && Object.keys(g.env.vars).length > 0)) {
      if (!p.env) p.env = {};
      if (g.env.HTTP_PROXY) p.env.HTTP_PROXY = g.env.HTTP_PROXY;
      if (g.env.HTTPS_PROXY) p.env.HTTPS_PROXY = g.env.HTTPS_PROXY;
      if (g.env.vars && Object.keys(g.env.vars).length > 0) p.env.vars = { ...(p.env.vars || {}), ...g.env.vars };
      migrated = true;
    }
    if (!migrated) process.exit(0);
    const output = JSON.stringify(p, null, 2) + '\n';
    try { JSON.parse(output); } catch { process.exit(1); }
    const tmp = projectPath + '.tmp.' + process.pid;
    fs.writeFileSync(tmp, output);
    try { JSON.parse(fs.readFileSync(tmp, 'utf8')); } catch { fs.unlinkSync(tmp); process.exit(1); }
    fs.renameSync(tmp, projectPath);
    const parts = [];
    if (hasGlobalProviders) parts.push('models');
    if (hasGlobalModel) parts.push('model');
    if (hasGlobalChannels) parts.push('channels');
    if (hasGlobalProxy) parts.push('proxy');
    console.log('[research-claw] Migrated from global: ' + parts.join(', '));
  " 2>/dev/null || true
fi

# --- Docker-specific config overrides ---
# The config template is designed for native (loopback) use. Docker requires:
#   - bind: "lan" (container must be reachable from host via port mapping)
#   - dangerouslyAllowHostHeaderOriginFallback: true (OC v2026.2.26+ requires
#     explicit allowedOrigins for non-loopback; Host-header fallback is safe
#     because Docker Desktop only exposes the mapped port to localhost)
#   - dangerouslyDisableDeviceAuth: true (no device pairing in Docker)
# Shared config cleanup: plugins.allow, discovery.mdns, stale entries, auth token
node /app/scripts/ensure-config.cjs "$CONFIG_FILE" 2>/dev/null || true

# Docker-specific config patches (not in ensure-config.cjs — Docker only)
node -e "
  const fs = require('fs');
  const f = '$CONFIG_FILE';
  const c = JSON.parse(fs.readFileSync(f, 'utf8'));
  let changed = false;

  // Gateway: ensure Docker-compatible settings
  if (!c.gateway) c.gateway = {};
  if (c.gateway.bind !== 'lan') { c.gateway.bind = 'lan'; changed = true; }
  if (!c.gateway.controlUi) c.gateway.controlUi = {};
  if (!c.gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback) {
    c.gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback = true;
    changed = true;
  }
  if (!c.gateway.controlUi.dangerouslyDisableDeviceAuth) {
    c.gateway.controlUi.dangerouslyDisableDeviceAuth = true;
    changed = true;
  }

  // Set default gateway auth token if none exists.
  // Never overwrite — respects user-customized tokens for remote deployments.
  // Docker users override via: docker run -e OPENCLAW_GATEWAY_TOKEN=my-secret ...
  if (!c.gateway.auth) c.gateway.auth = {};
  if (!c.gateway.auth.token) {
    c.gateway.auth.token = process.env.OPENCLAW_GATEWAY_TOKEN || 'research-claw';
    changed = true;
  }
  if (c.gateway.auth.mode && c.gateway.auth.mode !== 'token') {
    c.gateway.auth.mode = 'token';
    changed = true;
  }

  // Plugin dbPath: Docker volume rc-data mounts at /app/.research-claw.
  // ensure-config.cjs normalizes dbPath to os.homedir() (/root in container),
  // which is NOT on the volume — database would be lost on container recreation.
  // Force the volume-backed path so data persists across upgrades.
  const DOCKER_DB_PATH = '/app/.research-claw/library.db';
  const rcEntry = c.plugins?.entries?.['research-claw-core'];
  if (rcEntry) {
    if (!rcEntry.config) { rcEntry.config = {}; changed = true; }
    if (rcEntry.config.dbPath !== DOCKER_DB_PATH) {
      rcEntry.config.dbPath = DOCKER_DB_PATH;
      changed = true;
    }
  }

  if (changed) { const o=JSON.stringify(c,null,2)+'\n',t=f+'.tmp.'+process.pid; fs.writeFileSync(t,o); fs.renameSync(t,f); }
" 2>&1 || echo "[research-claw] WARNING: Config patch failed — gateway may not start correctly"

# --- Resolve relative paths to absolute (prevents CWD drift during agent runs) ---
# Agent process.chdir(workspace/) changes CWD; relative paths in config break.
node -e "
  const fs = require('fs'), path = require('path');
  const f = '$CONFIG_FILE';
  const cfg = JSON.parse(fs.readFileSync(f, 'utf8'));
  const root = '/app';
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
  if (changed) { const o=JSON.stringify(cfg,null,2)+'\n',t=f+'.tmp.'+process.pid; fs.writeFileSync(t,o); fs.renameSync(t,f); }
" 2>/dev/null || true

# --- Sync research-plugins from image → volume if version differs ---
# rc-state volume persists /root/.openclaw/ across container recreation.
# On image upgrade, the baked-in plugin version may be newer than the volume's.
IMAGE_RP_VER=$(cat /defaults/rp-version.txt 2>/dev/null || true)
VOL_RP_VER=$(node -e "console.log(require('/root/.openclaw/extensions/research-plugins/package.json').version)" 2>/dev/null || true)
if [ -n "$IMAGE_RP_VER" ] && [ "$IMAGE_RP_VER" != "$VOL_RP_VER" ]; then
  echo "[research-claw] Updating research-plugins: ${VOL_RP_VER:-none} → $IMAGE_RP_VER"
  echo '{}' > /tmp/rp-update.json
  OPENCLAW_CONFIG_PATH=/tmp/rp-update.json \
    node /app/node_modules/openclaw/dist/entry.js \
    plugins install @wentorai/research-plugins >/dev/null 2>&1 || true
  rm -f /tmp/rp-update.json
fi

# --- Sync bootstrap prompt files from image → volume ---
RC_DIR=/app/workspace/.ResearchClaw
BP=/defaults/bootstrap-prompts
mkdir -p "$RC_DIR"
# L1 system prompts: always force-update from image (safe — no user data).
for f in AGENTS.md HEARTBEAT.md; do
  [ -f "$BP/$f" ] && cp "$BP/$f" "$RC_DIR/$f"
done
# L3 user-owned files: only initialize if missing (never overwrite user customizations).
for f in SOUL.md IDENTITY.md TOOLS.md USER.md; do
  [ ! -f "$RC_DIR/$f" ] && [ -f "$BP/$f.example" ] && cp "$BP/$f.example" "$RC_DIR/$f"
done
# L2 onboarding: only create if not yet completed (.done absent)
if [ ! -f "$RC_DIR/BOOTSTRAP.md" ] && [ ! -f "$RC_DIR/BOOTSTRAP.md.done" ] && [ -f "$BP/BOOTSTRAP.md.example" ]; then
  cp "$BP/BOOTSTRAP.md.example" "$RC_DIR/BOOTSTRAP.md"
fi
[ ! -f /app/workspace/MEMORY.md ] && [ -f "$BP/MEMORY.md.example" ] && cp "$BP/MEMORY.md.example" /app/workspace/MEMORY.md
[ ! -f /app/workspace/USER.md ] && [ -f "$BP/ws-USER.md.example" ] && cp "$BP/ws-USER.md.example" /app/workspace/USER.md

# Token: config file is source of truth; env var is a convenience override.
# Override via env: docker run -e OPENCLAW_GATEWAY_TOKEN=your-secret ...
if [ -z "$OPENCLAW_GATEWAY_TOKEN" ]; then
  OPENCLAW_GATEWAY_TOKEN=$(node -e "
    try { const c = JSON.parse(require('fs').readFileSync('/app/config/openclaw.json', 'utf8'));
      if (c.gateway?.auth?.token) console.log(c.gateway.auth.token);
    } catch {}
  " 2>/dev/null)
  export OPENCLAW_GATEWAY_TOKEN="${OPENCLAW_GATEWAY_TOKEN:-research-claw}"
fi

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

echo "[research-claw] Starting gateway on port $PORT..."
echo "[research-claw] Open dashboard: http://127.0.0.1:$PORT/?token=$OPENCLAW_GATEWAY_TOKEN"
echo "[research-claw] Gateway token: $OPENCLAW_GATEWAY_TOKEN"
echo "[research-claw] (Tip: set OPENCLAW_GATEWAY_TOKEN env var for a fixed token)"

# Ensure `openclaw` CLI and conda Python are available to agent's system.run commands.
export PATH="/opt/miniforge3/bin:/app/node_modules/.bin:$PATH"

# --- Detect scientific environment ---
# Log what's available so users can verify in `docker logs`.
if command -v python3 >/dev/null 2>&1; then
  PY_VER="$(python3 --version 2>&1 | awk '{print $2}')"
  echo "[research-claw] Python: $PY_VER (Miniforge3)"
fi
if [ -x /usr/bin/chromium ]; then
  echo "[research-claw] Chromium: headless (OC browser tool)"
fi
if [ -f /host/zotero/zotero.sqlite ]; then
  echo "[research-claw] Zotero: detected at /host/zotero"
elif [ -d /host/zotero ]; then
  echo "[research-claw] Zotero: mount present but no database found (~/Zotero empty on host?)"
fi

STOP=false
trap 'STOP=true' INT TERM

while true; do
  # MiniMax OAuth (sk-cp-...) compatibility proxy (no-op unless configured).
  node /app/scripts/minimax-oauth-proxy.mjs >/tmp/research-claw-minimax-oauth-proxy.log 2>&1 &
  PROXY_PID=$!

  OPENCLAW_CONFIG_PATH=$CONFIG_FILE \
    node /app/node_modules/openclaw/dist/entry.js \
    gateway run --allow-unconfigured --auth token --port $PORT --bind lan --force
  CODE=$?

  kill "$PROXY_PID" >/dev/null 2>&1 || true

  if [ "$STOP" = "true" ]; then
    exit 0
  fi

  echo "[research-claw] Gateway exited (code $CODE) — restarting in 3s..."
  sleep 3
done

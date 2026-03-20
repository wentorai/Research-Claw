#!/bin/sh
# Research-Claw Docker entrypoint with auto-restart.
# Gateway exits on SIGUSR1 after config save — this loop restarts it.

CONFIG_DIR=/app/config
CONFIG_FILE=$CONFIG_DIR/openclaw.json
CONFIG_VERSION_FILE=$CONFIG_DIR/.config-version
IMAGE_VERSION="0.5.6"
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
      for (const [name, ch] of Object.entries(merged)) {
        if (name === 'defaults' || typeof ch !== 'object' || ch === null) continue;
        if (!ch.commands) ch.commands = {}; ch.commands.native = false;
      }
      p.channels = merged; migrated = true;
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
# Also clean stale entries that cause warnings on every boot.
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

  // Force gateway auth token to match OPENCLAW_GATEWAY_TOKEN env var.
  // Without this, stale gateway.auth.token in persisted config overrides env var
  // → token_mismatch on every connection (P0 bug for v0.5.0→v0.5.6 upgraders).
  const expectedToken = process.env.OPENCLAW_GATEWAY_TOKEN || 'research-claw';
  if (!c.gateway.auth) c.gateway.auth = {};
  if (c.gateway.auth.token !== expectedToken) {
    c.gateway.auth.token = expectedToken;
    changed = true;
  }
  if (c.gateway.auth.mode && c.gateway.auth.mode !== 'token') {
    c.gateway.auth.mode = 'token';
    changed = true;
  }

  // Clean stale plugin entries (wentor-connect is a placeholder, never functional)
  if (c.plugins?.entries?.['wentor-connect']) {
    delete c.plugins.entries['wentor-connect'];
    changed = true;
  }
  // v0.5.2+: auto-discover replaces plugins.allow whitelist
  if (c.plugins?.allow) {
    delete c.plugins.allow;
    changed = true;
  }

  // Clean stale tool names from alsoAllow
  const STALE_TOOLS = ['search_papers', 'get_paper', 'get_citations',
    'radar_configure', 'radar_get_config', 'radar_scan'];
  if (c.tools?.alsoAllow) {
    const before = c.tools.alsoAllow.length;
    c.tools.alsoAllow = c.tools.alsoAllow.filter(t => !STALE_TOOLS.includes(t));
    if (c.tools.alsoAllow.length !== before) changed = true;
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
# L1 system prompts: always force-update from image (safe — no user data).
RC_DIR=/app/workspace/.ResearchClaw
BP=/defaults/bootstrap-prompts
mkdir -p "$RC_DIR"
for f in AGENTS.md SOUL.md TOOLS.md IDENTITY.md HEARTBEAT.md; do
  [ -f "$BP/$f" ] && cp "$BP/$f" "$RC_DIR/$f"
done
# L2 onboarding: only create if not yet completed (.done absent)
if [ ! -f "$RC_DIR/BOOTSTRAP.md" ] && [ ! -f "$RC_DIR/BOOTSTRAP.md.done" ] && [ -f "$BP/BOOTSTRAP.md.example" ]; then
  cp "$BP/BOOTSTRAP.md.example" "$RC_DIR/BOOTSTRAP.md"
fi
# L3 user data: only initialize if missing (never overwrite)
[ ! -f "$RC_DIR/USER.md" ] && [ -f "$BP/USER.md.example" ] && cp "$BP/USER.md.example" "$RC_DIR/USER.md"
[ ! -f /app/workspace/MEMORY.md ] && [ -f "$BP/MEMORY.md.example" ] && cp "$BP/MEMORY.md.example" /app/workspace/MEMORY.md
[ ! -f /app/workspace/USER.md ] && [ -f "$BP/ws-USER.md.example" ] && cp "$BP/ws-USER.md.example" /app/workspace/USER.md

# Default gateway token matches dashboard's DEFAULT_TOKEN for seamless access.
# Override via env: docker run -e OPENCLAW_GATEWAY_TOKEN=your-secret ...
if [ -z "$OPENCLAW_GATEWAY_TOKEN" ]; then
  OPENCLAW_GATEWAY_TOKEN="research-claw"
  export OPENCLAW_GATEWAY_TOKEN
fi

echo "[research-claw] Starting gateway on port $PORT..."
echo "[research-claw] Open dashboard: http://127.0.0.1:$PORT/?token=$OPENCLAW_GATEWAY_TOKEN"
echo "[research-claw] Gateway token: $OPENCLAW_GATEWAY_TOKEN"
echo "[research-claw] (Tip: set OPENCLAW_GATEWAY_TOKEN env var for a fixed token)"

# Ensure `openclaw` CLI is available to agent's system.run commands.
export PATH="/app/node_modules/.bin:$PATH"

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

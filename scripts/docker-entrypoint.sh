#!/bin/sh
# Research-Claw Docker entrypoint with auto-restart.
# Gateway exits on SIGUSR1 after config save — this loop restarts it.

CONFIG_DIR=/app/config
CONFIG_FILE=$CONFIG_DIR/openclaw.json
CONFIG_VERSION_FILE=$CONFIG_DIR/.config-version
IMAGE_VERSION="0.7.5"
PORT=${PORT:-28789}

# Entrypoint chatter discipline: the GATEWAY's own output stays full in
# `docker logs` (that's the container's diagnostic channel — never filtered).
# Only the entrypoint's OWN step detail is gated: dbg() lines show only with
# RC_VERBOSE=1. Keeps a clean first screen without hiding gateway diagnostics.
dbg() { [ -n "$RC_VERBOSE" ] && echo "$@" || true; }

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

# Docker-only config patch. File-log level is raised to info only when it is
# missing/quieter; explicit debug/trace survives. Paths travel through argv,
# never through interpolated JavaScript source.
node /app/scripts/docker-config-patch.cjs "$CONFIG_FILE" 2>&1 || \
  echo "[research-claw] WARNING: Config patch failed — gateway may not start correctly"

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

# --- Ensure research-plugins is in plugins.load.paths (Docker only) ---
# RP lives at /root/.openclaw/extensions/research-plugins (rc-state volume) — NOT under
# /app/extensions where OC discovers the baked path plugins, and not in the config
# template's load.paths. Without an explicit load-path entry it is allow-listed but never
# loaded, silently losing all 34 agent tools (SkillSearch still indexes its catalog).
# Native installs auto-discover ~/.openclaw/extensions, so this gap is Docker-specific.
# Idempotent: matched by suffix so re-runs don't duplicate.
node -e "
  const fs = require('fs');
  const f = '$CONFIG_FILE', rp = '/root/.openclaw/extensions/research-plugins';
  const cfg = JSON.parse(fs.readFileSync(f, 'utf8'));
  if (!cfg.plugins) cfg.plugins = {};
  if (!cfg.plugins.load) cfg.plugins.load = {};
  if (!Array.isArray(cfg.plugins.load.paths)) cfg.plugins.load.paths = [];
  if (!cfg.plugins.load.paths.some(p => p === rp || p.endsWith('/extensions/research-plugins'))) {
    cfg.plugins.load.paths.push(rp);
    const o = JSON.stringify(cfg, null, 2) + '\n', t = f + '.tmp.' + process.pid;
    fs.writeFileSync(t, o); fs.renameSync(t, f);
    if (process.env.RC_VERBOSE) console.log('[research-claw] Added research-plugins to plugins.load.paths');
  }
" 2>/dev/null || true

# --- Sync research-plugins from image → volume if version differs ---
# rc-state volume persists /root/.openclaw/ across container recreation.
# On image upgrade, the baked-in plugin version may be newer than the volume's.
# Copy from /defaults/research-plugins/ (baked in image, not shadowed by volume)
# instead of npm install (avoids silent network failures in China/offline).
IMAGE_RP_VER=$(cat /defaults/rp-version.txt 2>/dev/null || true)
VOL_RP_VER=$(node -e "console.log(require('/root/.openclaw/extensions/research-plugins/package.json').version)" 2>/dev/null || true)
# Guard on /defaults/research-plugins existing: never rm a good volume install
# when the baked source is missing (would leave SkillSearch permanently broken).
if [ -d /defaults/research-plugins ] && [ -n "$IMAGE_RP_VER" ] && [ "$IMAGE_RP_VER" != "$VOL_RP_VER" ]; then
  echo "[research-claw] Updating research-plugins: ${VOL_RP_VER:-none} → $IMAGE_RP_VER"
  mkdir -p /root/.openclaw/extensions
  rm -rf /root/.openclaw/extensions/research-plugins
  cp -a /defaults/research-plugins /root/.openclaw/extensions/research-plugins
fi

# --- Sync bootstrap prompt files from image → volume ---
RC_DIR=/app/workspace/.ResearchClaw
BP=/defaults/bootstrap-prompts
mkdir -p "$RC_DIR"
# L1 system prompts (AGENTS/HEARTBEAT): version-gated refresh of the
# .ResearchClaw/ canonical copy, same pattern as the openclaw.json handling
# above — update on fresh install or version change, re-seed if missing,
# no rewrite on a same-version restart. L1 files are system-managed machine
# contracts (no .example = system-owned); user customization belongs in L3.
# $CURRENT_VERSION still holds the pre-upgrade version captured earlier.
for f in AGENTS.md HEARTBEAT.md; do
  if [ -f "$BP/$f" ] && { [ "$CURRENT_VERSION" != "$IMAGE_VERSION" ] || [ ! -f "$RC_DIR/$f" ]; }; then
    cp "$BP/$f" "$RC_DIR/$f"
  fi
done
# Only HEARTBEAT.md is mirrored to the workspace root — OC's heartbeat system
# reads workspace/HEARTBEAT.md directly and the pnpm patch doesn't cover
# health-DSTtGBUV.js. AGENTS.md (and the other relocatable prompts) get a
# workspace-root SYMLINK from migratePromptFiles() instead.
[ -f "$BP/HEARTBEAT.md" ] && cp "$BP/HEARTBEAT.md" /app/workspace/HEARTBEAT.md
# L3 user-owned files: only initialize if missing (never overwrite user customizations).
for f in SOUL.md IDENTITY.md TOOLS.md USER.md; do
  [ ! -f "$RC_DIR/$f" ] && [ -f "$BP/$f.example" ] && cp "$BP/$f.example" "$RC_DIR/$f"
done
# L2 onboarding: only create if not yet completed (.done absent)
if [ ! -f "$RC_DIR/BOOTSTRAP.md" ] && [ ! -f "$RC_DIR/BOOTSTRAP.md.done" ] && [ -f "$BP/BOOTSTRAP.md.example" ]; then
  cp "$BP/BOOTSTRAP.md.example" "$RC_DIR/BOOTSTRAP.md"
fi
[ ! -f /app/workspace/MEMORY.md ] && [ -f "$BP/MEMORY.md.example" ] && cp "$BP/MEMORY.md.example" /app/workspace/MEMORY.md
# NOTE: do NOT seed a root workspace/USER.md — USER.md is relocatable, so
# migratePromptFiles() seeds .ResearchClaw/USER.md and leaves a root symlink.
# A real root file would only be renamed to .bak by the migration.

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

echo "[research-claw] Dashboard: http://127.0.0.1:$PORT/?token=$OPENCLAW_GATEWAY_TOKEN"
dbg "[research-claw] Gateway token: $OPENCLAW_GATEWAY_TOKEN (override via -e OPENCLAW_GATEWAY_TOKEN=…)"

# Ensure `openclaw` CLI and conda Python are available to agent's system.run commands.
export PATH="/opt/miniforge3/bin:/app/node_modules/.bin:$PATH"

# --- Detect scientific environment (verbose only; gateway log records the rest) ---
if command -v python3 >/dev/null 2>&1; then
  dbg "[research-claw] Python: $(python3 --version 2>&1 | awk '{print $2}') (Miniforge3)"
fi
[ -x /usr/bin/chromium ] && dbg "[research-claw] Chromium: headless (OC browser tool)"
if [ -f /host/zotero/zotero.sqlite ]; then
  dbg "[research-claw] Zotero: detected at /host/zotero"
elif [ -d /host/zotero ]; then
  dbg "[research-claw] Zotero: mount present but no database found (~/Zotero empty on host?)"
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

  if [ "$CODE" -ne 0 ]; then
    echo "[research-claw] ✗ Gateway exited (code $CODE). If it keeps failing, capture:"
    echo "[research-claw]     docker logs <container>                          (this output)"
    echo "[research-claw]     /app/.research-claw/logs/openclaw.log            (full gateway log, on rc-data volume)"
  fi
  echo "[research-claw] Restarting in 3s..."
  sleep 3
done

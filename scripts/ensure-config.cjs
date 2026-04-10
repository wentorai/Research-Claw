#!/usr/bin/env node
/**
 * ensure-config.cjs — Shared config cleanup/migration for RC v0.5.6+ (OC 2026.3.13)
 *
 * Called by: run.sh, install.sh, docker-entrypoint.sh
 * Purpose:  Ensure the RC project config contains all fields required by the
 *           current OC version.  Idempotent — safe to call on every startup.
 *
 * Usage:    node scripts/ensure-config.cjs <config-path> [<config-path-2> ...]
 *
 * Fixes applied (all idempotent):
 *   1. plugins.allow — OC 2026.3.12+ requires explicit trust list
 *   2. discovery.mdns/wideArea — OC 2026.3.13 mDNS crash prevention
 *   3. Stale plugin entries (wentor-connect placeholder)
 *   4. tools.alsoAllow — remove entirely (redundant with profile "full")
 *   5. gateway.auth.token alignment with Dashboard DEFAULT_TOKEN
 *   6. channels.discord.botToken → token (fix stale example config key)
 *  10. agents.defaults.sandbox.mode = "off" (RC has no Docker sandbox)
 *  14. plugins.installs — provenance records for loaded plugins
 *  15. dangerouslyDisableDeviceAuth — remove (unnecessary on loopback)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const REQUIRED_ALLOW = ['research-claw-core', 'research-plugins', 'openclaw-weixin'];
const RC_PLUGIN_IDS = ['research-claw-core', 'openclaw-weixin', 'research-plugins'];
const RC_EXTENSION_DIRS = ['extensions/research-claw-core', 'extensions/openclaw-weixin'];
const RC_DB_PATH = path.join(os.homedir(), '.research-claw', 'library.db');
// Provenance install records for all RC plugins (eliminates "loaded without
// install/load-path provenance" warnings from OC's plugin loader)
const PLUGIN_INSTALL_RECORDS = {
  'research-claw-core': { source: 'path', sourcePath: './extensions/research-claw-core' },
  'openclaw-weixin':    { source: 'path', sourcePath: './extensions/openclaw-weixin' },
  'research-plugins':   { source: 'npm',  spec: '@wentorai/research-plugins',
                          installPath: '~/.openclaw/extensions/research-plugins' },
};

function normalizeRcDbPath(configPath, rawPath) {
  if (!rawPath || typeof rawPath !== 'string') return RC_DB_PATH;

  const projectRoot = path.resolve(path.dirname(configPath), '..');
  const legacyRel = '.research-claw/library.db';
  const legacyAbs = path.join(projectRoot, '.research-claw', 'library.db');
  const normalized = rawPath.trim();

  if (
    normalized === legacyRel ||
    normalized === '~/.research-claw/library.db' ||
    normalized === '$HOME/.research-claw/library.db' ||
    normalized === legacyAbs
  ) {
    return RC_DB_PATH;
  }

  if (path.isAbsolute(normalized) && normalized.startsWith(path.join(projectRoot, '.research-claw') + path.sep)) {
    return RC_DB_PATH;
  }

  return normalized;
}

function ensureConfig(filePath) {
  if (!fs.existsSync(filePath)) return false;

  let c;
  try {
    c = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return false; // Don't crash on corrupted config — let gateway report it
  }

  let changed = false;

  // Detect global config: RC-specific plugin paths/entries must NOT be written here.
  // OC 2026.3.28+ strictly validates plugins.load.paths — RC extension paths in the
  // global config cause "Config invalid" fatal errors for standalone openclaw users.
  const globalDir = path.join(os.homedir(), '.openclaw');
  const isGlobal = path.resolve(filePath).startsWith(globalDir);

  // 0. Global config cleanup — remove previously synced RC-specific plugin data
  if (isGlobal) {
    // Remove RC plugin IDs from plugins.allow
    if (Array.isArray(c.plugins?.allow)) {
      const before = c.plugins.allow.length;
      c.plugins.allow = c.plugins.allow.filter(id => !RC_PLUGIN_IDS.includes(id));
      if (c.plugins.allow.length !== before) changed = true;
    }
    // Remove RC extension paths from plugins.load.paths
    if (Array.isArray(c.plugins?.load?.paths)) {
      const before = c.plugins.load.paths.length;
      c.plugins.load.paths = c.plugins.load.paths.filter(p =>
        !RC_EXTENSION_DIRS.some(d => p === './' + d || p.endsWith('/' + d))
      );
      if (c.plugins.load.paths.length !== before) changed = true;
    }
    // Remove RC plugin entries
    if (c.plugins?.entries) {
      for (const id of RC_PLUGIN_IDS) {
        if (c.plugins.entries[id]) { delete c.plugins.entries[id]; changed = true; }
      }
    }
  }

  // 1. plugins.allow — append missing required IDs (project config only)
  if (!isGlobal) {
    if (!c.plugins) c.plugins = {};
    if (!Array.isArray(c.plugins.allow)) c.plugins.allow = [];
    for (const id of REQUIRED_ALLOW) {
      if (!c.plugins.allow.includes(id)) {
        c.plugins.allow.push(id);
        changed = true;
      }
    }
  }

  // 2. discovery — disable mDNS and wideArea (RC doesn't need device discovery)
  if (!c.discovery) c.discovery = {};
  if (c.discovery.mdns?.mode !== 'off') {
    c.discovery.mdns = { mode: 'off' };
    changed = true;
  }
  if (c.discovery.wideArea?.enabled !== false) {
    c.discovery.wideArea = { enabled: false };
    changed = true;
  }

  // 3. Remove stale wentor-connect plugin (placeholder, never functional)
  if (c.plugins?.entries?.['wentor-connect']) {
    delete c.plugins.entries['wentor-connect'];
    changed = true;
  }
  // 3b. Also purge wentor-connect from allow list
  if (Array.isArray(c.plugins?.allow) && c.plugins.allow.includes('wentor-connect')) {
    c.plugins.allow = c.plugins.allow.filter(id => id !== 'wentor-connect');
    changed = true;
  }
  // 3c. Also purge wentor-connect from load paths
  if (Array.isArray(c.plugins?.load?.paths)) {
    const before = c.plugins.load.paths.length;
    c.plugins.load.paths = c.plugins.load.paths.filter(p => !p.includes('wentor-connect'));
    if (c.plugins.load.paths.length !== before) changed = true;
  }

  // 4. Remove tools.alsoAllow entirely — redundant with profile "full".
  //    OC's "full" profile skips the tool-policy step (empty policy → undefined),
  //    meaning ALL tools (core + plugin) are allowed. alsoAllow entries were never
  //    evaluated but triggered "unknown entries" warnings at config-parse time
  //    because plugin tools aren't registered yet at that point.
  if (c.tools?.alsoAllow) {
    delete c.tools.alsoAllow;
    changed = true;
  }

  // 5. gateway.auth.token must match the expected token (env var or default 'research-claw').
  //    This aligns config to the runtime token so OC's config-first precedence doesn't
  //    pick up a stale token from a previous openclaw setup or manual edit.
  const expectedToken = process.env.OPENCLAW_GATEWAY_TOKEN || 'research-claw';
  if (c.gateway?.auth) {
    if (c.gateway.auth.token && c.gateway.auth.token !== expectedToken) {
      c.gateway.auth.token = expectedToken;
      changed = true;
    }
    if (c.gateway.auth.mode && c.gateway.auth.mode !== 'none' && c.gateway.auth.mode !== 'token') {
      c.gateway.auth.mode = 'token';
      changed = true;
    }
  }

  // 6. channels.discord: rename botToken → token (example config had wrong key;
  //    OC Discord schema always used `token`, but strict validation was silent before 2026.3.13)
  if (c.channels?.discord?.botToken && !c.channels.discord.token) {
    c.channels.discord.token = c.channels.discord.botToken;
    delete c.channels.discord.botToken;
    changed = true;
  } else if (c.channels?.discord?.botToken) {
    // token already exists, just remove the stale key
    delete c.channels.discord.botToken;
    changed = true;
  }

  // 7. Remove node_modules references from plugin load paths
  if (c.plugins?.load?.paths) {
    const before = c.plugins.load.paths.length;
    c.plugins.load.paths = c.plugins.load.paths.filter(p => !p.includes('node_modules'));
    if (c.plugins.load.paths.length !== before) changed = true;
  }

  // 8. plugins.load.paths — ensure openclaw-weixin is discoverable (project config only)
  // Match by directory suffix, not exact string — paths may be absolute from a previous run.
  if (!isGlobal) {
    if (!c.plugins) c.plugins = {};
    if (!c.plugins.load) c.plugins.load = {};
    if (!Array.isArray(c.plugins.load.paths)) c.plugins.load.paths = [];
    for (const dir of RC_EXTENSION_DIRS) {
      const alreadyPresent = c.plugins.load.paths.some(p =>
        p === './' + dir || p.endsWith('/' + dir)
      );
      if (!alreadyPresent) {
        c.plugins.load.paths.push('./' + dir);
        changed = true;
      }
    }
  }

  // 8b. Deduplicate plugin load paths (stale re-roots can leave duplicates)
  if (c.plugins?.load?.paths) {
    const unique = [...new Set(c.plugins.load.paths)];
    if (unique.length !== c.plugins.load.paths.length) {
      c.plugins.load.paths = unique;
      changed = true;
    }
  }

  // 9. Restore critical RC fields if missing (safety net for config.apply stripping)
  if (!c.gateway) c.gateway = {};
  if (!c.gateway.controlUi) {
    c.gateway.controlUi = {
      root: './dashboard/dist',
      allowedOrigins: [
        'http://127.0.0.1:28789', 'http://localhost:28789',
        'http://127.0.0.1:5175', 'http://localhost:5175',
      ],
    };
    changed = true;
  }
  if (!c.gateway.auth || !c.gateway.auth.mode) {
    c.gateway.auth = { mode: 'none' };
    changed = true;
  }
  if (!c.gateway.port) { c.gateway.port = 28789; changed = true; }
  if (!c.gateway.mode) { c.gateway.mode = 'local'; changed = true; }
  if (!c.gateway.bind) { c.gateway.bind = 'loopback'; changed = true; }
  if (!c.ui) { c.ui = { assistant: { name: 'Research-Claw' } }; changed = true; }
  if (!c.skills) { c.skills = { load: { extraDirs: ['./skills'] } }; changed = true; }
  if (!c.cron) { c.cron = { enabled: true }; changed = true; }

  // 10. Sandbox — force off. RC is a local desktop app; native installs don't have Docker,
  //     Docker installs don't need nested Docker. Global config from a previous OC Docker
  //     setup may carry sandbox.mode="non-main" which crashes agents on launch.
  if (!c.agents) c.agents = {};
  if (!c.agents.defaults) c.agents.defaults = {};
  if (!c.agents.defaults.sandbox || c.agents.defaults.sandbox.mode !== 'off') {
    if (!c.agents.defaults.sandbox) c.agents.defaults.sandbox = {};
    c.agents.defaults.sandbox.mode = 'off';
    changed = true;
  }

  // 10b. Agent timeout — cap at 300s (5 min). The original 900s (15 min)
  //      causes unrecoverable hangs when the model API is unresponsive.
  //      OC default (600s) is also too long; RC uses faster failover.
  const RC_TIMEOUT_SECONDS = 300;
  if (!c.agents.defaults.timeoutSeconds || c.agents.defaults.timeoutSeconds > RC_TIMEOUT_SECONDS) {
    c.agents.defaults.timeoutSeconds = RC_TIMEOUT_SECONDS;
    changed = true;
  }

  // 11. Heartbeat — ensure lightContext is true to minimize token cost
  if (!c.agents.defaults.heartbeat) {
    c.agents.defaults.heartbeat = { every: '30m', lightContext: true };
    changed = true;
  } else if (c.agents.defaults.heartbeat.lightContext !== true) {
    c.agents.defaults.heartbeat.lightContext = true;
    changed = true;
  }
  if (!isGlobal && !c.plugins?.entries) {
    if (!c.plugins) c.plugins = {};
    c.plugins.entries = {
      'research-claw-core': { enabled: true, config: { dbPath: RC_DB_PATH, autoTrackGit: true, defaultCitationStyle: 'apa', heartbeatDeadlineWarningHours: 48, pptRoot: 'integrations/ppt-master' } },
      'openclaw-weixin': { enabled: true },
    };
    changed = true;
  }

  if (!isGlobal && c.plugins?.entries?.['research-claw-core']) {
    const entry = c.plugins.entries['research-claw-core'];
    if (!entry.config) {
      entry.config = {};
      changed = true;
    }
    const nextDbPath = normalizeRcDbPath(filePath, entry.config.dbPath);
    if (entry.config.dbPath !== nextDbPath) {
      entry.config.dbPath = nextDbPath;
      changed = true;
    }
  }

  // 14. plugins.installs — provenance records so OC's loader treats each plugin
  //     as intentionally tracked (eliminates "loaded without install/load-path
  //     provenance" warnings). Idempotent: only adds missing records.
  if (!isGlobal) {
    if (!c.plugins) c.plugins = {};
    if (!c.plugins.installs) c.plugins.installs = {};
    for (const [id, record] of Object.entries(PLUGIN_INSTALL_RECORDS)) {
      if (!c.plugins.installs[id]) {
        c.plugins.installs[id] = { ...record };
        changed = true;
      }
    }
  }

  // 15. Remove dangerouslyDisableDeviceAuth — unnecessary on loopback.
  //     When gateway.bind is "loopback", all connections from 127.0.0.1 are
  //     auto-approved by OC's device-auth pairing flow. The flag was only needed
  //     for LAN-bound gateways; Docker sets it independently in docker-entrypoint.sh.
  if (!isGlobal && c.gateway?.controlUi?.dangerouslyDisableDeviceAuth !== undefined) {
    delete c.gateway.controlUi.dangerouslyDisableDeviceAuth;
    changed = true;
  }

  // 12. Browser — ensure config exists with RC default profile
  // Added in v0.5.9: Docker images now ship Chromium. Older configs created before
  // browser support was added have no `browser` key → dashboard shows "未启用".
  if (!c.browser) {
    c.browser = {
      enabled: true,
      defaultProfile: 'research-claw',
      profiles: { 'research-claw': { cdpPort: 18800, color: '#EF4444' } },
    };
    changed = true;
  } else if (c.browser.enabled === undefined) {
    c.browser.enabled = true;
    changed = true;
  }

  // 13. Session reset — override OC default "daily 4AM" with idle-based reset.
  // Scientific workflows span days; daily reset silently archives the transcript,
  // causing issue #31 ("会话记录被覆盖"). 4320 min = 72 hours idle before reset.
  if (!c.session || !c.session.reset || c.session.reset.mode === 'daily') {
    c.session = { reset: { mode: 'idle', idleMinutes: 4320 } };
    changed = true;
  }

  // Write atomically (temp + rename) to prevent corruption on disk-full
  if (changed) {
    const out = JSON.stringify(c, null, 2) + '\n';
    const tmp = filePath + '.tmp.' + process.pid;
    fs.writeFileSync(tmp, out);
    fs.renameSync(tmp, filePath);
  }

  return changed;
}

// CLI entry: process all paths passed as arguments
const paths = process.argv.slice(2);
if (paths.length === 0) {
  console.error('Usage: node scripts/ensure-config.cjs <config-path> [...]');
  process.exit(1);
}

let totalChanged = 0;
for (const p of paths) {
  if (ensureConfig(p)) totalChanged++;
}

if (totalChanged > 0) {
  console.log(`[ensure-config] Updated ${totalChanged} config file(s)`);
}

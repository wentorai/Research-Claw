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
 *   4. Stale tool names in tools.alsoAllow
 *   5. gateway.auth.token alignment with Dashboard DEFAULT_TOKEN
 *   6. channels.discord.botToken → token (fix stale example config key)
 */
'use strict';

const fs = require('fs');

const REQUIRED_ALLOW = ['research-claw-core', 'research-plugins', 'openclaw-weixin'];
const REQUIRED_TOOLS = ['ppt_init', 'ppt_export'];
const STALE_TOOLS = [
  'search_papers', 'get_paper', 'get_citations',
  'radar_configure', 'radar_get_config', 'radar_scan',
];

function ensureConfig(filePath) {
  if (!fs.existsSync(filePath)) return false;

  let c;
  try {
    c = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return false; // Don't crash on corrupted config — let gateway report it
  }

  let changed = false;

  // 1. plugins.allow — append missing required IDs (don't replace user's extras)
  if (!c.plugins) c.plugins = {};
  if (!Array.isArray(c.plugins.allow)) c.plugins.allow = [];
  for (const id of REQUIRED_ALLOW) {
    if (!c.plugins.allow.includes(id)) {
      c.plugins.allow.push(id);
      changed = true;
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

  // 3. Remove stale wentor-connect plugin entry (placeholder, never functional)
  if (c.plugins?.entries?.['wentor-connect']) {
    delete c.plugins.entries['wentor-connect'];
    changed = true;
  }

  // 4. Remove stale tool names from alsoAllow
  if (c.tools?.alsoAllow) {
    const before = c.tools.alsoAllow.length;
    c.tools.alsoAllow = c.tools.alsoAllow.filter(t => !STALE_TOOLS.includes(t));
    if (c.tools.alsoAllow.length !== before) changed = true;
    for (const tool of REQUIRED_TOOLS) {
      if (!c.tools.alsoAllow.includes(tool)) {
        c.tools.alsoAllow.push(tool);
        changed = true;
      }
    }
  }

  // 5. gateway.auth.token must match Dashboard's DEFAULT_TOKEN
  if (c.gateway?.auth) {
    if (c.gateway.auth.token && c.gateway.auth.token !== 'research-claw') {
      c.gateway.auth.token = 'research-claw';
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

  // 8. plugins.load.paths — ensure openclaw-weixin is discoverable
  // Match by directory suffix, not exact string — paths may be absolute from a previous run.
  if (!c.plugins.load) c.plugins.load = {};
  if (!Array.isArray(c.plugins.load.paths)) c.plugins.load.paths = [];
  const REQUIRED_DIRS = ['extensions/research-claw-core', 'extensions/openclaw-weixin'];
  for (const dir of REQUIRED_DIRS) {
    const alreadyPresent = c.plugins.load.paths.some(p =>
      p === './' + dir || p.endsWith('/' + dir)
    );
    if (!alreadyPresent) {
      c.plugins.load.paths.push('./' + dir);
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
      dangerouslyDisableDeviceAuth: true,
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

  // 10. Heartbeat — ensure lightContext is true to minimize token cost
  if (!c.agents) c.agents = {};
  if (!c.agents.defaults) c.agents.defaults = {};
  if (!c.agents.defaults.heartbeat) {
    c.agents.defaults.heartbeat = { every: '30m', lightContext: true };
    changed = true;
  } else if (c.agents.defaults.heartbeat.lightContext !== true) {
    c.agents.defaults.heartbeat.lightContext = true;
    changed = true;
  }
  if (!c.plugins.entries) {
    c.plugins.entries = {
      'research-claw-core': { enabled: true, config: { dbPath: '.research-claw/library.db', autoTrackGit: true, defaultCitationStyle: 'apa', heartbeatDeadlineWarningHours: 48, pptRoot: 'integrations/ppt-master' } },
      'openclaw-weixin': { enabled: true },
    };
    changed = true;
  }

  // 11. Browser — ensure config exists with RC default profile
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

  // 12. Session reset — override OC default "daily 4AM" with idle-based reset.
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

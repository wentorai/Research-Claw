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

const REQUIRED_ALLOW = ['research-claw-core', 'research-plugins'];
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

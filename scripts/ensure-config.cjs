#!/usr/bin/env node
/**
 * ensure-config.cjs — Shared config cleanup/migration for RC v0.5.6+ (OC 2026.6.1)
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
 *  16. OC 2026.6.1 — legacy model APIs, bundledDiscovery, telegram streaming, DMS hooks
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const REQUIRED_ALLOW = ['research-claw-core', 'research-plugins', 'openclaw-weixin', 'dual-model-supervisor'];
const RC_PLUGIN_IDS = ['research-claw-core', 'openclaw-weixin', 'research-plugins', 'dual-model-supervisor'];
const RC_EXTENSION_DIRS = ['extensions/research-claw-core', 'extensions/openclaw-weixin', 'extensions/dual-model-supervisor'];
const RC_DB_PATH = path.join(os.homedir(), '.research-claw', 'library.db');
// Provenance install records for all RC plugins (eliminates "loaded without
// install/load-path provenance" warnings from OC's plugin loader)
const PLUGIN_INSTALL_RECORDS = {
  'research-claw-core':       { source: 'path', sourcePath: './extensions/research-claw-core' },
  'openclaw-weixin':          { source: 'path', sourcePath: './extensions/openclaw-weixin' },
  'dual-model-supervisor':    { source: 'path', sourcePath: './extensions/dual-model-supervisor' },
  'research-plugins':         { source: 'npm',  spec: '@wentorai/research-plugins',
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

  // 4. Remove tools keys not in OC 2026.3.13 schema.
  //    tools.alsoAllow is redundant with profile "full".
  //    tools.web.fetch.ssrfPolicy, tools.web.sessions, tools.commands,
  //    tools.channels, tools.cron were erroneously added to the example config
  //    in v0.6.3 (commits 0367b43, fca3d3b) and cause "Config invalid" + exit 1.
  if (c.tools?.alsoAllow) {
    delete c.tools.alsoAllow;
    changed = true;
  }
  if (c.tools?.web?.fetch?.ssrfPolicy) {
    delete c.tools.web.fetch.ssrfPolicy;
    if (Object.keys(c.tools.web.fetch).length === 0) delete c.tools.web.fetch;
    changed = true;
  }
  if (c.tools?.web?.sessions) {
    delete c.tools.web.sessions;
    if (Object.keys(c.tools.web).length === 0) delete c.tools.web;
    changed = true;
  }
  for (const k of ['commands', 'channels', 'cron']) {
    if (c.tools?.[k]) {
      delete c.tools[k];
      changed = true;
    }
  }

  // 4b. Remove top-level "mcp" — not in OC 2026.3.13 schema.
  //     Was erroneously added to example config in fca3d3b (MarkItDown integration).
  if (c.mcp) {
    delete c.mcp;
    changed = true;
  }

  // 5. gateway.auth — set defaults but never overwrite user-customized tokens.
  //    Users deploying with Nginx + HTTPS set custom tokens in config and expect
  //    them to persist across restarts. run.sh reads the config token into
  //    OPENCLAW_GATEWAY_TOKEN env var so the two are always in sync.
  if (!c.gateway) c.gateway = {};
  if (!c.gateway.auth) c.gateway.auth = {};
  if (!c.gateway.auth.token) {
    c.gateway.auth.token = process.env.OPENCLAW_GATEWAY_TOKEN || 'research-claw';
    changed = true;
  }
  if (c.gateway.auth.mode && c.gateway.auth.mode !== 'none' && c.gateway.auth.mode !== 'token') {
    c.gateway.auth.mode = 'token';
    changed = true;
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
  if (!c.gateway.auth) c.gateway.auth = {};
  if (!c.gateway.auth.mode) {
    c.gateway.auth.mode = 'none';
    changed = true;
  }
  if (!c.gateway.port) { c.gateway.port = 28789; changed = true; }
  if (!c.gateway.mode) { c.gateway.mode = 'local'; changed = true; }
  if (!c.gateway.bind) { c.gateway.bind = 'loopback'; changed = true; }
  if (!c.ui) { c.ui = { assistant: { name: 'Research-Claw' } }; changed = true; }
  if (!c.skills) { c.skills = { load: { extraDirs: ['./skills'] } }; changed = true; }
  // Skill Workshop (OC 2026.6.1): applied skills live under workspace/skills — load alongside repo ./skills
  if (!c.skills.load) { c.skills.load = { extraDirs: ['./skills'] }; changed = true; }
  if (!Array.isArray(c.skills.load.extraDirs)) {
    c.skills.load.extraDirs = ['./skills'];
    changed = true;
  }
  if (!c.skills.load.extraDirs.includes('./workspace/skills')) {
    c.skills.load.extraDirs.push('./workspace/skills');
    changed = true;
  }
  if (!c.skills.workshop) {
    c.skills.workshop = {
      autonomous: { enabled: false },
      approvalPolicy: 'pending',
      maxPending: 50,
      maxSkillBytes: 40000,
    };
    changed = true;
  }
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

  // 11. Heartbeat — lightContext keeps token cost low; isolatedSession runs heartbeat
  // turns in <base>:heartbeat so they never pollute the main session transcript.
  if (!c.agents.defaults.heartbeat) {
    c.agents.defaults.heartbeat = { every: '30m', lightContext: true, isolatedSession: true };
    changed = true;
  } else {
    if (c.agents.defaults.heartbeat.lightContext !== true) {
      c.agents.defaults.heartbeat.lightContext = true;
      changed = true;
    }
    if (c.agents.defaults.heartbeat.isolatedSession !== true) {
      c.agents.defaults.heartbeat.isolatedSession = true;
      changed = true;
    }
  }
  if (!isGlobal && !c.plugins?.entries) {
    if (!c.plugins) c.plugins = {};
    c.plugins.entries = {
      'research-claw-core': { enabled: true, config: { dbPath: RC_DB_PATH, autoTrackGit: true, defaultCitationStyle: 'apa', heartbeatDeadlineWarningHours: 48, pptRoot: 'integrations/ppt-master' } },
      'openclaw-weixin': { enabled: true },
      'dual-model-supervisor': { enabled: true },
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

  // 13b. dual-model-supervisor dbPath — expand ~/ to absolute
  if (!isGlobal && c.plugins?.entries?.['dual-model-supervisor']?.config?.dbPath) {
    const raw = c.plugins.entries['dual-model-supervisor'].config.dbPath;
    if (typeof raw === 'string' && raw.startsWith('~/')) {
      c.plugins.entries['dual-model-supervisor'].config.dbPath = path.join(os.homedir(), raw.slice(2));
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

  // 16. OC 2026.6.1 config migrations (project config only)
  if (!isGlobal) {
    const LEGACY_CODEX_API = 'openai-codex-responses';
    const CHATGPT_API = 'openai-chatgpt-responses';
    const providers = c.models?.providers;
    if (providers && typeof providers === 'object') {
      if (providers['openai-codex'] && !providers.openai) {
        providers.openai = providers['openai-codex'];
        delete providers['openai-codex'];
        changed = true;
      } else if (providers['openai-codex']) {
        delete providers['openai-codex'];
        changed = true;
      }
      for (const prov of Object.values(providers)) {
        if (!prov || typeof prov !== 'object') continue;
        if (prov.api === LEGACY_CODEX_API) {
          prov.api = CHATGPT_API;
          changed = true;
        }
        if (Array.isArray(prov.models)) {
          for (const m of prov.models) {
            if (m && typeof m === 'object' && m.api === LEGACY_CODEX_API) {
              m.api = CHATGPT_API;
              changed = true;
            }
          }
        }
      }
    }

    const tg = c.channels?.telegram;
    if (tg && typeof tg.streaming === 'string') {
      const mode = tg.streaming;
      tg.streaming = { mode };
      changed = true;
    }

    if (Array.isArray(c.plugins?.allow) && c.plugins.allow.length > 0 && !c.plugins.bundledDiscovery) {
      c.plugins.bundledDiscovery = 'compat';
      changed = true;
    }

    const dmsEntry = c.plugins?.entries?.['dual-model-supervisor'];
    if (dmsEntry && dmsEntry.hooks?.allowConversationAccess !== true) {
      if (!dmsEntry.hooks) dmsEntry.hooks = {};
      dmsEntry.hooks.allowConversationAccess = true;
      changed = true;
    }

    // OC 2026.6.1: channel.commands is not in schema (feishu/qqbot/etc.)
    if (c.channels && typeof c.channels === 'object') {
      for (const ch of Object.values(c.channels)) {
        if (ch && typeof ch === 'object' && ch.commands) {
          delete ch.commands;
          changed = true;
        }
      }
    }

    // Memory slot pointing at missing plugin breaks config validation
    if (c.plugins?.slots?.memory === 'claude-mem') {
      delete c.plugins.slots.memory;
      if (Object.keys(c.plugins.slots).length === 0) delete c.plugins.slots;
      changed = true;
    }
    if (Array.isArray(c.plugins?.allow) && c.plugins.allow.includes('claude-mem')) {
      c.plugins.allow = c.plugins.allow.filter(id => id !== 'claude-mem');
      changed = true;
    }
    if (c.plugins?.entries?.['claude-mem']) {
      delete c.plugins.entries['claude-mem'];
      changed = true;
    }
  }

  // 13. Session reset — minimize automatic transcript rollover on idle/daily expiry.
  // OC default "daily 4AM" and prior RC 72h idle caused issue #31: reopening an old
  // session shows history, but the first chat.send archives the transcript and wipes
  // UI + model context. OC schema requires idleMinutes > 0, so use 365 days (~never).
  const RC_SESSION_IDLE_MINUTES = 525600;
  if (!c.session) c.session = {};
  const reset = c.session.reset;
  const idleMinutes = typeof reset?.idleMinutes === 'number' ? reset.idleMinutes : null;
  const needsResetPolicy =
    !reset
    || reset.mode === 'daily'
    || reset.mode !== 'idle'
    || idleMinutes == null
    || idleMinutes <= 0
    || idleMinutes < RC_SESSION_IDLE_MINUTES;
  if (needsResetPolicy) {
    c.session.reset = { mode: 'idle', idleMinutes: RC_SESSION_IDLE_MINUTES };
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

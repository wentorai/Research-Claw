#!/usr/bin/env node
/**
 * ensure-config.cjs — Shared config cleanup/migration for RC v0.5.6+ (OC 2026.6.1)
 *
 * Called by: run.sh, install.sh, docker-entrypoint.sh
 * Purpose:  Ensure the RC project config contains all fields required by the
 *           current OC version.  Idempotent — safe to call on every startup.
 *
 * Usage:    node scripts/ensure-config.cjs [--inherit-global-compaction]
 *           <config-path> [<config-path-2> ...]
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
 *  17. agents.defaults.compaction.maxHistoryShare — strip (defer to OC default 0.5)
 *  18. models.providers.<manual>.models[].contextWindow — raise to ≥ 64000 floor
 *  19. agents.defaults.compaction.reserveTokens/reserveTokensFloor — strip stale override
 *  20. agents.defaults.compaction.customInstructions — add RC scientific default
 *  21. dual-model-supervisor — remove withdrawn settings and validation placeholders
 *  22. agents.defaults.memorySearch — default off until embeddings are configured
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const RC_SCIENTIFIC_COMPACTION_INSTRUCTIONS = fs.readFileSync(
  path.join(__dirname, '../config/research-compaction-instructions.txt'),
  'utf8',
).trim();

// `browser` is a bundled OC plugin but the trust list is restrictive: when
// plugins.allow is non-empty, a plugin absent from it is NOT enabled-by-config.
// The gateway still auto-enables browser in-memory (settings read config → show
// 已启用), but the browser control service re-reads the on-disk config and, not
// finding `browser` in allow, refuses to start → "browser control disabled" →
// all browser-driven skills (CNKI) fail. So `browser` MUST be allow-listed.
// `research-superpower` is an RC path extension (rp_* tools); it needs allow +
// load.paths + install record like the other RC extensions.
const REQUIRED_ALLOW = ['browser', 'research-claw-core', 'research-plugins', 'openclaw-weixin', 'dual-model-supervisor', 'research-superpower'];
const RC_PLUGIN_IDS = ['research-claw-core', 'openclaw-weixin', 'research-plugins', 'dual-model-supervisor', 'research-superpower'];
const RC_EXTENSION_DIRS = ['extensions/research-claw-core', 'extensions/openclaw-weixin', 'extensions/dual-model-supervisor', 'extensions/research-superpower'];
const RESEARCH_PLUGINS_PATH = path.join(os.homedir(), '.openclaw', 'extensions', 'research-plugins');
const RC_DB_PATH = path.join(os.homedir(), '.research-claw', 'library.db');
// Provenance install records for all RC plugins (eliminates "loaded without
// install/load-path provenance" warnings from OC's plugin loader)
const PLUGIN_INSTALL_RECORDS = {
  'research-claw-core':       { source: 'path', sourcePath: './extensions/research-claw-core' },
  'openclaw-weixin':          { source: 'path', sourcePath: './extensions/openclaw-weixin' },
  'dual-model-supervisor':    { source: 'path', sourcePath: './extensions/dual-model-supervisor' },
  'research-plugins':         { source: 'npm',  spec: '@wentorai/research-plugins',
                                installPath: '~/.openclaw/extensions/research-plugins' },
  'research-superpower':      { source: 'path', sourcePath: './extensions/research-superpower' },
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

  // 4b. Clean up legacy markitdown MCP entry (added by fca3d3b, binary absent
  //     on native installs). OC 2026.6.1 supports top-level "mcp" natively —
  //     user-configured servers (e.g. plaud) must survive restarts.
  if (c.mcp && c.mcp.servers && c.mcp.servers.markitdown) {
    delete c.mcp.servers.markitdown;
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

  // 6b. Old RC templates shipped Telegram/Discord placeholder channel blocks.
  // Remove only the recognisable placeholder shape; a real token or explicit
  // plugin provenance is operator intent and must survive every migration.
  const discordChannel = c.channels?.discord;
  if (discordChannel && typeof discordChannel === 'object' && !Array.isArray(discordChannel)) {
    const token = discordChannel.token;
    const placeholderToken =
      typeof token === 'string'
      && (token.includes('<') || token.includes('YOUR_'));
    const legacyOnly = Object.keys(discordChannel).every((key) =>
      ['token', 'botToken', 'commands', 'enabled'].includes(key));
    if (placeholderToken && legacyOnly) {
      delete c.channels.discord;
      if (Object.keys(c.channels).length === 0) delete c.channels;
      changed = true;
    }
  }
  const discordHasProvenance = Boolean(
    c.channels?.discord
    || c.plugins?.entries?.discord
    || c.plugins?.installs?.discord
    || c.plugins?.load?.paths?.some((entry) =>
      typeof entry === 'string' && /(^|[/\\])discord([/\\]|$)/i.test(entry)),
  );
  if (
    Array.isArray(c.plugins?.allow)
    && c.plugins.allow.includes('discord')
    && !discordHasProvenance
  ) {
    c.plugins.allow = c.plugins.allow.filter((id) => id !== 'discord');
    changed = true;
  }
  const telegramChannel = c.channels?.telegram;
  if (telegramChannel && typeof telegramChannel === 'object' && !Array.isArray(telegramChannel)) {
    const token = telegramChannel.token ?? telegramChannel.botToken;
    const placeholderToken =
      typeof token === 'string'
      && (token.includes('<') || token.includes('YOUR_'));
    const legacyOnly = Object.keys(telegramChannel).every((key) =>
      ['token', 'botToken', 'commands', 'enabled'].includes(key));
    if (placeholderToken && legacyOnly) {
      delete c.channels.telegram;
      if (Object.keys(c.channels).length === 0) delete c.channels;
      changed = true;
    }
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
    if (!c.plugins.load.paths.includes(RESEARCH_PLUGINS_PATH)) {
      c.plugins.load.paths.push(RESEARCH_PLUGINS_PATH);
      changed = true;
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
      'research-claw-core': {
        enabled: true,
        hooks: { allowConversationAccess: true },
        config: { dbPath: RC_DB_PATH, autoTrackGit: true, defaultCitationStyle: 'apa', heartbeatDeadlineWarningHours: 48, pptRoot: 'integrations/ppt-master' },
      },
      'openclaw-weixin': { enabled: true },
      'dual-model-supervisor': { enabled: true },
      'research-superpower': { enabled: true },
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

    // Repoint any `openai-codex/<model>` references to `openai/<model>` so the
    // retired provider id never leaves a dangling model ref after the rename above.
    const rewriteCodexRef = (ref) =>
      typeof ref === 'string' && ref.startsWith('openai-codex/')
        ? 'openai/' + ref.slice('openai-codex/'.length)
        : ref;
    const defaults = c.agents?.defaults;
    if (defaults && typeof defaults === 'object') {
      for (const block of [defaults.model, defaults.imageModel]) {
        if (block && typeof block === 'object' && typeof block.primary === 'string') {
          const next = rewriteCodexRef(block.primary);
          if (next !== block.primary) {
            block.primary = next;
            changed = true;
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

    // Typed hooks that inspect agent_end conversation/run metadata are blocked
    // for non-bundled plugins unless this permission is explicit. Core needs it
    // for runtime tools/skills reconciliation; DMS needs it for supervision.
    for (const pluginId of ['research-claw-core', 'dual-model-supervisor']) {
      const entry = c.plugins?.entries?.[pluginId];
      if (entry && entry.hooks?.allowConversationAccess !== true) {
        if (!entry.hooks) entry.hooks = {};
        entry.hooks.allowConversationAccess = true;
        changed = true;
      }
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

    // 21. Supervisor lifecycle cleanup. These keys came from capabilities that were
    //     withdrawn before v0.7.6 and must not survive an upgrade as dead controls.
    //     `test/*` was used only by isolated acceptance fixtures; if it escaped into
    //     a user's ignored project config it disables AI review while looking enabled.
    //     Clear only that known fixture namespace. Never erase an operator's external
    //     provider merely because the current project config does not define it.
    const supervisorEntry = c.plugins?.entries?.['dual-model-supervisor'];
    const supervisorConfig = supervisorEntry?.config;
    if (
      supervisorConfig
      && typeof supervisorConfig === 'object'
      && !Array.isArray(supervisorConfig)
    ) {
      if (supervisorConfig.memoryGuard !== undefined) {
        delete supervisorConfig.memoryGuard;
        changed = true;
      }
      if (supervisorConfig.appendReviewToChannelOutput !== undefined) {
        delete supervisorConfig.appendReviewToChannelOutput;
        changed = true;
      }
      if (supervisorConfig.reviewMode === 'full') {
        supervisorConfig.reviewMode = 'correct';
        changed = true;
      }
      if (
        typeof supervisorConfig.supervisorModel === 'string'
        && supervisorConfig.supervisorModel.startsWith('test/')
      ) {
        supervisorConfig.supervisorModel = '';
        changed = true;
      }
    }
    if (
      supervisorEntry
      && typeof supervisorEntry === 'object'
      && !Array.isArray(supervisorEntry)
      && (
        !supervisorEntry.llm
        || typeof supervisorEntry.llm !== 'object'
        || Array.isArray(supervisorEntry.llm)
        || supervisorEntry.llm.allowModelOverride !== true
      )
    ) {
      supervisorEntry.llm = {
        ...(supervisorEntry.llm
          && typeof supervisorEntry.llm === 'object'
          && !Array.isArray(supervisorEntry.llm)
          ? supervisorEntry.llm
          : {}),
        allowModelOverride: true,
      };
      changed = true;
    }

    // 17. Compaction history share — RC no longer exposes this knob and defers it
    //     to OpenClaw's default (0.5). Strip any value written by an older RC
    //     dashboard so existing users get the default behavior with no stale cap.
    let compaction = c.agents?.defaults?.compaction;
    if (!compaction || typeof compaction !== 'object' || Array.isArray(compaction)) {
      compaction = {};
      c.agents.defaults.compaction = compaction;
      changed = true;
    }
    if (compaction.maxHistoryShare !== undefined) {
      delete compaction.maxHistoryShare;
      changed = true;
    }

    // 18. Context window floor — RC requires ≥ 64000 (CONTEXT_WINDOW_MIN in
    //     dashboard/src/utils/config-patch.ts). OC pins the turn-1 precheck reserve
    //     at a hardcoded 16384, so a manually-pinned window below ~36.5K overflows on
    //     the very first "你好" before any history exists. Raise any sub-floor window an
    //     older RC saved for a MANUAL endpoint (local ollama/vllm + custom-* API
    //     profiles); preset/OC-known providers are left to the startup aligner so their
    //     real catalog window is never inflated.
    const RC_CONTEXT_WINDOW_MIN = 64000; // keep in sync with CONTEXT_WINDOW_MIN
    const isManualProviderKey = (key) =>
      key === 'ollama' || key === 'vllm' || key === 'custom' || key.startsWith('custom-');
    if (providers && typeof providers === 'object') {
      for (const [key, prov] of Object.entries(providers)) {
        if (!isManualProviderKey(key) || !prov || typeof prov !== 'object') continue;
        if (!Array.isArray(prov.models)) continue;
        for (const m of prov.models) {
          if (
            m && typeof m === 'object' &&
            typeof m.contextWindow === 'number' &&
            m.contextWindow < RC_CONTEXT_WINDOW_MIN
          ) {
            m.contextWindow = RC_CONTEXT_WINDOW_MIN;
            changed = true;
          }
        }
      }
    }

    // 19. Stale compaction reserve override — an older RC build briefly wrote
    //     reserveTokens/reserveTokensFloor; the dashboard no longer does and OC ignores
    //     them on the turn-1 precheck path anyway. Strip to keep the config clean.
    if (compaction.reserveTokens !== undefined) {
      delete compaction.reserveTokens;
      changed = true;
    }
    if (compaction.reserveTokensFloor !== undefined) {
      delete compaction.reserveTokensFloor;
      changed = true;
    }

    // 20. Scientific compaction default — use the same tracked prompt as the
    // Dashboard. Preserve every non-empty user instruction byte-for-byte.
    if (compaction.mode === undefined) {
      compaction.mode = 'safeguard';
      changed = true;
    }
    if (
      typeof compaction.customInstructions !== 'string'
      || compaction.customInstructions.trim().length === 0
    ) {
      compaction.customInstructions = RC_SCIENTIFIC_COMPACTION_INSTRUCTIONS;
      changed = true;
    }

    // 22. Semantic memory defaults OFF unless the operator has made an explicit
    // choice. RC's default DeepSeek chat provider has no embeddings endpoint;
    // leaving this field absent makes OpenClaw implicitly select OpenAI
    // text-embedding-3-small and retry forever without credentials. Preserve an
    // existing object byte-for-byte: enabled=true, provider/model and extension
    // fields are operator-owned.
    if (!Object.prototype.hasOwnProperty.call(c.agents.defaults, 'memorySearch')) {
      c.agents.defaults.memorySearch = { enabled: false };
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

  // N. Logging — quiet terminal, full persistent file log (project config only).
  // Rationale: gateway INFO chatter on the terminal only confuses users who
  // can't act on P1/P2 noise; the full detail belongs in a file we can ask
  // them to send. consoleLevel=warn quiets stdout; level=info keeps the file
  // complete; file=<persistent path> survives reboots (unlike /tmp).
  // 3-state: inject when absent, fill missing keys, NEVER override user values.
  if (!isGlobal) {
    const LOG_DEFAULTS = {
      level: 'info',
      consoleLevel: 'warn',
      file: '~/.research-claw/logs/openclaw.log',
    };
    if (!c.logging || typeof c.logging !== 'object' || Array.isArray(c.logging)) {
      c.logging = { ...LOG_DEFAULTS };
      changed = true;
    } else {
      for (const [k, v] of Object.entries(LOG_DEFAULTS)) {
        if (c.logging[k] === undefined) { c.logging[k] = v; changed = true; }
      }
    }
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

function inheritGlobalCompaction(projectPath, globalPath) {
  if (!fs.existsSync(projectPath) || !fs.existsSync(globalPath)) return false;

  let projectConfig;
  let globalConfig;
  try {
    projectConfig = JSON.parse(fs.readFileSync(projectPath, 'utf8'));
    globalConfig = JSON.parse(fs.readFileSync(globalPath, 'utf8'));
  } catch {
    return false;
  }

  const globalInstructions =
    globalConfig.agents?.defaults?.compaction?.customInstructions;
  if (
    typeof globalInstructions !== 'string'
    || globalInstructions.trim().length === 0
  ) {
    return false;
  }

  const projectInstructions =
    projectConfig.agents?.defaults?.compaction?.customInstructions;
  const projectHasOwnInstructions =
    typeof projectInstructions === 'string'
    && projectInstructions.trim().length > 0
    && projectInstructions !== RC_SCIENTIFIC_COMPACTION_INSTRUCTIONS;
  if (projectHasOwnInstructions) return false;

  if (!projectConfig.agents) projectConfig.agents = {};
  if (!projectConfig.agents.defaults) projectConfig.agents.defaults = {};
  if (!projectConfig.agents.defaults.compaction) {
    projectConfig.agents.defaults.compaction = {};
  }
  projectConfig.agents.defaults.compaction.customInstructions =
    globalInstructions;

  const out = JSON.stringify(projectConfig, null, 2) + '\n';
  const tmp = projectPath + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, out);
  fs.renameSync(tmp, projectPath);
  return true;
}

// CLI entry: process all paths passed as arguments. The install-only flag lets
// a pre-existing global user instruction replace the freshly copied RC
// template default. Normal startup never performs this cross-config migration.
const args = process.argv.slice(2);
const inheritGlobal = args.includes('--inherit-global-compaction');
const paths = args.filter(arg => arg !== '--inherit-global-compaction');
if (paths.length === 0) {
  console.error(
    'Usage: node scripts/ensure-config.cjs [--inherit-global-compaction] <config-path> [...]',
  );
  process.exit(1);
}
if (inheritGlobal && paths.length < 2) {
  console.error('--inherit-global-compaction requires project and global config paths');
  process.exit(1);
}

const changedPaths = new Set();
if (inheritGlobal && inheritGlobalCompaction(paths[0], paths[1])) {
  changedPaths.add(paths[0]);
}
for (const p of paths) {
  if (ensureConfig(p)) changedPaths.add(p);
}

if (changedPaths.size > 0) {
  console.log(`[ensure-config] Updated ${changedPaths.size} config file(s)`);
}

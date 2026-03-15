#!/usr/bin/env node
/**
 * Sync Research-Claw project config → ~/.openclaw/openclaw.json
 *
 * Why: OpenClaw CLI (`openclaw gateway --force`) only reads the global config.
 * RC is a satellite with project-level config (plugin paths, tool whitelist, dashboard).
 * This script merges RC settings (with absolute paths) into the global config
 * so both `pnpm start` AND `openclaw gateway --force` work correctly.
 *
 * Preserves existing global config fields (API key, meta, etc.).
 * Safe to run multiple times (idempotent).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const PROJECT_CONFIG = path.join(PROJECT_ROOT, 'config', 'openclaw.json');
const GLOBAL_DIR = path.join(os.homedir(), '.openclaw');
const GLOBAL_CONFIG = path.join(GLOBAL_DIR, 'openclaw.json');

// --- Strip JSON5 comments (string-aware — won't eat // inside URLs) ---
function stripComments(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    // String literal — copy verbatim until closing quote
    if (src[i] === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\') j++; // skip escaped char
        j++;
      }
      out += src.slice(i, j + 1);
      i = j + 1;
    // Line comment
    } else if (src[i] === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
    // Block comment
    } else if (src[i] === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
    } else {
      out += src[i++];
    }
  }
  // Strip trailing commas before } or ]
  return out.replace(/,\s*([}\]])/g, '$1');
}

// --- Read project config ---
let raw;
try {
  raw = fs.readFileSync(PROJECT_CONFIG, 'utf8');
} catch (err) {
  console.error('[sync] Cannot read project config:', PROJECT_CONFIG);
  process.exit(1);
}

let project;
try {
  project = JSON.parse(stripComments(raw));
} catch (err) {
  console.error('[sync] Failed to parse project config:', err.message);
  process.exit(1);
}

// --- Read existing global config (preserve API key, meta, etc.) ---
let global = {};
try {
  global = JSON.parse(fs.readFileSync(GLOBAL_CONFIG, 'utf8'));
} catch {
  // No global config yet — will create
}

// --- Helper: resolve relative path to absolute from project root ---
const abs = (p) => path.resolve(PROJECT_ROOT, p);

// --- Deep merge helper (source wins, but preserves target-only keys) ---
function merge(target, source) {
  const result = { ...target };
  for (const [key, val] of Object.entries(source)) {
    if (val && typeof val === 'object' && !Array.isArray(val) &&
        result[key] && typeof result[key] === 'object' && !Array.isArray(result[key])) {
      result[key] = merge(result[key], val);
    } else {
      result[key] = val;
    }
  }
  return result;
}

// --- Fix channels: ensure commands.native=false for all existing channels ---
// RC registers 529 commands, which exceeds every IM channel's command menu limit.
// Without this, Telegram (and others) enter a BOT_COMMANDS_TOO_MUCH retry loop
// that blocks message processing for 15+ minutes.
let projectChanged = false;
if (project.channels) {
  for (const [name, ch] of Object.entries(project.channels)) {
    if (name === 'defaults' || typeof ch !== 'object' || ch === null) continue;
    if (!ch.commands) ch.commands = {};
    if (ch.commands.native !== false) {
      ch.commands.native = false;
      projectChanged = true;
    }
  }
  if (projectChanged) {
    fs.writeFileSync(PROJECT_CONFIG, JSON.stringify(project, null, 2) + '\n');
    console.log('[sync] Fixed channels.*.commands.native=false in project config');
  }
}

// --- Build RC overlay with absolute paths ---
const overlay = JSON.parse(JSON.stringify(project)); // deep clone

// gateway.controlUi.root → absolute
if (overlay.gateway?.controlUi?.root) {
  overlay.gateway.controlUi.root = abs(overlay.gateway.controlUi.root);
}

// gateway.auth.mode = none (RC runs unauthenticated locally)
if (!overlay.gateway) overlay.gateway = {};
overlay.gateway.auth = { mode: 'none' };

// plugins.load.paths → absolute
if (overlay.plugins?.load?.paths) {
  overlay.plugins.load.paths = overlay.plugins.load.paths.map(abs);
}

// skills.load.extraDirs → absolute
if (overlay.skills?.load?.extraDirs) {
  overlay.skills.load.extraDirs = overlay.skills.load.extraDirs.map(abs);
}

// plugins.entries.*.config.dbPath → absolute (prevents CWD mismatch
// when `openclaw gateway --force` resolves relative paths from wrong directory)
if (overlay.plugins?.entries) {
  for (const entry of Object.values(overlay.plugins.entries)) {
    if (entry?.config?.dbPath && !path.isAbsolute(entry.config.dbPath)) {
      entry.config.dbPath = abs(entry.config.dbPath);
    }
  }
}

// --- Merge into global config ---
const merged = merge(global, overlay);

// --- Write ---
fs.mkdirSync(GLOBAL_DIR, { recursive: true, mode: 0o700 });
fs.writeFileSync(GLOBAL_CONFIG, JSON.stringify(merged, null, 2) + '\n', { mode: 0o600 });

console.log('[sync] RC settings → ~/.openclaw/openclaw.json');

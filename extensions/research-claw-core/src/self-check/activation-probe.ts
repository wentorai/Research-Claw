/**
 * Startup self-check: plugin activation-contract audit.
 *
 * OpenClaw silently degrades a path-loaded plugin to "toolDiscovery only" when
 * its openclaw.plugin.json advertises tools (contracts.tools) but lacks the
 * activation contract (activation.onStartup + main). The plugin's skills still
 * get indexed, but activate() is never called, so ZERO tools register — with no
 * diagnostic. This is exactly what bit research-plugins v1.4.7 (manifest claimed
 * 34 tools, shipped 0). See docs/postmortem/rp-tools-not-loaded-manifest-activation.md.
 *
 * This probe reconstructs that failure deterministically from disk — comparing
 * each plugin's advertised tools against its activation contract — so the gap is
 * surfaced (log warn + dashboard notification) instead of staying invisible.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface PluginManifestLike {
  id?: string;
  main?: unknown;
  activation?: { onStartup?: unknown } | unknown;
  contracts?: { tools?: unknown } | unknown;
}

export interface ProbeInput {
  /** Plugin id (fallback to dir basename by the caller). */
  id: string;
  /** Absolute directory the manifest was read from (for the message). */
  dir: string;
  /** Parsed openclaw.plugin.json, or null if it was missing/unparseable. */
  manifest: PluginManifestLike | null;
}

export interface ProbeFinding {
  severity: 'warn';
  id: string;
  /** Short machine tag for the failure class. */
  kind: 'missing-activation' | 'missing-main' | 'unreadable-manifest';
  /** Human-facing message (already includes the plugin id + advice). */
  message: string;
}

export interface PluginDiscoveryOptions {
  projectRoot: string;
  stateDir: string;
  loadPaths: string[];
}

/** Match OpenClaw's state-dir precedence without importing its unstable internals. */
export function resolveOpenClawStateDir(
  env: { OPENCLAW_STATE_DIR?: string } = process.env,
  homeDir = os.homedir(),
): string {
  const configured = env.OPENCLAW_STATE_DIR?.trim();
  if (!configured) return path.join(homeDir, '.openclaw');
  if (configured === '~') return homeDir;
  if (configured.startsWith('~/')) return path.join(homeDir, configured.slice(2));
  return path.resolve(configured);
}

function candidatePluginDirs(options: PluginDiscoveryOptions): string[] {
  const dirs: string[] = [];
  for (const extensionsRoot of [
    path.join(options.projectRoot, 'extensions'),
    path.join(options.stateDir, 'extensions'),
  ]) {
    if (!fs.existsSync(extensionsRoot)) continue;
    for (const name of fs.readdirSync(extensionsRoot)) {
      dirs.push(path.join(extensionsRoot, name));
    }
  }
  for (const configuredPath of options.loadPaths) {
    const absolute = path.isAbsolute(configuredPath)
      ? configuredPath
      : path.resolve(options.projectRoot, configuredPath);
    dirs.push(path.extname(absolute) ? path.dirname(absolute) : absolute);
  }
  return dirs;
}

/**
 * Discover plugin manifests from every path OpenClaw uses in Research-Claw:
 * bundled project extensions, native state-dir installs, and explicit paths.
 */
export function discoverPluginInputs(options: PluginDiscoveryOptions): ProbeInput[] {
  const discovered: ProbeInput[] = [];
  const seen = new Set<string>();

  for (const candidate of candidatePluginDirs(options)) {
    let dir = path.resolve(candidate);
    try {
      dir = fs.realpathSync(dir);
    } catch {
      // A missing explicit path has no manifest to audit; OpenClaw diagnoses it.
    }
    if (seen.has(dir)) continue;
    const manifestPath = path.join(dir, 'openclaw.plugin.json');
    if (!fs.existsSync(manifestPath)) continue;
    seen.add(dir);

    let manifest: PluginManifestLike | null = null;
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      manifest = parsed !== null && typeof parsed === 'object'
        ? parsed as PluginManifestLike
        : null;
    } catch {
      manifest = null;
    }
    const id =
      manifest && typeof manifest.id === 'string' && manifest.id.trim()
        ? manifest.id.trim()
        : path.basename(dir);
    discovered.push({ id, dir, manifest });
  }

  return discovered;
}

export function findRecentStartupFailures(
  stateDir: string,
  now = Date.now(),
  windowMs = 24 * 60 * 60 * 1000,
): string[] {
  const stabilityDir = path.join(stateDir, 'logs', 'stability');
  if (!fs.existsSync(stabilityDir)) return [];
  const cutoff = now - windowMs;
  return fs
    .readdirSync(stabilityDir)
    .filter((name) => name.includes('startup_failed') && name.endsWith('.json'))
    .map((name) => path.join(stabilityDir, name))
    .filter((filePath) => {
      try {
        return fs.statSync(filePath).mtimeMs >= cutoff;
      } catch {
        return false;
      }
    })
    .sort();
}

function toolCount(manifest: PluginManifestLike): number {
  const tools = (manifest.contracts as { tools?: unknown } | undefined)?.tools;
  return Array.isArray(tools) ? tools.length : 0;
}

function hasOnStartup(manifest: PluginManifestLike): boolean {
  return (manifest.activation as { onStartup?: unknown } | undefined)?.onStartup === true;
}

function hasMain(manifest: PluginManifestLike): boolean {
  return typeof manifest.main === 'string' && manifest.main.length > 0;
}

/**
 * Audit a set of discovered plugins for the activation-contract gap.
 * Only plugins that ADVERTISE tools are checked — a plugin with no tools that
 * omits activation is legitimately tool-discovery-only, not a failure.
 */
export function auditPluginActivation(plugins: ProbeInput[]): ProbeFinding[] {
  const findings: ProbeFinding[] = [];
  for (const p of plugins) {
    if (p.manifest === null) {
      // A discovered plugin dir whose manifest can't be read is itself suspect,
      // but only flag it if the caller expected it to load (it's in the list).
      findings.push({
        severity: 'warn',
        id: p.id,
        kind: 'unreadable-manifest',
        message: `Plugin "${p.id}" at ${p.dir}: openclaw.plugin.json missing or unparseable — plugin will not load.`,
      });
      continue;
    }
    const n = toolCount(p.manifest);
    if (n === 0) continue; // no advertised tools → nothing to lose, skip

    if (!hasOnStartup(p.manifest)) {
      findings.push({
        severity: 'warn',
        id: p.id,
        kind: 'missing-activation',
        message:
          `Plugin "${p.id}" advertises ${n} tool(s) but its manifest lacks ` +
          `activation.onStartup:true — activate() will NOT run, so all ${n} tools ` +
          `are silently dropped (skills still index). Add activation.onStartup to ${p.dir}/openclaw.plugin.json.`,
      });
      continue;
    }
    if (!hasMain(p.manifest)) {
      findings.push({
        severity: 'warn',
        id: p.id,
        kind: 'missing-main',
        message:
          `Plugin "${p.id}" advertises ${n} tool(s) with activation.onStartup but no "main" ` +
          `entry — the gateway cannot load its built artifact. Set "main" in ${p.dir}/openclaw.plugin.json.`,
      });
    }
  }
  return findings;
}

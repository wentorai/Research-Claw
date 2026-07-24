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

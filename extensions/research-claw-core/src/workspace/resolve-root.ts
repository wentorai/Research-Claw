import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { findGitRoot } from '../app-updates.js';

function expandHome(raw: string): string {
  return raw.startsWith('~/') ? path.join(os.homedir(), raw.slice(2)) : raw;
}

function resolveAgainstRepo(raw: string, repoRoot: string): string {
  const expanded = expandHome(raw.trim());
  return path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(repoRoot, expanded);
}

/**
 * Resolve the RC workspace root to match OpenClaw's agent workspace.
 * Plugin-relative `workspace/` must NOT be used when agents.defaults.workspace
 * points at the project workspace (Dashboard upload vs agent tools mismatch).
 */
export function resolveWorkspaceRoot(
  api: { resolvePath: (input: string) => string },
  cfgRoot?: string,
): string {
  const repoRoot = findGitRoot(api.resolvePath('.'));

  if (cfgRoot?.trim()) {
    return resolveAgainstRepo(cfgRoot, repoRoot);
  }

  const configPath =
    process.env.OPENCLAW_CONFIG_PATH ?? path.join(repoRoot, 'config', 'openclaw.json');

  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as {
      agents?: { defaults?: { workspace?: string } };
    };
    const agentWorkspace = config.agents?.defaults?.workspace;
    if (typeof agentWorkspace === 'string' && agentWorkspace.trim()) {
      return resolveAgainstRepo(agentWorkspace, repoRoot);
    }
  } catch {
    // Config missing or unreadable — fall back to project workspace/.
  }

  return path.resolve(repoRoot, 'workspace');
}

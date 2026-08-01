import * as fs from 'node:fs';
import * as path from 'node:path';

export interface SessionRegistrySnapshot {
  ok: boolean;
  sessionKeys: Set<string>;
  filesRead: number;
  bytesRead: number;
  errors: number;
}

/**
 * Read only the bounded OC session indexes, never transcripts. `ok=false`
 * tells the caller to fail closed and skip deletion when Session truth cannot
 * be established.
 */
export function loadOpenClawSessionRegistry(
  stateDir: string,
  options: { maxAgents?: number; maxFileBytes?: number } = {},
): SessionRegistrySnapshot {
  const maxAgents = Math.max(1, Math.min(options.maxAgents ?? 32, 128));
  const maxFileBytes = Math.max(1_024, Math.min(options.maxFileBytes ?? 8 * 1024 * 1024, 32 * 1024 * 1024));
  const snapshot: SessionRegistrySnapshot = {
    ok: false,
    sessionKeys: new Set<string>(),
    filesRead: 0,
    bytesRead: 0,
    errors: 0,
  };
  let agents: fs.Dirent[];
  try {
    agents = fs.readdirSync(path.join(stateDir, 'agents'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, maxAgents);
  } catch {
    snapshot.errors += 1;
    return snapshot;
  }
  for (const agent of agents) {
    const filePath = path.join(stateDir, 'agents', agent.name, 'sessions', 'sessions.json');
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile() || stat.size > maxFileBytes) {
        snapshot.errors += 1;
        continue;
      }
      const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        snapshot.errors += 1;
        continue;
      }
      snapshot.ok = true;
      snapshot.filesRead += 1;
      snapshot.bytesRead += stat.size;
      for (const key of Object.keys(parsed)) {
        if (key && key.length <= 2_048 && !key.includes('\0')) snapshot.sessionKeys.add(key);
      }
    } catch {
      // A missing registry for an otherwise valid agent directory is expected;
      // other successfully read agents still make the snapshot authoritative.
      snapshot.errors += 1;
    }
  }
  return snapshot;
}

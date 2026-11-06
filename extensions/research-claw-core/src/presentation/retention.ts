import * as fs from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { resolveSessionStorePath } from '../self-check/runtime-probe.js';

/** A named failure for one agent whose Session truth could not be read. */
export interface SessionRegistryStoreError {
  agent: string;
  path: string;
  message: string;
}

export interface SessionRegistrySnapshot {
  ok: boolean;
  sessionKeys: Set<string>;
  filesRead: number;
  bytesRead: number;
  errors: number;
  /**
   * The reason behind `errors`: one entry per agent whose session store could
   * not be read, named by path and message. Without it a degraded snapshot is
   * indistinguishable from an empty one.
   */
  storeErrors: SessionRegistryStoreError[];
}

interface SessionKeyRead {
  keys: string[];
  bytes: number;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Read the session keys out of the 2026.9.2 per-agent SQLite store
 * (`session_nodes`, the table the gateway persists every session entry into).
 * Only the keys are selected — the entries themselves (and their transcripts)
 * are never loaded, so the sweep stays bounded.
 */
function readDatabaseSessionKeys(
  databasePath: string,
  maxFileBytes: number,
): SessionKeyRead | { error: string } {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(databasePath);
  } catch (err) {
    return { error: describeError(err) };
  }
  if (!stat.isFile()) return { error: 'session store is not a file' };
  if (stat.size > maxFileBytes) {
    return { error: `session store exceeds ${maxFileBytes} bytes` };
  }
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true });
    const rows = database.prepare('SELECT session_key FROM session_nodes').all();
    const keys: string[] = [];
    for (const row of rows) {
      if (typeof row.session_key === 'string' && row.session_key) keys.push(row.session_key);
    }
    return { keys, bytes: stat.size };
  } catch (err) {
    return { error: describeError(err) };
  } finally {
    try {
      database?.close();
    } catch {
      // A half-open handle is harmless; the next sweep opens a fresh one.
    }
  }
}

/**
 * Read a legacy `sessions.json` index. OpenClaw 2026.9.2 no longer writes it,
 * but a state dir is migrated on first boot, so the file is still read while
 * the SQLite store beside it does not exist yet.
 */
function readLegacySessionKeys(
  sessionsPath: string,
  maxFileBytes: number,
): SessionKeyRead | { error: string } {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(sessionsPath);
  } catch (err) {
    return { error: describeError(err) };
  }
  if (!stat.isFile()) return { error: 'session index is not a file' };
  if (stat.size > maxFileBytes) {
    return { error: `session index exceeds ${maxFileBytes} bytes` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(sessionsPath, 'utf8'));
  } catch (err) {
    return { error: describeError(err) };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: 'session index is not a keyed session object' };
  }
  return { keys: Object.keys(parsed), bytes: stat.size };
}

/**
 * Read only the bounded OC session indexes, never transcripts. `ok=false`
 * tells the caller to fail closed and skip deletion when Session truth cannot
 * be established.
 *
 * The authoritative store is the per-agent SQLite database OpenClaw 2026.9.2
 * writes (`<state>/agents/<agent>/agent/openclaw-agent.sqlite`); the legacy
 * `<state>/agents/<agent>/sessions/sessions.json` is only migration input and
 * is read when the database has not been created yet. A store that exists but
 * cannot be read is recorded in `storeErrors` by name — never silently dropped
 * into an empty snapshot.
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
    storeErrors: [],
  };
  let agents: fs.Dirent[];
  try {
    agents = fs.readdirSync(path.join(stateDir, 'agents'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, maxAgents);
  } catch (err) {
    snapshot.errors += 1;
    snapshot.storeErrors.push({
      agent: '*',
      path: path.join(stateDir, 'agents'),
      message: describeError(err),
    });
    return snapshot;
  }
  for (const agent of agents) {
    const databasePath = resolveSessionStorePath({ stateDir, agentId: agent.name });
    const legacyPath = path.join(stateDir, 'agents', agent.name, 'sessions', 'sessions.json');
    const storePath = fs.existsSync(databasePath)
      ? databasePath
      : fs.existsSync(legacyPath)
        ? legacyPath
        : null;
    if (!storePath) {
      // A missing registry for an otherwise valid agent directory is expected;
      // other successfully read agents still make the snapshot authoritative.
      snapshot.errors += 1;
      snapshot.storeErrors.push({
        agent: agent.name,
        path: databasePath,
        message: 'session store not found',
      });
      continue;
    }
    const read = storePath === databasePath
      ? readDatabaseSessionKeys(storePath, maxFileBytes)
      : readLegacySessionKeys(storePath, maxFileBytes);
    if ('error' in read) {
      snapshot.errors += 1;
      snapshot.storeErrors.push({ agent: agent.name, path: storePath, message: read.error });
      continue;
    }
    snapshot.ok = true;
    snapshot.filesRead += 1;
    snapshot.bytesRead += read.bytes;
    for (const key of read.keys) {
      if (key && key.length <= 2_048 && !key.includes('\0')) snapshot.sessionKeys.add(key);
    }
  }
  return snapshot;
}

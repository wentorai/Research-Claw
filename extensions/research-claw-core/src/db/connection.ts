/**
 * Research-Claw Core — SQLite Connection Manager
 *
 * Manages the SQLite database lifecycle: open, pragma setup, close.
 * Uses better-sqlite3 synchronous API with WAL mode.
 *
 * Since better-sqlite3 is a CommonJS-only package and this project uses
 * ESM ("type": "module"), we use createRequire to load it.
 */

import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import type BetterSqlite3 from 'better-sqlite3';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as typeof BetterSqlite3;

// ── Public interface ────────────────────────────────────────────────

export interface DatabaseManager {
  /** The underlying better-sqlite3 database instance. */
  readonly db: BetterSqlite3.Database;
  /** Close the database connection. Safe to call multiple times. */
  close(): void;
  /** Whether the database connection is currently open. */
  isOpen(): boolean;
}

// ── Factory ─────────────────────────────────────────────────────────

/**
 * Create a new DatabaseManager for the given file path.
 *
 * - Creates parent directories if they do not exist.
 * - Opens (or creates) the SQLite database file.
 * - Applies performance and safety PRAGMAs:
 *     journal_mode  = WAL      (concurrent reads + writes)
 *     foreign_keys  = ON       (enforce FK constraints)
 *     busy_timeout  = 5000     (wait up to 5 s on lock)
 *     synchronous   = FULL     (WAL frames fsynced — survives SIGKILL)
 *     cache_size    = -8000    (8 MB page cache)
 *     temp_store    = MEMORY   (temp tables in RAM)
 */
export function createDatabaseManager(dbPath: string): DatabaseManager {
  // Ensure the parent directory tree exists
  const dir = dirname(dbPath);
  mkdirSync(dir, { recursive: true });

  // Open database (creates file if absent)
  const db: BetterSqlite3.Database = new Database(dbPath);

  // Apply PRAGMAs — better-sqlite3's .pragma() returns the result,
  // but we only care about the side-effect of setting each value.
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = FULL');
  db.pragma('cache_size = -8000');
  db.pragma('temp_store = MEMORY');

  let open = true;

  return {
    get db() {
      if (!open) {
        throw new Error('Database is closed');
      }
      return db;
    },

    close() {
      if (open) {
        db.close();
        open = false;
      }
    },

    isOpen() {
      return open;
    },
  };
}

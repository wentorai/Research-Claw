/**
 * M6 — cross-CONNECTION write atomicity (real SQLite, two connections).
 *
 * Single-connection tests cannot observe these races: they only appear when a
 * second connection commits between two of the first connection's autocommit
 * statements. Both invariants below are properties of the COMMIT order, so they
 * hold only if the revision allocation and the row write share ONE transaction.
 *
 *  1. Replay completeness — a row must never be committed with a revision that a
 *     reader has already passed (otherwise it is permanently unreachable).
 *  2. First-terminal-wins — a terminal committed by another connection must never
 *     be overwritten by a late terminal.
 */

import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ReviewStore, type ReviewFinding } from '../core/review-store.js';

const LOGGER = { info() {}, warn() {}, error() {} };
const NO_FINDINGS: ReviewFinding[] = [];
const META = { sessionKey: 'sk', kind: 'auto' as const, verdict: 'exists', findings: NO_FINDINGS };

let dir: string;
let dbA: Database.Database;
let dbB: Database.Database;
let A: ReviewStore;
let B: ReviewStore;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sup-rev-conc-'));
  const file = path.join(dir, 'reviews.db');
  dbA = new Database(file);
  dbB = new Database(file);
  A = new ReviewStore(dbA, LOGGER);
  B = new ReviewStore(dbB, LOGGER);
  // Fail fast instead of stalling when the other connection holds the write lock.
  // (The store's constructor sets busy_timeout=5000; override AFTER construction.)
  dbB.pragma('busy_timeout = 0');
});

afterEach(() => {
  dbA.close();
  dbB.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * Run `hook` exactly once, immediately after the first statement matching `match`
 * executes on `db` — i.e. INSIDE the store method under test, at a real statement
 * boundary. This is the controlled interleaving a second process would produce.
 */
function injectAfterFirst(db: Database.Database, match: RegExp, hook: () => void): void {
  const origPrepare = db.prepare.bind(db);
  let fired = false;
  (db as unknown as { prepare: unknown }).prepare = (sql: string) => {
    const stmt = origPrepare(sql);
    if (!match.test(sql)) return stmt;
    for (const m of ['get', 'run'] as const) {
      const orig = (stmt[m] as (...a: unknown[]) => unknown).bind(stmt);
      (stmt as unknown as Record<string, unknown>)[m] = (...a: unknown[]) => {
        const v = orig(...a);
        if (!fired) { fired = true; hook(); }
        return v;
      };
    }
    return stmt;
  };
}

describe('M6 cross-connection atomicity', () => {
  // Codex repro: A allocates revision=1 and pauses; B commits revision=2; a reader
  // replays and advances its cursor to 2; A then commits revision=1 — forever below
  // the cursor. Fix: allocate the revision INSIDE the row-write transaction, so
  // revision order == commit-visible order.
  it('a concurrent commit can never strand a row below the replay cursor', () => {
    const seen = new Set<string>();
    let cursor = 0;
    const replay = (): void => {
      const page = A.list({ sessionKey: 'sk', sinceRevision: cursor });
      for (const r of page.reviews) seen.add(r.reviewId);
      if (page.nextCursor != null) cursor = page.nextCursor;
    };

    let bCommitted = false;
    injectAfterFirst(dbA, /revision_seq/, () => {
      // Another connection completes a whole review while A is mid-write ...
      bCommitted = B.finalize('early-b', 'completed', META, 100).ok;
      // ... and a reconnecting dashboard replays + advances its cursor right then.
      if (bCommitted) replay();
    });

    A.finalize('late-a', 'completed', META, 200);
    if (!bCommitted) B.finalize('early-b', 'completed', META, 100); // serialized after A
    replay();

    const persisted = A.list({ sessionKey: 'sk' }).reviews.map((r) => r.reviewId).sort();
    expect(persisted).toEqual(['early-b', 'late-a']);
    expect([...seen].sort()).toEqual(persisted); // every persisted row was reachable
  });

  // Codex repro: A and B both read 'started'; B commits 'completed'; A then
  // unconditionally writes 'failed' — the first terminal loses.
  it('a terminal committed by another connection is never overwritten', () => {
    A.begin('r', { sessionKey: 'sk', kind: 'auto' }, 1);

    let firstTerminal: string | null = null;
    injectAfterFirst(dbA, /supervisor_reviews/, () => {
      if (B.finalize('r', 'completed', META, 2).ok) {
        firstTerminal = (dbB.prepare('SELECT state FROM supervisor_reviews WHERE reviewId = ?').get('r') as { state: string }).state;
      }
    });

    A.finalize('r', 'failed', { ...META, verdict: 'none' }, 3);
    if (firstTerminal === null) {
      firstTerminal = A.get('r')!.state;      // A won the race — it committed first
      B.finalize('r', 'completed', META, 4);  // late duplicate terminal from the loser
    }

    expect(A.get('r')!.state).toBe(firstTerminal); // whoever committed first keeps the terminal
  });
});

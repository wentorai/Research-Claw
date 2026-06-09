/**
 * Regression: rc_memories.type CHECK constraint must accept every MemoryType.
 *
 * The DB CHECK previously omitted 'agent' while the application layer
 * (MemoryType union, memory_create tool enum, rpc VALID_MEMORY_TYPES) treated
 * it as valid — so any agent-type write crashed on the SQLite CHECK. These tests
 * pin the DB constraint to the full type set and confirm it still rejects
 * unknown values.
 */

import { describe, expect, it } from 'vitest';

import { MemoryService } from '../memory/service.js';
import type { MemoryType } from '../memory/types.js';
import { createTestDb } from './setup.js';

const ALL_TYPES: readonly MemoryType[] = ['user', 'feedback', 'project', 'reference', 'agent'];

describe('rc_memories type CHECK constraint', () => {
  it('accepts and retrieves every MemoryType', async () => {
    const db = createTestDb();
    const service = new MemoryService(db);

    for (const type of ALL_TYPES) {
      const created = await service.createMemory({
        type,
        name: `mem-${type}`,
        content: `content for ${type}`,
      });
      expect(created.type).toBe(type);

      const fetched = service.getMemory(created.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.type).toBe(type);
    }

    db.close();
  });

  it("persists an 'agent' memory (the previously-crashing path)", async () => {
    const db = createTestDb();
    const service = new MemoryService(db);

    await service.createMemory({
      type: 'agent',
      name: 'synced-from-claude-mem',
      content: 'agent-captured memory',
    });

    const row = db
      .prepare("SELECT COUNT(*) AS count FROM rc_memories WHERE type = 'agent'")
      .get() as { count: number };
    expect(row.count).toBe(1);

    db.close();
  });

  it('still rejects an unknown type (constraint not loosened)', () => {
    const db = createTestDb();

    const insertBogus = () =>
      db
        .prepare(
          `INSERT INTO rc_memories (id, type, name, content, created_at, updated_at)
           VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))`,
        )
        .run('mem-bogus', 'bogus', 'bad', 'bad');

    expect(insertBogus).toThrow(/CHECK constraint failed/);

    db.close();
  });
});

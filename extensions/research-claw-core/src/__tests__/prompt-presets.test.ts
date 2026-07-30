import { createRequire } from 'node:module';
import type BetterSqlite3 from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { runMigrations, getCurrentVersion } from '../db/migrations.js';
import { SCHEMA_VERSION } from '../db/schema.js';
import { PromptPresetService } from '../prompt-presets/service.js';
import { registerPromptPresetRpc } from '../prompt-presets/rpc.js';
import type { RegisterMethod } from '../types.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as typeof BetterSqlite3;

describe('prompt preset schema migration', () => {
  it('creates the table on both fresh install and a v17 database', () => {
    for (const initialVersion of [0, 17]) {
      const db = new Database(':memory:');
      if (initialVersion === 17) {
        db.exec(`
          CREATE TABLE rc_schema_version (version INTEGER NOT NULL, applied_at TEXT NOT NULL);
          INSERT INTO rc_schema_version VALUES (17, datetime('now'));
        `);
      }
      runMigrations(db);
      expect(getCurrentVersion(db)).toBe(SCHEMA_VERSION);
      expect(
        (db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='rc_prompt_presets'").get() as { count: number }).count,
      ).toBe(1);
      db.close();
    }
  });
});

describe('prompt preset CRUD RPC', () => {
  let db: BetterSqlite3.Database;
  let call: (method: string, params?: Record<string, unknown>) => Promise<unknown>;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    const methods = new Map<string, (params: Record<string, unknown>) => Promise<unknown> | unknown>();
    const register: RegisterMethod = (method, handler) => methods.set(method, handler);
    registerPromptPresetRpc(register, new PromptPresetService(db));
    call = async (method, params = {}) => methods.get(method)!(params);
  });

  it('supports create, list, edit, favorite, usage, reorder, delete and service restart', async () => {
    const first = (await call('rc.prompt-presets.create', {
      name: '文献梳理',
      content: '请梳理这些文献',
      category: '阅读',
    }) as any).preset;
    const second = (await call('rc.prompt-presets.create', {
      name: '审稿',
      content: '请按审稿标准检查',
    }) as any).preset;

    const edited = (await call('rc.prompt-presets.update', {
      id: first.id,
      content: '请按主题梳理这些文献',
      favorite: true,
    }) as any).preset;
    expect(edited).toMatchObject({ favorite: true, content: '请按主题梳理这些文献' });

    const used = (await call('rc.prompt-presets.mark-used', { id: first.id }) as any).preset;
    expect(used.use_count).toBe(1);
    expect(used.last_used_at).toBeTruthy();

    const reordered = (await call('rc.prompt-presets.reorder', {
      ids: [second.id, first.id],
    }) as any).presets;
    expect(reordered.find((p: any) => p.id === second.id).sort_order).toBe(0);
    expect(reordered.find((p: any) => p.id === first.id).sort_order).toBe(1);

    expect(new PromptPresetService(db).get(first.id)).toMatchObject({
      favorite: true,
      use_count: 1,
    });
    expect(await call('rc.prompt-presets.delete', { id: second.id })).toEqual({ deleted: true });
    expect((await call('rc.prompt-presets.list') as any).presets).toHaveLength(1);
  });

  it('rejects invalid data and stale or duplicate reorder requests atomically', async () => {
    await expect(call('rc.prompt-presets.create', { name: ' ', content: 'ok' })).rejects.toThrow(/name/i);
    await expect(call('rc.prompt-presets.create', { name: 'x', content: ' '.repeat(2) })).rejects.toThrow(/content/i);
    await expect(call('rc.prompt-presets.create', { name: 'x'.repeat(101), content: 'ok' })).rejects.toThrow(/100/);
    const a = (await call('rc.prompt-presets.create', { name: 'a', content: 'a' }) as any).preset;
    const b = (await call('rc.prompt-presets.create', { name: 'b', content: 'b' }) as any).preset;
    await expect(call('rc.prompt-presets.reorder', { ids: [a.id, a.id] })).rejects.toThrow(/stale/i);
    await expect(call('rc.prompt-presets.reorder', { ids: [a.id] })).rejects.toThrow(/stale/i);
    expect((await call('rc.prompt-presets.list') as any).presets.map((p: any) => p.id)).toEqual([a.id, b.id]);
  });
});

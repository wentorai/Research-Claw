import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

export interface PromptPreset {
  id: string;
  name: string;
  content: string;
  category: string;
  favorite: boolean;
  sort_order: number;
  use_count: number;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

interface PromptPresetRow extends Omit<PromptPreset, 'favorite'> {
  favorite: number;
}

function rowToPreset(row: PromptPresetRow): PromptPreset {
  return { ...row, favorite: row.favorite !== 0 };
}

export class PromptPresetService {
  constructor(private readonly db: Database.Database) {}

  list(): PromptPreset[] {
    const rows = this.db.prepare(`
      SELECT * FROM rc_prompt_presets
      ORDER BY favorite DESC, sort_order ASC, created_at ASC, id ASC
    `).all() as PromptPresetRow[];
    return rows.map(rowToPreset);
  }

  get(id: string): PromptPreset | null {
    const row = this.db
      .prepare('SELECT * FROM rc_prompt_presets WHERE id = ?')
      .get(id) as PromptPresetRow | undefined;
    return row ? rowToPreset(row) : null;
  }

  create(input: { name: string; content: string; category?: string; favorite?: boolean }): PromptPreset {
    const id = randomUUID();
    const nextOrder = (
      this.db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS value FROM rc_prompt_presets')
        .get() as { value: number }
    ).value;
    this.db.prepare(`
      INSERT INTO rc_prompt_presets (id, name, content, category, favorite, sort_order)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, input.name, input.content, input.category ?? '', input.favorite ? 1 : 0, nextOrder);
    return this.get(id)!;
  }

  update(
    id: string,
    patch: Partial<Pick<PromptPreset, 'name' | 'content' | 'category' | 'favorite'>>,
  ): PromptPreset {
    if (!this.get(id)) throw new Error(`Prompt preset not found: ${id}`);
    const sets: string[] = [];
    const values: unknown[] = [];
    if (patch.name !== undefined) { sets.push('name = ?'); values.push(patch.name); }
    if (patch.content !== undefined) { sets.push('content = ?'); values.push(patch.content); }
    if (patch.category !== undefined) { sets.push('category = ?'); values.push(patch.category); }
    if (patch.favorite !== undefined) { sets.push('favorite = ?'); values.push(patch.favorite ? 1 : 0); }
    if (sets.length === 0) return this.get(id)!;
    sets.push("updated_at = datetime('now')");
    this.db.prepare(`UPDATE rc_prompt_presets SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
    return this.get(id)!;
  }

  delete(id: string): boolean {
    return this.db.prepare('DELETE FROM rc_prompt_presets WHERE id = ?').run(id).changes > 0;
  }

  /**
   * Replace the complete order atomically. Requiring every current id exactly once
   * prevents a stale client from silently dropping a preset created in another window.
   */
  reorder(ids: string[]): PromptPreset[] {
    const apply = this.db.transaction((orderedIds: string[]) => {
      const existing = this.db
        .prepare('SELECT id FROM rc_prompt_presets')
        .all() as Array<{ id: string }>;
      const existingIds = new Set(existing.map((row) => row.id));
      const suppliedIds = new Set(orderedIds);
      if (
        suppliedIds.size !== orderedIds.length
        || suppliedIds.size !== existingIds.size
        || [...suppliedIds].some((id) => !existingIds.has(id))
      ) {
        throw new Error('Preset order is stale: ids must contain every current preset exactly once');
      }
      const update = this.db.prepare(
        "UPDATE rc_prompt_presets SET sort_order = ?, updated_at = datetime('now') WHERE id = ?",
      );
      orderedIds.forEach((id, index) => update.run(index, id));
    });
    apply(ids);
    return this.list();
  }

  markUsed(id: string): PromptPreset {
    const result = this.db.prepare(`
      UPDATE rc_prompt_presets
      SET use_count = use_count + 1,
          last_used_at = datetime('now'),
          updated_at = datetime('now')
      WHERE id = ?
    `).run(id);
    if (result.changes === 0) throw new Error(`Prompt preset not found: ${id}`);
    return this.get(id)!;
  }
}

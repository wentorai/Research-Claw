/**
 * Claude-mem Sync Service
 *
 * Pulls observations from the claude-mem worker API (:37777) and syncs them
 * into the RC library.db as 'agent' type memories.
 *
 * Run via cron or on-demand. Handles deduplication via observation ID mapping.
 */

import Database from 'better-sqlite3';
import { type ClaudeMemObservation, type SyncResult } from './types.js';
import { MemoryService } from './service.js';
import type { CreateMemoryParams } from './types.js';

export interface ClaudeMemSyncConfig {
  workerUrl: string;       // e.g. 'http://127.0.0.1:37777'
  syncIntervalMs?: number;  // for cron-based usage
  dryRun?: boolean;
}

export class ClaudeMemSyncService {
  private memoryService: MemoryService;

  constructor(
    private db: Database.Database,
    config: ClaudeMemSyncConfig
  ) {
    this.memoryService = new MemoryService(db);
  }

  /**
   * Fetch observations from the claude-mem worker API.
   */
  async fetchObservations(limit: number = 50, offset: number = 0): Promise<ClaudeMemObservation[]> {
    const url = `${'http://127.0.0.1:37777'}/api/observations?limit=${limit}&offset=${offset}`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) throw new Error(`Worker API returned ${res.status}`);
      const data = await res.json() as { items: ClaudeMemObservation[]; hasMore: boolean };
      return data.items ?? [];
    } catch (err) {
      throw new Error(`Failed to fetch claude-mem observations: ${err}`);
    }
  }

  /**
   * Convert a claude-mem observation into RC memory create params.
   * Uses the observation ID as a stable dedupe_key so the same observation
   * always maps to one memory (idempotent upsert).
   */
  private toCreateParams(obs: ClaudeMemObservation): CreateMemoryParams {
    // Parse JSON arrays from the worker
    let facts: string[] = [];
    let concepts: string[] = [];
    let filesRead: string[] = [];
    let filesModified: string[] = [];

    try { facts = JSON.parse(obs.facts || '[]'); } catch { /* skip */ }
    try { concepts = JSON.parse(obs.concepts || '[]'); } catch { /* skip */ }
    try { filesRead = JSON.parse(obs.files_read || '[]'); } catch { /* skip */ }
    try { filesModified = JSON.parse(obs.files_modified || '[]'); } catch { /* skip */ }

    // Build content: narrative is the rich description, fall back to title
    const content = obs.narrative
      ?? obs.subtitle
      ?? obs.title;

    return {
      type: 'agent',
      name: obs.title.slice(0, 120),           // RC name column max ~120
      description: obs.subtitle ?? null,
      content,
      is_private: false,
      metadata: {
        // Track provenance for debugging
        claude_mem_id: obs.id,
        claude_mem_session_id: obs.memory_session_id,
        claude_mem_project: obs.project,
        claude_mem_type: obs.type,              // discovery | change | approach | reference | feedback
        claude_mem_created_at: obs.created_at,
        claude_mem_platform_source: obs.platform_source,
        claude_mem_prompt_number: obs.prompt_number,

        // Structured fields for UI rendering
        facts,
        files_read: filesRead,
        files_modified: filesModified,

        // Narrative (may be long)
        narrative: obs.narrative ?? null,
        subtitle: obs.subtitle ?? null,
      },
    };
  }

  /**
   * Sync all observations from the worker into RC memory.
   * Idempotent: re-running syncs the same observations (no duplicate).
   */
  async syncAll(limit: number = 100): Promise<SyncResult> {
    const result: SyncResult = { synced: 0, updated: 0, skipped: 0, errors: [] };

    try {
      const observations = await this.fetchObservations(limit);

      for (const obs of observations) {
        try {
          const params = this.toCreateParams(obs);

          // Use claude-mem observation ID as dedupe key
          const dedupeKey = `claude-mem-${obs.id}`;

          // Check if already synced by looking for existing memory with this dedupe_key
          const existing = this.findByClaudeMemId(obs.id);

          if (existing) {
            // Skip already-synced observations (no update — observation data is immutable in worker)
            result.skipped++;
            continue;
          }

          // Upsert into RC memory
          this.memoryService.upsertMemory({
            ...params,
            dedupe_key: dedupeKey,
            tags: ['claude-mem', `type:${obs.type}`, `project:${obs.project}`],
          });

          result.synced++;
        } catch (err) {
          result.errors.push(`Observation ${obs.id}: ${err}`);
        }
      }
    } catch (err) {
      result.errors.push(`Fetch failed: ${err}`);
    }

    return result;
  }

  /**
   * Find an existing RC memory synced from a specific claude-mem observation ID.
   */
  private findByClaudeMemId(claudeMemId: number): string | null {
    const stmt = this.db.prepare(`
      SELECT id FROM rc_memories
      WHERE json_extract(metadata, '$.claude_mem_id') = ?
      LIMIT 1
    `);
    const row = stmt.get(claudeMemId) as { id: string } | undefined;
    return row?.id ?? null;
  }

  /**
   * Get sync status — how many observations from worker are already in RC.
   */
  async getSyncStatus(limit: number = 100): Promise<{
    workerTotal: number;
    rcSynced: number;
    workerUrl: string;
  }> {
    const observations = await this.fetchObservations(limit);
    const workerTotal = observations.length;

    let rcSynced = 0;
    for (const obs of observations) {
      if (this.findByClaudeMemId(obs.id)) rcSynced++;
    }

    return { workerTotal, rcSynced, workerUrl: 'http://127.0.0.1:37777' };
  }

  /**
   * Get the count of 'agent' type memories in RC (synced from claude-mem).
   */
  getAgentMemoryCount(): number {
    const stmt = this.db.prepare(
      "SELECT COUNT(*) as count FROM rc_memories WHERE type = 'agent'"
    );
    const row = stmt.get() as { count: number };
    return row.count;
  }
}
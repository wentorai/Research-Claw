/**
 * Memory Management Service
 *
 * Core service for managing persistent memories in Research-Claw.
 * Provides CRUD operations, search, and tag management.
 * Now includes semantic search capabilities with vector embeddings.
 */

import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import {
  type Memory,
  type MemoryType,
  type CreateMemoryParams,
  type UpdateMemoryParams,
  type MemoryFilters,
  type MemorySearchResult,
  type MemoryStats,
  type MemoryWithTags,
  type MemoryTag,
  type MemoryLink,
} from './types.js';
import { MemoryVectorStore } from './vector-store.js';
import {
  createEmbeddingProvider,
  type EmbeddingConfig,
  type EmbeddingProvider,
} from './embeddings.js';

export interface MemoryServiceConfig {
  embedding?: EmbeddingConfig;
  vectorStore?: {
    useSqliteVec?: boolean;
    sqliteVecExtensionPath?: string;
  };
  hybridSearch?: {
    enabled?: boolean;
    vectorWeight?: number;
    textWeight?: number;
  };
}

export class MemoryService {
  private vectorStore: MemoryVectorStore | null = null;
  private embeddingProvider: EmbeddingProvider | null = null;
  private hybridSearchConfig = {
    enabled: true,
    vectorWeight: 0.7,
    textWeight: 0.3,
  };

  constructor(
    private db: Database.Database,
    private config: MemoryServiceConfig = {}
  ) {
    this.initializeSemanticSearch();
  }

  /**
   * Initialize semantic search components
   */
  private initializeSemanticSearch(): void {
    try {
      // Initialize vector store
      if (this.config.embedding) {
        this.vectorStore = new MemoryVectorStore(this.db, this.config.vectorStore);

        // Initialize embedding provider
        this.embeddingProvider = createEmbeddingProvider(this.config.embedding);

        // Configure hybrid search
        if (this.config.hybridSearch) {
          this.hybridSearchConfig = {
            enabled: this.config.hybridSearch.enabled ?? true,
            vectorWeight: this.config.hybridSearch.vectorWeight ?? 0.7,
            textWeight: this.config.hybridSearch.textWeight ?? 0.3,
          };
        }
      }
    } catch (error) {
      console.warn('Failed to initialize semantic search:', error);
      this.vectorStore = null;
      this.embeddingProvider = null;
    }
  }

  private normalizeForDedupe(text: string): string {
    return text
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .replace(/[^\p{L}\p{N}\s]/gu, '')
      .trim();
  }

  private hashDedupeKey(type: MemoryType, name: string, content: string): string {
    const seed = `${type}:${this.normalizeForDedupe(name)}:${this.normalizeForDedupe(content).slice(0, 220)}`;
    return createHash('sha256').update(seed).digest('hex').slice(0, 24);
  }

  private parseMetadata(raw: string | null | undefined): Record<string, unknown> {
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};
    } catch {
      return {};
    }
  }

  private findDuplicate(type: MemoryType, dedupeKey: string, name: string): Memory | null {
    const candidates = this.listMemories({ type, is_active: true }, 200);
    const normalizedName = this.normalizeForDedupe(name);
    for (const candidate of candidates) {
      const metadata = this.parseMetadata(candidate.metadata);
      if (metadata.dedupe_key === dedupeKey) return candidate;
      if (this.normalizeForDedupe(candidate.name) === normalizedName) return candidate;
    }
    return null;
  }

  // ── CRUD Operations ─────────────────────────────────────────────────

  /**
   * Create a new memory
   */
  async createMemory(params: CreateMemoryParams): Promise<Memory> {
    const id = `mem-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const now = new Date().toISOString();

    const stmt = this.db.prepare(`
      INSERT INTO rc_memories (
        id, type, name, description, content, metadata,
        related_paper_id, related_task_id,
        created_at, updated_at, is_active, is_private
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      params.type,
      params.name,
      params.description || null,
      params.content,
      JSON.stringify(params.metadata || {}),
      params.related_paper_id || null,
      params.related_task_id || null,
      now,
      now,
      1,
      params.is_private ? 1 : 0
    );

    const memory = this.getMemory(id)!;

    // Generate and store embedding if semantic search is enabled
    if (this.embeddingProvider && this.vectorStore) {
      try {
        const textToEmbed = `${params.name}. ${params.description || ''} ${params.content}`;
        const embedding = await this.embeddingProvider.embed(textToEmbed);
        await this.vectorStore.upsertEmbedding(id, embedding);
      } catch (error) {
        console.warn(`Failed to generate embedding for memory ${id}:`, error);
      }
    }

    return memory;
  }

  /**
   * Create or merge a memory using a stable dedupe key.
   *
   * Automatic capture can fire after every agent run, so exact "create only"
   * semantics quickly produce noisy duplicates. This method keeps one canonical
   * memory per dedupe key and updates it with the latest compressed content.
   */
  async upsertMemory(params: CreateMemoryParams & { dedupe_key?: string; tags?: string[] }): Promise<Memory> {
    const dedupeKey = params.dedupe_key || this.hashDedupeKey(params.type, params.name, params.content);
    const existing = await this.findDuplicate(params.type, dedupeKey, params.name);
    const metadata = {
      ...(params.metadata ?? {}),
      dedupe_key: dedupeKey,
      occurrences: 1,
      updated_by: 'auto_memory_capture',
    };

    if (!existing) {
      const created = await this.createMemory({ ...params, metadata });
      for (const tag of params.tags ?? []) {
        this.addTagToMemory(created.id, tag);
      }
      return created;
    }

    const existingMetadata = this.parseMetadata(existing.metadata);
    const occurrences = Number(existingMetadata.occurrences ?? 1);
    const nextMetadata = {
      ...existingMetadata,
      ...metadata,
      occurrences: Number.isFinite(occurrences) ? occurrences + 1 : 2,
      last_seen_at: new Date().toISOString(),
    };

    const shouldAppendHistory = existing.content.trim() !== params.content.trim();
    const nextContent = shouldAppendHistory
      ? `${params.content}\n\n---\n历史摘录：${existing.content.slice(0, 1000)}`
      : existing.content;

    const updated = await this.updateMemory(existing.id, {
      name: params.name || existing.name,
      description: params.description ?? existing.description,
      content: nextContent,
      metadata: nextMetadata,
      is_active: true,
      is_private: params.is_private,
    }) ?? existing;

    for (const tag of params.tags ?? []) {
      this.addTagToMemory(updated.id, tag);
    }
    return updated;
  }

  /**
   * Get a memory by ID
   */
  getMemory(id: string): Memory | null {
    const stmt = this.db.prepare('SELECT * FROM rc_memories WHERE id = ?');
    const row = stmt.get(id) as Memory | undefined;
    return row || null;
  }

  /**
   * Get a memory with tags
   */
  getMemoryWithTags(id: string): MemoryWithTags | null {
    const memory = this.getMemory(id);
    if (!memory) return null;

    const tags = this.getMemoryTags(id);
    return { ...memory, tags };
  }

  /**
   * Update a memory
   */
  updateMemory(id: string, params: UpdateMemoryParams): Memory | null {
    const existing = this.getMemory(id);
    if (!existing) return null;

    const updates: string[] = [];
    const values: unknown[] = [];

    if (params.name !== undefined) {
      updates.push('name = ?');
      values.push(params.name);
    }
    if (params.description !== undefined) {
      updates.push('description = ?');
      values.push(params.description);
    }
    if (params.content !== undefined) {
      updates.push('content = ?');
      values.push(params.content);
    }
    if (params.metadata !== undefined) {
      updates.push('metadata = ?');
      values.push(JSON.stringify(params.metadata));
    }
    if (params.is_active !== undefined) {
      updates.push('is_active = ?');
      values.push(params.is_active ? 1 : 0);
    }
    if (params.is_private !== undefined) {
      updates.push('is_private = ?');
      values.push(params.is_private ? 1 : 0);
    }

    if (updates.length === 0) return existing;

    updates.push('updated_at = ?');
    values.push(new Date().toISOString());
    values.push(id);

    const stmt = this.db.prepare(`
      UPDATE rc_memories SET ${updates.join(', ')} WHERE id = ?
    `);
    stmt.run(...values);

    return this.getMemory(id)!;
  }

  /**
   * Delete a memory
   */
  deleteMemory(id: string): boolean {
    const stmt = this.db.prepare('DELETE FROM rc_memories WHERE id = ?');
    const result = stmt.run(id);
    return result.changes > 0;
  }

  // ── List & Filter ───────────────────────────────────────────────────

  /**
   * List memories with optional filters
   */
  listMemories(filters?: MemoryFilters, limit: number = 100, offset: number = 0): MemoryWithTags[] {
    let query = 'SELECT * FROM rc_memories WHERE 1=1';
    const params: unknown[] = [];

    if (filters?.type) {
      query += ' AND type = ?';
      params.push(filters.type);
    }
    if (filters?.is_active !== undefined) {
      query += ' AND is_active = ?';
      params.push(filters.is_active ? 1 : 0);
    }
    if (filters?.is_private !== undefined) {
      query += ' AND is_private = ?';
      params.push(filters.is_private ? 1 : 0);
    }
    if (filters?.related_paper_id) {
      query += ' AND related_paper_id = ?';
      params.push(filters.related_paper_id);
    }
    if (filters?.related_task_id) {
      query += ' AND related_task_id = ?';
      params.push(filters.related_task_id);
    }

    // Tag filter requires JOIN
    if (filters?.tag_name) {
      query = `
        SELECT DISTINCT m.* FROM rc_memories m
        INNER JOIN rc_memory_tag_links l ON m.id = l.memory_id
        INNER JOIN rc_memory_tags t ON l.tag_id = t.id
        WHERE t.name = ?
      `;
      // Reset params array for JOIN query
      params.length = 0;
      params.push(filters.tag_name);

      // Re-apply other filters if they exist
      if (filters?.type) {
        query += ' AND m.type = ?';
        params.push(filters.type);
      }
    }

    query += ' ORDER BY updated_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const stmt = this.db.prepare(query);
    const memories = stmt.all(...params) as Memory[];

    // Fetch tags for each memory
    return memories.map(memory => ({
      ...memory,
      tags: this.getMemoryTags(memory.id),
    }));
  }

  /**
   * Get memories by type
   */
  getMemoriesByType(type: MemoryType, limit: number = 50): MemoryWithTags[] {
    return this.listMemories({ type, is_active: true }, limit);
  }

  /**
   * Get recently accessed memories
   */
  getRecentMemories(limit: number = 10): Memory[] {
    const stmt = this.db.prepare(`
      SELECT * FROM rc_memories
      WHERE is_active = 1 AND accessed_at IS NOT NULL
      ORDER BY accessed_at DESC
      LIMIT ?
    `);
    return stmt.all(limit) as Memory[];
  }

  // ── Search ─────────────────────────────────────────────────────────

  /**
   * Probe which backend is actually wired for memory search.
   *
   * - `fts5`     : SQLite FTS5 virtual table is present and queryable
   * - `like`     : FTS5 missing but the base table works (LIKE fallback)
   * - `none`     : the memory tables themselves are not initialized yet
   *
   * `embedding_available` indicates whether semantic vector search is enabled.
   */
  getSearchProvider(): {
    provider: 'fts5' | 'like' | 'none';
    fts_available: boolean;
    embedding_available: boolean;
    notes: string;
    vector_store?: {
      available: boolean;
      sqlite_vec: boolean;
      total_vectors: number;
      provider?: string;
      model?: string;
    };
  } {
    let ftsAvailable = false;
    let baseAvailable = false;
    try {
      this.db.prepare('SELECT 1 FROM rc_memories LIMIT 1').get();
      baseAvailable = true;
    } catch {
      baseAvailable = false;
    }
    if (baseAvailable) {
      try {
        this.db.prepare("SELECT 1 FROM rc_memories_fts WHERE rc_memories_fts MATCH 'x' LIMIT 1").all();
        ftsAvailable = true;
      } catch {
        ftsAvailable = false;
      }
    }

    // Check vector store availability
    let vectorStoreInfo: {
      available: boolean;
      sqlite_vec: boolean;
      total_vectors: number;
      provider?: string;
      model?: string;
    } = {
      available: false,
      sqlite_vec: false,
      total_vectors: 0,
    };

    if (this.vectorStore) {
      const stats = this.vectorStore.getStats();
      vectorStoreInfo = {
        available: true,
        sqlite_vec: stats.sqliteVecAvailable,
        total_vectors: stats.totalVectors,
        provider: this.embeddingProvider?.name,
        model: this.config.embedding?.model,
      };
    }

    if (!baseAvailable) {
      return {
        provider: 'none',
        fts_available: false,
        embedding_available: false,
        notes: 'rc_memories table is not initialized — run migrations.',
        vector_store: vectorStoreInfo,
      };
    }
    if (ftsAvailable) {
      return {
        provider: 'fts5',
        fts_available: true,
        embedding_available: vectorStoreInfo.available,
        notes: vectorStoreInfo.available
          ? 'FTS5 + Vector search active. Hybrid search enabled.'
          : 'FTS5 backend active. Semantic vector search is not enabled.',
        vector_store: vectorStoreInfo,
      };
    }
    return {
      provider: 'like',
      fts_available: false,
      embedding_available: vectorStoreInfo.available,
      notes: vectorStoreInfo.available
        ? 'LIKE fallback + Vector search active.'
        : 'FTS5 unavailable; falling back to LIKE-based search.',
      vector_store: vectorStoreInfo,
    };
  }

  /**
   * Like-based fallback search (used when FTS5 is not available).
   */
  private searchMemoriesLike(query: string, filters: MemoryFilters | undefined, limit: number): MemorySearchResult[] {
    const like = `%${query.replace(/[%_]/g, (m) => `\\${m}`)}%`;
    const where: string[] = ['(name LIKE ? ESCAPE \'\\\' OR content LIKE ? ESCAPE \'\\\' OR description LIKE ? ESCAPE \'\\\')'];
    const params: unknown[] = [like, like, like];
    if (filters?.type) {
      where.push('type = ?');
      params.push(filters.type);
    }
    if (filters?.is_active !== undefined) {
      where.push('is_active = ?');
      params.push(filters.is_active ? 1 : 0);
    }
    if (filters?.is_private !== undefined) {
      where.push('is_private = ?');
      params.push(filters.is_private ? 1 : 0);
    }
    params.push(limit);
    const stmt = this.db.prepare(`SELECT id, type, name, description FROM rc_memories WHERE ${where.join(' AND ')} ORDER BY updated_at DESC LIMIT ?`);
    const rows = stmt.all(...params) as Array<{ id: string; type: MemoryType; name: string; description: string | null }>;
    return rows.map((row, idx) => {
      const memory = this.getMemoryWithTags(row.id);
      return {
        id: row.id,
        type: row.type,
        name: row.name,
        description: row.description,
        rank: idx + 1,
        snippet: memory?.content?.slice(0, 160),
        memory: memory ?? undefined,
      } as MemorySearchResult;
    });
  }

  /**
   * Search memories using FTS5 (or LIKE fallback when FTS5 is unavailable).
   * Now supports hybrid search with vector embeddings when enabled.
   */
  async searchMemories(
    query: string,
    filters?: MemoryFilters,
    limit: number = 20
  ): Promise<MemorySearchResult[]> {
    if (!query.trim()) return [];

    const provider = this.getSearchProvider();

    // If vector search is available and hybrid search is enabled, use hybrid search
    if (provider.embedding_available && this.hybridSearchConfig.enabled) {
      return this.hybridSearch(query, filters, limit);
    }

    // Fall back to text-only search
    if (provider.provider === 'none') return [];
    if (provider.provider === 'like') {
      return this.searchMemoriesLike(query, filters, limit);
    }

    // FTS5 search
    return this.fts5Search(query, filters, limit);
  }

  /**
   * Perform hybrid search combining FTS5 and vector similarity
   */
  private async hybridSearch(
    query: string,
    filters?: MemoryFilters,
    limit: number = 20
  ): Promise<MemorySearchResult[]> {
    // Get text search results
    const textResults = this.fts5Search(query, filters, limit * 2); // Get more candidates

    // Get vector search results
    let vectorResults: Array<{ memory_id: string; score: number }> = [];
    if (this.embeddingProvider && this.vectorStore) {
      try {
        // Generate embedding for query
        const embedding = await this.embeddingProvider.embed(query);

        // Search for similar vectors
        const vectorMatches = await this.vectorStore.vectorSearch(embedding.vector, {
          limit: limit * 2,
          minScore: 0.3, // Minimum similarity threshold
          filters: {
            type: filters?.type,
            is_active: filters?.is_active,
            is_private: filters?.is_private,
          },
        });

        vectorResults = vectorMatches.map((match) => ({
          memory_id: match.memory_id,
          score: match.score,
        }));
      } catch (error) {
        console.warn('Vector search failed, falling back to text-only:', error);
        return textResults.slice(0, limit);
      }
    }

    // Combine and re-rank results
    return this.combineSearchResults(textResults, vectorResults, limit);
  }

  /**
   * Combine text and vector search results with weighted scoring
   */
  private combineSearchResults(
    textResults: MemorySearchResult[],
    vectorResults: Array<{ memory_id: string; score: number }>,
    limit: number
  ): MemorySearchResult[] {
    const combinedScores = new Map<string, { textScore: number; vectorScore: number; result: MemorySearchResult }>();

    // Normalize text scores (BM25 returns lower scores for better matches, so we invert)
    const maxTextScore = Math.max(...textResults.map((r) => r.rank), 1);
    for (const result of textResults) {
      const normalizedTextScore = 1 - (result.rank / maxTextScore); // Higher is better
      combinedScores.set(result.id, {
        textScore: normalizedTextScore,
        vectorScore: 0,
        result,
      });
    }

    // Add vector scores
    for (const vectorResult of vectorResults) {
      const existing = combinedScores.get(vectorResult.memory_id);
      if (existing) {
        existing.vectorScore = vectorResult.score;
      } else {
        // This memory was only found by vector search, add it
        const memory = this.getMemoryWithTags(vectorResult.memory_id);
        if (memory) {
          combinedScores.set(vectorResult.memory_id, {
            textScore: 0,
            vectorScore: vectorResult.score,
            result: {
              id: memory.id,
              type: memory.type,
              name: memory.name,
              description: memory.description,
              rank: 0, // Will be recalculated
              memory: memory as unknown as MemoryWithTags,
            },
          });
        }
      }
    }

    // Calculate hybrid scores and sort
    const hybridResults: MemorySearchResult[] = [];
    for (const [memoryId, scores] of combinedScores) {
      const hybridScore =
        scores.textScore * this.hybridSearchConfig.textWeight +
        scores.vectorScore * this.hybridSearchConfig.vectorWeight;

      hybridResults.push({
        ...scores.result,
        rank: hybridScore, // Use hybrid score as rank
      });
    }

    // Sort by hybrid score (descending) and limit
    return hybridResults
      .sort((a, b) => b.rank - a.rank)
      .slice(0, limit);
  }

  /**
   * Perform FTS5 text search
   */
  private fts5Search(
    query: string,
    filters?: MemoryFilters,
    limit: number = 20
  ): MemorySearchResult[] {
    // Build WHERE clause for filters
    const filterClauses: string[] = [];
    const params: unknown[] = [query];

    if (filters?.type) {
      filterClauses.push('m.type = ?');
      params.push(filters.type);
    }
    if (filters?.is_active !== undefined) {
      filterClauses.push('m.is_active = ?');
      params.push(filters.is_active ? 1 : 0);
    }
    if (filters?.is_private !== undefined) {
      filterClauses.push('m.is_private = ?');
      params.push(filters.is_private ? 1 : 0);
    }

    const whereClause = filterClauses.length > 0 ? `AND ${filterClauses.join(' AND ')}` : '';

    let searchResults: Array<{
      id: string;
      type: MemoryType;
      name: string;
      description: string | null;
      rank: number;
      snippet?: string;
    }>;
    try {
      const stmt = this.db.prepare(`
        SELECT
          m.id,
          m.type,
          m.name,
          m.description,
          snippet(rc_memories_fts, 2, '<mark>', '</mark>', '...', 64) as snippet,
          bm25(rc_memories_fts) as rank
        FROM rc_memories_fts
        INNER JOIN rc_memories m ON rc_memories_fts.rowid = m.rowid
        WHERE rc_memories_fts MATCH ?
        ${whereClause}
        ORDER BY rank
        LIMIT ?
      `);

      params.push(limit);
      searchResults = stmt.all(...params) as Array<{
        id: string;
        type: MemoryType;
        name: string;
        description: string | null;
        rank: number;
        snippet?: string;
      }>;
    } catch {
      return this.searchMemoriesLike(query, filters, limit);
    }

    // Convert search results to full memories with tags
    return searchResults.map((result) => {
      const memory = this.getMemoryWithTags(result.id);
      if (!memory) {
        return {
          id: result.id,
          type: result.type,
          name: result.name,
          description: result.description,
          rank: result.rank,
          snippet: result.snippet,
        };
      }
      return {
        id: result.id,
        type: result.type,
        name: result.name,
        description: result.description,
        rank: result.rank,
        snippet: result.snippet,
        // Add full memory data
        memory: memory as unknown as MemoryWithTags,
      };
    }) as MemorySearchResult[];
  }

  // ── Tag Management ───────────────────────────────────────────────────

  /**
   * Create a new tag
   */
  createTag(name: string, color?: string): MemoryTag {
    const id = `tag-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const stmt = this.db.prepare(`
      INSERT INTO rc_memory_tags (id, name, color, created_at)
      VALUES (?, ?, ?, ?)
    `);
    stmt.run(id, name, color || null, new Date().toISOString());
    return this.getTag(id)!;
  }

  /**
   * Get a tag by ID
   */
  getTag(id: string): MemoryTag | null {
    const stmt = this.db.prepare('SELECT * FROM rc_memory_tags WHERE id = ?');
    const row = stmt.get(id) as MemoryTag | undefined;
    return row || null;
  }

  /**
   * Get tag by name
   */
  getTagByName(name: string): MemoryTag | null {
    const stmt = this.db.prepare('SELECT * FROM rc_memory_tags WHERE name = ?');
    const row = stmt.get(name) as MemoryTag | undefined;
    return row || null;
  }

  /**
   * List all tags
   */
  listTags(): MemoryTag[] {
    const stmt = this.db.prepare('SELECT * FROM rc_memory_tags ORDER BY name');
    return stmt.all() as MemoryTag[];
  }

  /**
   * Get tags for a memory
   */
  getMemoryTags(memoryId: string): MemoryTag[] {
    const stmt = this.db.prepare(`
      SELECT t.* FROM rc_memory_tags t
      INNER JOIN rc_memory_tag_links l ON t.id = l.tag_id
      WHERE l.memory_id = ?
      ORDER BY t.name
    `);
    return stmt.all(memoryId) as MemoryTag[];
  }

  /**
   * Add a tag to a memory
   */
  addTagToMemory(memoryId: string, tagName: string): MemoryTag | null {
    // Get or create tag
    let tag = this.getTagByName(tagName);
    if (!tag) {
      tag = this.createTag(tagName);
    }

    // Check if already linked
    const existing = this.db.prepare(`
      SELECT * FROM rc_memory_tag_links WHERE memory_id = ? AND tag_id = ?
    `).get(memoryId, tag.id);

    if (existing) return tag;

    // Create link
    const stmt = this.db.prepare(`
      INSERT INTO rc_memory_tag_links (memory_id, tag_id) VALUES (?, ?)
    `);
    stmt.run(memoryId, tag.id);

    return tag;
  }

  /**
   * Remove a tag from a memory
   */
  removeTagFromMemory(memoryId: string, tagName: string): boolean {
    const tag = this.getTagByName(tagName);
    if (!tag) return false;

    const stmt = this.db.prepare(`
      DELETE FROM rc_memory_tag_links WHERE memory_id = ? AND tag_id = ?
    `);
    const result = stmt.run(memoryId, tag.id);
    return result.changes > 0;
  }

  /**
   * Delete a tag
   */
  deleteTag(tagId: string): boolean {
    const stmt = this.db.prepare('DELETE FROM rc_memory_tags WHERE id = ?');
    const result = stmt.run(tagId);
    return result.changes > 0;
  }

  // ── Link Management ─────────────────────────────────────────────────

  /**
   * Create a link between two memories
   */
  linkMemories(fromId: string, toId: string, context?: string): MemoryLink | null {
    // Verify both memories exist
    if (!this.getMemory(fromId) || !this.getMemory(toId)) {
      return null;
    }

    const id = `link-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const stmt = this.db.prepare(`
      INSERT INTO rc_memory_links (id, from_memory_id, to_memory_id, context, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(id, fromId, toId, context || null, new Date().toISOString());

    return this.getLink(id)!;
  }

  /**
   * Get a link by ID
   */
  getLink(id: string): MemoryLink | null {
    const stmt = this.db.prepare('SELECT * FROM rc_memory_links WHERE id = ?');
    const row = stmt.get(id) as MemoryLink | undefined;
    return row || null;
  }

  /**
   * Get links for a memory
   */
  getMemoryLinks(memoryId: string, direction: 'incoming' | 'outgoing' | 'both' = 'both'): MemoryLink[] {
    let query = 'SELECT * FROM rc_memory_links WHERE ';
    const params: unknown[] = [];

    if (direction === 'incoming') {
      query += 'to_memory_id = ?';
      params.push(memoryId);
    } else if (direction === 'outgoing') {
      query += 'from_memory_id = ?';
      params.push(memoryId);
    } else {
      query += '(from_memory_id = ? OR to_memory_id = ?)';
      params.push(memoryId, memoryId);
    }

    query += ' ORDER BY created_at DESC';
    const stmt = this.db.prepare(query);
    return stmt.all(...params) as MemoryLink[];
  }

  /**
   * Delete a link
   */
  deleteLink(linkId: string): boolean {
    const stmt = this.db.prepare('DELETE FROM rc_memory_links WHERE id = ?');
    const result = stmt.run(linkId);
    return result.changes > 0;
  }

  /**
   * Unlink two memories
   */
  unlinkMemories(fromId: string, toId: string): boolean {
    const stmt = this.db.prepare(`
      DELETE FROM rc_memory_links WHERE from_memory_id = ? AND to_memory_id = ?
    `);
    const result = stmt.run(fromId, toId);
    return result.changes > 0;
  }

  // ── Statistics ──────────────────────────────────────────────────────

  /**
   * Get memory statistics
   */
  getStats(): MemoryStats {
    const total = this.db.prepare('SELECT COUNT(*) as count FROM rc_memories').get() as { count: number };
    const active = this.db.prepare('SELECT COUNT(*) as count FROM rc_memories WHERE is_active = 1').get() as { count: number };
    const private_ = this.db.prepare('SELECT COUNT(*) as count FROM rc_memories WHERE is_private = 1').get() as { count: number };

    const byType: Record<MemoryType, number> = {
      user: 0,
      feedback: 0,
      project: 0,
      reference: 0,
      agent: 0,
    };

    const typeCounts = this.db.prepare('SELECT type, COUNT(*) as count FROM rc_memories GROUP BY type').all() as Array<{ type: MemoryType; count: number }>;
    typeCounts.forEach(({ type, count }) => {
      byType[type] = count;
    });

    const mostAccessed = this.db.prepare(`
      SELECT * FROM rc_memories ORDER BY access_count DESC LIMIT 5
    `).all() as Memory[];

    const recentlyAccessed = this.db.prepare(`
      SELECT * FROM rc_memories
      WHERE accessed_at IS NOT NULL
      ORDER BY accessed_at DESC
      LIMIT 10
    `).all() as Memory[];

    // Find unused memories (not accessed in 30 days)
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const unused = this.db.prepare(`
      SELECT * FROM rc_memories
      WHERE (accessed_at IS NULL OR accessed_at < ?) AND is_active = 1
      ORDER BY updated_at ASC
      LIMIT 20
    `).all(thirtyDaysAgo) as Memory[];

    return {
      total: total.count,
      by_type: byType,
      active: active.count,
      private: private_.count,
      most_accessed: mostAccessed,
      recently_accessed: recentlyAccessed,
      unused,
    };
  }

  /**
   * Record a memory access
   */
  recordAccess(memoryId: string): void {
    const stmt = this.db.prepare(`
      UPDATE rc_memories
      SET accessed_at = ?, access_count = access_count + 1
      WHERE id = ?
    `);
    stmt.run(new Date().toISOString(), memoryId);
  }

  /**
   * Get sample data for demo
   */
  getSampleData(): Memory[] {
    return [
      {
        id: 'mem-sample-1',
        type: 'user',
        name: '用户背景',
        description: '基本信息和专长',
        content: '我是一名数据科学家，专注于机器学习和自然语言处理研究。主要研究兴趣包括：多智能体系统、推理能力提升、LLM 评估。',
        metadata: JSON.stringify({ expertise: ['ML', 'NLP', 'Multi-Agent'] }),
        related_paper_id: null,
        related_task_id: null,
        created_at: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
        updated_at: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
        accessed_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
        access_count: 156,
        is_active: 1,
        is_private: 0,
      },
      {
        id: 'mem-sample-2',
        type: 'feedback',
        name: '沟通偏好',
        description: '对话风格偏好',
        content: '偏好简洁的回复风格，不要过多的总结性文字。直接回答问题，避免冗长的铺垫。',
        metadata: JSON.stringify({ preference: 'concise' }),
        related_paper_id: null,
        related_task_id: null,
        created_at: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
        updated_at: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
        accessed_at: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
        access_count: 42,
        is_active: 1,
        is_private: 0,
      },
      {
        id: 'mem-sample-3',
        type: 'project',
        name: '论文截止日期',
        description: 'Multi-Agent Reasoning 论文',
        content: '论文 "Multi-Agent Debate for Factual Reasoning" 截止日期是 2026-05-15。目前完成度：方法部分 80%，实验部分 30%。',
        metadata: JSON.stringify({
          deadline: '2026-05-15',
          progress: { method: 0.8, experiment: 0.3 },
        }),
        related_paper_id: null,
        related_task_id: null,
        created_at: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
        updated_at: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString(),
        accessed_at: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
        access_count: 89,
        is_active: 1,
        is_private: 0,
      },
      {
        id: 'mem-sample-4',
        type: 'project',
        name: '实验参数配置',
        description: 'MLP baseline 配置',
        content: '实验参数：batch_size=32, learning_rate=0.001, epochs=100, optimizer=Adam, weight_decay=0.01。用于复现基线模型。',
        metadata: JSON.stringify({
          batch_size: 32,
          learning_rate: 0.001,
          epochs: 100,
          optimizer: 'Adam',
          weight_decay: 0.01,
        }),
        related_paper_id: null,
        related_task_id: null,
        created_at: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
        updated_at: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
        accessed_at: new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString(),
        access_count: 67,
        is_active: 1,
        is_private: 0,
      },
      {
        id: 'mem-sample-5',
        type: 'reference',
        name: 'Grafana 仪表盘',
        description: 'API 延迟监控',
        content: 'Grafana 仪表盘链接：http://grafana.internal/d/api-latency。用于监控 API 延迟指标，在修改请求处理代码时需要检查。',
        metadata: JSON.stringify({ url: 'http://grafana.internal/d/api-latency' }),
        related_paper_id: null,
        related_task_id: null,
        created_at: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
        updated_at: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
        accessed_at: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
        access_count: 23,
        is_active: 1,
        is_private: 0,
      },
    ];
  }
}

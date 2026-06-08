/**
 * Memory Vector Store
 *
 * Provides vector storage and similarity search for memories using SQLite.
 * Supports both sqlite-vec extension and fallback to in-memory vector operations.
 */

import Database from 'better-sqlite3';
import type { EmbeddingResult, EmbeddingProvider, VectorUtils } from './embeddings.js';

export interface VectorSearchOptions {
  limit?: number;
  minScore?: number;
  filters?: {
    type?: string;
    is_active?: boolean;
    is_private?: boolean;
  };
}

export interface VectorSearchResult {
  memory_id: string;
  score: number;
  metadata?: Record<string, unknown>;
}

export interface VectorStoreConfig {
  useSqliteVec?: boolean;
  sqliteVecExtensionPath?: string;
}

/**
 * Vector Store for managing memory embeddings
 */
export class MemoryVectorStore {
  private sqliteVecAvailable: boolean = false;
  private inMemoryVectors: Map<string, number[]> = new Map();

  constructor(
    private db: Database.Database,
    private config: VectorStoreConfig = {}
  ) {
    this.initializeVectorStore();
  }

  /**
   * Initialize vector storage tables and check for sqlite-vec availability
   */
  private initializeVectorStore(): void {
    // Create memory embeddings table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS rc_memory_embeddings (
        id TEXT PRIMARY KEY,
        memory_id TEXT NOT NULL UNIQUE REFERENCES rc_memories(id) ON DELETE CASCADE,
        vector BLOB NOT NULL,
        model TEXT NOT NULL,
        dimensions INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    // Create indexes
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_rc_memory_embeddings_memory_id
      ON rc_memory_embeddings(memory_id);
    `);

    // Check for sqlite-vec availability
    if (this.config.useSqliteVec !== false) {
      try {
        // Try to load sqlite-vec extension
        const extensionPath = this.config.sqliteVecExtensionPath;
        if (extensionPath) {
          this.db.loadExtension(extensionPath);
        } else {
          // Try default extension names
          const defaultPaths = [
            'sqlite-vec',
            'vec0',
            '/usr/local/lib/sqlite-vec',
            '/opt/homebrew/lib/sqlite-vec',
          ];

          for (const path of defaultPaths) {
            try {
              this.db.loadExtension(path);
              this.sqliteVecAvailable = true;
              break;
            } catch {
              continue;
            }
          }
        }

        if (this.sqliteVecAvailable) {
          // Create virtual table for vector search
          this.db.exec(`
            CREATE VIRTUAL TABLE IF NOT EXISTS rc_memory_vectors USING vec0(
              memory_id TEXT PRIMARY KEY,
              embedding FLOAT[1536]
            )
          `);
        }
      } catch (error) {
        console.warn('sqlite-vec extension not available, using in-memory vectors:', error);
        this.sqliteVecAvailable = false;
      }
    }

    // Load existing vectors into memory if not using sqlite-vec
    if (!this.sqliteVecAvailable) {
      this.loadVectorsIntoMemory();
    }
  }

  /**
   * Load existing vectors from database into memory
   */
  private loadVectorsIntoMemory(): void {
    const rows = this.db
      .prepare('SELECT memory_id, vector FROM rc_memory_embeddings')
      .all() as Array<{ memory_id: string; vector: Buffer }>;

    for (const row of rows) {
      const vector = this.deserializeVector(row.vector);
      this.inMemoryVectors.set(row.memory_id, vector);
    }
  }

  /**
   * Serialize vector to binary format
   */
  private serializeVector(vector: number[]): Buffer {
    const buffer = Buffer.allocUnsafe(vector.length * 4);
    for (let i = 0; i < vector.length; i++) {
      buffer.writeFloatLE(vector[i], i * 4);
    }
    return buffer;
  }

  /**
   * Deserialize vector from binary format
   */
  private deserializeVector(buffer: Buffer): number[] {
    const vector = [];
    for (let i = 0; i < buffer.length; i += 4) {
      vector.push(buffer.readFloatLE(i));
    }
    return vector;
  }

  /**
   * Store or update embedding for a memory
   */
  async upsertEmbedding(
    memoryId: string,
    embedding: EmbeddingResult
  ): Promise<void> {
    const vectorBlob = this.serializeVector(embedding.vector);
    const now = new Date().toISOString();

    // Check if embedding exists
    const existing = this.db
      .prepare('SELECT id FROM rc_memory_embeddings WHERE memory_id = ?')
      .get(memoryId) as { id: string } | undefined;

    if (existing) {
      // Update existing embedding
      this.db
        .prepare(`
          UPDATE rc_memory_embeddings
          SET vector = ?, model = ?, dimensions = ?, updated_at = ?
          WHERE memory_id = ?
        `)
        .run(vectorBlob, embedding.model, embedding.dimensions, now, memoryId);
    } else {
      // Insert new embedding
      const id = `emb-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      this.db
        .prepare(`
          INSERT INTO rc_memory_embeddings (id, memory_id, vector, model, dimensions, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `)
        .run(id, memoryId, vectorBlob, embedding.model, embedding.dimensions, now, now);
    }

    // Update in-memory cache
    this.inMemoryVectors.set(memoryId, embedding.vector);

    // Update sqlite-vec virtual table if available
    if (this.sqliteVecAvailable) {
      try {
        // Delete old entry
        this.db.prepare('DELETE FROM rc_memory_vectors WHERE memory_id = ?').run(memoryId);

        // Insert new entry
        const vectorStr = `[${embedding.vector.join(',')}]`;
        this.db
          .prepare('INSERT INTO rc_memory_vectors (memory_id, embedding) VALUES (?, ?)')
          .run(memoryId, vectorStr);
      } catch (error) {
        console.warn('Failed to update sqlite-vec virtual table:', error);
      }
    }
  }

  /**
   * Get embedding for a memory
   */
  getEmbedding(memoryId: string): number[] | null {
    // Check in-memory cache first
    if (this.inMemoryVectors.has(memoryId)) {
      return this.inMemoryVectors.get(memoryId)!;
    }

    // Load from database
    const row = this.db
      .prepare('SELECT vector FROM rc_memory_embeddings WHERE memory_id = ?')
      .get(memoryId) as { vector: Buffer } | undefined;

    if (!row) return null;

    const vector = this.deserializeVector(row.vector);
    this.inMemoryVectors.set(memoryId, vector);
    return vector;
  }

  /**
   * Delete embedding for a memory
   */
  deleteEmbedding(memoryId: string): void {
    // Delete from database
    this.db.prepare('DELETE FROM rc_memory_embeddings WHERE memory_id = ?').run(memoryId);

    // Remove from in-memory cache
    this.inMemoryVectors.delete(memoryId);

    // Remove from sqlite-vec virtual table if available
    if (this.sqliteVecAvailable) {
      try {
        this.db.prepare('DELETE FROM rc_memory_vectors WHERE memory_id = ?').run(memoryId);
      } catch (error) {
        console.warn('Failed to delete from sqlite-vec virtual table:', error);
      }
    }
  }

  /**
   * Search for similar memories using vector similarity
   */
  async vectorSearch(
    queryVector: number[],
    options: VectorSearchOptions = {}
  ): Promise<VectorSearchResult[]> {
    const {
      limit = 10,
      minScore = 0.0,
      filters = {},
    } = options;

    if (this.sqliteVecAvailable) {
      return this.sqliteVecSearch(queryVector, limit, minScore, filters);
    } else {
      return this.inMemorySearch(queryVector, limit, minScore, filters);
    }
  }

  /**
   * Search using sqlite-vec extension
   */
  private async sqliteVecSearch(
    queryVector: number[],
    limit: number,
    minScore: number,
    filters: Record<string, unknown>
  ): Promise<VectorSearchResult[]> {
    try {
      const vectorStr = `[${queryVector.join(',')}]`;
      let query = `
        SELECT
          v.memory_id,
          distance,
          m.metadata
        FROM rc_memory_vectors v
        INNER JOIN rc_memories m ON v.memory_id = m.id
        WHERE v.embedding MATCH ?
          AND m.is_active = 1
      `;
      const params: unknown[] = [vectorStr];

      // Apply filters
      if (filters.type) {
        query += ' AND m.type = ?';
        params.push(filters.type);
      }
      if (filters.is_private !== undefined) {
        query += ' AND m.is_private = ?';
        params.push(filters.is_private ? 1 : 0);
      }

      query += ` ORDER BY distance LIMIT ?`;
      params.push(limit);

      const rows = this.db.prepare(query).all(...params) as Array<{
        memory_id: string;
        distance: number;
        metadata: string;
      }>;

      // Convert distance to similarity score (1 - distance for cosine distance)
      return rows
        .map((row) => ({
          memory_id: row.memory_id,
          score: 1 - row.distance,
          metadata: JSON.parse(row.metadata || '{}'),
        }))
        .filter((result) => result.score >= minScore);
    } catch (error) {
      console.warn('sqlite-vec search failed, falling back to in-memory search:', error);
      return this.inMemorySearch(queryVector, limit, minScore, filters);
    }
  }

  /**
   * Search using in-memory vector operations
   */
  private async inMemorySearch(
    queryVector: number[],
    limit: number,
    minScore: number,
    filters: Record<string, unknown>
  ): Promise<VectorSearchResult[]> {
    // Build filter query
    let whereClause = 'WHERE m.is_active = 1';
    const params: unknown[] = [];

    if (filters.type) {
      whereClause += ' AND m.type = ?';
      params.push(filters.type);
    }
    if (filters.is_private !== undefined) {
      whereClause += ' AND m.is_private = ?';
      params.push(filters.is_private ? 1 : 0);
    }

    // Get all memory IDs that match filters
    const memories = this.db
      .prepare(`SELECT id, metadata FROM rc_memories ${whereClause}`)
      .all(...params) as Array<{ id: string; metadata: string }>;

    // Calculate similarities
    const results: VectorSearchResult[] = [];
    for (const memory of memories) {
      const vector = this.inMemoryVectors.get(memory.id);
      if (!vector) continue;

      const similarity = this.cosineSimilarity(queryVector, vector);
      if (similarity >= minScore) {
        results.push({
          memory_id: memory.id,
          score: similarity,
          metadata: JSON.parse(memory.metadata || '{}'),
        });
      }
    }

    // Sort by similarity and limit results
    return results
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  /**
   * Calculate cosine similarity between two vectors
   */
  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) {
      throw new Error('Vector dimensions must match');
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    if (normA === 0 || normB === 0) {
      return 0;
    }

    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  /**
   * Get statistics about the vector store
   */
  getStats(): {
    totalVectors: number;
    sqliteVecAvailable: boolean;
    modelDistribution: Record<string, number>;
  } {
    const totalVectors = this.db
      .prepare('SELECT COUNT(*) as count FROM rc_memory_embeddings')
      .get() as { count: number };

    const modelRows = this.db
      .prepare('SELECT model, COUNT(*) as count FROM rc_memory_embeddings GROUP BY model')
      .all() as Array<{ model: string; count: number }>;

    const modelDistribution: Record<string, number> = {};
    for (const row of modelRows) {
      modelDistribution[row.model] = row.count;
    }

    return {
      totalVectors: totalVectors.count,
      sqliteVecAvailable: this.sqliteVecAvailable,
      modelDistribution,
    };
  }

  /**
   * Clear all vectors (useful for testing or rebuilding)
   */
  clearAll(): void {
    this.db.prepare('DELETE FROM rc_memory_embeddings').run();
    if (this.sqliteVecAvailable) {
      try {
        this.db.prepare('DELETE FROM rc_memory_vectors').run();
      } catch (error) {
        console.warn('Failed to clear sqlite-vec virtual table:', error);
      }
    }
    this.inMemoryVectors.clear();
  }
}

/**
 * Memory Embedding Service
 *
 * Provides vector embedding functionality for semantic search in memories.
 * Supports multiple embedding providers (OpenAI, Gemini, local models).
 */

import Database from 'better-sqlite3';

export interface EmbeddingConfig {
  provider: 'openai' | 'gemini' | 'local' | 'ollama';
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  dimensions?: number;
}

export interface EmbeddingResult {
  vector: number[];
  model: string;
  dimensions: number;
}

export interface EmbeddingProvider {
  name: string;
  embed(text: string): Promise<EmbeddingResult>;
  embedBatch(texts: string[]): Promise<EmbeddingResult[]>;
}

/**
 * OpenAI Embedding Provider
 */
class OpenAIEmbeddingProvider implements EmbeddingProvider {
  name = 'openai';

  constructor(private config: EmbeddingConfig) {
    if (!config.apiKey) {
      throw new Error('OpenAI API key is required');
    }
  }

  async embed(text: string): Promise<EmbeddingResult> {
    const response = await fetch(
      `${this.config.baseUrl || 'https://api.openai.com/v1'}/embeddings`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model: this.config.model || 'text-embedding-3-small',
          input: text,
        }),
      }
    );

    if (!response.ok) {
      throw new Error(`OpenAI embedding failed: ${response.statusText}`);
    }

    const data = await response.json() as {
      data: Array<{ embedding: number[] }>;
      model: string;
    };

    return {
      vector: data.data[0].embedding,
      model: data.model,
      dimensions: data.data[0].embedding.length,
    };
  }

  async embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
    const response = await fetch(
      `${this.config.baseUrl || 'https://api.openai.com/v1'}/embeddings`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model: this.config.model || 'text-embedding-3-small',
          input: texts,
        }),
      }
    );

    if (!response.ok) {
      throw new Error(`OpenAI batch embedding failed: ${response.statusText}`);
    }

    const data = await response.json() as {
      data: Array<{ embedding: number[] }>;
      model: string;
    };

    return data.data.map((item) => ({
      vector: item.embedding,
      model: data.model,
      dimensions: item.embedding.length,
    }));
  }
}

/**
 * Gemini Embedding Provider
 */
class GeminiEmbeddingProvider implements EmbeddingProvider {
  name = 'gemini';

  constructor(private config: EmbeddingConfig) {
    if (!config.apiKey) {
      throw new Error('Gemini API key is required');
    }
  }

  async embed(text: string): Promise<EmbeddingResult> {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${this.config.model || 'text-embedding-004'}:embedContent?key=${this.config.apiKey}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          content: {
            parts: [{ text }],
          },
        }),
      }
    );

    if (!response.ok) {
      throw new Error(`Gemini embedding failed: ${response.statusText}`);
    }

    const data = await response.json() as {
      embedding: { values: number[] };
    };

    return {
      vector: data.embedding.values,
      model: this.config.model || 'text-embedding-004',
      dimensions: data.embedding.values.length,
    };
  }

  async embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
    // Gemini doesn't support batch embedding, so we'll process sequentially
    return Promise.all(texts.map((text) => this.embed(text)));
  }
}

/**
 * Ollama Embedding Provider
 */
class OllamaEmbeddingProvider implements EmbeddingProvider {
  name = 'ollama';

  constructor(private config: EmbeddingConfig) {}

  async embed(text: string): Promise<EmbeddingResult> {
    const response = await fetch(
      `${this.config.baseUrl || 'http://127.0.0.1:11434'}/api/embeddings`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.config.model || 'nomic-embed-text',
          prompt: text,
        }),
      }
    );

    if (!response.ok) {
      throw new Error(`Ollama embedding failed: ${response.statusText}`);
    }

    const data = await response.json() as {
      embedding: number[];
    };

    return {
      vector: data.embedding,
      model: this.config.model || 'nomic-embed-text',
      dimensions: data.embedding.length,
    };
  }

  async embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
    // Ollama doesn't support batch embedding, so we'll process sequentially
    return Promise.all(texts.map((text) => this.embed(text)));
  }
}

/**
 * Embedding Service Factory
 */
export function createEmbeddingProvider(config: EmbeddingConfig): EmbeddingProvider {
  switch (config.provider) {
    case 'openai':
      return new OpenAIEmbeddingProvider(config);
    case 'gemini':
      return new GeminiEmbeddingProvider(config);
    case 'ollama':
      return new OllamaEmbeddingProvider(config);
    case 'local':
      throw new Error('Local embedding provider not yet implemented');
    default:
      throw new Error(`Unknown embedding provider: ${config.provider}`);
  }
}

/**
 * Vector similarity utilities
 */
export class VectorUtils {
  static cosineSimilarity(a: number[], b: number[]): number {
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

  static findNearest(
    queryVector: number[],
    vectors: Array<{ id: string; vector: number[] }>,
    limit: number = 10,
    minSimilarity: number = 0.0
  ): Array<{ id: string; similarity: number }> {
    const results = vectors
      .map(({ id, vector }) => ({
        id,
        similarity: this.cosineSimilarity(queryVector, vector),
      }))
      .filter((result) => result.similarity >= minSimilarity)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit);

    return results;
  }
}

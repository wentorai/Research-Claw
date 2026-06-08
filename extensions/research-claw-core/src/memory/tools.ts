/**
 * Research-Claw Core — Memory Agent Tools
 *
 * Agent tools for the memory management module:
 *   1. memory_create           — Create a new memory
 *   2. memory_get              — Get a memory by ID
 *   3. memory_update           — Update a memory
 *   4. memory_delete           — Delete a memory
 *   5. memory_list             — List memories with filters
 *   6. memory_search           — Search memories using FTS5
 *   7. memory_add_tag          — Add a tag to a memory
 *   8. memory_remove_tag       — Remove a tag from a memory
 *   9. memory_link             — Create a link between memories
 *   10. memory_unlink          — Remove a link between memories
 *   11. memory_stats           — Get memory statistics
 */

import { MemoryService } from './service.js';
import type { CreateMemoryParams, UpdateMemoryParams, MemoryFilters, MemoryType } from './types.js';
import type { ToolDefinition } from '../types.js';

// ── Helpers ──────────────────────────────────────────────────────────────

function ok(text: string, details: unknown): unknown {
  return { content: [{ type: 'text', text }], details };
}

function fail(message: string): unknown {
  return { content: [{ type: 'text', text: `Error: ${message}` }], details: { error: message } };
}

function formatMemory(memory: any): string {
  const parts = [
    `[${memory.type.toUpperCase()}] ${memory.name}`,
    `  id: ${memory.id}`,
  ];
  if (memory.description) {
    parts.push(`  description: ${memory.description}`);
  }
  parts.push(`  content: ${memory.content}`);
  if (memory.accessed_at) {
    parts.push(`  last accessed: ${memory.accessed_at}`);
  }
  parts.push(`  access count: ${memory.access_count}`);
  return parts.join('\n');
}

// ── Registration ─────────────────────────────────────────────────────────

export function createMemoryTools(service: MemoryService): ToolDefinition[] {
  const tools: ToolDefinition[] = [];

  // ── 1. memory_create ──────────────────────────────────────────────────

  tools.push({
    name: 'memory_create',
    description:
      'Create a new memory entry. Use this to persist important information ' +
      'about the user, project preferences, or reference links.',
    parameters: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['user', 'feedback', 'project', 'reference', 'agent'],
          description: 'Type of memory: user (profile/preferences), feedback (workflow preferences), project (project-specific), reference (external links)',
        },
        name: { type: 'string', description: 'Short, descriptive name for the memory' },
        content: { type: 'string', description: 'Detailed content of the memory' },
        description: { type: 'string', description: 'One-line description (optional)' },
        is_private: {
          type: 'boolean',
          description: 'Mark as private (will not be injected into context) (optional)',
        },
      },
      required: ['type', 'name', 'content'],
    },
    execute: async (_toolCallId: string, params: Record<string, unknown>) => {
      try {
        const createParams: CreateMemoryParams = {
          type: params.type as MemoryType,
          name: params.name as string,
          content: params.content as string,
          description: params.description as string | undefined,
          is_private: params.is_private as boolean | undefined,
        };

        const memory = await service.createMemory(createParams);
        service.recordAccess(memory.id);

        return ok(`Created memory:\n${formatMemory(memory)}`, { id: memory.id, memory });
      } catch (error) {
        return fail(error instanceof Error ? error.message : 'Unknown error');
      }
    },
  });

  // ── 2. memory_get ─────────────────────────────────────────────────────

  tools.push({
    name: 'memory_get',
    description: 'Get a memory by its ID',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Memory ID' },
      },
      required: ['id'],
    },
    execute: async (_toolCallId: string, params: Record<string, unknown>) => {
      try {
        const memory = service.getMemory(params.id as string);
        if (!memory) {
          return fail('Memory not found');
        }

        service.recordAccess(memory.id);

        const memoryWithTags = service.getMemoryWithTags(memory.id);
        const tagNames = memoryWithTags?.tags.map((t) => t.name).join(', ') || 'none';

        return ok(
          `Memory:\n${formatMemory(memory)}\n  tags: ${tagNames}`,
          { id: memory.id, memory: memoryWithTags }
        );
      } catch (error) {
        return fail(error instanceof Error ? error.message : 'Unknown error');
      }
    },
  });

  // ── 3. memory_update ───────────────────────────────────────────────────

  tools.push({
    name: 'memory_update',
    description: 'Update an existing memory',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Memory ID to update' },
        name: { type: 'string', description: 'New name (optional)' },
        description: { type: 'string', description: 'New description (optional)' },
        content: { type: 'string', description: 'New content (optional)' },
        is_active: { type: 'boolean', description: 'Activate/deactivate the memory (optional)' },
        is_private: { type: 'boolean', description: 'Privacy flag (optional)' },
      },
      required: ['id'],
    },
    execute: async (_toolCallId: string, params: Record<string, unknown>) => {
      try {
        const updateParams: UpdateMemoryParams = {
          name: params.name as string | undefined,
          description: params.description as string | undefined,
          content: params.content as string | undefined,
          is_active: params.is_active as boolean | undefined,
          is_private: params.is_private as boolean | undefined,
        };

        const memory = service.updateMemory(params.id as string, updateParams);
        if (!memory) {
          return fail('Memory not found');
        }

        service.recordAccess(memory.id);

        return ok(`Updated memory:\n${formatMemory(memory)}`, { id: memory.id, memory });
      } catch (error) {
        return fail(error instanceof Error ? error.message : 'Unknown error');
      }
    },
  });

  // ── 4. memory_delete ───────────────────────────────────────────────────

  tools.push({
    name: 'memory_delete',
    description: 'Delete a memory permanently',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Memory ID to delete' },
      },
      required: ['id'],
    },
    execute: async (_toolCallId: string, params: Record<string, unknown>) => {
      try {
        const success = service.deleteMemory(params.id as string);
        if (!success) {
          return fail('Memory not found');
        }

        return ok(`Deleted memory: ${params.id}`, { id: params.id });
      } catch (error) {
        return fail(error instanceof Error ? error.message : 'Unknown error');
      }
    },
  });

  // ── 5. memory_list ────────────────────────────────────────────────────

  tools.push({
    name: 'memory_list',
    description: 'List memories with optional filters',
    parameters: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['user', 'feedback', 'project', 'reference', 'agent'],
          description: 'Filter by memory type (optional)',
        },
        is_active: {
          type: 'boolean',
          description: 'Filter by active status (optional)',
        },
        limit: { type: 'number', description: 'Maximum number of results (default: 50)' },
      },
    },
    execute: async (_toolCallId: string, params: Record<string, unknown>) => {
      try {
        const filters: MemoryFilters = {
          type: params.type as MemoryType | undefined,
          is_active: params.is_active as boolean | undefined,
        };

        const limit = (params.limit as number) || 50;
        const memories = service.listMemories(filters, limit);

        if (memories.length === 0) {
          return ok('No memories found matching the criteria', { memories: [] });
        }

        const formatted = memories.map((m) => `  - [${m.type}] ${m.name} (${m.id})`).join('\n');
        return ok(`Found ${memories.length} memories:\n${formatted}`, {
          count: memories.length,
          memories,
        });
      } catch (error) {
        return fail(error instanceof Error ? error.message : 'Unknown error');
      }
    },
  });

  // ── 6. memory_search ─────────────────────────────────────────────────

  tools.push({
    name: 'memory_search',
    description: 'Search memories using full-text search',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        type: {
          type: 'string',
          enum: ['user', 'feedback', 'project', 'reference', 'agent'],
          description: 'Filter by memory type (optional)',
        },
        limit: { type: 'number', description: 'Maximum number of results (default: 20)' },
      },
      required: ['query'],
    },
    execute: async (_toolCallId: string, params: Record<string, unknown>) => {
      try {
        const filters: MemoryFilters = {
          type: params.type as MemoryType | undefined,
          is_active: true,
        };

        const limit = (params.limit as number) || 20;
        const provider = service.getSearchProvider();
        const results = await service.searchMemories(params.query as string, filters, limit);

        if (results.length === 0) {
          return ok(
            `No memories found matching the search query (search provider: ${provider.provider})`,
            { results: [], provider: provider.provider, provider_details: provider }
          );
        }

        const formatted = results
          .map(
            (r) =>
              `  - [${r.type}] ${r.name} (rank: ${r.rank.toFixed(2)})\n    ${r.description || 'No description'}`
          )
          .join('\n\n');

        return ok(
          `Found ${results.length} memories (provider: ${provider.provider}):\n${formatted}`,
          {
            count: results.length,
            results,
            provider: provider.provider,
            provider_details: provider,
          }
        );
      } catch (error) {
        return fail(error instanceof Error ? error.message : 'Unknown error');
      }
    },
  });

  // ── 7. memory_add_tag ────────────────────────────────────────────────

  tools.push({
    name: 'memory_add_tag',
    description: 'Add a tag to a memory',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Memory ID' },
        tag_name: { type: 'string', description: 'Tag name (will be created if not exists)' },
      },
      required: ['id', 'tag_name'],
    },
    execute: async (_toolCallId: string, params: Record<string, unknown>) => {
      try {
        const tag = service.addTagToMemory(params.id as string, params.tag_name as string);
        if (!tag) {
          return fail('Failed to add tag (memory may not exist)');
        }

        return ok(`Added tag "${tag.name}" to memory ${params.id}`, {
          memory_id: params.id,
          tag,
        });
      } catch (error) {
        return fail(error instanceof Error ? error.message : 'Unknown error');
      }
    },
  });

  // ── 8. memory_remove_tag ─────────────────────────────────────────────

  tools.push({
    name: 'memory_remove_tag',
    description: 'Remove a tag from a memory',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Memory ID' },
        tag_name: { type: 'string', description: 'Tag name to remove' },
      },
      required: ['id', 'tag_name'],
    },
    execute: async (_toolCallId: string, params: Record<string, unknown>) => {
      try {
        const success = service.removeTagFromMemory(params.id as string, params.tag_name as string);
        if (!success) {
          return fail('Failed to remove tag (memory or tag may not exist)');
        }

        return ok(`Removed tag "${params.tag_name}" from memory ${params.id}`, {
          memory_id: params.id,
          tag_name: params.tag_name,
        });
      } catch (error) {
        return fail(error instanceof Error ? error.message : 'Unknown error');
      }
    },
  });

  // ── 9. memory_link ───────────────────────────────────────────────────

  tools.push({
    name: 'memory_link',
    description: 'Create a bidirectional link between two memories',
    parameters: {
      type: 'object',
      properties: {
        from_id: { type: 'string', description: 'Source memory ID' },
        to_id: { type: 'string', description: 'Target memory ID' },
        context: { type: 'string', description: 'Context for the link (optional)' },
      },
      required: ['from_id', 'to_id'],
    },
    execute: async (_toolCallId: string, params: Record<string, unknown>) => {
      try {
        const link = service.linkMemories(
          params.from_id as string,
          params.to_id as string,
          params.context as string | undefined
        );
        if (!link) {
          return fail('Failed to create link (one or both memories may not exist)');
        }

        return ok(`Created link from ${params.from_id} to ${params.to_id}`, {
          link,
        });
      } catch (error) {
        return fail(error instanceof Error ? error.message : 'Unknown error');
      }
    },
  });

  // ── 10. memory_unlink ─────────────────────────────────────────────────

  tools.push({
    name: 'memory_unlink',
    description: 'Remove a link between two memories',
    parameters: {
      type: 'object',
      properties: {
        from_id: { type: 'string', description: 'Source memory ID' },
        to_id: { type: 'string', description: 'Target memory ID' },
      },
      required: ['from_id', 'to_id'],
    },
    execute: async (_toolCallId: string, params: Record<string, unknown>) => {
      try {
        const success = service.unlinkMemories(params.from_id as string, params.to_id as string);
        if (!success) {
          return fail('Failed to remove link (link may not exist)');
        }

        return ok(`Removed link from ${params.from_id} to ${params.to_id}`, {
          from_id: params.from_id,
          to_id: params.to_id,
        });
      } catch (error) {
        return fail(error instanceof Error ? error.message : 'Unknown error');
      }
    },
  });

  // ── 11. memory_stats ─────────────────────────────────────────────────

  tools.push({
    name: 'memory_stats',
    description: 'Get memory statistics and usage patterns',
    parameters: {
      type: 'object',
      properties: {},
    },
    execute: async (_toolCallId: string) => {
      try {
        const stats = service.getStats();

        const summary = [
          `Total memories: ${stats.total}`,
          `Active: ${stats.active} | Private: ${stats.private}`,
          '',
          'By type:',
          `  user: ${stats.by_type.user}`,
          `  feedback: ${stats.by_type.feedback}`,
          `  project: ${stats.by_type.project}`,
          `  reference: ${stats.by_type.reference}`,
          '',
          `Most accessed: ${stats.most_accessed.map((m) => `${m.name} (${m.access_count})`).join(', ')}`,
        ].join('\n');

        return ok(summary, { stats });
      } catch (error) {
        return fail(error instanceof Error ? error.message : 'Unknown error');
      }
    },
  });

  return tools;
}

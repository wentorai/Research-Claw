/**
 * Research-Claw Core — Memory RPC Handlers
 *
 * Gateway RPC method handlers for the memory management module:
 *
 * Memory methods (rc.memory.*):
 *   1. rc.memory.list        — List memories with filters and pagination
 *   2. rc.memory.get         — Get memory details with tags and links
 *   3. rc.memory.create      — Create a new memory
 *   4. rc.memory.update      — Update a memory
 *   5. rc.memory.delete      — Delete a memory
 *   6. rc.memory.search      — Search memories using FTS5
 *   7. rc.memory.getByType   — Get memories by type
 *   8. rc.memory.getRecent   — Get recently accessed memories
 *
 * Tag methods (rc.memory.tags.*):
 *   9. rc.memory.tags.list   — List all tags
 *   10. rc.memory.tags.create — Create a new tag
 *   11. rc.memory.tags.delete — Delete a tag
 *   12. rc.memory.tags.add    — Add a tag to a memory
 *   13. rc.memory.tags.remove — Remove a tag from a memory
 *
 * Link methods (rc.memory.links.*):
 *   14. rc.memory.links.get   — Get links for a memory
 *   15. rc.memory.links.create — Create a link between memories
 *   16. rc.memory.links.delete — Delete a link
 *
 * Stats methods (rc.memory.stats):
 *   17. rc.memory.stats.get   — Get memory statistics
 *
 * All RPC handlers are registered via api.registerGatewayMethod().
 */

import { MemoryService } from './service.js';
import type { CreateMemoryParams, UpdateMemoryParams, MemoryType, MemoryFilters } from './types.js';
import type { RegisterMethod } from '../types.js';

// ── Validation Helpers ───────────────────────────────────────────────────

const VALID_MEMORY_TYPES: readonly MemoryType[] = ['user', 'feedback', 'project', 'reference', 'agent'];

class RpcValidationError extends Error {
  errorCode: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'RpcValidationError';
    this.errorCode = code;
  }
}

function requireString(val: unknown, field: string): string {
  if (typeof val !== 'string' || val.trim().length === 0) {
    throw new RpcValidationError('INVALID_PARAMS', `${field} is required and must be a non-empty string`);
  }
  return val.trim();
}

function optionalString(val: unknown, field: string): string | undefined {
  if (val === undefined || val === null) return undefined;
  if (typeof val !== 'string') {
    throw new RpcValidationError('INVALID_PARAMS', `${field} must be a string`);
  }
  return val;
}

function optionalNullableString(val: unknown, field: string): string | null | undefined {
  if (val === undefined) return undefined;
  if (val === null) return null;
  if (typeof val !== 'string') {
    throw new RpcValidationError('INVALID_PARAMS', `${field} must be a string or null`);
  }
  return val;
}

function requireEnum<T extends string>(val: unknown, field: string, allowed: readonly T[]): T {
  if (typeof val !== 'string' || !allowed.includes(val as T)) {
    throw new RpcValidationError('INVALID_PARAMS', `${field} must be one of: ${allowed.join(', ')}`);
  }
  return val as T;
}

function optionalEnum<T extends string>(val: unknown, field: string, allowed: readonly T[]): T | undefined {
  if (val === undefined || val === null) return undefined;
  if (typeof val !== 'string') {
    throw new RpcValidationError('INVALID_PARAMS', `${field} must be a string`);
  }
  if (!allowed.includes(val as T)) {
    throw new RpcValidationError('INVALID_PARAMS', `${field} must be one of: ${allowed.join(', ')}`);
  }
  return val as T;
}

function optionalNumber(val: unknown, field: string): number | undefined {
  if (val === undefined || val === null) return undefined;
  if (typeof val !== 'number' || !Number.isFinite(val)) {
    throw new RpcValidationError('INVALID_PARAMS', `${field} must be a number`);
  }
  return val;
}

function optionalBoolean(val: unknown, field: string): boolean | undefined {
  if (val === undefined || val === null) return undefined;
  if (typeof val !== 'boolean') {
    throw new RpcValidationError('INVALID_PARAMS', `${field} must be a boolean`);
  }
  return val;
}

// ── Registration ─────────────────────────────────────────────────────────

export function registerMemoryRpcMethods(registerMethod: RegisterMethod, service: MemoryService): void {
  // ── 1. rc.memory.list ────────────────────────────────────────────────

  registerMethod('rc.memory.list', async (params) => {
    const filters: MemoryFilters = {
      type: optionalEnum(params.type, 'type', VALID_MEMORY_TYPES),
      is_active: optionalBoolean(params.is_active, 'is_active'),
      is_private: optionalBoolean(params.is_private, 'is_private'),
      tag_name: optionalString(params.tag_name, 'tag_name'),
      related_paper_id: optionalString(params.related_paper_id, 'related_paper_id'),
      related_task_id: optionalString(params.related_task_id, 'related_task_id'),
    };

    const limit = optionalNumber(params.limit, 'limit') || 50;
    const offset = optionalNumber(params.offset, 'offset') || 0;

    const memories = service.listMemories(filters, limit, offset);

    // Return consistent format with other services: { items: [...], total: number }
    return {
      items: memories,
      total: memories.length,
    };
  });

  // ── 2. rc.memory.get ─────────────────────────────────────────────────

  registerMethod('rc.memory.get', async (params) => {
    const id = requireString(params.id, 'id');

    const memory = service.getMemoryWithTags(id);
    if (!memory) {
      throw new RpcValidationError('NOT_FOUND', 'Memory not found');
    }

    service.recordAccess(id);

    const links = service.getMemoryLinks(id, 'both');

    // Return memory with links directly
    return {
      ...memory,
      links,
    };
  });

  // ── 3. rc.memory.create ───────────────────────────────────────────────

  registerMethod('rc.memory.create', async (params) => {
    const type = requireEnum(params.type, 'type', VALID_MEMORY_TYPES);
    const name = requireString(params.name, 'name');
    const content = requireString(params.content, 'content');

    const createParams: CreateMemoryParams = {
      type,
      name,
      content,
      description: optionalNullableString(params.description, 'description'),
      metadata: params.metadata as Record<string, unknown> | undefined,
      related_paper_id: optionalString(params.related_paper_id, 'related_paper_id'),
      related_task_id: optionalString(params.related_task_id, 'related_task_id'),
      is_private: optionalBoolean(params.is_private, 'is_private'),
    };

    const memory = await service.createMemory(createParams);

    // Return the created memory with tags directly
    return service.getMemoryWithTags(memory.id);
  });

  // ── 4. rc.memory.update ───────────────────────────────────────────────

  registerMethod('rc.memory.update', async (params) => {
    const id = requireString(params.id, 'id');

    const updateParams: UpdateMemoryParams = {
      name: optionalString(params.name, 'name'),
      description: optionalNullableString(params.description, 'description'),
      content: optionalString(params.content, 'content'),
      metadata: params.metadata as Record<string, unknown> | undefined,
      is_active: optionalBoolean(params.is_active, 'is_active'),
      is_private: optionalBoolean(params.is_private, 'is_private'),
    };

    const memory = service.updateMemory(id, updateParams);
    if (!memory) {
      throw new RpcValidationError('NOT_FOUND', 'Memory not found');
    }

    // Return the updated memory with tags directly
    return service.getMemoryWithTags(memory.id);
  });

  // ── 5. rc.memory.delete ───────────────────────────────────────────────

  registerMethod('rc.memory.delete', async (params) => {
    const id = requireString(params.id, 'id');

    const success = service.deleteMemory(id);
    if (!success) {
      throw new RpcValidationError('NOT_FOUND', 'Memory not found');
    }

    return {
      success: true,
      id,
    };
  });

  // ── 6. rc.memory.search ──────────────────────────────────────────────

  registerMethod('rc.memory.search', async (params) => {
    const query = requireString(params.query, 'query');

    const filters: MemoryFilters = {
      type: optionalEnum(params.type, 'type', VALID_MEMORY_TYPES),
      is_active: params.is_active === undefined ? true : optionalBoolean(params.is_active, 'is_active'),
      is_private: optionalBoolean(params.is_private, 'is_private'),
    };

    const limit = optionalNumber(params.limit, 'limit') || 20;

    const provider = service.getSearchProvider();
    const results = await service.searchMemories(query, filters, limit);

    return {
      results,
      count: results.length,
      query,
      provider: provider.provider,
      provider_details: provider,
    };
  });

  // ── 7. rc.memory.getByType ────────────────────────────────────────────

  registerMethod('rc.memory.getByType', async (params) => {
    const type = requireEnum(params.type, 'type', VALID_MEMORY_TYPES);
    const limit = optionalNumber(params.limit, 'limit') || 50;

    const memories = service.getMemoriesByType(type, limit);

    // Return consistent format: { memories: [...], count: number, type: string }
    return {
      memories,
      count: memories.length,
      type,
    };
  });

  // ── 8. rc.memory.getRecent ────────────────────────────────────────────

  registerMethod('rc.memory.getRecent', async (params) => {
    const limit = optionalNumber(params.limit, 'limit') || 10;

    const memories = service.getRecentMemories(limit);

    // Return consistent format: { memories: [...], count: number }
    return {
      memories,
      count: memories.length,
    };
  });

  // ── 9. rc.memory.tags.list ───────────────────────────────────────────

  registerMethod('rc.memory.tags.list', async () => {
    const tags = service.listTags();

    return {
      success: true,
      tags,
      count: tags.length,
    };
  });

  // ── 10. rc.memory.tags.create ─────────────────────────────────────────

  registerMethod('rc.memory.tags.create', async (params) => {
    const name = requireString(params.name, 'name');
    const color = optionalString(params.color, 'color');

    // Check if tag already exists
    const existing = service.getTagByName(name);
    if (existing) {
      return {
        success: true,
        tag: existing,
        existed: true,
      };
    }

    const tag = service.createTag(name, color);

    return {
      success: true,
      tag,
      existed: false,
    };
  });

  // ── 11. rc.memory.tags.delete ─────────────────────────────────────────

  registerMethod('rc.memory.tags.delete', async (params) => {
    const id = requireString(params.id, 'id');

    const success = service.deleteTag(id);
    if (!success) {
      throw new RpcValidationError('NOT_FOUND', 'Tag not found');
    }

    return {
      success: true,
      id,
    };
  });

  // ── 12. rc.memory.tags.add ────────────────────────────────────────────

  registerMethod('rc.memory.tags.add', async (params) => {
    const id = requireString(params.id, 'id');
    const tag_name = requireString(params.tag_name, 'tag_name');

    const tag = service.addTagToMemory(id, tag_name);
    if (!tag) {
      throw new RpcValidationError('NOT_FOUND', 'Memory not found');
    }

    return {
      success: true,
      memory_id: id,
      tag,
    };
  });

  // ── 13. rc.memory.tags.remove ─────────────────────────────────────────

  registerMethod('rc.memory.tags.remove', async (params) => {
    const id = requireString(params.id, 'id');
    const tag_name = requireString(params.tag_name, 'tag_name');

    const success = service.removeTagFromMemory(id, tag_name);
    if (!success) {
      throw new RpcValidationError('NOT_FOUND', 'Memory or tag not found');
    }

    return {
      success: true,
      memory_id: id,
      tag_name,
    };
  });

  // ── 14. rc.memory.links.get ───────────────────────────────────────────

  registerMethod('rc.memory.links.get', async (params) => {
    const id = requireString(params.id, 'id');
    const direction = (params.direction === 'incoming' || params.direction === 'outgoing' || params.direction === 'both'
      ? params.direction
      : 'both') as 'incoming' | 'outgoing' | 'both';

    const links = service.getMemoryLinks(id, direction);

    return {
      success: true,
      memory_id: id,
      direction,
      links,
      count: links.length,
    };
  });

  // ── 15. rc.memory.links.create ─────────────────────────────────────────

  registerMethod('rc.memory.links.create', async (params) => {
    const from_id = requireString(params.from_id, 'from_id');
    const to_id = requireString(params.to_id, 'to_id');
    const context = optionalString(params.context, 'context');

    const link = service.linkMemories(from_id, to_id, context);
    if (!link) {
      throw new RpcValidationError('NOT_FOUND', 'One or both memories not found');
    }

    return {
      success: true,
      link,
    };
  });

  // ── 16. rc.memory.links.delete ─────────────────────────────────────────

  registerMethod('rc.memory.links.delete', async (params) => {
    const id = requireString(params.id, 'id');

    const success = service.deleteLink(id);
    if (!success) {
      throw new RpcValidationError('NOT_FOUND', 'Link not found');
    }

    return {
      success: true,
      id,
    };
  });

  // ── 17. rc.memory.stats.get ───────────────────────────────────────────

  registerMethod('rc.memory.stats.get', async () => {
    const stats = service.getStats();

    return {
      success: true,
      stats,
    };
  });
}

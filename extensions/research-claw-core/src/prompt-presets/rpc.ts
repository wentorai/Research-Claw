import type { RegisterMethod } from '../types.js';
import type { PromptPresetService } from './service.js';

const NAME_MAX = 100;
const CONTENT_MAX = 20_000;
const CATEGORY_MAX = 100;

function requiredText(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${field} is required and must be a non-empty string`);
  }
  const trimmed = value.trim();
  if (trimmed.length > max) throw new Error(`${field} must be at most ${max} characters`);
  return trimmed;
}

function optionalText(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`${field} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw new Error(`${field} must be at most ${max} characters`);
  return trimmed;
}

function requiredId(value: unknown): string {
  return requiredText(value, 'id', 100);
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new Error(`${field} must be a boolean`);
  return value;
}

export function registerPromptPresetRpc(
  registerMethod: RegisterMethod,
  service: PromptPresetService,
): void {
  registerMethod('rc.prompt-presets.list', async () => ({ presets: service.list() }));

  registerMethod('rc.prompt-presets.create', async (params) => ({
    preset: service.create({
      name: requiredText(params.name, 'name', NAME_MAX),
      content: requiredText(params.content, 'content', CONTENT_MAX),
      category: optionalText(params.category, 'category', CATEGORY_MAX),
      favorite: optionalBoolean(params.favorite, 'favorite'),
    }),
  }));

  registerMethod('rc.prompt-presets.update', async (params) => {
    const id = requiredId(params.id);
    const patch = {
      name: optionalText(params.name, 'name', NAME_MAX),
      content: optionalText(params.content, 'content', CONTENT_MAX),
      category: optionalText(params.category, 'category', CATEGORY_MAX),
      favorite: optionalBoolean(params.favorite, 'favorite'),
    };
    if (patch.name !== undefined && patch.name.length === 0) throw new Error('name must not be empty');
    if (patch.content !== undefined && patch.content.length === 0) throw new Error('content must not be empty');
    return { preset: service.update(id, patch) };
  });

  registerMethod('rc.prompt-presets.delete', async (params) => ({
    deleted: service.delete(requiredId(params.id)),
  }));

  registerMethod('rc.prompt-presets.reorder', async (params) => {
    if (!Array.isArray(params.ids) || params.ids.some((id) => typeof id !== 'string' || !id)) {
      throw new Error('ids must be an array of non-empty strings');
    }
    return { presets: service.reorder(params.ids) };
  });

  registerMethod('rc.prompt-presets.mark-used', async (params) => ({
    preset: service.markUsed(requiredId(params.id)),
  }));
}

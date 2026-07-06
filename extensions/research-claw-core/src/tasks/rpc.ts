/**
 * Research-Claw Core — Task RPC Handlers
 *
 * 19 gateway RPC method handlers for the task management module:
 *
 * Task methods (rc.task.*):
 *   1.  rc.task.list           — List/filter tasks with pagination
 *   2.  rc.task.get            — Get task details (activity log + subtasks)
 *   3.  rc.task.create         — Create a new task (actor: human)
 *   4.  rc.task.update         — Update task fields (actor: human)
 *   5.  rc.task.complete       — Mark a task as done (actor: human)
 *   6.  rc.task.delete         — Delete a task
 *   7.  rc.task.upcoming       — Tasks with deadlines in the next N hours
 *   8.  rc.task.overdue        — Tasks past their deadline
 *   9.  rc.task.link           — Link a task to a paper
 *   10. rc.task.linkFile       — Link a task to a workspace file
 *   11. rc.task.notes.add      — Append a note to a task
 *
 * Cron preset methods (rc.cron.presets.*):
 *   11. rc.cron.presets.list       — List all cron presets with state
 *   12. rc.cron.presets.activate   — Activate a cron preset
 *   13. rc.cron.presets.deactivate — Deactivate a cron preset
 *   14. rc.cron.presets.setJobId   — Store gateway cron job ID
 *   15. rc.cron.presets.delete     — Delete a cron preset from DB
 *   16. rc.cron.presets.restore    — Restore a deleted preset from PRESET_DEFINITIONS
 *
 * Notification methods (rc.notifications.*):
 *   17. rc.notifications.pending   — Query pending deadline/overdue notifications
 *
 * Error codes: rc.task.* and rc.cron.* use string-based error codes
 * (INVALID_PARAMS, SERVICE_ERROR) via RpcValidationError, not numeric JSON-RPC codes.
 * This differs from rc.lit.* which uses numeric codes -32001 to -32012.
 *
 * All RPC handlers are registered via api.registerGatewayMethod().
 * Task mutations use actor = 'human'. Cron preset state is managed via the TaskService.
 */

import {
  type TaskService,
  type TaskInput,
  type TaskPatch,
  type TaskType,
  type TaskStatus,
  type TaskPriority,
  type ListParams,
} from './service.js';
import type { RegisterMethod } from '../types.js';

// ── Validation Helpers ───────────────────────────────────────────────────

const VALID_TASK_TYPES: readonly TaskType[] = ['human', 'agent', 'mixed'];
const VALID_PRIORITIES: readonly TaskPriority[] = ['urgent', 'high', 'medium', 'low'];
const VALID_STATUSES: readonly TaskStatus[] = ['todo', 'in_progress', 'blocked', 'done', 'cancelled'];
const VALID_SORT_COLUMNS = ['title', 'deadline', 'priority', 'status', 'created_at', 'updated_at', 'completed_at'] as const;
const VALID_DIRECTIONS = ['asc', 'desc'] as const;

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
    throw new RpcValidationError(
      'INVALID_PARAMS',
      `${field} must be one of: ${allowed.join(', ')}`,
    );
  }
  return val as T;
}

function optionalEnum<T extends string>(val: unknown, field: string, allowed: readonly T[]): T | undefined {
  if (val === undefined || val === null) return undefined;
  return requireEnum(val, field, allowed);
}

function optionalNumber(val: unknown, field: string, min?: number, max?: number): number | undefined {
  if (val === undefined || val === null) return undefined;
  const n = typeof val === 'number' ? val : Number(val);
  if (isNaN(n)) {
    throw new RpcValidationError('INVALID_PARAMS', `${field} must be a number`);
  }
  if (min !== undefined && n < min) {
    throw new RpcValidationError('INVALID_PARAMS', `${field} must be >= ${min}`);
  }
  if (max !== undefined && n > max) {
    throw new RpcValidationError('INVALID_PARAMS', `${field} must be <= ${max}`);
  }
  return n;
}

function optionalBoolean(val: unknown, field: string): boolean | undefined {
  if (val === undefined || val === null) return undefined;
  if (typeof val === 'boolean') return val;
  if (val === 'true') return true;
  if (val === 'false') return false;
  throw new RpcValidationError('INVALID_PARAMS', `${field} must be a boolean`);
}

function optionalStringArray(val: unknown, field: string, maxLen?: number): string[] | undefined {
  if (val === undefined || val === null) return undefined;
  if (!Array.isArray(val)) {
    throw new RpcValidationError('INVALID_PARAMS', `${field} must be an array of strings`);
  }
  if (maxLen !== undefined && val.length > maxLen) {
    throw new RpcValidationError('INVALID_PARAMS', `${field} must have at most ${maxLen} items`);
  }
  for (const item of val) {
    if (typeof item !== 'string') {
      throw new RpcValidationError('INVALID_PARAMS', `${field} must contain only strings`);
    }
  }
  return val as string[];
}

function requireObject(val: unknown, field: string): Record<string, unknown> {
  if (val === null || val === undefined || typeof val !== 'object' || Array.isArray(val)) {
    throw new RpcValidationError('INVALID_PARAMS', `${field} is required and must be an object`);
  }
  return val as Record<string, unknown>;
}

function optionalObject(val: unknown, field: string): Record<string, unknown> | undefined {
  if (val === undefined || val === null) return undefined;
  if (typeof val !== 'object' || Array.isArray(val)) {
    throw new RpcValidationError('INVALID_PARAMS', `${field} must be an object`);
  }
  return val as Record<string, unknown>;
}

// ── Error Mapping ────────────────────────────────────────────────────────

function mapServiceError(err: unknown): { error: string; message: string } {
  const message = err instanceof Error ? err.message : String(err);
  return { error: 'SERVICE_ERROR', message };
}

// ── Registration ─────────────────────────────────────────────────────────

export function registerTaskRpc(registerMethod: RegisterMethod, service: TaskService): void {

  // ── 1. rc.task.list ───────────────────────────────────────────────

  registerMethod('rc.task.list', async (params: Record<string, unknown>) => {
    try {
      const listParams: ListParams = {
        offset: optionalNumber(params.offset, 'offset', 0),
        limit: optionalNumber(params.limit, 'limit', 1, 200),
        status: optionalEnum(params.status, 'status', VALID_STATUSES),
        priority: optionalEnum(params.priority, 'priority', VALID_PRIORITIES),
        task_type: optionalEnum(params.task_type, 'task_type', VALID_TASK_TYPES),
        sort: optionalEnum(params.sort, 'sort', [...VALID_SORT_COLUMNS]),
        direction: optionalEnum(params.direction, 'direction', [...VALID_DIRECTIONS]),
        include_completed: optionalBoolean(params.include_completed, 'include_completed'),
      };

      return service.list(listParams);
    } catch (err) {
      if (err instanceof RpcValidationError) {
        throw new Error(err.message);
      }
      throw err;
    }
  });

  // ── 2. rc.task.get ────────────────────────────────────────────────

  registerMethod('rc.task.get', async (params: Record<string, unknown>) => {
    try {
      const id = requireString(params.id, 'id');
      const taskWithDetails = service.get(id);

      if (taskWithDetails === null) {
        throw new Error(`Task not found: ${id}`);
      }

      return taskWithDetails;
    } catch (err) {
      throw err instanceof RpcValidationError ? new Error(err.message) : err;
    }
  });

  // ── 3. rc.task.create ─────────────────────────────────────────────

  registerMethod('rc.task.create', async (params: Record<string, unknown>) => {
    try {
      const taskData = requireObject(params.task, 'task');

      const input: TaskInput = {
        title: requireString(taskData.title, 'task.title'),
        task_type: requireEnum(taskData.task_type, 'task.task_type', VALID_TASK_TYPES),
        description: optionalString(taskData.description, 'task.description'),
        priority: optionalEnum(taskData.priority, 'task.priority', VALID_PRIORITIES),
        deadline: optionalString(taskData.deadline, 'task.deadline'),
        parent_task_id: optionalString(taskData.parent_task_id, 'task.parent_task_id'),
        related_paper_id: optionalString(taskData.related_paper_id, 'task.related_paper_id'),
        related_file_path: optionalString(taskData.related_file_path, 'task.related_file_path'),
        tags: optionalStringArray(taskData.tags, 'task.tags', 20),
        notes: optionalString(taskData.notes, 'task.notes'),
      };

      return service.create(input, 'human');
    } catch (err) {
      throw err instanceof RpcValidationError ? new Error(err.message) : err;
    }
  });

  // ── 4. rc.task.update ─────────────────────────────────────────────

  registerMethod('rc.task.update', async (params: Record<string, unknown>) => {
    try {
      const id = requireString(params.id, 'id');
      const patchData = requireObject(params.patch, 'patch');

      const patch: TaskPatch = {};

      if (patchData.title !== undefined) {
        patch.title = requireString(patchData.title, 'patch.title');
      }
      if (patchData.description !== undefined) {
        const desc = optionalNullableString(patchData.description, 'patch.description');
        patch.description = desc === undefined ? undefined : desc;
        if (patchData.description === null) patch.description = null;
      }
      if (patchData.task_type !== undefined) {
        patch.task_type = requireEnum(patchData.task_type, 'patch.task_type', VALID_TASK_TYPES);
      }
      if (patchData.status !== undefined) {
        patch.status = requireEnum(patchData.status, 'patch.status', VALID_STATUSES);
      }
      if (patchData.priority !== undefined) {
        patch.priority = requireEnum(patchData.priority, 'patch.priority', VALID_PRIORITIES);
      }
      if (patchData.deadline !== undefined) {
        const dl = optionalNullableString(patchData.deadline, 'patch.deadline');
        patch.deadline = dl === undefined ? undefined : dl;
        if (patchData.deadline === null) patch.deadline = null;
      }
      if (patchData.parent_task_id !== undefined) {
        const pid = optionalNullableString(patchData.parent_task_id, 'patch.parent_task_id');
        patch.parent_task_id = pid === undefined ? undefined : pid;
        if (patchData.parent_task_id === null) patch.parent_task_id = null;
      }
      if (patchData.related_paper_id !== undefined) {
        const rpid = optionalNullableString(patchData.related_paper_id, 'patch.related_paper_id');
        patch.related_paper_id = rpid === undefined ? undefined : rpid;
        if (patchData.related_paper_id === null) patch.related_paper_id = null;
      }
      if (patchData.related_file_path !== undefined) {
        const rfp = optionalNullableString(patchData.related_file_path, 'patch.related_file_path');
        patch.related_file_path = rfp === undefined ? undefined : rfp;
        if (patchData.related_file_path === null) patch.related_file_path = null;
      }
      if (patchData.agent_session_id !== undefined) {
        const asid = optionalNullableString(patchData.agent_session_id, 'patch.agent_session_id');
        patch.agent_session_id = asid === undefined ? undefined : asid;
        if (patchData.agent_session_id === null) patch.agent_session_id = null;
      }
      if (patchData.tags !== undefined) {
        patch.tags = optionalStringArray(patchData.tags, 'patch.tags', 20);
      }
      if (patchData.notes !== undefined) {
        const notes = optionalNullableString(patchData.notes, 'patch.notes');
        patch.notes = notes === undefined ? undefined : notes;
        if (patchData.notes === null) patch.notes = null;
      }

      return service.update(id, patch, 'human');
    } catch (err) {
      throw err instanceof RpcValidationError ? new Error(err.message) : err;
    }
  });

  // ── 5. rc.task.complete ───────────────────────────────────────────

  registerMethod('rc.task.complete', async (params: Record<string, unknown>) => {
    try {
      const id = requireString(params.id, 'id');
      const notes = optionalString(params.notes, 'notes');

      return service.complete(id, notes, 'human');
    } catch (err) {
      throw err instanceof RpcValidationError ? new Error(err.message) : err;
    }
  });

  // ── 6. rc.task.delete ─────────────────────────────────────────────

  registerMethod('rc.task.delete', async (params: Record<string, unknown>) => {
    try {
      const id = requireString(params.id, 'id');
      service.delete(id);
      return { ok: true, deleted: true, id };
    } catch (err) {
      throw err instanceof RpcValidationError ? new Error(err.message) : err;
    }
  });

  // ── 7. rc.task.upcoming ───────────────────────────────────────────

  registerMethod('rc.task.upcoming', async (params: Record<string, unknown>) => {
    try {
      const hours = optionalNumber(params.hours, 'hours', 1, 720) ?? 48;
      const tasks = service.upcoming(hours);
      return { items: tasks, total: tasks.length, hours };
    } catch (err) {
      throw err instanceof RpcValidationError ? new Error(err.message) : err;
    }
  });

  // ── 8. rc.task.overdue ────────────────────────────────────────────

  registerMethod('rc.task.overdue', async (_params: Record<string, unknown>) => {
    try {
      const tasks = service.overdue();
      return { items: tasks, total: tasks.length };
    } catch (err) {
      throw err instanceof RpcValidationError ? new Error(err.message) : err;
    }
  });

  // ── 9. rc.task.link ───────────────────────────────────────────────

  registerMethod('rc.task.link', async (params: Record<string, unknown>) => {
    try {
      const taskId = requireString(params.task_id, 'task_id');
      const paperId = requireString(params.paper_id, 'paper_id');

      service.link(taskId, paperId);
      return { ok: true, linked: true, task_id: taskId, paper_id: paperId };
    } catch (err) {
      throw err instanceof RpcValidationError ? new Error(err.message) : err;
    }
  });

  // ── 10. rc.task.linkFile ──────────────────────────────────────────

  registerMethod('rc.task.linkFile', async (params: Record<string, unknown>) => {
    try {
      const taskId = requireString(params.task_id, 'task_id');
      const filePath = requireString(params.file_path, 'file_path');

      service.linkFile(taskId, filePath, 'human');
      return { ok: true, linked: true, task_id: taskId, file_path: filePath };
    } catch (err) {
      throw err instanceof RpcValidationError ? new Error(err.message) : err;
    }
  });

  // ── 11. rc.task.notes.add ─────────────────────────────────────────

  registerMethod('rc.task.notes.add', async (params: Record<string, unknown>) => {
    try {
      const taskId = requireString(params.task_id, 'task_id');
      const content = requireString(params.content, 'content');

      return service.addNote(taskId, content, 'human');
    } catch (err) {
      throw err instanceof RpcValidationError ? new Error(err.message) : err;
    }
  });

  // ── 11. rc.cron.presets.list ──────────────────────────────────────

  registerMethod('rc.cron.presets.list', async (_params: Record<string, unknown>) => {
    try {
      const presets = service.cronPresetsList();
      return { presets };
    } catch (err) {
      throw err instanceof RpcValidationError ? new Error(err.message) : err;
    }
  });

  // ── 12. rc.cron.presets.activate ──────────────────────────────────

  registerMethod('rc.cron.presets.activate', async (params: Record<string, unknown>) => {
    try {
      const presetId = requireString(params.preset_id, 'preset_id');
      const config = optionalObject(params.config, 'config');

      return service.cronPresetsActivate(presetId, config);
    } catch (err) {
      throw err instanceof RpcValidationError ? new Error(err.message) : err;
    }
  });

  // ── 13. rc.cron.presets.deactivate ────────────────────────────────

  registerMethod('rc.cron.presets.deactivate', async (params: Record<string, unknown>) => {
    try {
      const presetId = requireString(params.preset_id, 'preset_id');

      return service.cronPresetsDeactivate(presetId);
    } catch (err) {
      throw err instanceof RpcValidationError ? new Error(err.message) : err;
    }
  });

  // ── 14. rc.cron.presets.setJobId ──────────────────────────────────

  registerMethod('rc.cron.presets.setJobId', async (params: Record<string, unknown>) => {
    try {
      const presetId = requireString(params.preset_id, 'preset_id');
      const rawJobId = params.job_id;
      const jobId = typeof rawJobId === 'string' ? rawJobId.trim() : '';

      return service.cronPresetsSetJobId(presetId, jobId);
    } catch (err) {
      throw err instanceof RpcValidationError ? new Error(err.message) : err;
    }
  });

  // ── 15. rc.cron.presets.delete ──────────────────────────────────

  registerMethod('rc.cron.presets.delete', async (params: Record<string, unknown>) => {
    try {
      const presetId = requireString(params.preset_id, 'preset_id');
      return service.cronPresetsDelete(presetId);
    } catch (err) {
      throw err instanceof RpcValidationError ? new Error(err.message) : err;
    }
  });

  // ── 16. rc.cron.presets.restore ─────────────────────────────────

  registerMethod('rc.cron.presets.restore', async (params: Record<string, unknown>) => {
    try {
      const presetId = requireString(params.preset_id, 'preset_id');
      return service.cronPresetsRestore(presetId);
    } catch (err) {
      throw err instanceof RpcValidationError ? new Error(err.message) : err;
    }
  });

  // ── 17. rc.cron.presets.updateSchedule ──────────────────────────

  registerMethod('rc.cron.presets.updateSchedule', async (params: Record<string, unknown>) => {
    try {
      const presetId = requireString(params.preset_id, 'preset_id');
      const schedule = requireString(params.schedule, 'schedule');

      return service.cronPresetsUpdateSchedule(presetId, schedule);
    } catch (err) {
      throw err instanceof RpcValidationError ? new Error(err.message) : err;
    }
  });

  // ── 18. rc.notifications.pending ────────────────────────────────
  //
  // Returns overdue + upcoming tasks for the dashboard notification bell.
  // Dashboard polls this on connect, after chat turns, and on a 60s timer.

  registerMethod('rc.notifications.pending', async (params: Record<string, unknown>) => {
    try {
      const hours = optionalNumber(params.hours, 'hours', 1, 720) ?? 48;
      const overdue = service.overdue();
      const upcoming = service.upcoming(hours);
      const custom = service.getUnreadNotifications(20);

      return {
        overdue: overdue.map((t) => ({
          id: t.id,
          title: t.title,
          deadline: t.deadline,
          priority: t.priority,
        })),
        upcoming: upcoming.map((t) => ({
          id: t.id,
          title: t.title,
          deadline: t.deadline,
          priority: t.priority,
        })),
        custom: custom.map((n) => ({
          id: n.id,
          type: n.type,
          title: n.title,
          body: n.body,
          created_at: n.created_at,
        })),
        timestamp: new Date().toISOString(),
      };
    } catch (err) {
      throw err instanceof RpcValidationError ? new Error(err.message) : err;
    }
  });

  // ── 18. rc.notifications.markRead ───────────────────────────────

  registerMethod('rc.notifications.markRead', async (params: Record<string, unknown>) => {
    try {
      const id = requireString(params.id, 'id');
      service.markNotificationRead(id);
      return { ok: true };
    } catch (err) {
      throw err instanceof RpcValidationError ? new Error(err.message) : err;
    }
  });
}

/**
 * Research-Claw Core — Task Agent Tools
 *
 * 10 agent tools for the task management module:
 *   1. task_create           — Create a new research task
 *   2. task_list             — List/filter tasks with smart sorting
 *   3. task_complete         — Mark a task as done
 *   4. task_update           — Update task fields (state-machine validated)
 *   5. task_link             — Link a task to a paper
 *   6. task_note             — Append a timestamped note to a task
 *   7. task_link_file        — Link a task to a workspace file
 *   8. cron_update_schedule  — Update cron preset schedule
 *   9. send_notification     — Push a notification to the dashboard bell
 *  10. task_delete           — Permanently delete a task
 *
 * Each tool uses plain JSON Schema objects for parameters (no TypeBox).
 * Registered via api.registerTool() from the OpenClaw plugin SDK.
 */

// Note: Tool parameters use raw JSON Schema objects for simplicity.
// The spec suggests TypeBox (@sinclair/typebox) but raw schemas are
// functionally equivalent and avoid an additional abstraction layer.

import {
  TaskService,
  type Task,
  type TaskInput,
  type TaskPatch,
  type TaskType,
  type TaskStatus,
  type TaskPriority,
} from './service.js';
import type { ToolDefinition } from '../types.js';

// ── Helpers ──────────────────────────────────────────────────────────────

function ok(text: string, details: unknown): unknown {
  return { content: [{ type: 'text', text }], details };
}

function fail(message: string): unknown {
  return { content: [{ type: 'text', text: `Error: ${message}` }], details: { error: message } };
}

function formatTask(task: Task): string {
  const parts = [
    `[${task.status.toUpperCase()}] ${task.title}`,
    `  id: ${task.id}`,
    `  type: ${task.task_type} | priority: ${task.priority}`,
  ];
  if (task.deadline) {
    parts.push(`  deadline: ${task.deadline}`);
  }
  if (task.description) {
    parts.push(`  description: ${task.description}`);
  }
  if (task.related_paper_id) {
    parts.push(`  linked paper: ${task.related_paper_id}`);
  }
  if (task.related_file_path) {
    parts.push(`  linked file: ${task.related_file_path}`);
  }
  if (task.tags.length > 0) {
    parts.push(`  tags: ${task.tags.join(', ')}`);
  }
  if (task.notes) {
    const preview = task.notes.length > 120 ? task.notes.slice(0, 120) + '...' : task.notes;
    parts.push(`  notes: ${preview}`);
  }
  return parts.join('\n');
}

// ── Registration ─────────────────────────────────────────────────────────

export function createTaskTools(service: TaskService): ToolDefinition[] {
  const tools: ToolDefinition[] = [];

  // ── 1. task_create ──────────────────────────────────────────────────

  tools.push({
    name: 'task_create',
    description:
      'Create a new research task. Use this to track work items like reading papers, ' +
      'running experiments, writing sections, or coordinating agent sub-tasks.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short descriptive title for the task' },
        task_type: {
          type: 'string',
          enum: ['human', 'agent', 'mixed'],
          description: 'Who will perform this task: human, agent, or mixed',
        },
        description: { type: 'string', description: 'Detailed description of what needs to be done' },
        priority: {
          type: 'string',
          enum: ['urgent', 'high', 'medium', 'low'],
          description: 'Task priority level',
        },
        deadline: { type: 'string', description: 'ISO 8601 deadline string (e.g. 2026-03-15T09:00:00Z)' },
        parent_task_id: { type: 'string', description: 'UUID of a parent task to create this as a subtask' },
        related_paper_id: { type: 'string', description: 'UUID of a paper to link to this task' },
        related_file_path: { type: 'string', description: 'Workspace-relative path of an output file (e.g. "outputs/drafts/review.md")' },
        tags: {
          type: 'array',
          items: { type: 'string' },
          maxItems: 20,
          description: 'Tags for categorization (max 20)',
        },
        notes: { type: 'string', description: 'Initial notes to attach to the task' },
      },
      required: ['title', 'task_type'],
    },
    async execute(_toolCallId: string, params: Record<string, unknown>): Promise<unknown> {
      try {
        // Defensive validation: LLM may omit or null-out required fields
        if (typeof params.title !== 'string' || !params.title.trim()) {
          return fail('title is required and must be a non-empty string');
        }
        const validTaskTypes = ['human', 'agent', 'mixed'] as const;
        const rawType = typeof params.task_type === 'string' ? params.task_type : 'agent';
        if (!validTaskTypes.includes(rawType as typeof validTaskTypes[number])) {
          return fail(`task_type must be one of: ${validTaskTypes.join(', ')} (got "${rawType}")`);
        }

        const validPriorities = ['urgent', 'high', 'medium', 'low'] as const;
        const rawPriority = typeof params.priority === 'string' ? params.priority : undefined;
        if (rawPriority !== undefined && !validPriorities.includes(rawPriority as typeof validPriorities[number])) {
          return fail(`priority must be one of: ${validPriorities.join(', ')} (got "${rawPriority}")`);
        }

        const input: TaskInput = {
          title: params.title.trim(),
          task_type: rawType as TaskInput['task_type'],
          description: typeof params.description === 'string' ? params.description : undefined,
          priority: rawPriority as TaskInput['priority'],
          deadline: typeof params.deadline === 'string' ? params.deadline : undefined,
          parent_task_id: typeof params.parent_task_id === 'string' ? params.parent_task_id : undefined,
          related_paper_id: typeof params.related_paper_id === 'string' ? params.related_paper_id : undefined,
          related_file_path: typeof params.related_file_path === 'string' ? params.related_file_path : undefined,
          tags: Array.isArray(params.tags) ? params.tags.filter((t): t is string => typeof t === 'string') : undefined,
          notes: typeof params.notes === 'string' ? params.notes : undefined,
        };

        const task = service.create(input, 'agent');

        const summary = [
          `Created task "${task.title}" (${task.id})`,
          `  type: ${task.task_type} | priority: ${task.priority} | status: ${task.status}`,
        ];
        if (task.deadline) summary.push(`  deadline: ${task.deadline}`);
        if (task.parent_task_id) summary.push(`  parent: ${task.parent_task_id}`);
        if (task.related_paper_id) summary.push(`  linked paper: ${task.related_paper_id}`);

        return ok(summary.join('\n'), task);
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  });

  // ── 2. task_list ────────────────────────────────────────────────────

  tools.push({
    name: 'task_list',
    description:
      'List research tasks with optional filters. Returns active tasks by default ' +
      '(excludes done/cancelled). Use to get an overview of current work.',
    parameters: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['todo', 'in_progress', 'blocked', 'done', 'cancelled'],
          description: 'Filter by task status',
        },
        priority: {
          type: 'string',
          enum: ['urgent', 'high', 'medium', 'low'],
          description: 'Filter by priority level',
        },
        task_type: {
          type: 'string',
          enum: ['human', 'agent', 'mixed'],
          description: 'Filter by task type',
        },
        sort_by: {
          type: 'string',
          enum: ['deadline', 'priority', 'created_at'],
          description: 'Sort field (default: smart deadline bucketing)',
        },
        include_completed: {
          type: 'boolean',
          description: 'Include done/cancelled tasks (default: false)',
        },
      },
    },
    async execute(_toolCallId: string, params: Record<string, unknown>): Promise<unknown> {
      try {
        const result = service.list({
          status: typeof params.status === 'string' ? params.status as TaskStatus : undefined,
          priority: typeof params.priority === 'string' ? params.priority as TaskPriority : undefined,
          task_type: typeof params.task_type === 'string' ? params.task_type as TaskType : undefined,
          sort: typeof params.sort_by === 'string' ? params.sort_by : undefined,
          include_completed: typeof params.include_completed === 'boolean' ? params.include_completed : false,
        });

        let summary: string;
        if (result.items.length === 0) {
          summary = `No tasks found (total: ${result.total}).`;
        } else {
          const lines = [
            `Found ${result.items.length} task(s) (total: ${result.total}):`,
            '',
          ];
          for (const task of result.items) {
            lines.push(formatTask(task));
            lines.push('');
          }
          summary = lines.join('\n');
        }

        return ok(summary, result);
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  });

  // ── 3. task_complete ────────────────────────────────────────────────

  tools.push({
    name: 'task_complete',
    description:
      'Mark a task as completed. Optionally attach completion notes. ' +
      'Only works on tasks in in_progress or blocked status.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'UUID of the task to complete' },
        notes: { type: 'string', description: 'Optional completion notes' },
      },
      required: ['id'],
    },
    async execute(_toolCallId: string, params: Record<string, unknown>): Promise<unknown> {
      try {
        if (typeof params.id !== 'string' || !params.id.trim()) {
          return fail('id is required and must be a non-empty string');
        }
        const id = params.id.trim();
        const notes = typeof params.notes === 'string' ? params.notes : undefined;

        const task = service.complete(id, notes, 'agent');

        const summary = [
          `Completed task "${task.title}" (${task.id})`,
          `  completed_at: ${task.completed_at ?? 'N/A'}`,
        ];
        if (notes) summary.push(`  completion notes: ${notes}`);

        return ok(summary.join('\n'), task);
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  });

  // ── 4. task_update ──────────────────────────────────────────────────

  tools.push({
    name: 'task_update',
    description:
      'Update one or more fields of an existing task. Status changes are validated ' +
      'against the state machine (e.g. done tasks cannot be reopened).',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'UUID of the task to update' },
        title: { type: 'string', description: 'New title' },
        description: {
          type: 'string',
          description: 'New description (empty string to clear)',
        },
        task_type: {
          type: 'string',
          enum: ['human', 'agent', 'mixed'],
          description: 'New task type',
        },
        status: {
          type: 'string',
          enum: ['todo', 'in_progress', 'blocked', 'done', 'cancelled'],
          description: 'New status (state-machine validated)',
        },
        priority: {
          type: 'string',
          enum: ['urgent', 'high', 'medium', 'low'],
          description: 'New priority level',
        },
        deadline: {
          type: 'string',
          description: 'New deadline ISO 8601 (empty string to clear)',
        },
        parent_task_id: {
          type: 'string',
          description: 'Reassign parent (empty string to detach)',
        },
        related_paper_id: {
          type: 'string',
          description: 'Link to a different paper (empty string to unlink)',
        },
        related_file_path: {
          type: 'string',
          description: 'Link to a workspace file (empty string to unlink). Use relative paths like "outputs/drafts/review.md".',
        },
        agent_session_id: {
          type: 'string',
          description: 'Associate with an agent session (empty string to clear)',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          maxItems: 20,
          description: 'Replace tags array (max 20)',
        },
        notes: {
          type: 'string',
          description: 'Replace notes (empty string to clear)',
        },
      },
      required: ['id'],
    },
    async execute(_toolCallId: string, params: Record<string, unknown>): Promise<unknown> {
      try {
        if (typeof params.id !== 'string' || !params.id.trim()) {
          return fail('id is required and must be a non-empty string');
        }
        const id = params.id.trim();

        const patch: TaskPatch = {};

        if (params.title !== undefined) patch.title = typeof params.title === 'string' ? params.title : String(params.title);
        // Nullable fields: empty string OR null both mean "clear the field".
        // LLM sends '' (schema says type:'string'), legacy null kept as defense.
        const clearable = (v: unknown): string | null | undefined =>
          v === null || v === '' ? null : typeof v === 'string' ? v : undefined;

        if (params.description !== undefined) patch.description = clearable(params.description);
        if (params.task_type !== undefined && typeof params.task_type === 'string') patch.task_type = params.task_type as TaskPatch['task_type'];
        if (params.status !== undefined && typeof params.status === 'string') patch.status = params.status as TaskPatch['status'];
        if (params.priority !== undefined && typeof params.priority === 'string') patch.priority = params.priority as TaskPatch['priority'];
        if (params.deadline !== undefined) patch.deadline = clearable(params.deadline);
        if (params.parent_task_id !== undefined) patch.parent_task_id = clearable(params.parent_task_id);
        if (params.related_paper_id !== undefined) patch.related_paper_id = clearable(params.related_paper_id);
        if (params.related_file_path !== undefined) patch.related_file_path = clearable(params.related_file_path);
        if (params.agent_session_id !== undefined) patch.agent_session_id = clearable(params.agent_session_id);
        if (params.tags !== undefined && Array.isArray(params.tags)) patch.tags = params.tags.filter((t): t is string => typeof t === 'string');
        if (params.notes !== undefined) patch.notes = clearable(params.notes);

        const task = service.update(id, patch, 'agent');

        const changedFields = Object.keys(params).filter((k) => k !== 'id' && params[k] !== undefined);
        const summary = [
          `Updated task "${task.title}" (${task.id})`,
          `  changed fields: ${changedFields.length > 0 ? changedFields.join(', ') : 'none'}`,
          `  status: ${task.status} | priority: ${task.priority}`,
        ];

        return ok(summary.join('\n'), task);
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  });

  // ── 5. task_link ────────────────────────────────────────────────────

  tools.push({
    name: 'task_link',
    description:
      'Link a task to a paper in the literature database. ' +
      'This associates the task with a specific paper for cross-referencing.',
    parameters: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'UUID of the task' },
        paper_id: { type: 'string', description: 'UUID of the paper to link' },
      },
      required: ['task_id', 'paper_id'],
    },
    async execute(_toolCallId: string, params: Record<string, unknown>): Promise<unknown> {
      try {
        if (typeof params.task_id !== 'string' || !params.task_id.trim()) {
          return fail('task_id is required and must be a non-empty string');
        }
        if (typeof params.paper_id !== 'string' || !params.paper_id.trim()) {
          return fail('paper_id is required and must be a non-empty string');
        }
        const taskId = params.task_id.trim();
        const paperId = params.paper_id.trim();

        service.link(taskId, paperId);

        return ok(
          `Linked task ${taskId} to paper ${paperId}.`,
          { task_id: taskId, paper_id: paperId, ok: true },
        );
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  });

  // ── 6. task_note ────────────────────────────────────────────────────

  tools.push({
    name: 'task_note',
    description:
      'Append a note to a task. Notes are timestamped and attributed to the actor ' +
      '(human or agent). Use this to log progress, observations, or decisions.',
    parameters: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'UUID of the task to annotate' },
        note: { type: 'string', minLength: 1, description: 'Note content (must not be empty)' },
      },
      required: ['task_id', 'note'],
    },
    async execute(_toolCallId: string, params: Record<string, unknown>): Promise<unknown> {
      try {
        if (typeof params.task_id !== 'string' || !params.task_id.trim()) {
          return fail('task_id is required and must be a non-empty string');
        }
        if (typeof params.note !== 'string' || !params.note.trim()) {
          return fail('note is required and must be a non-empty string');
        }
        const taskId = params.task_id.trim();
        const note = params.note.trim();

        const entry = service.addNote(taskId, note, 'agent');

        const summary = [
          `Added note to task ${taskId}:`,
          `  "${note.length > 100 ? note.slice(0, 100) + '...' : note}"`,
          `  logged at: ${entry.created_at}`,
        ].join('\n');

        return ok(summary, entry);
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  });

  // ── 7. task_link_file ──────────────────────────────────────────────

  tools.push({
    name: 'task_link_file',
    description:
      'Link a task to a workspace file. This associates the task with a specific ' +
      'output file for cross-referencing (e.g. linking a "Write Chapter 3" task to ' +
      '"outputs/drafts/chapter-3.md").',
    parameters: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'UUID of the task' },
        file_path: {
          type: 'string',
          description: 'Workspace-relative path of the file (e.g. "outputs/drafts/review.md")',
        },
      },
      required: ['task_id', 'file_path'],
    },
    async execute(_toolCallId: string, params: Record<string, unknown>): Promise<unknown> {
      try {
        if (typeof params.task_id !== 'string' || !params.task_id.trim()) {
          return fail('task_id is required and must be a non-empty string');
        }
        if (typeof params.file_path !== 'string' || !params.file_path.trim()) {
          return fail('file_path is required and must be a non-empty string');
        }
        const taskId = params.task_id.trim();
        const filePath = params.file_path.trim();

        service.linkFile(taskId, filePath, 'agent');

        return ok(
          `Linked task ${taskId} to file "${filePath}".`,
          { task_id: taskId, file_path: filePath, ok: true },
        );
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  });

  // ── 8. cron_update_schedule ─────────────────────────────────────

  tools.push({
    name: 'cron_update_schedule',
    description:
      'Update the schedule of a cron preset (e.g. weekly_report, arxiv_daily_scan). ' +
      'Accepts a standard 5-field cron expression. The change is persisted to the database ' +
      'and the dashboard will reflect the new schedule immediately on refresh.',
    parameters: {
      type: 'object',
      properties: {
        preset_id: {
          type: 'string',
          description: 'Cron preset ID (e.g. "weekly_report", "arxiv_daily_scan", "deadline_reminders_daily", "citation_tracking_weekly", "group_meeting_prep")',
        },
        schedule: {
          type: 'string',
          description: 'Cron expression with 5 fields: "minute hour day-of-month month day-of-week". Examples: "0 12 * * 4" = Thursday 12:00, "0 9 * * *" = daily 09:00, "0 8 * * 1-5" = weekdays 08:00',
        },
      },
      required: ['preset_id', 'schedule'],
    },
    async execute(_toolCallId: string, params: Record<string, unknown>): Promise<unknown> {
      try {
        if (typeof params.preset_id !== 'string' || !params.preset_id.trim()) {
          return fail('preset_id is required and must be a non-empty string');
        }
        if (typeof params.schedule !== 'string' || !params.schedule.trim()) {
          return fail('schedule is required and must be a non-empty string');
        }
        const presetId = params.preset_id.trim();
        const schedule = params.schedule.trim();

        const result = service.cronPresetsUpdateSchedule(presetId, schedule);

        return ok(
          `Updated schedule for "${result.preset.name}" to "${schedule}" (${result.preset.enabled ? 'active' : 'inactive'}).` +
          `\nDashboard will show the new schedule on refresh.`,
          result.preset,
        );
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  });

  // ── 9. send_notification ────────────────────────────────────────

  tools.push({
    name: 'send_notification',
    description:
      'Send a notification to the user\'s dashboard bell icon. Use this to proactively alert ' +
      'the user about important events: task deadlines, paper discoveries, completed analyses, ' +
      'or anything that warrants their attention. The notification appears in the top-right bell ' +
      'dropdown without interrupting their workflow.',
    parameters: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['deadline', 'heartbeat', 'system', 'error'],
          description: 'Notification type: deadline (time-sensitive), heartbeat (progress update), system (informational), error (requires attention)',
        },
        title: { type: 'string', description: 'Short notification title (displayed in bold)' },
        body: { type: 'string', description: 'Optional detail text (displayed below title)' },
      },
      required: ['type', 'title'],
    },
    async execute(_toolCallId: string, params: Record<string, unknown>): Promise<unknown> {
      try {
        if (typeof params.title !== 'string' || !params.title.trim()) {
          return fail('title is required and must be a non-empty string');
        }
        const validTypes = ['deadline', 'heartbeat', 'system', 'error'];
        const rawType = typeof params.type === 'string' ? params.type : 'system';
        if (!validTypes.includes(rawType)) {
          return fail(`type must be one of: ${validTypes.join(', ')} (got "${rawType}")`);
        }
        const body = typeof params.body === 'string' ? params.body : undefined;

        const notification = service.sendNotification(rawType, params.title.trim(), body);

        return ok(
          `Notification sent: "${notification.title}" (type: ${notification.type}, id: ${notification.id})`,
          notification,
        );
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  });

  // ── 10. task_delete ────────────────────────────────────────────────

  tools.push({
    name: 'task_delete',
    description:
      'Permanently delete a task and all its activity log entries. This is destructive and ' +
      'cannot be undone. Use only when the user explicitly requests task deletion. ' +
      'Subtasks of the deleted task will have their parent_task_id set to NULL.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'UUID of the task to delete' },
      },
      required: ['id'],
    },
    async execute(_toolCallId: string, params: Record<string, unknown>): Promise<unknown> {
      try {
        if (typeof params.id !== 'string' || !params.id.trim()) {
          return fail('id is required and must be a non-empty string');
        }
        const id = params.id.trim();

        // Fetch task info before deletion for the confirmation message
        const existing = service.get(id);
        if (!existing) {
          return fail(`Task not found: ${id}`);
        }

        const title = existing.title;
        service.delete(id);

        return ok(
          `Deleted task "${title}" (${id}). This action cannot be undone.`,
          { id, title, deleted: true },
        );
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  });

  return tools;
}

/**
 * Research-Claw Core — Task Service
 *
 * Implements the `rc.task.*` RPC namespace (10 methods) plus 3 cron preset methods.
 * Uses better-sqlite3 synchronous API against `rc_tasks` and `rc_activity_log` tables.
 *
 * State machine:
 *   todo -> in_progress | cancelled
 *   in_progress -> done | blocked | todo | cancelled
 *   blocked -> in_progress | done | cancelled
 *   done -> (TERMINAL)
 *   cancelled -> (TERMINAL)
 */

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

// ── Type Definitions ────────────────────────────────────────────────────

export type TaskType = 'human' | 'agent' | 'mixed';
export type TaskStatus = 'todo' | 'in_progress' | 'blocked' | 'done' | 'cancelled';
export type TaskPriority = 'urgent' | 'high' | 'medium' | 'low';
export type Actor = 'human' | 'agent';

export interface Task {
  id: string;
  title: string;
  description: string | null;
  task_type: TaskType;
  status: TaskStatus;
  priority: TaskPriority;
  deadline: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
  parent_task_id: string | null;
  related_paper_id: string | null;
  related_file_path: string | null;
  agent_session_id: string | null;
  tags: string[];
  notes: string | null;
}

export interface TaskInput {
  title: string;
  description?: string;
  task_type: TaskType;
  priority?: TaskPriority;
  deadline?: string;
  parent_task_id?: string;
  related_paper_id?: string;
  related_file_path?: string;
  agent_session_id?: string;
  tags?: string[];
  notes?: string;
}

export interface TaskPatch {
  title?: string;
  description?: string | null;
  task_type?: TaskType;
  status?: TaskStatus;
  priority?: TaskPriority;
  deadline?: string | null;
  parent_task_id?: string | null;
  related_paper_id?: string | null;
  related_file_path?: string | null;
  agent_session_id?: string | null;
  tags?: string[];
  notes?: string | null;
}

export interface ActivityLogEntry {
  id: string;
  task_id: string;
  event_type: string;
  old_value: string | null;
  new_value: string | null;
  actor: Actor;
  created_at: string;
}

export interface CronPreset {
  id: string;
  name: string;
  description: string;
  schedule: string;
  enabled: boolean;
  config: Record<string, unknown>;
  last_run_at: string | null;
  next_run_at: string | null;
  gateway_job_id: string | null;
}

export interface ListParams {
  status?: TaskStatus;
  priority?: TaskPriority;
  task_type?: TaskType;
  sort?: string;
  direction?: 'asc' | 'desc';
  include_completed?: boolean;
  limit?: number;
  offset?: number;
}

export interface TaskWithDetails extends Task {
  activity_log: ActivityLogEntry[];
  subtasks: Task[];
}

// ── Constants ───────────────────────────────────────────────────────────

const VALID_TASK_TYPES: ReadonlySet<string> = new Set<TaskType>(['human', 'agent', 'mixed']);

const VALID_PRIORITIES: ReadonlySet<string> = new Set<TaskPriority>(['urgent', 'high', 'medium', 'low']);

const VALID_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  todo: ['in_progress', 'cancelled'],
  in_progress: ['done', 'blocked', 'todo', 'cancelled'],
  blocked: ['in_progress', 'done', 'cancelled'],
  done: ['todo'],
  cancelled: ['todo'],
};

const PRESET_DEFINITIONS: Omit<CronPreset, 'enabled' | 'last_run_at' | 'next_run_at' | 'config' | 'gateway_job_id'>[] = [
  {
    id: 'arxiv_daily_scan',
    name: 'arXiv Daily Scan',
    description: 'Scan arXiv for new papers matching your research interests daily.',
    schedule: '0 7 * * *',
  },
  {
    id: 'citation_tracking_weekly',
    name: 'Citation Tracking Weekly',
    description: 'Check for new citations of your tracked papers every week.',
    schedule: '0 8 * * 1',
  },
  {
    id: 'deadline_reminders_daily',
    name: 'Deadline Reminders Daily',
    description: 'Send reminders for tasks with upcoming deadlines every morning.',
    schedule: '0 9 * * *',
  },
  {
    id: 'group_meeting_prep',
    name: 'Group Meeting Prep',
    description: 'Check USER.md for upcoming group meetings and prepare review materials, reading summaries, and discussion points.',
    schedule: '0 9 * * 1-5',
  },
  {
    id: 'weekly_report',
    name: 'Weekly Report',
    description: 'Generate a weekly research progress report: papers read, tasks completed, key findings, and next week goals. Save with workspace_save("outputs/reports/weekly-report-YYYY-MM-DD.md").',
    schedule: '0 17 * * 5',
  },
];

// ── Helpers ─────────────────────────────────────────────────────────────

function now(): string {
  return new Date().toISOString();
}

function isValidTransition(from: TaskStatus, to: TaskStatus): boolean {
  return VALID_TRANSITIONS[from].includes(to);
}

function validateTaskType(value: string): asserts value is TaskType {
  if (!VALID_TASK_TYPES.has(value)) {
    throw new RpcError(-32600, `Invalid task_type: ${value}. Must be one of: human, agent, mixed`);
  }
}

function validatePriority(value: string): asserts value is TaskPriority {
  if (!VALID_PRIORITIES.has(value)) {
    throw new RpcError(-32600, `Invalid priority: ${value}. Must be one of: urgent, high, medium, low`);
  }
}

function logActivity(
  db: Database.Database,
  taskId: string,
  eventType: string,
  oldValue: string | null,
  newValue: string | null,
  actor: Actor,
): ActivityLogEntry {
  const id = randomUUID();
  const createdAt = now();
  const stmt = db.prepare(
    `INSERT INTO rc_activity_log (id, task_id, event_type, old_value, new_value, actor, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  stmt.run(id, taskId, eventType, oldValue, newValue, actor, createdAt);
  return {
    id,
    task_id: taskId,
    event_type: eventType,
    old_value: oldValue,
    new_value: newValue,
    actor,
    created_at: createdAt,
  };
}

// ── Row types ───────────────────────────────────────────────────────────

interface TaskRow {
  id: string;
  title: string;
  description: string | null;
  task_type: string;
  status: string;
  priority: string;
  deadline: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
  parent_task_id: string | null;
  related_paper_id: string | null;
  related_file_path: string | null;
  agent_session_id: string | null;
  tags: string | null;
  notes: string | null;
}

function rowToTask(row: TaskRow): Task {
  let tags: string[] = [];
  if (row.tags) {
    try {
      tags = JSON.parse(row.tags) as string[];
    } catch {
      tags = [];
    }
  }
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    task_type: row.task_type as TaskType,
    status: row.status as TaskStatus,
    priority: row.priority as TaskPriority,
    deadline: row.deadline,
    completed_at: row.completed_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    parent_task_id: row.parent_task_id,
    related_paper_id: row.related_paper_id,
    related_file_path: row.related_file_path,
    agent_session_id: row.agent_session_id,
    tags,
    notes: row.notes,
  };
}

interface ActivityLogRow {
  id: string;
  task_id: string;
  event_type: string;
  old_value: string | null;
  new_value: string | null;
  actor: string;
  created_at: string;
}

function rowToActivityLog(row: ActivityLogRow): ActivityLogEntry {
  return {
    id: row.id,
    task_id: row.task_id,
    event_type: row.event_type,
    old_value: row.old_value,
    new_value: row.new_value,
    actor: row.actor as Actor,
    created_at: row.created_at,
  };
}

// ── JSON-RPC Error ──────────────────────────────────────────────────────

class RpcError extends Error {
  code: number;
  constructor(code: number, message: string) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
  }
}

// ── TaskService ─────────────────────────────────────────────────────────

export class TaskService {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;

    // Create cron state persistence table if it doesn't exist
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS rc_cron_state (
        preset_id      TEXT PRIMARY KEY,
        enabled        INTEGER NOT NULL DEFAULT 0,
        config         TEXT NOT NULL DEFAULT '{}',
        last_run_at    TEXT,
        next_run_at    TEXT,
        gateway_job_id TEXT
      )
    `);

    // Migration: add gateway_job_id column if missing (for existing DBs)
    try {
      this.db.exec('ALTER TABLE rc_cron_state ADD COLUMN gateway_job_id TEXT');
    } catch {
      // Column already exists — ignore
    }

    // Migration: add schedule column if missing (for existing DBs)
    try {
      this.db.exec('ALTER TABLE rc_cron_state ADD COLUMN schedule TEXT');
    } catch {
      // Column already exists — ignore
    }

    // Only seed preset definitions when table is empty (first initialization).
    // This ensures deleted presets don't reappear on restart.
    const count = this.db.prepare(
      'SELECT COUNT(*) as cnt FROM rc_cron_state',
    ).get() as { cnt: number };

    if (count.cnt === 0) {
      const insertStmt = this.db.prepare(
        `INSERT INTO rc_cron_state (preset_id, enabled, config, last_run_at, next_run_at)
         VALUES (?, ?, '{}', NULL, NULL)`,
      );
      for (const preset of PRESET_DEFINITIONS) {
        // deadline_reminders_daily is enabled by default
        const defaultEnabled = preset.id === 'deadline_reminders_daily' ? 1 : 0;
        insertStmt.run(preset.id, defaultEnabled);
      }
    }
  }

  // ── 1. create ───────────────────────────────────────────────────────

  /**
   * Create a new task.
   *
   * - Generates a UUID for the id.
   * - Validates task_type and priority values.
   * - Validates parent_task_id exists (if provided).
   * - Validates related_paper_id exists (if provided).
   * - Logs a 'created' activity event.
   * - Initial status is always 'todo'.
   */
  create(input: TaskInput, actor: Actor = 'human'): Task {
    // Validate enums
    validateTaskType(input.task_type);
    if (input.priority !== undefined) {
      validatePriority(input.priority);
    }

    // Validate parent_task_id if provided
    if (input.parent_task_id) {
      const parent = this.db.prepare('SELECT id FROM rc_tasks WHERE id = ?').get(input.parent_task_id) as { id: string } | undefined;
      if (!parent) {
        throw new RpcError(-32002, `Invalid parent_task_id: ${input.parent_task_id}`);
      }
    }

    // Validate related_paper_id if provided
    if (input.related_paper_id) {
      const paper = this.db.prepare('SELECT id FROM rc_papers WHERE id = ?').get(input.related_paper_id) as { id: string } | undefined;
      if (!paper) {
        throw new RpcError(-32003, `Invalid related_paper_id: ${input.related_paper_id}`);
      }
    }

    // Validate related_file_path if provided (must be a safe relative path)
    if (input.related_file_path) {
      const fp = input.related_file_path;
      if (fp.startsWith('/') || fp.startsWith('\\') || fp.includes('..') || fp.includes('\0')) {
        throw new RpcError(-32005, 'related_file_path must be a relative path within the workspace');
      }
    }

    // M3: Wrap INSERT + logActivity in a transaction
    const doCreate = this.db.transaction(() => {
      const id = randomUUID();
      const timestamp = now();
      const tagsJson = input.tags ? JSON.stringify(input.tags) : '[]';

      const stmt = this.db.prepare(
        `INSERT INTO rc_tasks (
          id, title, description, task_type, status, priority, deadline,
          completed_at, created_at, updated_at, parent_task_id, related_paper_id,
          related_file_path, agent_session_id, tags, notes
        ) VALUES (?, ?, ?, ?, 'todo', ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );

      stmt.run(
        id,
        input.title,
        input.description ?? null,
        input.task_type,
        input.priority ?? 'medium',
        input.deadline ?? null,
        timestamp,
        timestamp,
        input.parent_task_id ?? null,
        input.related_paper_id ?? null,
        input.related_file_path ?? null,
        input.agent_session_id ?? null,
        tagsJson,
        input.notes ?? null,
      );

      // Log creation event
      logActivity(this.db, id, 'created', null, input.title, actor);

      return id;
    });

    const newId = doCreate();
    return this.getTaskById(newId);
  }

  // ── 2. get ──────────────────────────────────────────────────────────

  /**
   * Get a single task with its full activity log and direct subtasks.
   * Returns null if the task does not exist.
   */
  get(id: string): TaskWithDetails | null {
    const row = this.db.prepare('SELECT * FROM rc_tasks WHERE id = ?').get(id) as TaskRow | undefined;
    if (!row) {
      return null;
    }

    const task = rowToTask(row);

    // Activity log sorted by created_at DESC (newest first)
    const logRows = this.db.prepare(
      'SELECT * FROM rc_activity_log WHERE task_id = ? ORDER BY created_at DESC',
    ).all(id) as ActivityLogRow[];

    // Subtasks (direct children) sorted by created_at ASC
    const subtaskRows = this.db.prepare(
      'SELECT * FROM rc_tasks WHERE parent_task_id = ? ORDER BY created_at ASC',
    ).all(id) as TaskRow[];

    return {
      ...task,
      activity_log: logRows.map(rowToActivityLog),
      subtasks: subtaskRows.map(rowToTask),
    };
  }

  // ── 3. list ─────────────────────────────────────────────────────────

  /**
   * List tasks with filtering, pagination, and smart default sorting.
   *
   * Default sort order (4 buckets):
   *   Bucket 0: overdue (deadline < now, active) — by deadline ASC
   *   Bucket 1: has future deadline — by deadline ASC
   *   Bucket 2: no deadline — by priority DESC (weight ASC) then created_at ASC
   *   Bucket 3: completed/cancelled — by completed_at DESC
   *
   * If `sort` is specified, uses that column instead of the default bucketing.
   */
  list(params: ListParams = {}): { items: Task[]; total: number } {
    const {
      status,
      priority,
      task_type,
      sort,
      direction,
      include_completed = false,
      limit = 50,
      offset = 0,
    } = params;

    const conditions: string[] = [];
    const bindings: unknown[] = [];

    if (status) {
      conditions.push('status = ?');
      bindings.push(status);
    }

    if (priority) {
      conditions.push('priority = ?');
      bindings.push(priority);
    }

    if (task_type) {
      conditions.push('task_type = ?');
      bindings.push(task_type);
    }

    if (!include_completed) {
      conditions.push("status NOT IN ('done', 'cancelled')");
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Count total
    const countSql = `SELECT COUNT(*) as total FROM rc_tasks ${whereClause}`;
    const countRow = this.db.prepare(countSql).get(...bindings) as { total: number };
    const total = countRow.total;

    // Build ORDER BY
    let orderBy: string;

    if (sort) {
      // User-specified sort
      const validSortColumns = ['title', 'deadline', 'priority', 'status', 'created_at', 'updated_at', 'completed_at'];
      const sortCol = validSortColumns.includes(sort) ? sort : 'deadline';
      const dir = direction === 'desc' ? 'DESC' : 'ASC';

      if (sortCol === 'priority') {
        orderBy = `ORDER BY CASE priority
          WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3
        END ${dir}`;
      } else {
        orderBy = `ORDER BY ${sortCol} ${dir}`;
      }
    } else {
      // Default: 4-bucket deadline ordering
      orderBy = `ORDER BY
        CASE
          WHEN status IN ('done', 'cancelled') THEN 3
          WHEN deadline IS NULL THEN 2
          WHEN deadline < datetime('now') THEN 0
          ELSE 1
        END ASC,
        CASE
          WHEN status IN ('done', 'cancelled') THEN NULL
          WHEN deadline IS NOT NULL THEN deadline
          ELSE NULL
        END ASC,
        CASE priority
          WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3
        END ASC,
        CASE
          WHEN status IN ('done', 'cancelled') THEN completed_at
          ELSE NULL
        END DESC,
        created_at ASC`;
    }

    const dataSql = `SELECT * FROM rc_tasks ${whereClause} ${orderBy} LIMIT ? OFFSET ?`;
    const dataBindings = [...bindings, limit, offset];
    const rows = this.db.prepare(dataSql).all(...dataBindings) as TaskRow[];

    return {
      items: rows.map(rowToTask),
      total,
    };
  }

  // ── 4. update ───────────────────────────────────────────────────────

  /**
   * Partial update of a task. Validates state machine transitions, applies
   * side effects on status change, and logs every changed field.
   *
   * Side effects:
   *   * -> done: set completed_at = now()
   *   * -> cancelled: clear completed_at
   *   in_progress -> todo: clear agent_session_id
   */
  update(id: string, patch: TaskPatch, actor: Actor = 'human'): Task {
    const existing = this.db.prepare('SELECT * FROM rc_tasks WHERE id = ?').get(id) as TaskRow | undefined;
    if (!existing) {
      throw new RpcError(-32001, `Task not found: ${id}`);
    }

    const currentTask = rowToTask(existing);

    // Validate enums before entering transaction
    if (patch.task_type !== undefined) {
      validateTaskType(patch.task_type);
    }
    if (patch.priority !== undefined) {
      validatePriority(patch.priority);
    }

    // Validate state machine transition before entering transaction
    if (patch.status !== undefined && patch.status !== currentTask.status) {
      if (!isValidTransition(currentTask.status, patch.status)) {
        throw new RpcError(
          -32004,
          `Invalid status transition: ${currentTask.status} -> ${patch.status}`,
        );
      }
    }

    // Validate parent_task_id before entering transaction
    if (patch.parent_task_id !== undefined && patch.parent_task_id !== currentTask.parent_task_id) {
      if (patch.parent_task_id !== null) {
        const parent = this.db.prepare('SELECT id FROM rc_tasks WHERE id = ?').get(patch.parent_task_id) as { id: string } | undefined;
        if (!parent) {
          throw new RpcError(-32002, `Invalid parent_task_id: ${patch.parent_task_id}`);
        }
        if (patch.parent_task_id === id) {
          throw new RpcError(-32002, 'A task cannot be its own parent');
        }
      }
    }

    // Validate related_paper_id before entering transaction
    if (patch.related_paper_id !== undefined && patch.related_paper_id !== currentTask.related_paper_id) {
      if (patch.related_paper_id !== null) {
        const paper = this.db.prepare('SELECT id FROM rc_papers WHERE id = ?').get(patch.related_paper_id) as { id: string } | undefined;
        if (!paper) {
          throw new RpcError(-32003, `Invalid related_paper_id: ${patch.related_paper_id}`);
        }
      }
    }

    // Validate related_file_path before entering transaction
    if (patch.related_file_path !== undefined && patch.related_file_path !== null) {
      const fp = patch.related_file_path;
      if (fp.startsWith('/') || fp.startsWith('\\') || fp.includes('..') || fp.includes('\0')) {
        throw new RpcError(-32005, 'related_file_path must be a relative path within the workspace');
      }
    }

    // Wrap all mutations (activity log INSERTs + task UPDATE) in a transaction
    const doUpdate = this.db.transaction(() => {
      const setClauses: string[] = [];
      const bindings: unknown[] = [];
      const timestamp = now();
      let newStatus: TaskStatus | undefined;

      // Process each field in the patch
      if (patch.title !== undefined && patch.title !== currentTask.title) {
        setClauses.push('title = ?');
        bindings.push(patch.title);
        logActivity(this.db, id, 'title_changed', currentTask.title, patch.title, actor);
      }

      if (patch.description !== undefined && patch.description !== currentTask.description) {
        setClauses.push('description = ?');
        bindings.push(patch.description);
        logActivity(this.db, id, 'description_changed', currentTask.description, patch.description, actor);
      }

      if (patch.task_type !== undefined && patch.task_type !== currentTask.task_type) {
        setClauses.push('task_type = ?');
        bindings.push(patch.task_type);
        // Note: task_type changes are applied but not logged as a separate event_type
        // since it is not in the spec's allowed event_type values.
      }

      if (patch.status !== undefined && patch.status !== currentTask.status) {
        newStatus = patch.status;
        setClauses.push('status = ?');
        bindings.push(patch.status);
        logActivity(this.db, id, 'status_changed', currentTask.status, patch.status, actor);
      }

      if (patch.priority !== undefined && patch.priority !== currentTask.priority) {
        setClauses.push('priority = ?');
        bindings.push(patch.priority);
        logActivity(this.db, id, 'priority_changed', currentTask.priority, patch.priority, actor);
      }

      if (patch.deadline !== undefined && patch.deadline !== currentTask.deadline) {
        setClauses.push('deadline = ?');
        bindings.push(patch.deadline);
        logActivity(this.db, id, 'deadline_changed', currentTask.deadline, patch.deadline, actor);
      }

      if (patch.parent_task_id !== undefined && patch.parent_task_id !== currentTask.parent_task_id) {
        setClauses.push('parent_task_id = ?');
        bindings.push(patch.parent_task_id);
        logActivity(this.db, id, 'parent_changed', currentTask.parent_task_id, patch.parent_task_id, actor);
      }

      if (patch.related_paper_id !== undefined && patch.related_paper_id !== currentTask.related_paper_id) {
        setClauses.push('related_paper_id = ?');
        bindings.push(patch.related_paper_id);
        if (currentTask.related_paper_id && patch.related_paper_id) {
          // Replacing one paper link with another: log unlink then link
          logActivity(this.db, id, 'paper_unlinked', currentTask.related_paper_id, null, actor);
          logActivity(this.db, id, 'paper_linked', null, patch.related_paper_id, actor);
        } else if (patch.related_paper_id) {
          logActivity(this.db, id, 'paper_linked', null, patch.related_paper_id, actor);
        } else {
          logActivity(this.db, id, 'paper_unlinked', currentTask.related_paper_id, null, actor);
        }
      }

      if (patch.related_file_path !== undefined && patch.related_file_path !== currentTask.related_file_path) {
        setClauses.push('related_file_path = ?');
        bindings.push(patch.related_file_path);
        if (currentTask.related_file_path && patch.related_file_path) {
          logActivity(this.db, id, 'file_unlinked', currentTask.related_file_path, null, actor);
          logActivity(this.db, id, 'file_linked', null, patch.related_file_path, actor);
        } else if (patch.related_file_path) {
          logActivity(this.db, id, 'file_linked', null, patch.related_file_path, actor);
        } else {
          logActivity(this.db, id, 'file_unlinked', currentTask.related_file_path, null, actor);
        }
      }

      if (patch.agent_session_id !== undefined && patch.agent_session_id !== currentTask.agent_session_id) {
        setClauses.push('agent_session_id = ?');
        bindings.push(patch.agent_session_id);
        // Note: agent_session_id changes are applied but not logged
        // since 'agent_session_changed' is not in the spec's allowed event_type values.
      }

      if (patch.tags !== undefined) {
        const newTagsJson = JSON.stringify(patch.tags);
        const oldTagsJson = JSON.stringify(currentTask.tags);
        if (newTagsJson !== oldTagsJson) {
          setClauses.push('tags = ?');
          bindings.push(newTagsJson);
          logActivity(this.db, id, 'tags_changed', oldTagsJson, newTagsJson, actor);
        }
      }

      if (patch.notes !== undefined && patch.notes !== currentTask.notes) {
        setClauses.push('notes = ?');
        bindings.push(patch.notes);
        logActivity(this.db, id, 'note_added', currentTask.notes, patch.notes, actor);
      }

      // Apply status transition side effects
      if (newStatus === 'done') {
        setClauses.push('completed_at = ?');
        bindings.push(timestamp);
      } else if (newStatus === 'cancelled') {
        setClauses.push('completed_at = NULL');
      } else if (newStatus === 'todo') {
        // Reopening from done/cancelled: clear completed_at
        if (currentTask.status === 'done' || currentTask.status === 'cancelled') {
          setClauses.push('completed_at = NULL');
        }
        // Reverting from in_progress: clear agent_session_id
        if (currentTask.status === 'in_progress') {
          setClauses.push('agent_session_id = NULL');
        }
      }

      // Nothing to update
      if (setClauses.length === 0) {
        return;
      }

      // Always update updated_at
      setClauses.push('updated_at = ?');
      bindings.push(timestamp);
      bindings.push(id);

      const sql = `UPDATE rc_tasks SET ${setClauses.join(', ')} WHERE id = ?`;
      this.db.prepare(sql).run(...bindings);
    });

    doUpdate();
    return this.getTaskById(id);
  }

  // ── 5. complete ─────────────────────────────────────────────────────

  /**
   * Mark a task as done.
   *
   * - Validates state machine (must be in_progress or blocked).
   * - Sets status='done', completed_at=now().
   * - Optionally appends a completion note.
   * - Logs 'completed' activity event.
   */
  complete(id: string, notes?: string, actor: Actor = 'human'): Task {
    const existing = this.db.prepare('SELECT * FROM rc_tasks WHERE id = ?').get(id) as TaskRow | undefined;
    if (!existing) {
      throw new RpcError(-32001, `Task not found: ${id}`);
    }

    const currentTask = rowToTask(existing);

    // Allow todo → done by auto-transitioning through in_progress.
    // This matches user expectation: "mark complete" should work regardless of current status.
    const needsAutoProgress = currentTask.status === 'todo';

    if (!needsAutoProgress && !isValidTransition(currentTask.status, 'done')) {
      throw new RpcError(
        -32004,
        `Invalid status transition: ${currentTask.status} -> done`,
      );
    }

    const doComplete = this.db.transaction(() => {
      const timestamp = now();

      // Auto-transition: todo → in_progress (logged as its own activity)
      if (needsAutoProgress) {
        this.db.prepare(
          `UPDATE rc_tasks SET status = 'in_progress', updated_at = ? WHERE id = ?`,
        ).run(timestamp, id);
        logActivity(this.db, id, 'status_changed', 'todo', 'in_progress', actor);
      }

      let updatedNotes = currentTask.notes;

      if (notes) {
        const noteEntry = `\n\n---\n[${timestamp} | ${actor}]\n${notes}`;
        updatedNotes = updatedNotes ? updatedNotes + noteEntry : noteEntry;
      }

      this.db.prepare(
        `UPDATE rc_tasks SET status = 'done', completed_at = ?, notes = ?, updated_at = ? WHERE id = ?`,
      ).run(timestamp, updatedNotes, timestamp, id);

      logActivity(this.db, id, 'completed', needsAutoProgress ? 'in_progress' : currentTask.status, 'done', actor);
    });

    doComplete();
    return this.getTaskById(id);
  }

  // ── 6. delete ───────────────────────────────────────────────────────

  /**
   * Hard-delete a task.
   *
   * - CASCADE removes associated rc_activity_log entries.
   * - Subtasks (parent_task_id referencing this task) get parent_task_id set to NULL
   *   via ON DELETE SET NULL in the schema.
   */
  delete(id: string): void {
    const existing = this.db.prepare('SELECT id FROM rc_tasks WHERE id = ?').get(id) as { id: string } | undefined;
    if (!existing) {
      throw new RpcError(-32001, `Task not found: ${id}`);
    }

    // CASCADE will remove rc_activity_log entries.
    // ON DELETE SET NULL will clear parent_task_id on subtasks.
    this.db.prepare('DELETE FROM rc_tasks WHERE id = ?').run(id);
  }

  // ── 7. upcoming ─────────────────────────────────────────────────────

  /**
   * Find tasks with deadlines within the next N hours (default 48).
   * Excludes done/cancelled tasks. Sorted by deadline ASC.
   */
  upcoming(hours: number = 48): Task[] {
    const nowTs = now();
    const futureDate = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();

    const rows = this.db.prepare(
      `SELECT * FROM rc_tasks
       WHERE status NOT IN ('done', 'cancelled')
         AND deadline IS NOT NULL
         AND deadline >= ?
         AND deadline <= ?
       ORDER BY deadline ASC`,
    ).all(nowTs, futureDate) as TaskRow[];

    return rows.map(rowToTask);
  }

  // ── 8. overdue ──────────────────────────────────────────────────────

  /**
   * Find tasks with deadlines that have already passed.
   * Excludes done/cancelled tasks. Sorted by deadline ASC (most overdue first).
   */
  overdue(): Task[] {
    const nowTs = now();

    const rows = this.db.prepare(
      `SELECT * FROM rc_tasks
       WHERE status NOT IN ('done', 'cancelled')
         AND deadline IS NOT NULL
         AND deadline < ?
       ORDER BY deadline ASC`,
    ).all(nowTs) as TaskRow[];

    return rows.map(rowToTask);
  }

  // ── 9. link ─────────────────────────────────────────────────────────

  /**
   * Link a task to a paper by setting related_paper_id.
   * Validates that both the task and paper exist.
   * Logs 'paper_linked' activity event (and 'paper_unlinked' if replacing).
   */
  link(taskId: string, paperId: string): void {
    const taskRow = this.db.prepare('SELECT * FROM rc_tasks WHERE id = ?').get(taskId) as TaskRow | undefined;
    if (!taskRow) {
      throw new RpcError(-32001, `Task not found: ${taskId}`);
    }

    const paper = this.db.prepare('SELECT id FROM rc_papers WHERE id = ?').get(paperId) as { id: string } | undefined;
    if (!paper) {
      throw new RpcError(-32003, `Invalid related_paper_id: ${paperId}`);
    }

    const currentTask = rowToTask(taskRow);

    const doLink = this.db.transaction(() => {
      const timestamp = now();

      // Log unlinking if replacing an existing paper link
      if (currentTask.related_paper_id && currentTask.related_paper_id !== paperId) {
        logActivity(this.db, taskId, 'paper_unlinked', currentTask.related_paper_id, null, 'human');
      }

      this.db.prepare(
        'UPDATE rc_tasks SET related_paper_id = ?, updated_at = ? WHERE id = ?',
      ).run(paperId, timestamp, taskId);

      logActivity(this.db, taskId, 'paper_linked', null, paperId, 'human');
    });
    doLink();
  }

  // ── 9b. linkFile ────────────────────────────────────────────────────

  /**
   * Link a task to a workspace file by setting related_file_path.
   * Validates that the task exists and the file path is a safe relative path.
   * Logs 'file_linked' activity event (and 'file_unlinked' if replacing).
   */
  linkFile(taskId: string, filePath: string, actor: Actor = 'human'): void {
    const taskRow = this.db.prepare('SELECT * FROM rc_tasks WHERE id = ?').get(taskId) as TaskRow | undefined;
    if (!taskRow) {
      throw new RpcError(-32001, `Task not found: ${taskId}`);
    }

    // Validate file path is a safe relative path
    if (filePath.startsWith('/') || filePath.startsWith('\\') || filePath.includes('..') || filePath.includes('\0')) {
      throw new RpcError(-32005, 'file_path must be a relative path within the workspace');
    }

    const currentTask = rowToTask(taskRow);

    const doLink = this.db.transaction(() => {
      const timestamp = now();

      if (currentTask.related_file_path && currentTask.related_file_path !== filePath) {
        logActivity(this.db, taskId, 'file_unlinked', currentTask.related_file_path, null, actor);
      }

      this.db.prepare(
        'UPDATE rc_tasks SET related_file_path = ?, updated_at = ? WHERE id = ?',
      ).run(filePath, timestamp, taskId);

      logActivity(this.db, taskId, 'file_linked', null, filePath, actor);
    });
    doLink();
  }

  // ── 10. addNote ─────────────────────────────────────────────────────

  /**
   * Add a note to a task's activity log.
   *
   * Inserts into rc_activity_log with event_type='note_added' and new_value=content.
   * Also appends the note text to the task's notes field for inline viewing.
   * Returns the created ActivityLogEntry.
   */
  addNote(taskId: string, content: string, actor: Actor = 'human'): ActivityLogEntry {
    const existing = this.db.prepare('SELECT * FROM rc_tasks WHERE id = ?').get(taskId) as TaskRow | undefined;
    if (!existing) {
      throw new RpcError(-32001, `Task not found: ${taskId}`);
    }

    let result!: ActivityLogEntry;
    const doAddNote = this.db.transaction(() => {
      const timestamp = now();
      const noteEntry = `\n\n---\n[${timestamp} | ${actor}]\n${content}`;
      const updatedNotes = existing.notes ? existing.notes + noteEntry : noteEntry;

      this.db.prepare(
        'UPDATE rc_tasks SET notes = ?, updated_at = ? WHERE id = ?',
      ).run(updatedNotes, timestamp, taskId);

      // Log to activity log and return the entry
      result = logActivity(this.db, taskId, 'note_added', null, content, actor);
    });
    doAddNote();
    return result;
  }

  // ── Cron Presets ──────────────────────────────────────────────────────

  /** List all available cron presets with their current activation state. */
  cronPresetsList(): CronPreset[] {
    return PRESET_DEFINITIONS
      .map((def) => {
        const row = this.db.prepare(
          'SELECT enabled, config, last_run_at, next_run_at, gateway_job_id, schedule FROM rc_cron_state WHERE preset_id = ?',
        ).get(def.id) as { enabled: number; config: string; last_run_at: string | null; next_run_at: string | null; gateway_job_id: string | null; schedule: string | null } | undefined;

        // Deleted preset: no row in rc_cron_state, omit from list
        if (!row) return null;

        let config: Record<string, unknown> = {};
        try { config = JSON.parse(row.config ?? '{}') as Record<string, unknown>; } catch { /* */ }

        return {
          id: def.id,
          name: def.name,
          description: def.description,
          schedule: row.schedule ?? def.schedule,
          enabled: row.enabled === 1,
          config,
          last_run_at: row.last_run_at ?? null,
          next_run_at: row.next_run_at ?? null,
          gateway_job_id: row.gateway_job_id ?? null,
        };
      })
      .filter((p): p is CronPreset => p !== null);
  }

  /** Activate a cron preset with optional configuration. */
  cronPresetsActivate(presetId: string, config?: Record<string, unknown>): { ok: true; preset: CronPreset } {
    const def = PRESET_DEFINITIONS.find((p) => p.id === presetId);
    if (!def) {
      throw new RpcError(-32001, `Cron preset not found: ${presetId}`);
    }

    const nextRunAt = now();
    if (config) {
      this.db.prepare(
        'UPDATE rc_cron_state SET enabled = 1, config = ?, next_run_at = ? WHERE preset_id = ?',
      ).run(JSON.stringify(config), nextRunAt, presetId);
    } else {
      this.db.prepare(
        'UPDATE rc_cron_state SET enabled = 1, next_run_at = ? WHERE preset_id = ?',
      ).run(nextRunAt, presetId);
    }

    // Read back persisted state
    const row = this.db.prepare(
      'SELECT enabled, config, last_run_at, next_run_at, gateway_job_id, schedule FROM rc_cron_state WHERE preset_id = ?',
    ).get(presetId) as { enabled: number; config: string; last_run_at: string | null; next_run_at: string | null; gateway_job_id: string | null; schedule: string | null };

    let storedConfig: Record<string, unknown> = {};
    try { storedConfig = JSON.parse(row.config) as Record<string, unknown>; } catch { /* */ }

    const preset: CronPreset = {
      id: def.id,
      name: def.name,
      description: def.description,
      schedule: row.schedule ?? def.schedule,
      enabled: true,
      config: storedConfig,
      last_run_at: row.last_run_at,
      next_run_at: row.next_run_at,
      gateway_job_id: row.gateway_job_id,
    };

    return { ok: true, preset };
  }

  /** Deactivate a cron preset. */
  cronPresetsDeactivate(presetId: string): { ok: true; preset: CronPreset } {
    const def = PRESET_DEFINITIONS.find((p) => p.id === presetId);
    if (!def) {
      throw new RpcError(-32001, `Cron preset not found: ${presetId}`);
    }

    this.db.prepare(
      'UPDATE rc_cron_state SET enabled = 0, next_run_at = NULL, gateway_job_id = NULL WHERE preset_id = ?',
    ).run(presetId);

    const row = this.db.prepare(
      'SELECT enabled, config, last_run_at, next_run_at, gateway_job_id, schedule FROM rc_cron_state WHERE preset_id = ?',
    ).get(presetId) as { enabled: number; config: string; last_run_at: string | null; next_run_at: string | null; gateway_job_id: string | null; schedule: string | null };

    let storedConfig: Record<string, unknown> = {};
    try { storedConfig = JSON.parse(row.config) as Record<string, unknown>; } catch { /* */ }

    const preset: CronPreset = {
      id: def.id,
      name: def.name,
      description: def.description,
      schedule: row.schedule ?? def.schedule,
      enabled: false,
      config: storedConfig,
      last_run_at: row.last_run_at,
      next_run_at: row.next_run_at,
      gateway_job_id: row.gateway_job_id,
    };

    return { ok: true, preset };
  }

  /** Delete a cron preset from the database. */
  cronPresetsDelete(presetId: string): { ok: true; deleted: string; gateway_job_id: string | null } {
    const row = this.db.prepare(
      'SELECT preset_id, gateway_job_id FROM rc_cron_state WHERE preset_id = ?',
    ).get(presetId) as { preset_id: string; gateway_job_id: string | null } | undefined;

    if (!row) {
      throw new RpcError(-32001, `Cron preset not found: ${presetId}`);
    }

    this.db.prepare('DELETE FROM rc_cron_state WHERE preset_id = ?').run(presetId);
    return { ok: true, deleted: presetId, gateway_job_id: row.gateway_job_id };
  }

  /** Restore a known preset from PRESET_DEFINITIONS. */
  cronPresetsRestore(presetId: string): { ok: true; preset: CronPreset } {
    const def = PRESET_DEFINITIONS.find((p) => p.id === presetId);
    if (!def) {
      throw new RpcError(-32001, `Unknown preset: ${presetId}`);
    }

    // Re-insert with defaults (enabled=0). INSERT OR IGNORE = no-op if already exists.
    this.db.prepare(
      `INSERT OR IGNORE INTO rc_cron_state (preset_id, enabled, config, last_run_at, next_run_at)
       VALUES (?, 0, '{}', NULL, NULL)`,
    ).run(presetId);

    // Read back the row
    const row = this.db.prepare(
      'SELECT enabled, config, last_run_at, next_run_at, gateway_job_id, schedule FROM rc_cron_state WHERE preset_id = ?',
    ).get(presetId) as { enabled: number; config: string; last_run_at: string | null; next_run_at: string | null; gateway_job_id: string | null; schedule: string | null };

    let storedConfig: Record<string, unknown> = {};
    try { storedConfig = JSON.parse(row.config) as Record<string, unknown>; } catch { /* */ }

    return {
      ok: true,
      preset: {
        id: def.id,
        name: def.name,
        description: def.description,
        schedule: row.schedule ?? def.schedule,
        enabled: row.enabled === 1,
        config: storedConfig,
        last_run_at: row.last_run_at,
        next_run_at: row.next_run_at,
        gateway_job_id: row.gateway_job_id,
      },
    };
  }

  /** Store the gateway cron job ID after activation. */
  cronPresetsSetJobId(presetId: string, jobId: string): { ok: true } {
    const def = PRESET_DEFINITIONS.find((p) => p.id === presetId);
    if (!def) {
      throw new RpcError(-32001, `Cron preset not found: ${presetId}`);
    }

    this.db.prepare(
      'UPDATE rc_cron_state SET gateway_job_id = ? WHERE preset_id = ?',
    ).run(jobId, presetId);

    return { ok: true };
  }

  /**
   * Update the schedule of a cron preset.
   * Persists the new cron expression to DB. Returns the updated preset
   * including gateway_job_id so the caller can re-register the gateway job.
   */
  cronPresetsUpdateSchedule(presetId: string, schedule: string): { ok: true; preset: CronPreset } {
    const def = PRESET_DEFINITIONS.find((p) => p.id === presetId);
    if (!def) {
      throw new RpcError(-32001, `Cron preset not found: ${presetId}`);
    }

    // Basic cron expression validation: 5 space-separated fields
    const fields = schedule.trim().split(/\s+/);
    if (fields.length !== 5) {
      throw new RpcError(-32600, `Invalid cron expression: expected 5 fields, got ${fields.length}`);
    }

    // Check preset exists in DB
    const exists = this.db.prepare(
      'SELECT preset_id FROM rc_cron_state WHERE preset_id = ?',
    ).get(presetId);
    if (!exists) {
      throw new RpcError(-32001, `Cron preset not found in database: ${presetId}`);
    }

    this.db.prepare(
      'UPDATE rc_cron_state SET schedule = ? WHERE preset_id = ?',
    ).run(schedule.trim(), presetId);

    // Read back full state
    const row = this.db.prepare(
      'SELECT enabled, config, last_run_at, next_run_at, gateway_job_id, schedule FROM rc_cron_state WHERE preset_id = ?',
    ).get(presetId) as { enabled: number; config: string; last_run_at: string | null; next_run_at: string | null; gateway_job_id: string | null; schedule: string | null };

    let storedConfig: Record<string, unknown> = {};
    try { storedConfig = JSON.parse(row.config) as Record<string, unknown>; } catch { /* */ }

    return {
      ok: true,
      preset: {
        id: def.id,
        name: def.name,
        description: def.description,
        schedule: row.schedule ?? def.schedule,
        enabled: row.enabled === 1,
        config: storedConfig,
        last_run_at: row.last_run_at,
        next_run_at: row.next_run_at,
        gateway_job_id: row.gateway_job_id,
      },
    };
  }

  // ── Agent Notifications ──────────────────────────────────────────────

  /** Insert a custom notification sent by the agent. */
  sendNotification(type: string, title: string, body?: string): { id: string; type: string; title: string; body: string | null; created_at: string } {
    const id = randomUUID();
    const validTypes = ['deadline', 'heartbeat', 'system', 'error'];
    const safeType = validTypes.includes(type) ? type : 'system';

    this.db.prepare(
      `INSERT INTO rc_agent_notifications (id, type, title, body) VALUES (?, ?, ?, ?)`,
    ).run(id, safeType, title, body ?? null);

    const row = this.db.prepare('SELECT * FROM rc_agent_notifications WHERE id = ?').get(id) as
      { id: string; type: string; title: string; body: string | null; created_at: string; read: number };

    return { id: row.id, type: row.type, title: row.title, body: row.body, created_at: row.created_at };
  }

  /** Get unread custom notifications (for dashboard polling). */
  getUnreadNotifications(limit = 20): Array<{ id: string; type: string; title: string; body: string | null; created_at: string }> {
    return this.db.prepare(
      `SELECT id, type, title, body, created_at FROM rc_agent_notifications
       WHERE read = 0 ORDER BY created_at DESC LIMIT ?`,
    ).all(limit) as Array<{ id: string; type: string; title: string; body: string | null; created_at: string }>;
  }

  /** Mark a custom notification as read. */
  markNotificationRead(id: string): void {
    this.db.prepare('UPDATE rc_agent_notifications SET read = 1 WHERE id = ?').run(id);
  }

  // ── Private Helpers ─────────────────────────────────────────────────

  private getTaskById(id: string): Task {
    const row = this.db.prepare('SELECT * FROM rc_tasks WHERE id = ?').get(id) as TaskRow | undefined;
    if (!row) {
      throw new RpcError(-32001, `Task not found: ${id}`);
    }
    return rowToTask(row);
  }
}

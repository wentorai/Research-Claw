/**
 * TaskService Unit Tests
 *
 * Comprehensive tests for the 13 methods in the rc.task.* namespace.
 * Each test uses a fresh in-memory SQLite database.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type BetterSqlite3 from 'better-sqlite3';

import { createTestDb } from './setup.js';
import { TaskService, type TaskInput } from '../tasks/service.js';
import { LiteratureService } from '../literature/service.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTask(overrides: Partial<TaskInput> = {}): TaskInput {
  return {
    title: 'Review transformer survey paper',
    task_type: 'human',
    priority: 'high',
    deadline: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    description: 'Read and annotate the methodology section',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe('TaskService', () => {
  let db: BetterSqlite3.Database;
  let svc: TaskService;

  beforeEach(() => {
    db = createTestDb();
    svc = new TaskService(db);
  });

  afterEach(() => {
    db.close();
  });

  // ── create ──────────────────────────────────────────────────────────

  describe('create', () => {
    it('creates a task with all fields', () => {
      const task = svc.create(makeTask());
      expect(task.id).toBeTruthy();
      expect(task.title).toBe('Review transformer survey paper');
      expect(task.task_type).toBe('human');
      expect(task.status).toBe('todo');
      expect(task.priority).toBe('high');
      expect(task.description).toBe('Read and annotate the methodology section');
      expect(task.deadline).toBeTruthy();
      expect(task.created_at).toBeTruthy();
    });

    it('creates a minimal task', () => {
      const task = svc.create({ title: 'Quick task', task_type: 'agent' });
      expect(task.title).toBe('Quick task');
      expect(task.task_type).toBe('agent');
      expect(task.priority).toBe('medium'); // default
      expect(task.status).toBe('todo'); // always initial
    });

    it('sets tags as JSON', () => {
      const task = svc.create(makeTask({ tags: ['urgent', 'survey'] }));
      expect(task.tags).toContain('urgent');
      expect(task.tags).toContain('survey');
    });

    it('logs a created activity event', () => {
      const task = svc.create(makeTask());
      const details = svc.get(task.id)!;
      expect(details.activity_log.length).toBeGreaterThanOrEqual(1);
      expect(details.activity_log.some((e) => e.event_type === 'created')).toBe(true);
    });

    it('throws for invalid task_type', () => {
      expect(() =>
        svc.create({ title: 'bad', task_type: 'invalid' as any }),
      ).toThrow('Invalid task_type');
    });

    it('throws for invalid priority', () => {
      expect(() =>
        svc.create({ title: 'bad', task_type: 'human', priority: 'critical' as any }),
      ).toThrow('Invalid priority');
    });

    it('validates parent_task_id exists', () => {
      expect(() =>
        svc.create(makeTask({ parent_task_id: 'non-existent' })),
      ).toThrow('Invalid parent_task_id');
    });

    it('validates related_paper_id exists', () => {
      expect(() =>
        svc.create(makeTask({ related_paper_id: 'non-existent' })),
      ).toThrow('Invalid related_paper_id');
    });

    it('accepts valid parent_task_id', () => {
      const parent = svc.create(makeTask({ title: 'Parent' }));
      const child = svc.create(makeTask({ title: 'Child', parent_task_id: parent.id }));
      expect(child.parent_task_id).toBe(parent.id);
    });

    it('accepts valid related_paper_id', () => {
      const litSvc = new LiteratureService(db);
      const paper = litSvc.add({ title: 'Test Paper' });

      const task = svc.create(makeTask({ related_paper_id: paper.id }));
      expect(task.related_paper_id).toBe(paper.id);
    });
  });

  // ── get ──────────────────────────────────────────────────────────────

  describe('get', () => {
    it('returns task with activity log and subtasks', () => {
      const parent = svc.create(makeTask({ title: 'Parent' }));
      svc.create(makeTask({ title: 'Child', parent_task_id: parent.id }));

      const details = svc.get(parent.id);
      expect(details).not.toBeNull();
      expect(details!.title).toBe('Parent');
      expect(details!.activity_log.length).toBeGreaterThanOrEqual(1);
      expect(details!.subtasks).toHaveLength(1);
      expect(details!.subtasks[0].title).toBe('Child');
    });

    it('returns null for non-existent task', () => {
      expect(svc.get('non-existent')).toBeNull();
    });
  });

  // ── list ─────────────────────────────────────────────────────────────

  describe('list', () => {
    it('lists all active tasks', () => {
      svc.create(makeTask({ title: 'Task A' }));
      svc.create(makeTask({ title: 'Task B' }));

      const result = svc.list();
      expect(result.items).toHaveLength(2);
      expect(result.total).toBe(2);
    });

    it('filters by status', () => {
      const t1 = svc.create(makeTask({ title: 'A' }));
      svc.create(makeTask({ title: 'B' }));
      svc.update(t1.id, { status: 'in_progress' });

      const result = svc.list({ status: 'in_progress' });
      expect(result.total).toBe(1);
      expect(result.items[0].id).toBe(t1.id);
    });

    it('filters by priority', () => {
      svc.create(makeTask({ title: 'A', priority: 'urgent' }));
      svc.create(makeTask({ title: 'B', priority: 'low' }));

      const result = svc.list({ priority: 'urgent' });
      expect(result.total).toBe(1);
    });

    it('filters by task_type', () => {
      svc.create(makeTask({ title: 'A', task_type: 'agent' }));
      svc.create(makeTask({ title: 'B', task_type: 'human' }));

      const result = svc.list({ task_type: 'agent' });
      expect(result.total).toBe(1);
    });

    it('excludes completed/cancelled by default', () => {
      const t = svc.create(makeTask());
      svc.update(t.id, { status: 'in_progress' });
      svc.complete(t.id);

      const result = svc.list();
      expect(result.total).toBe(0);
    });

    it('includes completed when include_completed=true', () => {
      const t = svc.create(makeTask());
      svc.update(t.id, { status: 'in_progress' });
      svc.complete(t.id);

      const result = svc.list({ include_completed: true });
      expect(result.total).toBe(1);
    });

    it('supports pagination', () => {
      for (let i = 0; i < 10; i++) {
        svc.create(makeTask({ title: `Task ${i}` }));
      }

      const page1 = svc.list({ limit: 3, offset: 0 });
      const page2 = svc.list({ limit: 3, offset: 3 });
      expect(page1.items).toHaveLength(3);
      expect(page2.items).toHaveLength(3);
      expect(page1.items[0].id).not.toBe(page2.items[0].id);
    });

    it('sorts by priority when specified', () => {
      svc.create(makeTask({ title: 'Low', priority: 'low' }));
      svc.create(makeTask({ title: 'Urgent', priority: 'urgent' }));
      svc.create(makeTask({ title: 'Medium', priority: 'medium' }));

      const result = svc.list({ sort: 'priority', direction: 'asc' });
      expect(result.items[0].priority).toBe('urgent');
      expect(result.items[result.items.length - 1].priority).toBe('low');
    });
  });

  // ── update ──────────────────────────────────────────────────────────

  describe('update', () => {
    it('updates title and logs activity', () => {
      const t = svc.create(makeTask());
      const updated = svc.update(t.id, { title: 'Updated Title' });
      expect(updated.title).toBe('Updated Title');

      const details = svc.get(t.id)!;
      expect(details.activity_log.some((e) => e.event_type === 'title_changed')).toBe(true);
    });

    it('validates status transitions', () => {
      const t = svc.create(makeTask());
      // todo -> done is NOT valid (must go through in_progress first)
      expect(() => svc.update(t.id, { status: 'done' })).toThrow(
        'Invalid status transition',
      );
    });

    it('allows valid status transition todo -> in_progress', () => {
      const t = svc.create(makeTask());
      const updated = svc.update(t.id, { status: 'in_progress' });
      expect(updated.status).toBe('in_progress');
    });

    it('sets completed_at when transitioning to done', () => {
      const t = svc.create(makeTask());
      svc.update(t.id, { status: 'in_progress' });
      const done = svc.update(t.id, { status: 'done' });
      expect(done.status).toBe('done');
      expect(done.completed_at).toBeTruthy();
    });

    it('clears completed_at when transitioning to cancelled', () => {
      const t = svc.create(makeTask());
      svc.update(t.id, { status: 'in_progress' });
      const cancelled = svc.update(t.id, { status: 'cancelled' });
      expect(cancelled.status).toBe('cancelled');
      expect(cancelled.completed_at).toBeNull();
    });

    it('clears agent_session_id when in_progress -> todo', () => {
      const t = svc.create(makeTask({ agent_session_id: 'session-1' }));
      svc.update(t.id, { status: 'in_progress' });
      const reverted = svc.update(t.id, { status: 'todo' });
      expect(reverted.agent_session_id).toBeNull();
    });

    it('throws for non-existent task', () => {
      expect(() => svc.update('bad-id', { title: 'x' })).toThrow('Task not found');
    });

    it('prevents a task from being its own parent', () => {
      const t = svc.create(makeTask());
      expect(() => svc.update(t.id, { parent_task_id: t.id })).toThrow(
        'cannot be its own parent',
      );
    });

    it('logs paper link/unlink events', () => {
      const litSvc = new LiteratureService(db);
      const paper = litSvc.add({ title: 'Test Paper' });
      const t = svc.create(makeTask());

      svc.update(t.id, { related_paper_id: paper.id });
      const details = svc.get(t.id)!;
      expect(details.activity_log.some((e) => e.event_type === 'paper_linked')).toBe(true);

      svc.update(t.id, { related_paper_id: null });
      const details2 = svc.get(t.id)!;
      expect(details2.activity_log.some((e) => e.event_type === 'paper_unlinked')).toBe(true);
    });
  });

  // ── complete ────────────────────────────────────────────────────────

  describe('complete', () => {
    it('marks an in_progress task as done', () => {
      const t = svc.create(makeTask());
      svc.update(t.id, { status: 'in_progress' });
      const done = svc.complete(t.id);
      expect(done.status).toBe('done');
      expect(done.completed_at).toBeTruthy();
    });

    it('marks a blocked task as done', () => {
      const t = svc.create(makeTask());
      svc.update(t.id, { status: 'in_progress' });
      svc.update(t.id, { status: 'blocked' });
      const done = svc.complete(t.id);
      expect(done.status).toBe('done');
    });

    it('auto-transitions todo -> in_progress -> done on complete', () => {
      const t = svc.create(makeTask());
      expect(t.status).toBe('todo');
      const completed = svc.complete(t.id);
      expect(completed.status).toBe('done');
      expect(completed.completed_at).toBeTruthy();
    });

    it('appends completion notes', () => {
      const t = svc.create(makeTask());
      svc.update(t.id, { status: 'in_progress' });
      const done = svc.complete(t.id, 'Finished review');
      expect(done.notes).toContain('Finished review');
    });

    it('logs completed event', () => {
      const t = svc.create(makeTask());
      svc.update(t.id, { status: 'in_progress' });
      svc.complete(t.id);

      const details = svc.get(t.id)!;
      expect(details.activity_log.some((e) => e.event_type === 'completed')).toBe(true);
    });
  });

  // ── delete ──────────────────────────────────────────────────────────

  describe('delete', () => {
    it('hard-deletes a task', () => {
      const t = svc.create(makeTask());
      svc.delete(t.id);
      expect(svc.get(t.id)).toBeNull();
    });

    it('cascades to activity log', () => {
      const t = svc.create(makeTask());
      svc.delete(t.id);

      const logRows = db
        .prepare('SELECT COUNT(*) as cnt FROM rc_activity_log WHERE task_id = ?')
        .get(t.id) as { cnt: number };
      expect(logRows.cnt).toBe(0);
    });

    it('nullifies parent_task_id on subtasks', () => {
      const parent = svc.create(makeTask({ title: 'Parent' }));
      const child = svc.create(makeTask({ title: 'Child', parent_task_id: parent.id }));
      svc.delete(parent.id);

      const childAfter = svc.get(child.id)!;
      expect(childAfter.parent_task_id).toBeNull();
    });

    it('throws for non-existent task', () => {
      expect(() => svc.delete('bad-id')).toThrow('Task not found');
    });
  });

  // ── upcoming ────────────────────────────────────────────────────────

  describe('upcoming', () => {
    it('finds tasks with deadlines within the next N hours', () => {
      // Task due in 24 hours
      svc.create(
        makeTask({
          title: 'Soon',
          deadline: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        }),
      );
      // Task due in 72 hours (beyond default 48h window)
      svc.create(
        makeTask({
          title: 'Later',
          deadline: new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString(),
        }),
      );

      const upcoming = svc.upcoming(48);
      expect(upcoming).toHaveLength(1);
      expect(upcoming[0].title).toBe('Soon');
    });

    it('excludes done tasks', () => {
      const t = svc.create(
        makeTask({
          deadline: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        }),
      );
      svc.update(t.id, { status: 'in_progress' });
      svc.complete(t.id);

      const upcoming = svc.upcoming(48);
      expect(upcoming).toHaveLength(0);
    });
  });

  // ── overdue ─────────────────────────────────────────────────────────

  describe('overdue', () => {
    it('finds tasks with deadlines in the past', () => {
      svc.create(
        makeTask({
          title: 'Overdue',
          deadline: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(),
        }),
      );
      svc.create(
        makeTask({
          title: 'Future',
          deadline: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
        }),
      );

      const overdue = svc.overdue();
      expect(overdue).toHaveLength(1);
      expect(overdue[0].title).toBe('Overdue');
    });

    it('returns empty when no overdue tasks', () => {
      svc.create(
        makeTask({
          deadline: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
        }),
      );
      expect(svc.overdue()).toHaveLength(0);
    });
  });

  // ── link ────────────────────────────────────────────────────────────

  describe('link', () => {
    it('links a task to a paper', () => {
      const litSvc = new LiteratureService(db);
      const paper = litSvc.add({ title: 'Test Paper' });
      const t = svc.create(makeTask());

      svc.link(t.id, paper.id);
      const details = svc.get(t.id)!;
      expect(details.related_paper_id).toBe(paper.id);
    });

    it('throws for non-existent task', () => {
      const litSvc = new LiteratureService(db);
      const paper = litSvc.add({ title: 'Test Paper' });
      expect(() => svc.link('bad-id', paper.id)).toThrow('Task not found');
    });

    it('throws for non-existent paper', () => {
      const t = svc.create(makeTask());
      expect(() => svc.link(t.id, 'bad-paper-id')).toThrow('Invalid related_paper_id');
    });
  });

  // ── addNote ─────────────────────────────────────────────────────────

  describe('addNote', () => {
    it('adds a note to the activity log', () => {
      const t = svc.create(makeTask());
      const entry = svc.addNote(t.id, 'Progress note');
      expect(entry.event_type).toBe('note_added');
      expect(entry.new_value).toBe('Progress note');
    });

    it('appends note to the task notes field', () => {
      const t = svc.create(makeTask());
      svc.addNote(t.id, 'First note');
      svc.addNote(t.id, 'Second note');

      const details = svc.get(t.id)!;
      expect(details.notes).toContain('First note');
      expect(details.notes).toContain('Second note');
    });

    it('throws for non-existent task', () => {
      expect(() => svc.addNote('bad-id', 'note')).toThrow('Task not found');
    });
  });

  describe('agent notifications', () => {
    it('deduplicates repeated unread self-check notifications by title', () => {
      const first = svc.sendNotificationOnce(
        'error',
        '网关近期启动失败',
        'first startup_failed snapshot',
      );
      const second = svc.sendNotificationOnce(
        'error',
        '网关近期启动失败',
        'second startup_failed snapshot',
      );

      expect(second.id).toBe(first.id);
      expect(svc.getUnreadNotifications()).toHaveLength(1);
      expect(svc.getUnreadNotifications()[0]?.body).toBe('first startup_failed snapshot');
    });

    it('allows the same self-check title again after the prior notification is read', () => {
      const first = svc.sendNotificationOnce('error', '插件未正确加载:research-plugins', 'old');
      svc.markNotificationRead(first.id);
      const second = svc.sendNotificationOnce('error', '插件未正确加载:research-plugins', 'new');

      expect(second.id).not.toBe(first.id);
      expect(svc.getUnreadNotifications()).toHaveLength(1);
      expect(svc.getUnreadNotifications()[0]?.body).toBe('new');
    });
  });

  // ── Cron Presets ────────────────────────────────────────────────────

  describe('cron presets', () => {
    it('lists all 5 preset definitions', () => {
      const presets = svc.cronPresetsList();
      expect(presets).toHaveLength(5);
      expect(presets.map((p) => p.id)).toContain('arxiv_daily_scan');
      expect(presets.map((p) => p.id)).toContain('citation_tracking_weekly');
      expect(presets.map((p) => p.id)).toContain('deadline_reminders_daily');
      expect(presets.map((p) => p.id)).toContain('group_meeting_prep');
      expect(presets.map((p) => p.id)).toContain('weekly_report');
    });

    it('all presets are disabled by default (monitor system handles scheduling)', () => {
      const presets = svc.cronPresetsList();
      const deadlines = presets.find((p) => p.id === 'deadline_reminders_daily');
      expect(deadlines!.enabled).toBe(false);
      // Post-monitor-migration: presets start disabled. Users activate via dashboard.
    });

    it('activates a preset', () => {
      const result = svc.cronPresetsActivate('arxiv_daily_scan', { topics: ['attention'] });
      expect(result.ok).toBe(true);
      expect(result.preset.enabled).toBe(true);
      expect(result.preset.config).toEqual({ topics: ['attention'] });
    });

    it('deactivates a preset', () => {
      svc.cronPresetsActivate('arxiv_daily_scan');
      const result = svc.cronPresetsDeactivate('arxiv_daily_scan');
      expect(result.ok).toBe(true);
      expect(result.preset.enabled).toBe(false);
    });

    it('throws for non-existent preset', () => {
      expect(() => svc.cronPresetsActivate('nonexistent')).toThrow('Cron preset not found');
      expect(() => svc.cronPresetsDeactivate('nonexistent')).toThrow('Cron preset not found');
    });
  });
});

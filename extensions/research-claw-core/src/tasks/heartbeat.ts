/**
 * Research-Claw Core — Adaptive Heartbeat Escalation Service
 *
 * Tracks tasks with deadlines and escalates notification frequency
 * as deadlines approach. Tiers:
 *
 *   silent      (>7d)    — context injection only
 *   daily       (7d→3d)  — 1 notification/day
 *   twice_daily (3d→1d)  — every 12h
 *   every_6h    (1d→12h) — every 6h
 *   hourly      (12h→1h) — every 1h
 *   overdue     (past)   — every 1h, max 3 days then auto-suppress
 */

import type BetterSqlite3 from 'better-sqlite3';

// ── Types ──────────────────────────────────────────────────────────────

export type HeartbeatTier = 'silent' | 'daily' | 'twice_daily' | 'every_6h' | 'hourly' | 'overdue';

export interface HeartbeatEntry {
  task_id: string;
  current_tier: HeartbeatTier;
  last_notified: string | null;
  notify_count: number;
  escalated_at: string;
  suppressed: number;
}

export interface HeartbeatStatus extends HeartbeatEntry {
  task_title: string;
  deadline: string;
  priority: string;
  status: string;
}

// ── Constants ──────────────────────────────────────────────────────────

const TIER_ORDER: readonly HeartbeatTier[] = [
  'silent', 'daily', 'twice_daily', 'every_6h', 'hourly', 'overdue',
];

/** Minimum interval in milliseconds between notifications for each tier. */
const TIER_INTERVAL_MS: Record<HeartbeatTier, number> = {
  silent:      Infinity,
  daily:       24 * 60 * 60 * 1000,
  twice_daily: 12 * 60 * 60 * 1000,
  every_6h:     6 * 60 * 60 * 1000,
  hourly:       1 * 60 * 60 * 1000,
  overdue:      1 * 60 * 60 * 1000,
};

/** Maximum time past deadline before auto-suppressing overdue notifications (3 days). */
const OVERDUE_SUPPRESS_MS = 3 * 24 * 60 * 60 * 1000;

// ── Tier calculation ───────────────────────────────────────────────────

/**
 * Determine the heartbeat tier based on time remaining to deadline.
 */
export function calculateTier(deadline: string): HeartbeatTier {
  const now = Date.now();
  const deadlineMs = new Date(deadline).getTime();
  const remaining = deadlineMs - now;

  if (remaining <= 0) return 'overdue';
  if (remaining <= 1 * 60 * 60 * 1000) return 'hourly';       // ≤1h
  if (remaining <= 12 * 60 * 60 * 1000) return 'hourly';      // ≤12h
  if (remaining <= 24 * 60 * 60 * 1000) return 'every_6h';    // ≤1d
  if (remaining <= 3 * 24 * 60 * 60 * 1000) return 'twice_daily'; // ≤3d
  if (remaining <= 7 * 24 * 60 * 60 * 1000) return 'daily';   // ≤7d
  return 'silent';
}

/**
 * Check if enough time has elapsed since last notification for the given tier.
 */
function shouldNotify(entry: HeartbeatEntry, now: number): boolean {
  if (entry.suppressed) return false;
  if (entry.current_tier === 'silent') return false;

  const interval = TIER_INTERVAL_MS[entry.current_tier];
  if (!isFinite(interval)) return false;

  if (!entry.last_notified) return true;

  const elapsed = now - new Date(entry.last_notified).getTime();
  return elapsed >= interval;
}

// ── Service ────────────────────────────────────────────────────────────

export class HeartbeatService {
  constructor(private db: BetterSqlite3.Database) {}

  /**
   * Register a task for heartbeat tracking.
   * Called when a task with a deadline is created.
   */
  register(taskId: string): void {
    const task = this.db.prepare(
      'SELECT deadline FROM rc_tasks WHERE id = ?',
    ).get(taskId) as { deadline: string | null } | undefined;

    if (!task?.deadline) return;

    const tier = calculateTier(task.deadline);

    this.db.prepare(`
      INSERT OR REPLACE INTO rc_heartbeat_log
        (task_id, current_tier, escalated_at)
      VALUES (?, ?, datetime('now'))
    `).run(taskId, tier);
  }

  /**
   * Remove a task from heartbeat tracking.
   * Called when a task is completed, cancelled, or has its deadline removed.
   * (Task deletion is handled by ON DELETE CASCADE.)
   */
  unregister(taskId: string): void {
    this.db.prepare('DELETE FROM rc_heartbeat_log WHERE task_id = ?').run(taskId);
  }

  /**
   * Recalculate the tier for a task after its deadline changed.
   */
  recalculate(taskId: string): void {
    const task = this.db.prepare(
      'SELECT deadline FROM rc_tasks WHERE id = ?',
    ).get(taskId) as { deadline: string | null } | undefined;

    if (!task?.deadline) {
      this.unregister(taskId);
      return;
    }

    const newTier = calculateTier(task.deadline);
    const existing = this.db.prepare(
      'SELECT current_tier FROM rc_heartbeat_log WHERE task_id = ?',
    ).get(taskId) as { current_tier: string } | undefined;

    if (!existing) {
      this.register(taskId);
      return;
    }

    if (existing.current_tier !== newTier) {
      this.db.prepare(`
        UPDATE rc_heartbeat_log
        SET current_tier = ?, escalated_at = datetime('now'), suppressed = 0
        WHERE task_id = ?
      `).run(newTier, taskId);
    }
  }

  /**
   * Suppress notifications for a specific task.
   */
  suppress(taskId: string): void {
    this.db.prepare(
      'UPDATE rc_heartbeat_log SET suppressed = 1 WHERE task_id = ?',
    ).run(taskId);
  }

  /**
   * On startup, scan all active tasks with deadlines and populate tracking.
   */
  bootstrap(): { registered: number; updated: number } {
    const tasks = this.db.prepare(`
      SELECT id, deadline FROM rc_tasks
      WHERE deadline IS NOT NULL
        AND status NOT IN ('done', 'cancelled')
    `).all() as Array<{ id: string; deadline: string }>;

    let registered = 0;
    let updated = 0;

    for (const task of tasks) {
      const tier = calculateTier(task.deadline);
      const existing = this.db.prepare(
        'SELECT current_tier FROM rc_heartbeat_log WHERE task_id = ?',
      ).get(task.id) as { current_tier: string } | undefined;

      if (!existing) {
        this.db.prepare(`
          INSERT INTO rc_heartbeat_log (task_id, current_tier, escalated_at)
          VALUES (?, ?, datetime('now'))
        `).run(task.id, tier);
        registered++;
      } else if (existing.current_tier !== tier) {
        this.db.prepare(`
          UPDATE rc_heartbeat_log SET current_tier = ?, escalated_at = datetime('now')
          WHERE task_id = ?
        `).run(tier, task.id);
        updated++;
      }
    }

    // Clean up entries for tasks that no longer qualify
    this.db.prepare(`
      DELETE FROM rc_heartbeat_log
      WHERE task_id NOT IN (
        SELECT id FROM rc_tasks
        WHERE deadline IS NOT NULL AND status NOT IN ('done', 'cancelled')
      )
    `).run();

    return { registered, updated };
  }

  /**
   * Cron tick: scan all tracked tasks, escalate tiers, send notifications
   * where due. Returns list of task IDs that were notified.
   *
   * @param sendNotification - callback to insert notification (from TaskService)
   */
  tick(sendNotification: (type: string, title: string, body?: string) => void): string[] {
    const now = Date.now();
    const notified: string[] = [];

    // Fetch all tracked entries joined with task data
    const entries = this.db.prepare(`
      SELECT h.*, t.title AS task_title, t.deadline, t.priority, t.status
      FROM rc_heartbeat_log h
      JOIN rc_tasks t ON t.id = h.task_id
      WHERE t.status NOT IN ('done', 'cancelled')
        AND t.deadline IS NOT NULL
    `).all() as HeartbeatStatus[];

    for (const entry of entries) {
      // Recalculate tier (deadline may have shifted relative to now)
      const newTier = calculateTier(entry.deadline);

      // Auto-suppress overdue tasks past the 3-day window
      if (newTier === 'overdue') {
        const overdueSince = now - new Date(entry.deadline).getTime();
        if (overdueSince > OVERDUE_SUPPRESS_MS) {
          this.db.prepare(
            'UPDATE rc_heartbeat_log SET suppressed = 1, current_tier = ? WHERE task_id = ?',
          ).run(newTier, entry.task_id);
          continue;
        }
      }

      // Update tier if changed
      if (entry.current_tier !== newTier) {
        const oldTierIdx = TIER_ORDER.indexOf(entry.current_tier as HeartbeatTier);
        const newTierIdx = TIER_ORDER.indexOf(newTier);

        this.db.prepare(`
          UPDATE rc_heartbeat_log
          SET current_tier = ?, escalated_at = datetime('now')
          WHERE task_id = ?
        `).run(newTier, entry.task_id);

        // If escalated (higher tier index), reset suppressed
        if (newTierIdx > oldTierIdx) {
          this.db.prepare(
            'UPDATE rc_heartbeat_log SET suppressed = 0 WHERE task_id = ?',
          ).run(entry.task_id);
        }

        entry.current_tier = newTier;
      }

      // Check if notification is due
      const hbEntry: HeartbeatEntry = {
        task_id: entry.task_id,
        current_tier: entry.current_tier as HeartbeatTier,
        last_notified: entry.last_notified,
        notify_count: entry.notify_count,
        escalated_at: entry.escalated_at,
        suppressed: entry.suppressed,
      };

      if (shouldNotify(hbEntry, now)) {
        const type = newTier === 'overdue' ? 'deadline' : 'heartbeat';
        const urgencyLabel = newTier === 'overdue'
          ? 'OVERDUE'
          : newTier === 'hourly' || newTier === 'every_6h'
            ? 'URGENT'
            : 'Reminder';

        const deadlineDate = new Date(entry.deadline);
        const remaining = deadlineDate.getTime() - now;
        let timeStr: string;
        if (remaining <= 0) {
          const overHours = Math.round(-remaining / (60 * 60 * 1000));
          timeStr = overHours < 24
            ? `${overHours}h overdue`
            : `${Math.round(overHours / 24)}d overdue`;
        } else {
          const hours = Math.round(remaining / (60 * 60 * 1000));
          timeStr = hours < 24
            ? `${hours}h remaining`
            : `${Math.round(hours / 24)}d remaining`;
        }

        sendNotification(
          type,
          `[${urgencyLabel}] ${entry.task_title}`,
          `Deadline: ${deadlineDate.toLocaleDateString()} (${timeStr}). Priority: ${entry.priority}.`,
        );

        this.db.prepare(`
          UPDATE rc_heartbeat_log
          SET last_notified = datetime('now'), notify_count = notify_count + 1
          WHERE task_id = ?
        `).run(entry.task_id);

        notified.push(entry.task_id);
      }
    }

    return notified;
  }

  /**
   * Get status of all tracked tasks (for dashboard display / RPC).
   */
  getStatus(): HeartbeatStatus[] {
    return this.db.prepare(`
      SELECT h.*, t.title AS task_title, t.deadline, t.priority, t.status
      FROM rc_heartbeat_log h
      JOIN rc_tasks t ON t.id = h.task_id
      ORDER BY
        CASE h.current_tier
          WHEN 'overdue' THEN 0
          WHEN 'hourly' THEN 1
          WHEN 'every_6h' THEN 2
          WHEN 'twice_daily' THEN 3
          WHEN 'daily' THEN 4
          WHEN 'silent' THEN 5
        END,
        t.deadline ASC
    `).all() as HeartbeatStatus[];
  }
}

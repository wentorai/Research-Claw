import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

export interface ExecutionTool {
  id: string;
  session_key: string;
  run_id: string;
  tool_call_id: string;
  tool_name: string;
  status: 'invoked' | 'completed' | 'error';
  started_at: number;
  ended_at: number | null;
  duration_ms: number | null;
  error: string | null;
}

export class ExecutionTraceService {
  constructor(private readonly db: Database.Database) {}

  recordBefore(input: {
    sessionKey: string;
    runId: string;
    toolCallId?: string;
    toolName: string;
    timestamp?: number;
  }): void {
    const toolCallId = input.toolCallId || randomUUID();
    this.db.prepare(`
      INSERT INTO rc_execution_tools
        (id, session_key, run_id, tool_call_id, tool_name, status, started_at)
      VALUES (?, ?, ?, ?, ?, 'invoked', ?)
      ON CONFLICT(run_id, tool_call_id) DO NOTHING
    `).run(randomUUID(), input.sessionKey, input.runId, toolCallId, input.toolName, input.timestamp ?? Date.now());
  }

  recordAfter(input: {
    sessionKey: string;
    runId: string;
    toolCallId?: string;
    toolName: string;
    durationMs?: number;
    error?: string;
    timestamp?: number;
  }): void {
    const endedAt = input.timestamp ?? Date.now();
    const toolCallId = input.toolCallId || randomUUID();
    const status = input.error ? 'error' : 'completed';
    const updated = this.db.prepare(`
      UPDATE rc_execution_tools
      SET status = ?, ended_at = ?, duration_ms = ?, error = ?
      WHERE run_id = ? AND tool_call_id = ?
    `).run(status, endedAt, input.durationMs ?? null, input.error?.slice(0, 500) ?? null, input.runId, toolCallId);
    if (updated.changes === 0) {
      this.db.prepare(`
        INSERT INTO rc_execution_tools
          (id, session_key, run_id, tool_call_id, tool_name, status, started_at, ended_at, duration_ms, error)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        randomUUID(), input.sessionKey, input.runId, toolCallId, input.toolName,
        status, endedAt - (input.durationMs ?? 0), endedAt, input.durationMs ?? null,
        input.error?.slice(0, 500) ?? null,
      );
    }
  }

  summary(runIds: string[]): Record<string, { toolCount: number; errorCount: number }> {
    if (runIds.length === 0) return {};
    const placeholders = runIds.map(() => '?').join(',');
    const rows = this.db.prepare(`
      SELECT run_id, COUNT(*) tool_count,
             SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) error_count
      FROM rc_execution_tools WHERE run_id IN (${placeholders}) GROUP BY run_id
    `).all(...runIds) as Array<{ run_id: string; tool_count: number; error_count: number }>;
    return Object.fromEntries(rows.map((row) => [
      row.run_id,
      { toolCount: row.tool_count, errorCount: row.error_count },
    ]));
  }

  detail(runId: string): ExecutionTool[] {
    return this.db.prepare(`
      SELECT * FROM rc_execution_tools WHERE run_id = ?
      ORDER BY started_at ASC, id ASC
    `).all(runId) as ExecutionTool[];
  }
}

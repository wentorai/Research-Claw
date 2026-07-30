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

export interface ExecutionSkill {
  id: string;
  session_key: string;
  run_id: string;
  skill_key: string;
  skill_name: string;
  skill_source: string;
  activation: 'read' | 'command';
  tool_call_id: string | null;
  first_used_at: number;
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

  recordSkill(input: {
    sessionKey: string;
    runId: string;
    skillKey: string;
    skillName: string;
    skillSource?: string;
    activation?: 'read' | 'command';
    toolCallId?: string;
    timestamp?: number;
  }): void {
    this.db.prepare(`
      INSERT INTO rc_execution_skills
        (id, session_key, run_id, skill_key, skill_name, skill_source, activation, tool_call_id, first_used_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id, skill_key) DO NOTHING
    `).run(
      randomUUID(), input.sessionKey, input.runId, input.skillKey, input.skillName,
      input.skillSource ?? 'research-plugins', input.activation ?? 'read',
      input.toolCallId ?? null, input.timestamp ?? Date.now(),
    );
  }

  summary(runIds: string[]): Record<string, { toolCount: number; errorCount: number; skillCount: number }> {
    if (runIds.length === 0) return {};
    const placeholders = runIds.map(() => '?').join(',');
    const rows = this.db.prepare(`
      SELECT run_id, COUNT(*) tool_count,
             SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) error_count
      FROM rc_execution_tools WHERE run_id IN (${placeholders}) GROUP BY run_id
    `).all(...runIds) as Array<{ run_id: string; tool_count: number; error_count: number }>;
    const skillRows = this.db.prepare(`
      SELECT run_id, COUNT(*) skill_count
      FROM rc_execution_skills WHERE run_id IN (${placeholders}) GROUP BY run_id
    `).all(...runIds) as Array<{ run_id: string; skill_count: number }>;
    const skillCounts = new Map(skillRows.map((row) => [row.run_id, row.skill_count]));
    return Object.fromEntries(runIds.flatMap((runId) => {
      const row = rows.find((candidate) => candidate.run_id === runId);
      const skillCount = skillCounts.get(runId) ?? 0;
      if (!row && skillCount === 0) return [];
      return [[runId, {
        toolCount: row?.tool_count ?? 0,
        errorCount: row?.error_count ?? 0,
        skillCount,
      }]];
    }));
  }

  detail(runId: string): ExecutionTool[] {
    return this.db.prepare(`
      SELECT * FROM rc_execution_tools WHERE run_id = ?
      ORDER BY started_at ASC, id ASC
    `).all(runId) as ExecutionTool[];
  }

  skillDetail(runId: string): ExecutionSkill[] {
    return this.db.prepare(`
      SELECT * FROM rc_execution_skills WHERE run_id = ?
      ORDER BY first_used_at ASC, id ASC
    `).all(runId) as ExecutionSkill[];
  }
}

/**
 * Monitor Module — Comprehensive Tests
 *
 * Covers MonitorService (service.ts), RPC layer (rpc.ts), and Agent tools (tools.ts).
 *
 * Core coverage:
 *   - report() fingerprint dedup + FIFO eviction
 *   - getContext() return structure
 *   - updateNote() 4KB limit
 *   - create() default prompt generation
 *   - seedDefaults() idempotency
 *   - CRUD: create, get, list, update, delete, toggle
 *   - RPC: parameter validation for all 12 methods
 *   - Tools: output format for all 5 tools
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type BetterSqlite3 from 'better-sqlite3';

import { createTestDb } from './setup.js';
import { MonitorService, type MonitorMemory } from '../monitor/service.js';
import { registerMonitorRpc } from '../monitor/rpc.js';
import { createMonitorTools } from '../monitor/tools.js';

// ── Helpers ──────────────────────────────────────────────────────────────

function makeInput(overrides: Partial<Parameters<MonitorService['create']>[0]> = {}) {
  return {
    name: 'Test Monitor',
    source_type: 'academic',
    target: 'https://example.com',
    filters: { keywords: ['test'] },
    schedule: '0 8 * * *',
    ...overrides,
  };
}

/** Read raw memory JSON from DB for assertions that bypass service parsing. */
function rawMemory(db: BetterSqlite3.Database, id: string): MonitorMemory {
  const row = db.prepare('SELECT memory FROM rc_monitors WHERE id = ?').get(id) as { memory: string } | undefined;
  return JSON.parse(row!.memory) as MonitorMemory;
}

// ══════════════════════════════════════════════════════════════════════════
// MonitorService — Unit Tests
// ══════════════════════════════════════════════════════════════════════════

describe('MonitorService', () => {
  let db: BetterSqlite3.Database;
  let svc: MonitorService;

  beforeEach(() => {
    db = createTestDb();
    svc = new MonitorService(db);
  });

  afterEach(() => {
    db.close();
  });

  // ── seedDefaults ─────────────────────────────────────────────────────

  describe('seedDefaults()', () => {
    it('seeds 9 default monitors on empty table', () => {
      svc.seedDefaults();
      const { items, total } = svc.list();
      expect(total).toBe(9);
      const ids = items.map((m) => m.id).sort();
      expect(ids).toEqual([
        'academic-daily',
        'code-releases',
        'code-trending',
        'conference-deadlines',
        'daily-reminder',
        'feed-monitor',
        'tech-news',
        'web-watch',
        'weekly-report',
      ]);
    });

    it('all seeds are disabled by default', () => {
      svc.seedDefaults();
      const { items } = svc.list();
      for (const m of items) {
        expect(m.enabled).toBe(false);
      }
    });

    it('is idempotent — calling twice does not duplicate rows', () => {
      svc.seedDefaults();
      svc.seedDefaults();
      expect(svc.list().total).toBe(9);
    });

    it('does not re-seed when any monitor exists (partial delete)', () => {
      svc.seedDefaults();
      svc.delete('academic-daily');
      expect(svc.list().total).toBe(8);

      // Re-seed should be a no-op because table is not empty
      svc.seedDefaults();
      expect(svc.list().total).toBe(8);
    });

    it('re-seeds if ALL monitors are deleted (table empty)', () => {
      svc.seedDefaults();
      const { items } = svc.list();
      for (const m of items) {
        svc.delete(m.id);
      }
      expect(svc.list().total).toBe(0);

      svc.seedDefaults();
      expect(svc.list().total).toBe(9);
    });

    it('seeds contain well-known source_types', () => {
      svc.seedDefaults();
      const types = new Set(svc.list().items.map((m) => m.source_type));
      expect(types).toContain('academic');
      expect(types).toContain('code');
      expect(types).toContain('feed');
      expect(types).toContain('web');
      expect(types).toContain('report');
      expect(types).toContain('reminder');
    });

    it('weekly-report and daily-reminder have custom agent_prompt', () => {
      svc.seedDefaults();
      const weekly = svc.get('weekly-report');
      const daily = svc.get('daily-reminder');
      expect(weekly.agent_prompt).toContain('weekly research progress');
      expect(daily.agent_prompt).toContain('task_list');
    });

    it('other seeds get auto-generated defaultAgentPrompt', () => {
      svc.seedDefaults();
      const academic = svc.get('academic-daily');
      expect(academic.agent_prompt).toContain('EXECUTION PROTOCOL');
      expect(academic.agent_prompt).toContain('monitor_get_context');
      expect(academic.agent_prompt).toContain('monitor_report');
    });
  });

  // ── create() ──────────────────────────────────────────────────────────

  describe('create()', () => {
    it('creates a monitor with all fields', () => {
      const m = svc.create(makeInput());
      expect(m.name).toBe('Test Monitor');
      expect(m.source_type).toBe('academic');
      expect(m.target).toBe('https://example.com');
      expect(m.filters).toEqual({ keywords: ['test'] });
      expect(m.schedule).toBe('0 8 * * *');
      expect(m.enabled).toBe(false);
      expect(m.notify).toBe(true);
      expect(m.id).toBeTruthy();
      expect(m.check_count).toBe(0);
      expect(m.finding_count).toBe(0);
      expect(m.gateway_job_id).toBeNull();
      expect(m.last_check_at).toBeNull();
      expect(m.last_results).toBeNull();
      expect(m.last_error).toBeNull();
    });

    it('initializes memory with default structure', () => {
      const m = svc.create(makeInput());
      expect(m.memory).toEqual({ v: 1, seen: [], runs: [], notes: '' });
    });

    it('throws on empty name', () => {
      expect(() => svc.create(makeInput({ name: '' }))).toThrow('name is required');
      expect(() => svc.create(makeInput({ name: '   ' }))).toThrow('name is required');
    });

    it('throws on empty source_type', () => {
      expect(() => svc.create(makeInput({ source_type: '' }))).toThrow('source_type is required');
    });

    it('throws on invalid cron expression', () => {
      expect(() => svc.create(makeInput({ schedule: '* *' }))).toThrow('Invalid cron expression');
      expect(() => svc.create(makeInput({ schedule: '1 2 3 4 5 6' }))).toThrow('Invalid cron expression');
    });

    it('accepts valid 5-field cron expressions', () => {
      const m = svc.create(makeInput({ schedule: '30 9 * * 1-5' }));
      expect(m.schedule).toBe('30 9 * * 1-5');
    });

    it('defaults schedule to "0 8 * * *" when not provided', () => {
      const m = svc.create({ name: 'No schedule', source_type: 'feed' });
      expect(m.schedule).toBe('0 8 * * *');
    });

    it('defaults enabled=false and notify=true', () => {
      const m = svc.create({ name: 'Defaults', source_type: 'code' });
      expect(m.enabled).toBe(false);
      expect(m.notify).toBe(true);
    });

    it('allows enabled=false and notify=false', () => {
      const m = svc.create(makeInput({ enabled: false, notify: false }));
      expect(m.enabled).toBe(false);
      expect(m.notify).toBe(false);
    });

    // ── Default prompt generation ──────────────────────────────────

    it('generates academic prompt with routing logic', () => {
      const m = svc.create({ name: 'Acad', source_type: 'academic' });
      expect(m.agent_prompt).toContain('EXECUTION PROTOCOL');
      expect(m.agent_prompt).toContain('search_dblp');
      expect(m.agent_prompt).toContain('search_arxiv');
      expect(m.agent_prompt).toContain('search_pubmed');
      expect(m.agent_prompt).toContain('search_crossref');
      expect(m.agent_prompt).toContain('doi:');
    });

    it('generates code prompt for code source_type', () => {
      const m = svc.create({ name: 'Code', source_type: 'code' });
      expect(m.agent_prompt).toContain('EXECUTION PROTOCOL');
      expect(m.agent_prompt).toContain('repository');
      expect(m.agent_prompt).toContain('gh:');
    });

    it('generates feed prompt for feed source_type', () => {
      const m = svc.create({ name: 'Feed', source_type: 'feed' });
      expect(m.agent_prompt).toContain('RSS/Atom');
      expect(m.agent_prompt).toContain('rss:');
    });

    it('generates web prompt for web source_type', () => {
      const m = svc.create({ name: 'Web', source_type: 'web' });
      expect(m.agent_prompt).toContain('webpage');
      expect(m.agent_prompt).toContain('web:sha256:');
    });

    it('generates social prompt for social source_type', () => {
      const m = svc.create({ name: 'Social', source_type: 'social' });
      expect(m.agent_prompt).toContain('social media');
      expect(m.agent_prompt).toContain('social:');
    });

    it('generates generic prompt for unknown source_type', () => {
      const m = svc.create({ name: 'Custom', source_type: 'my-custom-type' });
      expect(m.agent_prompt).toContain('EXECUTION PROTOCOL');
      expect(m.agent_prompt).toContain('monitoring task');
      expect(m.agent_prompt).toContain('unique fingerprint');
    });

    it('uses user-provided agent_prompt instead of default', () => {
      const m = svc.create(makeInput({ agent_prompt: 'Custom prompt here' }));
      expect(m.agent_prompt).toBe('Custom prompt here');
    });

    it('falls back to default prompt if agent_prompt is whitespace-only', () => {
      const m = svc.create(makeInput({ agent_prompt: '   ' }));
      expect(m.agent_prompt).toContain('EXECUTION PROTOCOL');
    });
  });

  // ── get() ──────────────────────────────────────────────────────────

  describe('get()', () => {
    it('returns monitor by id', () => {
      const created = svc.create(makeInput());
      const fetched = svc.get(created.id);
      expect(fetched.id).toBe(created.id);
      expect(fetched.name).toBe('Test Monitor');
    });

    it('throws for non-existent id', () => {
      expect(() => svc.get('nonexistent')).toThrow('Monitor not found: nonexistent');
    });
  });

  // ── list() ────────────────────────────────────────────────────────

  describe('list()', () => {
    it('returns empty list on empty table', () => {
      const { items, total } = svc.list();
      expect(items).toHaveLength(0);
      expect(total).toBe(0);
    });

    it('returns all monitors', () => {
      svc.create(makeInput({ name: 'A' }));
      svc.create(makeInput({ name: 'B' }));
      const { items, total } = svc.list();
      expect(total).toBe(2);
      expect(items).toHaveLength(2);
    });

    it('filters by enabled', () => {
      svc.create(makeInput({ name: 'Enabled', enabled: true }));
      svc.create(makeInput({ name: 'Disabled', enabled: false }));

      expect(svc.list({ enabled: true }).total).toBe(1);
      expect(svc.list({ enabled: true }).items[0].name).toBe('Enabled');
      expect(svc.list({ enabled: false }).total).toBe(1);
      expect(svc.list({ enabled: false }).items[0].name).toBe('Disabled');
    });

    it('filters by source_type', () => {
      svc.create(makeInput({ name: 'Acad', source_type: 'academic' }));
      svc.create(makeInput({ name: 'Code', source_type: 'code' }));

      const result = svc.list({ source_type: 'academic' });
      expect(result.total).toBe(1);
      expect(result.items[0].name).toBe('Acad');
    });

    it('combines enabled + source_type filters', () => {
      svc.create(makeInput({ name: 'A-on', source_type: 'academic', enabled: true }));
      svc.create(makeInput({ name: 'A-off', source_type: 'academic', enabled: false }));
      svc.create(makeInput({ name: 'C-on', source_type: 'code', enabled: true }));

      const result = svc.list({ enabled: true, source_type: 'academic' });
      expect(result.total).toBe(1);
      expect(result.items[0].name).toBe('A-on');
    });

    it('supports limit and offset', () => {
      for (let i = 0; i < 5; i++) {
        svc.create(makeInput({ name: `Monitor ${i}` }));
      }
      const page = svc.list({ limit: 2, offset: 2 });
      expect(page.total).toBe(5);
      expect(page.items).toHaveLength(2);
    });

    it('caps limit at 100', () => {
      // Create 1 monitor, request limit=200
      svc.create(makeInput());
      const { items } = svc.list({ limit: 200 });
      // Just verify it doesn't crash; limit capped internally
      expect(items).toHaveLength(1);
    });
  });

  // ── update() ──────────────────────────────────────────────────────

  describe('update()', () => {
    it('updates name', () => {
      const m = svc.create(makeInput());
      const updated = svc.update(m.id, { name: 'New Name' });
      expect(updated.name).toBe('New Name');
    });

    it('updates multiple fields at once', () => {
      const m = svc.create(makeInput());
      const updated = svc.update(m.id, {
        name: 'Updated',
        source_type: 'code',
        schedule: '0 9 * * 1',
        enabled: false,
        notify: false,
      });
      expect(updated.name).toBe('Updated');
      expect(updated.source_type).toBe('code');
      expect(updated.schedule).toBe('0 9 * * 1');
      expect(updated.enabled).toBe(false);
      expect(updated.notify).toBe(false);
    });

    it('returns unchanged monitor on empty patch', () => {
      const m = svc.create(makeInput());
      const unchanged = svc.update(m.id, {});
      expect(unchanged.name).toBe(m.name);
    });

    it('throws on non-existent id', () => {
      expect(() => svc.update('no-such-id', { name: 'X' })).toThrow('Monitor not found');
    });

    it('throws on invalid cron in patch', () => {
      const m = svc.create(makeInput());
      expect(() => svc.update(m.id, { schedule: 'bad' })).toThrow('Invalid cron expression');
    });

    it('updates target', () => {
      const m = svc.create(makeInput());
      const updated = svc.update(m.id, { target: 'https://new-target.com' });
      expect(updated.target).toBe('https://new-target.com');
    });

    it('updates filters', () => {
      const m = svc.create(makeInput());
      const updated = svc.update(m.id, { filters: { keywords: ['new'], authors: ['Smith'] } });
      expect(updated.filters).toEqual({ keywords: ['new'], authors: ['Smith'] });
    });

    it('updates agent_prompt', () => {
      const m = svc.create(makeInput());
      const updated = svc.update(m.id, { agent_prompt: 'New custom prompt' });
      expect(updated.agent_prompt).toBe('New custom prompt');
    });

    it('sets updated_at on change', () => {
      const m = svc.create(makeInput());
      const updated = svc.update(m.id, { name: 'Changed' });
      // updated_at should differ from created_at or at least be set
      expect(updated.updated_at).toBeTruthy();
    });
  });

  // ── delete() ──────────────────────────────────────────────────────

  describe('delete()', () => {
    it('deletes a monitor and returns metadata', () => {
      const m = svc.create(makeInput());
      const result = svc.delete(m.id);
      expect(result.ok).toBe(true);
      expect(result.deleted).toBe(m.id);
      expect(result.gateway_job_id).toBeNull();
    });

    it('returns gateway_job_id for cleanup', () => {
      const m = svc.create(makeInput());
      svc.setGatewayJobId(m.id, 'gw-job-123');
      const result = svc.delete(m.id);
      expect(result.gateway_job_id).toBe('gw-job-123');
    });

    it('monitor is gone after delete', () => {
      const m = svc.create(makeInput());
      svc.delete(m.id);
      expect(() => svc.get(m.id)).toThrow('Monitor not found');
    });

    it('throws on non-existent id', () => {
      expect(() => svc.delete('gone')).toThrow('Monitor not found');
    });
  });

  // ── toggle() ──────────────────────────────────────────────────────

  describe('toggle()', () => {
    it('enables a disabled monitor', () => {
      const m = svc.create(makeInput({ enabled: false }));
      const toggled = svc.toggle(m.id, true);
      expect(toggled.enabled).toBe(true);
    });

    it('disables an enabled monitor', () => {
      const m = svc.create(makeInput({ enabled: true }));
      const toggled = svc.toggle(m.id, false);
      expect(toggled.enabled).toBe(false);
    });

    it('throws on non-existent id', () => {
      expect(() => svc.toggle('nope', true)).toThrow('Monitor not found');
    });
  });

  // ── setGatewayJobId() ─────────────────────────────────────────────

  describe('setGatewayJobId()', () => {
    it('persists the gateway job id', () => {
      const m = svc.create(makeInput());
      svc.setGatewayJobId(m.id, 'job-abc');
      expect(svc.get(m.id).gateway_job_id).toBe('job-abc');
    });

    it('clears the gateway job id with null', () => {
      const m = svc.create(makeInput());
      svc.setGatewayJobId(m.id, 'job-abc');
      svc.setGatewayJobId(m.id, null);
      expect(svc.get(m.id).gateway_job_id).toBeNull();
    });
  });

  // ── report() — fingerprint dedup + FIFO ──────────────────────────

  describe('report()', () => {
    it('stores results and fingerprints', () => {
      const m = svc.create(makeInput());
      const results = [{ title: 'Paper A' }, { title: 'Paper B' }];
      const fps = ['doi:10.1/a', 'doi:10.1/b'];

      const updated = svc.report(m.id, results, fps);
      expect(updated.last_results).toEqual(results);
      expect(updated.check_count).toBe(1);
      expect(updated.finding_count).toBe(2); // 2 new fingerprints
      expect(updated.memory.seen).toEqual(['doi:10.1/a', 'doi:10.1/b']);
    });

    it('records a run entry', () => {
      const m = svc.create(makeInput());
      const updated = svc.report(m.id, [{ title: 'X' }], ['fp:1']);
      expect(updated.memory.runs).toHaveLength(1);
      expect(updated.memory.runs[0].found).toBe(1);
      expect(updated.memory.runs[0].new_count).toBe(1);
      expect(updated.memory.runs[0].sources).toEqual(['fp']);
      expect(updated.memory.runs[0].at).toBeTruthy();
    });

    it('deduplicates repeated fingerprints within same call', () => {
      const m = svc.create(makeInput());
      const updated = svc.report(m.id, [{ a: 1 }, { a: 2 }], ['fp:dup', 'fp:dup', 'fp:dup']);
      expect(updated.memory.seen).toEqual(['fp:dup']);
      expect(updated.memory.runs[0].new_count).toBe(1);
    });

    it('deduplicates against previously seen fingerprints', () => {
      const m = svc.create(makeInput());

      // First report: 2 new
      svc.report(m.id, [{ a: 1 }, { a: 2 }], ['doi:old-1', 'doi:old-2']);

      // Second report: 1 old + 1 new
      const updated = svc.report(m.id, [{ a: 3 }, { a: 4 }], ['doi:old-1', 'doi:new-1']);
      expect(updated.memory.runs[1].new_count).toBe(1);
      expect(updated.memory.seen).toContain('doi:old-1');
      expect(updated.memory.seen).toContain('doi:old-2');
      expect(updated.memory.seen).toContain('doi:new-1');
    });

    it('finding_count accumulates only new fingerprints', () => {
      const m = svc.create(makeInput());

      svc.report(m.id, [{ a: 1 }], ['fp:1', 'fp:2']);       // +2 new
      const updated = svc.report(m.id, [{ a: 1 }], ['fp:2', 'fp:3']); // +1 new (fp:2 seen)
      expect(updated.finding_count).toBe(3); // 2 + 1
    });

    it('FIFO eviction: caps seen at 2000, oldest removed first', () => {
      const m = svc.create(makeInput());

      // Fill exactly 2000 fingerprints
      const batch1 = Array.from({ length: 2000 }, (_, i) => `fp:batch1-${i}`);
      svc.report(m.id, [], batch1);

      const mem1 = rawMemory(db, m.id);
      expect(mem1.seen).toHaveLength(2000);
      expect(mem1.seen[0]).toBe('fp:batch1-0');
      expect(mem1.seen[1999]).toBe('fp:batch1-1999');

      // Add 100 more — oldest 100 should be evicted
      const batch2 = Array.from({ length: 100 }, (_, i) => `fp:batch2-${i}`);
      svc.report(m.id, [], batch2);

      const mem2 = rawMemory(db, m.id);
      expect(mem2.seen).toHaveLength(2000);
      // Oldest 100 from batch1 (0..99) should be gone
      expect(mem2.seen[0]).toBe('fp:batch1-100');
      // Newest from batch2 should be at the end
      expect(mem2.seen[1999]).toBe('fp:batch2-99');
      expect(mem2.seen[1900]).toBe('fp:batch2-0');
    });

    it('FIFO eviction does not remove still-new fingerprints', () => {
      const m = svc.create(makeInput());

      // Pre-fill 1999 items
      const prefill = Array.from({ length: 1999 }, (_, i) => `old:${i}`);
      svc.report(m.id, [], prefill);

      // Add 5 new — total 2004, should cap to 2000, evicting oldest 4
      const newFps = ['new:a', 'new:b', 'new:c', 'new:d', 'new:e'];
      svc.report(m.id, [], newFps);

      const mem = rawMemory(db, m.id);
      expect(mem.seen).toHaveLength(2000);
      // All 5 new fingerprints should be present (at end)
      for (const fp of newFps) {
        expect(mem.seen).toContain(fp);
      }
      // Oldest 4 from prefill should be gone
      expect(mem.seen).not.toContain('old:0');
      expect(mem.seen).not.toContain('old:3');
      expect(mem.seen).toContain('old:4'); // this one survived
    });

    it('runs history caps at 30 entries', () => {
      const m = svc.create(makeInput());

      // Make 35 reports
      for (let i = 0; i < 35; i++) {
        svc.report(m.id, [], [`fp:run-${i}`]);
      }

      const mem = rawMemory(db, m.id);
      expect(mem.runs).toHaveLength(30);
      // Oldest 5 runs should be evicted
      // The first surviving run should be the 6th report (index 5)
    });

    it('extracts unique sources from fingerprint prefixes', () => {
      const m = svc.create(makeInput());
      const fps = ['doi:10.1/a', 'doi:10.1/b', 'arxiv:2603.123', 'gh:org/repo:v1'];
      const updated = svc.report(m.id, [{}, {}, {}, {}], fps);
      const sources = updated.memory.runs[0].sources;
      expect(sources).toContain('doi');
      expect(sources).toContain('arxiv');
      expect(sources).toContain('gh');
      expect(sources).toHaveLength(3);
    });

    it('handles empty results and fingerprints', () => {
      const m = svc.create(makeInput());
      const updated = svc.report(m.id, [], []);
      expect(updated.check_count).toBe(1);
      expect(updated.finding_count).toBe(0);
      expect(updated.memory.runs[0].found).toBe(0);
      expect(updated.memory.runs[0].new_count).toBe(0);
    });

    it('throws for non-existent monitor', () => {
      expect(() => svc.report('no-id', [], [])).toThrow('Monitor not found');
    });

    it('clears last_error on successful report', () => {
      const m = svc.create(makeInput());
      svc.reportError(m.id, 'API down');
      expect(svc.get(m.id).last_error).toBe('API down');

      // Successful report should clear last_error
      const updated = svc.report(m.id, [{ title: 'OK' }], ['fp:ok']);
      expect(updated.last_error).toBeNull();
    });

    it('check_count accumulates across report and reportError', () => {
      const m = svc.create(makeInput());
      svc.report(m.id, [], ['fp:1']);       // check 1
      svc.reportError(m.id, 'fail');         // check 2
      svc.report(m.id, [], ['fp:2']);        // check 3
      expect(svc.get(m.id).check_count).toBe(3);
    });
  });

  // ── reportError() ────────────────────────────────────────────────

  describe('reportError()', () => {
    it('records error and increments check_count', () => {
      const m = svc.create(makeInput());
      svc.reportError(m.id, 'Network timeout');
      const updated = svc.get(m.id);
      expect(updated.last_error).toBe('Network timeout');
      expect(updated.check_count).toBe(1);
      expect(updated.last_check_at).toBeTruthy();
    });

    it('overwrites previous error', () => {
      const m = svc.create(makeInput());
      svc.reportError(m.id, 'Error 1');
      svc.reportError(m.id, 'Error 2');
      expect(svc.get(m.id).last_error).toBe('Error 2');
      expect(svc.get(m.id).check_count).toBe(2);
    });

    it('does not alter memory', () => {
      const m = svc.create(makeInput());
      svc.report(m.id, [{ a: 1 }], ['fp:1']);
      svc.reportError(m.id, 'Error');

      const mem = rawMemory(db, m.id);
      expect(mem.seen).toEqual(['fp:1']);
      expect(mem.runs).toHaveLength(1);
      expect(mem.notes).toBe('');
    });
  });

  // ── getContext() ──────────────────────────────────────────────────

  describe('getContext()', () => {
    it('returns config, memory, and agent_prompt', () => {
      const m = svc.create(makeInput({ name: 'Ctx Test' }));
      const ctx = svc.getContext(m.id);

      // config shape
      expect(ctx.config).toEqual({
        id: m.id,
        name: 'Ctx Test',
        source_type: 'academic',
        target: 'https://example.com',
        filters: { keywords: ['test'] },
        schedule: '0 8 * * *',
        notify: true,
      });

      // memory shape
      expect(ctx.memory).toEqual({
        notes: '',
        last_run: null,
        seen_count: 0,
      });

      // agent_prompt
      expect(ctx.agent_prompt).toContain('EXECUTION PROTOCOL');
    });

    it('config does NOT include enabled, gateway_job_id, or stats', () => {
      const m = svc.create(makeInput());
      const ctx = svc.getContext(m.id);
      expect(ctx.config).not.toHaveProperty('enabled');
      expect(ctx.config).not.toHaveProperty('gateway_job_id');
      expect(ctx.config).not.toHaveProperty('check_count');
      expect(ctx.config).not.toHaveProperty('finding_count');
    });

    it('memory.last_run reflects most recent run', () => {
      const m = svc.create(makeInput());
      svc.report(m.id, [{ a: 1 }], ['fp:1']);
      svc.report(m.id, [{ a: 2 }, { a: 3 }], ['fp:2', 'fp:3']);

      const ctx = svc.getContext(m.id);
      expect(ctx.memory.last_run).not.toBeNull();
      expect(ctx.memory.last_run!.found).toBe(2);
      expect(ctx.memory.last_run!.new_count).toBe(2);
      expect(ctx.memory.seen_count).toBe(3);
    });

    it('memory.notes reflects updated note', () => {
      const m = svc.create(makeInput());
      svc.updateNote(m.id, 'Source is flaky on weekends');
      const ctx = svc.getContext(m.id);
      expect(ctx.memory.notes).toBe('Source is flaky on weekends');
    });

    it('throws for non-existent id', () => {
      expect(() => svc.getContext('missing')).toThrow('Monitor not found');
    });
  });

  // ── updateNote() ──────────────────────────────────────────────────

  describe('updateNote()', () => {
    it('persists the note in memory', () => {
      const m = svc.create(makeInput());
      const updated = svc.updateNote(m.id, 'Important observation');
      expect(updated.memory.notes).toBe('Important observation');

      // Verify via raw DB
      const mem = rawMemory(db, m.id);
      expect(mem.notes).toBe('Important observation');
    });

    it('replaces previous note', () => {
      const m = svc.create(makeInput());
      svc.updateNote(m.id, 'Note v1');
      const updated = svc.updateNote(m.id, 'Note v2');
      expect(updated.memory.notes).toBe('Note v2');
    });

    it('preserves existing seen/runs when updating note', () => {
      const m = svc.create(makeInput());
      svc.report(m.id, [{ a: 1 }], ['fp:1']);
      svc.updateNote(m.id, 'Observation');

      const mem = rawMemory(db, m.id);
      expect(mem.seen).toEqual(['fp:1']);
      expect(mem.runs).toHaveLength(1);
      expect(mem.notes).toBe('Observation');
    });

    it('throws when note exceeds 4096 characters', () => {
      const m = svc.create(makeInput());
      const longNote = 'x'.repeat(4097);
      expect(() => svc.updateNote(m.id, longNote)).toThrow('Note must be <= 4096 characters');
    });

    it('accepts note at exactly 4096 characters', () => {
      const m = svc.create(makeInput());
      const exactNote = 'x'.repeat(4096);
      const updated = svc.updateNote(m.id, exactNote);
      expect(updated.memory.notes).toHaveLength(4096);
    });

    it('throws for non-existent id', () => {
      expect(() => svc.updateNote('nope', 'note')).toThrow('Monitor not found');
    });
  });

  // ── Malformed JSON resilience ───────────────────────────────────────

  describe('malformed JSON resilience', () => {
    it('parseMemory recovers from malformed memory JSON', () => {
      const m = svc.create(makeInput());
      // Corrupt memory column directly in DB
      db.prepare('UPDATE rc_monitors SET memory = ? WHERE id = ?').run('NOT JSON', m.id);

      const fetched = svc.get(m.id);
      expect(fetched.memory).toEqual({ v: 1, seen: [], runs: [], notes: '' });
    });

    it('parseMemory recovers from empty string memory', () => {
      const m = svc.create(makeInput());
      db.prepare('UPDATE rc_monitors SET memory = ? WHERE id = ?').run('', m.id);

      const fetched = svc.get(m.id);
      expect(fetched.memory).toEqual({ v: 1, seen: [], runs: [], notes: '' });
    });

    it('parseMemory recovers from wrong version', () => {
      const m = svc.create(makeInput());
      db.prepare('UPDATE rc_monitors SET memory = ? WHERE id = ?').run(
        JSON.stringify({ v: 99, seen: 'not-array', runs: [] }),
        m.id,
      );

      const fetched = svc.get(m.id);
      expect(fetched.memory).toEqual({ v: 1, seen: [], runs: [], notes: '' });
    });

    it('rowToMonitor recovers from malformed filters JSON', () => {
      const m = svc.create(makeInput());
      db.prepare('UPDATE rc_monitors SET filters = ? WHERE id = ?').run('BROKEN', m.id);

      const fetched = svc.get(m.id);
      expect(fetched.filters).toEqual({});
    });

    it('rowToMonitor recovers from malformed last_results JSON', () => {
      const m = svc.create(makeInput());
      db.prepare('UPDATE rc_monitors SET last_results = ? WHERE id = ?').run('BROKEN', m.id);

      const fetched = svc.get(m.id);
      expect(fetched.last_results).toBeNull();
    });
  });

  // ── listEnabled() ─────────────────────────────────────────────────

  describe('listEnabled()', () => {
    it('returns only enabled monitors', () => {
      svc.create(makeInput({ name: 'On', enabled: true }));
      svc.create(makeInput({ name: 'Off', enabled: false }));
      const enabled = svc.listEnabled();
      expect(enabled).toHaveLength(1);
      expect(enabled[0].name).toBe('On');
    });

    it('returns empty array when none enabled', () => {
      svc.create(makeInput({ enabled: false }));
      expect(svc.listEnabled()).toHaveLength(0);
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Monitor RPC — Integration Tests
// ══════════════════════════════════════════════════════════════════════════

describe('Monitor RPC', () => {
  let db: BetterSqlite3.Database;
  let svc: MonitorService;
  const handlers = new Map<string, (params: Record<string, unknown>) => Promise<unknown> | unknown>();

  beforeEach(() => {
    db = createTestDb();
    svc = new MonitorService(db);
    handlers.clear();

    const registerMethod = (method: string, handler: (params: Record<string, unknown>) => Promise<unknown> | unknown) => {
      handlers.set(method, handler);
    };
    registerMonitorRpc(registerMethod, svc);
  });

  afterEach(() => {
    db.close();
  });

  async function call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const handler = handlers.get(method);
    if (!handler) throw new Error(`No handler for ${method}`);
    return await handler(params);
  }

  it('registers all 12 RPC methods', () => {
    expect(handlers.size).toBe(12);
    const expected = [
      'rc.monitor.list', 'rc.monitor.get', 'rc.monitor.create', 'rc.monitor.update',
      'rc.monitor.delete', 'rc.monitor.toggle', 'rc.monitor.run', 'rc.monitor.history',
      'rc.monitor.report', 'rc.monitor.setJobId', 'rc.monitor.getContext', 'rc.monitor.updateNote',
    ];
    for (const m of expected) {
      expect(handlers.has(m)).toBe(true);
    }
  });

  // ── rc.monitor.create ─────────────────────────────────────────────

  describe('rc.monitor.create', () => {
    it('creates a monitor via RPC', async () => {
      const result = await call('rc.monitor.create', { name: 'RPC Test', source_type: 'feed' }) as any;
      expect(result.id).toBeTruthy();
      expect(result.name).toBe('RPC Test');
    });

    it('rejects missing name', async () => {
      await expect(call('rc.monitor.create', { source_type: 'feed' }))
        .rejects.toThrow('name is required');
    });

    it('rejects missing source_type', async () => {
      await expect(call('rc.monitor.create', { name: 'X' }))
        .rejects.toThrow('source_type is required');
    });
  });

  // ── rc.monitor.get ────────────────────────────────────────────────

  describe('rc.monitor.get', () => {
    it('returns a monitor by id', async () => {
      const created = svc.create(makeInput());
      const result = await call('rc.monitor.get', { id: created.id }) as any;
      expect(result.id).toBe(created.id);
    });

    it('rejects missing id', async () => {
      await expect(call('rc.monitor.get', {})).rejects.toThrow('id is required');
    });
  });

  // ── rc.monitor.list ───────────────────────────────────────────────

  describe('rc.monitor.list', () => {
    it('lists monitors with optional filters', async () => {
      svc.create(makeInput({ name: 'A', source_type: 'academic' }));
      svc.create(makeInput({ name: 'B', source_type: 'code' }));

      const all = await call('rc.monitor.list', {}) as any;
      expect(all.total).toBe(2);

      const filtered = await call('rc.monitor.list', { source_type: 'code' }) as any;
      expect(filtered.total).toBe(1);
    });

    it('rejects invalid limit type', async () => {
      await expect(call('rc.monitor.list', { limit: 'bad' }))
        .rejects.toThrow('limit must be a number');
    });

    it('rejects limit below minimum', async () => {
      await expect(call('rc.monitor.list', { limit: 0 }))
        .rejects.toThrow('limit must be >= 1');
    });

    it('rejects limit above maximum', async () => {
      await expect(call('rc.monitor.list', { limit: 101 }))
        .rejects.toThrow('limit must be <= 100');
    });

    it('rejects non-boolean enabled', async () => {
      await expect(call('rc.monitor.list', { enabled: 'yes' }))
        .rejects.toThrow('enabled must be a boolean');
    });
  });

  // ── rc.monitor.update ─────────────────────────────────────────────

  describe('rc.monitor.update', () => {
    it('updates fields', async () => {
      const m = svc.create(makeInput());
      const result = await call('rc.monitor.update', { id: m.id, name: 'Updated' }) as any;
      expect(result.name).toBe('Updated');
    });

    it('rejects missing id', async () => {
      await expect(call('rc.monitor.update', { name: 'X' })).rejects.toThrow('id is required');
    });

    it('rejects array for filters (must be object)', async () => {
      const m = svc.create(makeInput());
      await expect(call('rc.monitor.update', { id: m.id, filters: [1, 2] }))
        .rejects.toThrow('filters must be an object');
    });
  });

  // ── rc.monitor.delete ─────────────────────────────────────────────

  describe('rc.monitor.delete', () => {
    it('deletes and returns metadata', async () => {
      const m = svc.create(makeInput());
      const result = await call('rc.monitor.delete', { id: m.id }) as any;
      expect(result.ok).toBe(true);
      expect(result.deleted).toBe(m.id);
    });
  });

  // ── rc.monitor.toggle ─────────────────────────────────────────────

  describe('rc.monitor.toggle', () => {
    it('toggles enabled state', async () => {
      const m = svc.create(makeInput({ enabled: true }));
      const result = await call('rc.monitor.toggle', { id: m.id, enabled: false }) as any;
      expect(result.enabled).toBe(false);
    });

    it('rejects non-boolean enabled', async () => {
      const m = svc.create(makeInput());
      await expect(call('rc.monitor.toggle', { id: m.id, enabled: 'yes' }))
        .rejects.toThrow('enabled is required and must be a boolean');
    });
  });

  // ── rc.monitor.run ────────────────────────────────────────────────

  describe('rc.monitor.run', () => {
    it('returns gateway_job_id when set', async () => {
      const m = svc.create(makeInput());
      svc.setGatewayJobId(m.id, 'gw-123');
      const result = await call('rc.monitor.run', { id: m.id }) as any;
      expect(result.ok).toBe(true);
      expect(result.gateway_job_id).toBe('gw-123');
    });

    it('throws when no gateway_job_id', async () => {
      const m = svc.create(makeInput());
      await expect(call('rc.monitor.run', { id: m.id }))
        .rejects.toThrow('Monitor has no gateway job registered');
    });
  });

  // ── rc.monitor.history ────────────────────────────────────────────

  describe('rc.monitor.history', () => {
    it('returns all metadata fields', async () => {
      const m = svc.create(makeInput());
      svc.setGatewayJobId(m.id, 'gw-hist');
      svc.report(m.id, [{ x: 1 }], ['fp:1']);
      const result = await call('rc.monitor.history', { id: m.id }) as any;
      expect(result.monitor_id).toBe(m.id);
      expect(result.gateway_job_id).toBe('gw-hist');
      expect(result.last_check_at).toBeTruthy();
      expect(result.last_error).toBeNull();
      expect(result.check_count).toBe(1);
      expect(result.finding_count).toBe(1);
    });

    it('reflects last_error when set', async () => {
      const m = svc.create(makeInput());
      svc.reportError(m.id, 'timeout');
      const result = await call('rc.monitor.history', { id: m.id }) as any;
      expect(result.last_error).toBe('timeout');
    });
  });

  // ── rc.monitor.report ─────────────────────────────────────────────

  describe('rc.monitor.report', () => {
    it('persists results via RPC', async () => {
      const m = svc.create(makeInput());
      const result = await call('rc.monitor.report', {
        id: m.id,
        results: [{ title: 'Paper' }],
        fingerprints: ['doi:10.1/x'],
      }) as any;
      expect(result.check_count).toBe(1);
    });

    it('rejects non-array results', async () => {
      const m = svc.create(makeInput());
      await expect(call('rc.monitor.report', { id: m.id, results: 'not-array', fingerprints: [] }))
        .rejects.toThrow('results must be an array');
    });

    it('coerces non-string fingerprints to strings', async () => {
      const m = svc.create(makeInput());
      const result = await call('rc.monitor.report', {
        id: m.id,
        results: [{ a: 1 }],
        fingerprints: [123, true],
      }) as any;
      // Should not throw — fingerprints are mapped through String()
      expect(result.memory.seen).toContain('123');
      expect(result.memory.seen).toContain('true');
    });

    it('defaults fingerprints to empty array when missing', async () => {
      const m = svc.create(makeInput());
      const result = await call('rc.monitor.report', {
        id: m.id,
        results: [{ a: 1 }],
      }) as any;
      expect(result.check_count).toBe(1);
      expect(result.memory.seen).toHaveLength(0);
    });
  });

  // ── rc.monitor.setJobId ───────────────────────────────────────────

  describe('rc.monitor.setJobId', () => {
    it('sets job id', async () => {
      const m = svc.create(makeInput());
      await call('rc.monitor.setJobId', { id: m.id, job_id: 'job-xyz' });
      expect(svc.get(m.id).gateway_job_id).toBe('job-xyz');
    });

    it('clears job id with empty string', async () => {
      const m = svc.create(makeInput());
      svc.setGatewayJobId(m.id, 'job-abc');
      await call('rc.monitor.setJobId', { id: m.id, job_id: '' });
      expect(svc.get(m.id).gateway_job_id).toBeNull();
    });

    it('clears job id with null', async () => {
      const m = svc.create(makeInput());
      svc.setGatewayJobId(m.id, 'job-abc');
      await call('rc.monitor.setJobId', { id: m.id, job_id: null });
      expect(svc.get(m.id).gateway_job_id).toBeNull();
    });

    it('clears job id with whitespace-only string', async () => {
      const m = svc.create(makeInput());
      svc.setGatewayJobId(m.id, 'job-abc');
      await call('rc.monitor.setJobId', { id: m.id, job_id: '   ' });
      expect(svc.get(m.id).gateway_job_id).toBeNull();
    });
  });

  // ── rc.monitor.getContext ─────────────────────────────────────────

  describe('rc.monitor.getContext', () => {
    it('returns context structure', async () => {
      const m = svc.create(makeInput());
      const result = await call('rc.monitor.getContext', { id: m.id }) as any;
      expect(result.config).toBeDefined();
      expect(result.memory).toBeDefined();
      expect(result.agent_prompt).toBeDefined();
    });
  });

  // ── rc.monitor.updateNote ─────────────────────────────────────────

  describe('rc.monitor.updateNote', () => {
    it('updates note via RPC', async () => {
      const m = svc.create(makeInput());
      const result = await call('rc.monitor.updateNote', { id: m.id, note: 'RPC note' }) as any;
      expect(result.memory.notes).toBe('RPC note');
    });

    it('rejects missing note', async () => {
      const m = svc.create(makeInput());
      await expect(call('rc.monitor.updateNote', { id: m.id }))
        .rejects.toThrow('note is required');
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Monitor Agent Tools — Integration Tests
// ══════════════════════════════════════════════════════════════════════════

describe('Monitor Agent Tools', () => {
  let db: BetterSqlite3.Database;
  let svc: MonitorService;
  let tools: ReturnType<typeof createMonitorTools>;

  beforeEach(() => {
    db = createTestDb();
    svc = new MonitorService(db);
    tools = createMonitorTools(svc);
  });

  afterEach(() => {
    db.close();
  });

  function findTool(name: string) {
    const tool = tools.find((t) => t.name === name);
    if (!tool) throw new Error(`Tool not found: ${name}`);
    return tool;
  }

  async function exec(name: string, params: Record<string, unknown>): Promise<any> {
    return findTool(name).execute('test-call-id', params);
  }

  it('creates exactly 5 tools', () => {
    expect(tools).toHaveLength(5);
    expect(tools.map((t) => t.name).sort()).toEqual([
      'monitor_create',
      'monitor_get_context',
      'monitor_list',
      'monitor_note',
      'monitor_report',
    ]);
  });

  it('all tools have name, description, parameters, and execute', () => {
    for (const tool of tools) {
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.parameters).toBeDefined();
      expect(typeof tool.execute).toBe('function');
    }
  });

  // ── monitor_create ────────────────────────────────────────────────

  describe('monitor_create', () => {
    it('returns ok format with monitor details', async () => {
      const result = await exec('monitor_create', {
        name: 'Tool Test',
        source_type: 'code',
        target: 'org/repo',
      });
      expect(result.content[0].type).toBe('text');
      expect(result.content[0].text).toContain('Monitor created');
      expect(result.content[0].text).toContain('Tool Test');
      expect(result.details).toBeDefined();
      expect(result.details.id).toBeTruthy();
      expect(result.details.enabled).toBe(false);
      expect(result.content[0].text).toContain('Status: disabled');
    });

    it('returns error format on empty name', async () => {
      const result = await exec('monitor_create', { name: '', source_type: 'code' });
      expect(result.content[0].text).toContain('Error:');
      expect(result.details.error).toBeTruthy();
    });

    it('returns error format on missing source_type', async () => {
      const result = await exec('monitor_create', { name: 'X', source_type: '' });
      expect(result.content[0].text).toContain('Error:');
    });

    it('passes schedule and notify params', async () => {
      const result = await exec('monitor_create', {
        name: 'Scheduled',
        source_type: 'feed',
        schedule: '30 9 * * 1-5',
        notify: false,
      });
      expect(result.details.schedule).toBe('30 9 * * 1-5');
      expect(result.details.notify).toBe(false);
    });

    it('passes filters as object', async () => {
      const result = await exec('monitor_create', {
        name: 'Filtered',
        source_type: 'academic',
        filters: { keywords: ['protein'], authors: ['LeCun'] },
      });
      expect(result.details.filters).toEqual({ keywords: ['protein'], authors: ['LeCun'] });
    });

    it('ignores non-object filters', async () => {
      const result = await exec('monitor_create', {
        name: 'BadFilter',
        source_type: 'code',
        filters: 'not-an-object',
      });
      // Should still succeed — filters ignored, defaults to {}
      expect(result.content[0].text).toContain('Monitor created');
      expect(result.details.filters).toEqual({});
    });
  });

  // ── monitor_list ──────────────────────────────────────────────────

  describe('monitor_list', () => {
    it('returns message when no monitors', async () => {
      const result = await exec('monitor_list', {});
      expect(result.content[0].text).toContain('No monitors configured');
    });

    it('lists monitors with status', async () => {
      svc.create(makeInput({ name: 'Listed' }));
      const result = await exec('monitor_list', {});
      expect(result.content[0].text).toContain('1 monitor(s)');
      expect(result.content[0].text).toContain('Listed');
      expect(result.details.items).toHaveLength(1);
      expect(result.details.total).toBe(1);
    });

    it('supports source_type filter', async () => {
      svc.create(makeInput({ name: 'A', source_type: 'academic' }));
      svc.create(makeInput({ name: 'B', source_type: 'code' }));
      const result = await exec('monitor_list', { source_type: 'code' });
      expect(result.details.total).toBe(1);
    });

    it('supports enabled filter', async () => {
      svc.create(makeInput({ name: 'On', enabled: true }));
      svc.create(makeInput({ name: 'Off', enabled: false }));
      const result = await exec('monitor_list', { enabled: true });
      expect(result.details.total).toBe(1);
      expect(result.details.items[0].name).toBe('On');
    });
  });

  // ── monitor_report ────────────────────────────────────────────────

  describe('monitor_report', () => {
    it('returns result summary', async () => {
      const m = svc.create(makeInput());
      const result = await exec('monitor_report', {
        monitor_id: m.id,
        results: [{ title: 'A' }],
        fingerprints: ['fp:1'],
      });
      expect(result.content[0].text).toContain('1 finding(s)');
      expect(result.content[0].text).toContain('1 new');
      expect(result.details.check_count).toBe(1);
    });

    it('returns error for empty monitor_id', async () => {
      const result = await exec('monitor_report', {
        monitor_id: '',
        results: [],
        fingerprints: [],
      });
      expect(result.content[0].text).toContain('Error:');
    });

    it('output text includes seen pool count', async () => {
      const m = svc.create(makeInput());
      // Pre-load some fingerprints
      svc.report(m.id, [], ['fp:pre-1', 'fp:pre-2']);

      const result = await exec('monitor_report', {
        monitor_id: m.id,
        results: [{ title: 'New' }],
        fingerprints: ['fp:3'],
      });
      expect(result.content[0].text).toContain('Seen pool: 3 items');
    });

    it('handles non-array results gracefully', async () => {
      const m = svc.create(makeInput());
      // Tool coerces non-array results to []
      const result = await exec('monitor_report', {
        monitor_id: m.id,
        results: 'not-array',
        fingerprints: ['fp:1'],
      });
      expect(result.content[0].text).toContain('0 finding(s)');
    });
  });

  // ── monitor_get_context ───────────────────────────────────────────

  describe('monitor_get_context', () => {
    it('returns context in ok format', async () => {
      const m = svc.create(makeInput({ name: 'Ctx Tool' }));
      const result = await exec('monitor_get_context', { monitor_id: m.id });
      expect(result.content[0].text).toContain('Ctx Tool');
      expect(result.content[0].text).toContain('Seen: 0 items');
      expect(result.details.config).toBeDefined();
      expect(result.details.memory).toBeDefined();
      expect(result.details.agent_prompt).toBeDefined();
    });

    it('returns error for missing monitor_id', async () => {
      const result = await exec('monitor_get_context', { monitor_id: '' });
      expect(result.content[0].text).toContain('Error:');
    });

    it('returns error for non-existent monitor', async () => {
      const result = await exec('monitor_get_context', { monitor_id: 'ghost' });
      expect(result.content[0].text).toContain('Error:');
      expect(result.content[0].text).toContain('Monitor not found');
    });
  });

  // ── monitor_note ──────────────────────────────────────────────────

  describe('monitor_note', () => {
    it('updates and confirms note', async () => {
      const m = svc.create(makeInput());
      const result = await exec('monitor_note', { monitor_id: m.id, note: 'Tool note' });
      expect(result.content[0].text).toContain('Notes updated');
      expect(result.details.notes).toBe('Tool note');
    });

    it('returns error on empty note', async () => {
      const m = svc.create(makeInput());
      const result = await exec('monitor_note', { monitor_id: m.id, note: '' });
      expect(result.content[0].text).toContain('Error:');
    });

    it('returns error on missing monitor_id', async () => {
      const result = await exec('monitor_note', { monitor_id: '', note: 'something' });
      expect(result.content[0].text).toContain('Error:');
    });

    it('returns error when note exceeds 4KB', async () => {
      const m = svc.create(makeInput());
      const result = await exec('monitor_note', { monitor_id: m.id, note: 'x'.repeat(4097) });
      expect(result.content[0].text).toContain('Error:');
      expect(result.content[0].text).toContain('4096');
    });
  });
});

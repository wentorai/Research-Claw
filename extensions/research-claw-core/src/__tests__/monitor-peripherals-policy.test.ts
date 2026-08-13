import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type BetterSqlite3 from 'better-sqlite3';

import { runMigrations } from '../db/migrations.js';
import { MonitorService } from '../monitor/service.js';
import { createMonitorTools } from '../monitor/tools.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as typeof BetterSqlite3;

function insertDeviceMonitor(
  db: BetterSqlite3.Database,
  opts: { id?: string; sourceType?: string; prompt?: string } = {},
): void {
  const id = opts.id ?? 'legacy-device';
  const sourceType = opts.sourceType ?? 'device';
  const prompt = opts.prompt ?? 'OLD_DEVICE_PROMPT periph_camera_snap';
  db.prepare(`
    INSERT INTO rc_monitors (
      id, name, source_type, target, filters, schedule, enabled, notify,
      agent_prompt, gateway_job_id, last_results, memory, created_at, updated_at
    ) VALUES (
      ?, 'Legacy camera', ?, 'camera-id', '{}',
      '*/5 * * * *', 1, 1, ?,
      'cron-device-job', '[{"title":"private frame"}]',
      '{"v":1,"seen":[],"runs":[],"notes":"device history"}',
      datetime('now'), datetime('now')
    )
  `).run(id, sourceType, prompt);
}

describe('MonitorService peripherals policy boundary', () => {
  let db: BetterSqlite3.Database;
  let service: MonitorService;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    service = new MonitorService(db, { peripheralsEnabled: false });
    service.seedDefaults();
    insertDeviceMonitor(db);
  });

  afterEach(() => db.close());

  it('retains device rows byte-for-byte while hiding every read and execution surface', async () => {
    const before = db.prepare("SELECT * FROM rc_monitors WHERE id = 'legacy-device'").get();
    expect(service.list().items.some((item) => item.id === 'legacy-device')).toBe(false);
    expect(service.list({ source_type: 'device' })).toEqual({ items: [], total: 0 });
    expect(service.listEnabled().some((item) => item.id === 'legacy-device')).toBe(false);

    const blocked = [
      () => service.get('legacy-device'),
      () => service.getContext('legacy-device'),
      () => service.report('legacy-device', [{ title: 'changed' }], ['changed']),
      () => service.reportError('legacy-device', 'changed'),
      () => service.collectMonitorCandidates('legacy-device'),
      () => service.updateNote('legacy-device', 'changed'),
      () => service.setGatewayJobId('legacy-device', 'changed'),
      () => service.delete('legacy-device'),
    ];
    for (const call of blocked) {
      await expect(Promise.resolve().then(call)).rejects.toMatchObject({ errorCode: 'FEATURE_UNAVAILABLE' });
    }

    const after = db.prepare("SELECT * FROM rc_monitors WHERE id = 'legacy-device'").get();
    expect(after).toEqual(before);
  });

  it('rejects device create/update/toggle but leaves non-device monitors functional', () => {
    expect(() => service.create({ name: 'Camera', source_type: ' Device ', target: 'camera-id' }))
      .toThrow(expect.objectContaining({ errorCode: 'FEATURE_UNAVAILABLE' }));

    const web = service.create({ name: 'Web', source_type: 'web', target: 'https://example.invalid' });
    expect(() => service.update(web.id, { source_type: 'DEVICE' }))
      .toThrow(expect.objectContaining({ errorCode: 'FEATURE_UNAVAILABLE' }));
    expect(() => service.update('legacy-device', { name: 'mutate hidden row' }))
      .toThrow(expect.objectContaining({ errorCode: 'FEATURE_UNAVAILABLE' }));
    expect(() => service.toggle('legacy-device', true))
      .toThrow(expect.objectContaining({ errorCode: 'FEATURE_UNAVAILABLE' }));
    expect(() => service.toggle('legacy-device', false))
      .toThrow(expect.objectContaining({ errorCode: 'FEATURE_UNAVAILABLE' }));

    expect(service.toggle(web.id, true).enabled).toBe(true);
    expect(service.update(web.id, { name: 'Web updated' }).name).toBe('Web updated');
    expect(service.update(web.id, { source_type: '\tweb\n' }).source_type).toBe('web');

    // Migration v8 defines source_type TEXT NOT NULL. Empty/whitespace legacy
    // category values are ordinary rows, not devices, and remain visible.
    db.prepare("UPDATE rc_monitors SET source_type = '   ' WHERE id = ?").run(web.id);
    expect(service.list().items.some((item) => item.id === web.id)).toBe(true);

    // These helpers historically no-op for an unknown id. Product policy must
    // not turn unrelated stale caller races into a new error class.
    expect(() => service.setGatewayJobId('missing-ordinary-id', 'job')).not.toThrow();
    expect(() => service.reportError('missing-ordinary-id', 'late failure')).not.toThrow();
  });

  it('canonicalizes ECMAScript whitespace consistently across legacy SQL reads and repairs', () => {
    const legacyRows = [
      { id: 'legacy-device-ht-lf', sourceType: '\tDeViCe\n' },
      { id: 'legacy-device-nbsp', sourceType: '\u00a0DEVICE\u00a0' },
    ];
    for (const row of legacyRows) {
      insertDeviceMonitor(db, {
        ...row,
        prompt: '你是外设定时查证代理。最终回复**必须留空** PRIVATE_DEVICE_PROMPT',
      });
    }

    const before = db.prepare(`
      SELECT * FROM rc_monitors WHERE id IN ('legacy-device-ht-lf', 'legacy-device-nbsp') ORDER BY id
    `).all();
    expect(service.list().items.map((item) => item.id)).not.toEqual(
      expect.arrayContaining(legacyRows.map((row) => row.id)),
    );
    expect(service.listEnabled().map((item) => item.id)).not.toEqual(
      expect.arrayContaining(legacyRows.map((row) => row.id)),
    );
    expect(service.repairLegacyDefaultPrompts()).toBe(0);
    const after = db.prepare(`
      SELECT * FROM rc_monitors WHERE id IN ('legacy-device-ht-lf', 'legacy-device-nbsp') ORDER BY id
    `).all();
    expect(after).toEqual(before);
  });

  it('removes all peripheral guidance from monitor tool descriptions and schemas', () => {
    const tools = createMonitorTools(service);
    expect(tools).toHaveLength(7);
    expect(JSON.stringify(tools.map(({ execute: _execute, ...tool }) => tool)))
      .not.toMatch(/\bdevice\b|periph_|mediaDeviceId/i);
  });
});

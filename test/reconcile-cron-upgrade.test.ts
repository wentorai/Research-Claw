import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.resolve(__dirname, '../scripts/reconcile-cron-upgrade.cjs');
const Database = createRequire(
  path.join(ROOT, 'extensions', 'research-claw-core', 'package.json'),
)('better-sqlite3') as new (
  filename: string,
  options?: { readonly?: boolean },
) => {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): unknown;
  };
  close(): void;
};
const roots: string[] = [];

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-cron-upgrade-'));
  roots.push(root);
  const dbPath = path.join(root, 'library.db');
  const jobsPath = path.join(root, 'cron', 'jobs.json');
  fs.mkdirSync(path.dirname(jobsPath), { recursive: true });
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE rc_cron_state (
      preset_id TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 0,
      config TEXT NOT NULL DEFAULT '{}',
      gateway_job_id TEXT,
      schedule TEXT
    )
  `);
  return { root, db, dbPath, jobsPath };
}

function run(dbPath: string, jobsPath: string): string {
  return execFileSync(process.execPath, [
    SCRIPT,
    '--db',
    dbPath,
    '--jobs',
    jobsPath,
  ], { encoding: 'utf8' });
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('cron upgrade self-healing', () => {
  it('removes disabled RC preset jobs, clears stale DB bindings, and preserves unrelated jobs', () => {
    const { db, dbPath, jobsPath } = fixture();
    db.prepare(
      'INSERT INTO rc_cron_state (preset_id, enabled, gateway_job_id, schedule) VALUES (?, ?, ?, ?)',
    ).run('weekly_report', 0, 'weekly-old', '0 17 * * 5');
    fs.writeFileSync(jobsPath, JSON.stringify({
      version: 1,
      jobs: [
        {
          id: 'weekly-old',
          name: 'Weekly Report',
          sessionKey: 'cron:rc-preset:weekly_report',
          enabled: true,
          delivery: { mode: 'announce' },
          state: { lastStatus: 'error', lastError: 'Delivering requires target' },
        },
        {
          id: 'operator-job',
          name: 'My personal reminder',
          sessionKey: 'agent:main:cron:operator',
          enabled: true,
          delivery: { mode: 'announce', channel: 'telegram', to: '123' },
        },
      ],
    }, null, 2));
    db.close();

    expect(run(dbPath, jobsPath)).toMatch(/removed 1 disabled preset job/i);

    const jobs = JSON.parse(fs.readFileSync(jobsPath, 'utf8')).jobs;
    expect(jobs).toEqual([
      expect.objectContaining({ id: 'operator-job', name: 'My personal reminder' }),
    ]);
    const reopened = new Database(dbPath, { readonly: true });
    expect(reopened.prepare(
      'SELECT enabled, gateway_job_id FROM rc_cron_state WHERE preset_id = ?',
    ).get('weekly_report')).toEqual({ enabled: 0, gateway_job_id: null });
    reopened.close();
  });

  it('normalizes an enabled RC preset to non-delivering mode and is byte-idempotent', () => {
    const { db, dbPath, jobsPath } = fixture();
    db.prepare(
      'INSERT INTO rc_cron_state (preset_id, enabled, gateway_job_id, schedule) VALUES (?, ?, ?, ?)',
    ).run('deadline_reminders_daily', 1, 'deadline-live', '*/30 * * * *');
    fs.writeFileSync(jobsPath, JSON.stringify({
      version: 1,
      jobs: [{
        id: 'deadline-live',
        name: 'Deadline Reminders',
        sessionKey: 'cron:rc-preset:deadline_reminders_daily',
        enabled: true,
        delivery: {
          mode: 'announce',
          channel: 'telegram',
          to: '@heartbeat',
          bestEffort: true,
        },
      }],
    }, null, 2));
    db.close();

    expect(run(dbPath, jobsPath)).toMatch(/normalized 1 enabled preset job/i);
    const first = fs.readFileSync(jobsPath, 'utf8');
    expect(JSON.parse(first).jobs[0].delivery).toEqual({ mode: 'none' });

    expect(run(dbPath, jobsPath)).toBe('');
    expect(fs.readFileSync(jobsPath, 'utf8')).toBe(first);
  });

  it('does nothing when the RC database or cron table is unavailable', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-cron-upgrade-empty-'));
    roots.push(root);
    const jobsPath = path.join(root, 'jobs.json');
    const bytes = `${JSON.stringify({ version: 1, jobs: [{ id: 'operator-job' }] }, null, 2)}\n`;
    fs.writeFileSync(jobsPath, bytes);

    expect(run(path.join(root, 'missing.db'), jobsPath)).toBe('');
    expect(fs.readFileSync(jobsPath, 'utf8')).toBe(bytes);
  });

  it('is invoked by native and Docker startup before the gateway starts', () => {
    for (const relative of ['scripts/run.sh', 'scripts/docker-entrypoint.sh']) {
      const source = fs.readFileSync(path.resolve(__dirname, '..', relative), 'utf8');
      expect(source).toContain('reconcile-cron-upgrade.cjs');
    }
  });
});

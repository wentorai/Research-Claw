import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';

import { createTestDb } from './setup.js';
import { JobService } from '../jobs/service.js';
import { createJobTools } from '../jobs/tools.js';
import { registerJobRpc } from '../jobs/rpc.js';
import { syncOpenClawSubagentJobs } from '../jobs/openclaw-sync.js';

describe('JobService', () => {
  let db: BetterSqlite3.Database;
  let service: JobService;

  beforeEach(() => {
    db = createTestDb();
    service = new JobService(db);
  });

  afterEach(() => db.close());

  it('persists checkpoints and step progress', () => {
    const job = service.create({
      type: 'feishu-upload',
      title: 'Upload document',
      session_key: 'agent:main:project-31',
      input: { source: 'paper.md' },
      steps: [{ key: 'upload', label: 'Upload blocks' }],
    });

    const updated = service.checkpoint(job.id, {
      progress: 42,
      current_step: 'Uploading block 42/100',
      checkpoint: { uploaded: 42 },
      step_key: 'upload',
      step_status: 'running',
      step_progress: 42,
      step_checkpoint: { lastIndex: 41 },
    });

    expect(updated.status).toBe('running');
    expect(updated.progress).toBe(42);
    expect(updated.checkpoint).toEqual({ uploaded: 42 });
    expect(updated.steps?.[0]).toMatchObject({
      status: 'running',
      progress: 42,
      checkpoint: { lastIndex: 41 },
    });
  });

  it('attaches steps to listed jobs in one pass', () => {
    const withSteps = service.create({
      type: 'feishu-upload', title: 'Has steps',
      steps: [{ key: 'a', label: 'Step A' }, { key: 'b', label: 'Step B' }],
    });
    service.create({ type: 'export', title: 'No steps' });
    service.checkpoint(withSteps.id, { step_key: 'a', step_status: 'completed', step_progress: 100 });

    const jobs = service.list();
    const stepped = jobs.find((j) => j.id === withSteps.id);
    const bare = jobs.find((j) => j.title === 'No steps');
    expect(stepped?.steps?.map((s) => s.step_key)).toEqual(['a', 'b']);
    expect(stepped?.steps?.find((s) => s.step_key === 'a')?.status).toBe('completed');
    expect(bare?.steps).toEqual([]);
  });

  it('marks expired running jobs stalled while preserving completed jobs', () => {
    const running = service.create({ type: 'upload', title: 'Running' });
    const completed = service.create({ type: 'upload', title: 'Completed' });
    service.start(running.id);
    service.start(completed.id);
    service.finish(completed.id, 'completed');
    db.prepare(`UPDATE rc_jobs SET heartbeat_at=datetime('now', '-10 minutes') WHERE id=?`).run(running.id);

    expect(service.markStalled(90)).toBe(1);
    expect(service.get(running.id).status).toBe('stalled');
    expect(service.get(completed.id).status).toBe('completed');
  });

  it('marks long-idle queued jobs stalled so a never-started subagent does not hang forever', () => {
    const queued = service.create({ type: 'openclaw-subagent', title: 'Never started' });
    const fresh = service.create({ type: 'openclaw-subagent', title: 'Just queued' });
    db.prepare(`UPDATE rc_jobs SET created_at=datetime('now', '-30 minutes') WHERE id=?`).run(queued.id);

    expect(service.markStalled(90, 600)).toBe(1);
    expect(service.get(queued.id).status).toBe('stalled');
    expect(service.get(fresh.id).status).toBe('queued');
  });

  it('prunes terminal jobs older than the retention window and cascades steps', () => {
    const old = service.create({ type: 'export', title: 'Old', steps: [{ key: 's', label: 'Step' }] });
    const recent = service.create({ type: 'export', title: 'Recent' });
    const oldRunning = service.create({ type: 'export', title: 'Old but running' });
    service.finish(old.id, 'completed');
    service.finish(recent.id, 'completed');
    service.start(oldRunning.id);
    db.prepare(`UPDATE rc_jobs SET updated_at=datetime('now', '-40 days') WHERE id IN (?, ?)`).run(old.id, oldRunning.id);

    expect(service.pruneOld(30)).toBe(1);
    expect(() => service.get(old.id)).toThrow();
    expect(db.prepare('SELECT COUNT(*) AS n FROM rc_job_steps WHERE job_id=?').get(old.id)).toEqual({ n: 0 });
    expect(service.get(recent.id).status).toBe('completed');
    expect(service.get(oldRunning.id).status).toBe('running');
  });

  it('finishes a job with result and 100 percent progress', () => {
    const job = service.create({ type: 'export', title: 'Export' });
    const finished = service.finish(job.id, 'completed', { url: 'https://example.test/doc' });
    expect(finished.status).toBe('completed');
    expect(finished.progress).toBe(100);
    expect(finished.result).toEqual({ url: 'https://example.test/doc' });
  });

  it('upserts external jobs with stable ids', () => {
    const first = service.upsertExternal({
      id: 'openclaw:session-1',
      type: 'openclaw-subagent',
      title: 'Paper inventory',
      session_key: 'agent:main:subagent:abc',
      status: 'running',
      progress: 25,
      current_step: 'OpenClaw 子会话运行中',
      input: { session_id: 'session-1' },
      heartbeat_at: '2026-06-14 12:00:00',
      updated_at: '2026-06-14 12:00:00',
    });
    expect(first.title).toBe('Paper inventory');
    expect(first.status).toBe('running');
    expect(first.updated_at).toBe('2026-06-14 12:00:00');

    const completed = service.upsertExternal({
      id: 'openclaw:session-1',
      type: 'openclaw-subagent',
      title: 'Paper inventory',
      session_key: 'agent:main:subagent:abc',
      status: 'completed',
      progress: 100,
      current_step: 'OpenClaw 子会话已完成',
      result: { summary: 'done' },
      heartbeat_at: '2026-06-14 12:03:00',
      completed_at: '2026-06-14 12:03:00',
      updated_at: '2026-06-14 12:03:00',
    });
    expect(completed.id).toBe(first.id);
    expect(completed.status).toBe('completed');
    expect(completed.result).toEqual({ summary: 'done' });
    expect(completed.updated_at).toBe('2026-06-14 12:03:00');
    expect(service.list({ session_key: 'agent:main:subagent:abc' })).toHaveLength(1);
  });

  it('upserts external job steps without touching the supplied job timestamp', () => {
    const job = service.upsertExternal({
      id: 'longtask:steps',
      type: 'openclaw-subagent',
      title: 'Tracked work',
      status: 'running',
      progress: 40,
      current_step: 'Executing',
      updated_at: '2026-06-14 12:00:00',
      steps: [
        { key: 'scope', label: '确认范围与边界', status: 'completed', progress: 100 },
        { key: 'execute', label: '执行任务', status: 'running', progress: 40, checkpoint: { batch: 2 } },
      ],
    });

    expect(job.updated_at).toBe('2026-06-14 12:00:00');
    expect(job.steps?.map((step) => step.step_key)).toEqual(['scope', 'execute']);
    expect(job.steps?.[1]).toMatchObject({
      status: 'running',
      progress: 40,
      checkpoint: { batch: 2 },
    });
  });
});

describe('OpenClaw subagent job sync', () => {
  let db: BetterSqlite3.Database;
  let service: JobService;
  let tmpDir: string;

  beforeEach(() => {
    db = createTestDb();
    service = new JobService(db);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-openclaw-sync-'));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('projects recent OpenClaw subagent sessions into jobs', () => {
    const sessionFile = path.join(tmpDir, 'child.jsonl');
    fs.writeFileSync(sessionFile, [
      JSON.stringify({
        type: 'message',
        message: {
          role: 'user',
          content: [{ type: 'text', text: '[Subagent Task]\n\n## 任务：批量整理 workspace 论文\n\nBegin.' }],
        },
      }),
      JSON.stringify({
        type: 'message',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: '后台任务已完成，整理报告已生成。' }],
        },
      }),
    ].join('\n'));

    const sessionsPath = path.join(tmpDir, 'sessions.json');
    fs.writeFileSync(sessionsPath, JSON.stringify({
      'agent:main:subagent:abc': {
        subagentRole: 'leaf',
        spawnedBy: 'agent:main:project-1',
        sessionId: 'child-session-id',
        sessionFile,
        status: 'done',
        startedAt: Date.UTC(2026, 5, 14, 12, 0, 0),
        updatedAt: Date.UTC(2026, 5, 14, 12, 5, 0),
        model: 'MiniMax-M2.7',
        modelProvider: 'minimax',
      },
    }));

    const syncOptions = { sessionsJsonPath: sessionsPath, maxAgeDays: 365 };
    const result = syncOpenClawSubagentJobs(service, syncOptions);
    expect(result.synced).toBe(1);
    const jobs = service.list();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      id: 'openclaw:child-session-id',
      type: 'openclaw-subagent',
      title: '文献任务: 批量整理 workspace 论文',
      session_key: 'agent:main:subagent:abc',
      status: 'completed',
      progress: 100,
    });
    expect(jobs[0].completed_at).toBe('2026-06-14 12:05:00');
    expect(jobs[0].updated_at).toBe('2026-06-14 12:05:00');
    expect(jobs[0].checkpoint.latest_text).toContain('整理报告');
    expect(jobs[0].checkpoint).toMatchObject({
      protocol: 'bootstrap-2026-06-21',
      resume_policy: 'resume-from-latest',
    });
    expect((jobs[0].input.orchestration as { production_state_default?: string }).production_state_default).toBe('read-only');
    expect(jobs[0].steps?.map((step) => [step.step_key, step.status, step.progress])).toEqual([
      ['scope', 'completed', 100],
      ['execute', 'completed', 100],
      ['review', 'completed', 100],
    ]);

    syncOpenClawSubagentJobs(service, syncOptions);
    expect(service.get('openclaw:child-session-id').updated_at).toBe('2026-06-14 12:05:00');
  });

  it('binds OpenClaw subagent sessions back to pre-created long task jobs', () => {
    service.upsertExternal({
      id: 'longtask:tracked-job',
      type: 'openclaw-subagent',
      title: '批量整理 workspace 论文',
      session_key: 'agent:main:project-1',
      status: 'queued',
      progress: 0,
      current_step: '等待 OpenClaw 子会话启动',
      input: { source: 'auto-long-task' },
      heartbeat_at: '2026-06-14 12:00:00',
    });

    const sessionFile = path.join(tmpDir, 'tracked-child.jsonl');
    fs.writeFileSync(sessionFile, [
      JSON.stringify({
        type: 'message',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Research-Claw Job ID: longtask:tracked-job\n\n## 任务：批量整理 workspace 论文' }],
        },
      }),
      JSON.stringify({
        type: 'message',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: '整理完成，报告已写入 workspace/papers/report.md。' }],
        },
      }),
    ].join('\n'));

    const sessionsPath = path.join(tmpDir, 'tracked-sessions.json');
    fs.writeFileSync(sessionsPath, JSON.stringify({
      'agent:main:subagent:def': {
        subagentRole: 'leaf',
        spawnedBy: 'agent:main:project-1',
        sessionId: 'tracked-child-session',
        sessionFile,
        status: 'done',
        startedAt: Date.UTC(2026, 5, 14, 12, 0, 0),
        updatedAt: Date.UTC(2026, 5, 14, 12, 5, 0),
      },
    }));

    const result = syncOpenClawSubagentJobs(service, { sessionsJsonPath: sessionsPath, maxAgeDays: 365 });
    expect(result.synced).toBe(1);
    const jobs = service.list();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      id: 'longtask:tracked-job',
      title: '批量整理 workspace 论文',
      status: 'completed',
      progress: 100,
    });
    expect(jobs[0].input.linked_job_id).toBe('longtask:tracked-job');
    expect(jobs[0].steps?.find((step) => step.step_key === 'review')?.status).toBe('completed');
  });

  it('rebinds a subagent to a queued long task via spawnedBy when the transcript omits the Job ID', () => {
    service.upsertExternal({
      id: 'longtask:no-echo',
      type: 'openclaw-subagent',
      title: '批量扫描代码库',
      session_key: 'agent:main:project-7',
      status: 'queued',
      progress: 0,
      current_step: '等待 OpenClaw 子会话启动',
      input: { source: 'auto-long-task', message: '批量扫描代码库', references: ['a.ts', 'b.ts'] },
      heartbeat_at: '2026-06-14 12:00:00',
    });

    const sessionFile = path.join(tmpDir, 'no-echo-child.jsonl');
    // Note: child transcript deliberately does NOT print "Research-Claw Job ID".
    fs.writeFileSync(sessionFile, [
      JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: '## 任务：批量扫描代码库' }] } }),
      JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: '扫描完成。' }] } }),
    ].join('\n'));

    const sessionsPath = path.join(tmpDir, 'no-echo-sessions.json');
    fs.writeFileSync(sessionsPath, JSON.stringify({
      'agent:main:subagent:ghi': {
        subagentRole: 'leaf',
        spawnedBy: 'agent:main:project-7',
        sessionId: 'no-echo-child-session',
        sessionFile,
        status: 'done',
        startedAt: Date.UTC(2026, 5, 14, 12, 0, 0),
        updatedAt: Date.UTC(2026, 5, 14, 12, 5, 0),
      },
    }));

    syncOpenClawSubagentJobs(service, { sessionsJsonPath: sessionsPath, maxAgeDays: 365 });
    const jobs = service.list();
    // Must reuse the pre-created job, not spawn an orphan openclaw:<id> row.
    expect(jobs).toHaveLength(1);
    expect(jobs[0].id).toBe('longtask:no-echo');
    expect(jobs[0].status).toBe('completed');
    expect(jobs[0].session_key).toBe('agent:main:subagent:ghi');
    expect(jobs[0].input.bound_via).toBe('spawned_by');
    // Original submission payload survives the rebind.
    expect(jobs[0].input.references).toEqual(['a.ts', 'b.ts']);
    expect((jobs[0].input.orchestration as { checkpoint_policy?: string }).checkpoint_policy).toBe('resume-from-latest');
  });

  it('serves a cached transcript without re-reading when mtime and size are unchanged', () => {
    const sessionFile = path.join(tmpDir, 'cache-child.jsonl');
    const fixedTime = new Date(Date.UTC(2026, 5, 14, 12, 0, 0));
    const transcriptFor = (marker: string) => JSON.stringify({
      type: 'message',
      message: { role: 'assistant', content: [{ type: 'text', text: `cache-marker-${marker}` }] },
    });
    // v1 and v2 are byte-identical in length; pinning mtime makes (mtime,size) match.
    fs.writeFileSync(sessionFile, transcriptFor('AAAA'));
    fs.utimesSync(sessionFile, fixedTime, fixedTime);

    const sessionsPath = path.join(tmpDir, 'cache-sessions.json');
    fs.writeFileSync(sessionsPath, JSON.stringify({
      'agent:main:subagent:cache': {
        subagentRole: 'leaf',
        sessionId: 'cache-child-session',
        sessionFile,
        status: 'running',
        startedAt: Date.UTC(2026, 5, 14, 12, 0, 0),
        updatedAt: Date.now() - 10_000,
      },
    }));

    syncOpenClawSubagentJobs(service, { sessionsJsonPath: sessionsPath });
    expect(service.get('openclaw:cache-child-session').checkpoint.latest_text).toBe('cache-marker-AAAA');

    // Rewrite content but restore the same mtime + size → cache must win, so the
    // stale (un-re-read) value is returned, proving the transcript was not parsed.
    fs.writeFileSync(sessionFile, transcriptFor('BBBB'));
    fs.utimesSync(sessionFile, fixedTime, fixedTime);
    syncOpenClawSubagentJobs(service, { sessionsJsonPath: sessionsPath });
    expect(service.get('openclaw:cache-child-session').checkpoint.latest_text).toBe('cache-marker-AAAA');
  });

  it('preserves a recent resume request while OpenClaw still reports the old terminal state', () => {
    service.upsertExternal({
      id: 'longtask:resume-me',
      type: 'openclaw-subagent',
      title: '继续整理论文',
      session_key: 'agent:main:subagent:resume',
      status: 'cancelled',
      progress: 100,
      current_step: 'OpenClaw 子会话已取消',
      heartbeat_at: '2026-06-14 12:00:00',
    });
    service.resume('longtask:resume-me', '已请求 OpenClaw 子会话继续');

    const sessionFile = path.join(tmpDir, 'resume-child.jsonl');
    fs.writeFileSync(sessionFile, JSON.stringify({
      type: 'message',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'Research-Claw Job ID: longtask:resume-me\n\n## 任务：继续整理论文' }],
      },
    }));
    const sessionsPath = path.join(tmpDir, 'resume-sessions.json');
    fs.writeFileSync(sessionsPath, JSON.stringify({
      'agent:main:subagent:resume': {
        subagentRole: 'leaf',
        sessionId: 'resume-child-session',
        sessionFile,
        status: 'cancelled',
        startedAt: Date.now() - 10_000,
        updatedAt: Date.now() - 10_000,
      },
    }));

    syncOpenClawSubagentJobs(service, { sessionsJsonPath: sessionsPath });
    const job = service.get('longtask:resume-me');
    expect(job.status).toBe('running');
    expect(job.current_step).toBe('已请求 OpenClaw 子会话继续');
    expect(job.checkpoint.resume_requested_at).toBeTruthy();
  });
});

describe('job tools and RPC', () => {
  let db: BetterSqlite3.Database;
  let service: JobService;

  beforeEach(() => {
    db = createTestDb();
    service = new JobService(db);
  });

  afterEach(() => db.close());

  it('creates and reads jobs through tools', async () => {
    const tools = createJobTools(service);
    const start = tools.find((tool) => tool.name === 'job_start')!;
    const result = await start.execute('call-1', { type: 'upload', title: 'Upload' }) as { details: { id: string } };
    expect(service.get(result.details.id).title).toBe('Upload');
    expect((service.get(result.details.id).input.orchestration as { source?: string }).source).toBe('job-tool');
  });

  it('registers list/get/cancel/resume RPC methods', async () => {
    const handlers = new Map<string, (params: Record<string, unknown>) => unknown>();
    registerJobRpc((name, handler) => handlers.set(name, handler), service);
    const job = service.create({ type: 'upload', title: 'Upload' });
    const list = await handlers.get('rc.job.list')!({}) as Array<{ id: string }>;
    expect(list[0].id).toBe(job.id);
    const cancelled = await handlers.get('rc.job.cancel')!({ id: job.id, reason: 'Stopped from panel' }) as { status: string; error: string };
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.error).toBe('Stopped from panel');
    const resumed = await handlers.get('rc.job.resume')!({ id: job.id, current_step: 'Retry requested' }) as { status: string; current_step: string; error: string | null };
    expect(resumed.status).toBe('running');
    expect(resumed.current_step).toBe('Retry requested');
    expect(resumed.error).toBeNull();
  });

  it('registers long task submission RPC', async () => {
    const handlers = new Map<string, (params: Record<string, unknown>) => unknown>();
    registerJobRpc((name, handler) => handlers.set(name, handler), service);
    const submitted = await handlers.get('rc.longTask.submit')!({
      message: '帮我批量整理 workspace 里的论文，生成报告',
      display_title: '批量整理 workspace 论文',
      session_key: 'agent:main:project-1',
      references: ['papers/a.pdf'],
      detection: { score: 5, reasons: ['bulk-scope'] },
    }) as { job: { id: string; type: string; status: string; title: string } };

    expect(submitted.job.id).toMatch(/^longtask:/);
    expect(submitted.job.type).toBe('openclaw-subagent');
    expect(submitted.job.status).toBe('queued');
    expect(submitted.job.title).toBe('文献任务: 批量整理 workspace 里的论文，生成报告');
    const stored = service.get(submitted.job.id);
    expect(stored.input.source).toBe('auto-long-task');
    expect(stored.checkpoint).toMatchObject({
      protocol: 'bootstrap-2026-06-21',
      resume_policy: 'resume-from-latest',
      self_check_required: true,
    });
    expect((stored.input.orchestration as { prohibited_operations?: string[] }).prohibited_operations).toContain('direct-production-db-mutation');
    expect(stored.steps?.map((step) => step.step_key)).toEqual(['scope', 'execute', 'review']);
  });
});

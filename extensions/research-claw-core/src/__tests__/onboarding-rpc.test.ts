/**
 * Onboarding RPC + .done sentinel tests.
 *
 * Covers rc.onboarding.status first-run detection (fail-safe on every probe)
 * and the agent:bootstrap redirect hook's .done defense (residual BOOTSTRAP.md
 * must not re-run onboarding once BOOTSTRAP.md.done exists).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';

import { createTestDb } from './setup.js';
import { LiteratureService } from '../literature/service.js';
import { TaskService } from '../tasks/service.js';
import { registerOnboardingRpc, type OnboardingStatus } from '../onboarding/rpc.js';
import { bootstrapDoneExists } from '../onboarding/bootstrap-done.js';
import type { RegisterMethod } from '../types.js';
import plugin from '../../index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWorkspace(opts: {
  bootstrap?: boolean;
  doneInRcDir?: boolean;
  doneAtRoot?: boolean;
} = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-onboarding-'));
  const rcDir = path.join(root, '.ResearchClaw');
  fs.mkdirSync(rcDir, { recursive: true });
  if (opts.bootstrap ?? true) {
    fs.writeFileSync(path.join(rcDir, 'BOOTSTRAP.md'), '# First-Run Onboarding\n');
  }
  if (opts.doneInRcDir) {
    fs.writeFileSync(path.join(rcDir, 'BOOTSTRAP.md.done'), 'done\n');
  }
  if (opts.doneAtRoot) {
    fs.writeFileSync(path.join(root, 'BOOTSTRAP.md.done'), 'done\n');
  }
  return root;
}

// ---------------------------------------------------------------------------
// rc.onboarding.status
// ---------------------------------------------------------------------------

describe('rc.onboarding.status', () => {
  let db: BetterSqlite3.Database;
  let litService: LiteratureService;
  let taskService: TaskService;
  let workspaceRoot: string;

  beforeEach(() => {
    db = createTestDb();
    litService = new LiteratureService(db);
    taskService = new TaskService(db);
    workspaceRoot = makeWorkspace();
  });

  afterEach(() => {
    db.close();
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  function callStatus(overrides: {
    getWorkspaceRoot?: () => string | null;
    getLitService?: () => LiteratureService | null;
    getTaskService?: () => TaskService | null;
  } = {}): Promise<OnboardingStatus> {
    const handlers = new Map<string, (params: Record<string, unknown>) => Promise<unknown> | unknown>();
    const registerMethod: RegisterMethod = (method, handler) => handlers.set(method, handler);
    registerOnboardingRpc(registerMethod, {
      getWorkspaceRoot: () => workspaceRoot,
      getLitService: () => litService,
      getTaskService: () => taskService,
      ...overrides,
    });
    return Promise.resolve(handlers.get('rc.onboarding.status')!({})) as Promise<OnboardingStatus>;
  }

  it('reports firstRun=true for a genuinely fresh state', async () => {
    const result = await callStatus();
    expect(result).toEqual({
      firstRun: true,
      signals: { bootstrapPresent: true, doneExists: false, paperCount: 0, taskCount: 0 },
    });
  });

  it('reports firstRun=false when .done exists in .ResearchClaw/', async () => {
    fs.writeFileSync(path.join(workspaceRoot, '.ResearchClaw', 'BOOTSTRAP.md.done'), 'done\n');
    const result = await callStatus();
    expect(result.firstRun).toBe(false);
    expect(result.signals.doneExists).toBe(true);
  });

  it('reports firstRun=false when .done exists at workspace root only', async () => {
    fs.writeFileSync(path.join(workspaceRoot, 'BOOTSTRAP.md.done'), 'done\n');
    const result = await callStatus();
    expect(result.firstRun).toBe(false);
    expect(result.signals.doneExists).toBe(true);
  });

  it('reports firstRun=false when BOOTSTRAP.md is absent', async () => {
    fs.rmSync(path.join(workspaceRoot, '.ResearchClaw', 'BOOTSTRAP.md'));
    const result = await callStatus();
    expect(result.firstRun).toBe(false);
    expect(result.signals.bootstrapPresent).toBe(false);
  });

  it('reports firstRun=false when the library has papers', async () => {
    litService.add({ title: 'Attention Is All You Need' });
    const result = await callStatus();
    expect(result.firstRun).toBe(false);
    expect(result.signals.paperCount).toBe(1);
  });

  it('reports firstRun=false when tasks exist (any status, incl. completed)', async () => {
    const task = taskService.create({ title: 'Read survey', task_type: 'human' });
    taskService.update(task.id, { status: 'in_progress' });
    taskService.update(task.id, { status: 'done' });
    const result = await callStatus();
    expect(result.firstRun).toBe(false);
    expect(result.signals.taskCount).toBe(1);
  });

  it('fails safe (firstRun=false, count=-1) when a probe throws', async () => {
    const throwingLit = { getStats: () => { throw new Error('db closed'); } } as unknown as LiteratureService;
    const result = await callStatus({ getLitService: () => throwingLit });
    expect(result.firstRun).toBe(false);
    expect(result.signals.paperCount).toBe(-1);
  });

  it('fails safe when services are null (pre-init register pass)', async () => {
    const result = await callStatus({
      getLitService: () => null,
      getTaskService: () => null,
    });
    expect(result.firstRun).toBe(false);
    expect(result.signals.paperCount).toBe(-1);
    expect(result.signals.taskCount).toBe(-1);
  });

  it('fails safe when the workspace root is unavailable', async () => {
    const result = await callStatus({ getWorkspaceRoot: () => null });
    expect(result.firstRun).toBe(false);
    expect(result.signals.bootstrapPresent).toBe(false);
    expect(result.signals.doneExists).toBe(true);
  });

  it('fails safe when the workspace root getter throws', async () => {
    const result = await callStatus({
      getWorkspaceRoot: () => { throw new Error('not resolved'); },
    });
    expect(result.firstRun).toBe(false);
    expect(result.signals.doneExists).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// bootstrapDoneExists (shared util behind RPC + Hook 10)
// ---------------------------------------------------------------------------

describe('bootstrapDoneExists', () => {
  it('is false for a fresh workspace', () => {
    const root = makeWorkspace();
    expect(bootstrapDoneExists(root)).toBe(false);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('is true for .ResearchClaw/BOOTSTRAP.md.done', () => {
    const root = makeWorkspace({ doneInRcDir: true });
    expect(bootstrapDoneExists(root)).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('is true for a root-level BOOTSTRAP.md.done', () => {
    const root = makeWorkspace({ doneAtRoot: true });
    expect(bootstrapDoneExists(root)).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// agent:bootstrap hook — .done defense (Hook 10)
// ---------------------------------------------------------------------------

type BootstrapEntry = { name: string; path: string; content?: string; missing?: boolean };
type BootstrapHookHandler = (event: {
  type: string;
  action: string;
  context: Record<string, unknown>;
}) => void | Promise<void>;

describe('agent:bootstrap hook .done defense', () => {
  let pluginRoot: string;
  let hookHandler: BootstrapHookHandler | null = null;

  beforeEach(async () => {
    pluginRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-hook-plugin-'));
    // register() is guarded by module-level state; hooks only bind on the
    // first pass in this process. Capture (or keep) the agent:bootstrap
    // handler — its behavior depends only on event.context.workspaceDir.
    const api = {
      id: 'research-claw-core',
      name: 'Research-Claw Core',
      pluginConfig: {
        dbPath: path.join(pluginRoot, 'library.db'),
        autoTrackGit: false,
        workspace: { root: path.join(pluginRoot, 'workspace') },
      },
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      runtime: {
        config: {
          current: () => ({}),
          mutateConfigFile: async () => ({ path: '', persistedHash: null }),
        },
      },
      resolvePath: (input: string) => (path.isAbsolute(input) ? input : path.join(pluginRoot, input)),
      registerTool: () => {},
      registerGatewayMethod: () => {},
      registerHttpRoute: () => {},
      registerService: () => {},
      on: () => {},
      registerHook: (events: string | string[], handler: BootstrapHookHandler) => {
        if (events === 'agent:bootstrap') hookHandler = handler;
      },
    };
    await plugin.register?.(api);
  });

  afterEach(() => {
    fs.rmSync(pluginRoot, { recursive: true, force: true });
  });

  async function runHook(workspaceDir: string, entries: BootstrapEntry[]): Promise<BootstrapEntry[]> {
    expect(hookHandler).toBeTruthy();
    const context: Record<string, unknown> = { workspaceDir, bootstrapFiles: entries };
    await hookHandler!({ type: 'agent', action: 'bootstrap', context });
    return context.bootstrapFiles as BootstrapEntry[];
  }

  it('injects .ResearchClaw/BOOTSTRAP.md content when no .done sentinel exists', async () => {
    const wsRoot = makeWorkspace();
    const files = await runHook(wsRoot, [
      { name: 'BOOTSTRAP.md', path: path.join(wsRoot, 'BOOTSTRAP.md'), missing: true },
    ]);
    expect(files[0]).toMatchObject({
      name: 'BOOTSTRAP.md',
      path: path.join(wsRoot, '.ResearchClaw', 'BOOTSTRAP.md'),
      content: '# First-Run Onboarding\n',
      missing: false,
    });
    fs.rmSync(wsRoot, { recursive: true, force: true });
  });

  it('blanks the BOOTSTRAP entry when .done exists, even with residual content', async () => {
    // Residue scenario: .done exists but BOOTSTRAP.md (and its root symlink)
    // were never cleaned up — OC loaded content from the root path.
    const wsRoot = makeWorkspace({ doneInRcDir: true });
    const rootPath = path.join(wsRoot, 'BOOTSTRAP.md');
    const files = await runHook(wsRoot, [
      { name: 'BOOTSTRAP.md', path: rootPath, content: 'residual onboarding text', missing: false },
    ]);
    expect(files[0]).toEqual({ name: 'BOOTSTRAP.md', path: rootPath, missing: true });
    expect(files[0].content).toBeUndefined();
    fs.rmSync(wsRoot, { recursive: true, force: true });
  });

  it('blanks the BOOTSTRAP entry when only the root-level .done exists', async () => {
    const wsRoot = makeWorkspace({ doneAtRoot: true });
    const rootPath = path.join(wsRoot, 'BOOTSTRAP.md');
    const files = await runHook(wsRoot, [
      { name: 'BOOTSTRAP.md', path: rootPath, content: 'residual onboarding text', missing: false },
    ]);
    expect(files[0]).toEqual({ name: 'BOOTSTRAP.md', path: rootPath, missing: true });
    fs.rmSync(wsRoot, { recursive: true, force: true });
  });

  it('keeps redirecting other prompt files when .done exists', async () => {
    const wsRoot = makeWorkspace({ doneInRcDir: true });
    fs.writeFileSync(path.join(wsRoot, '.ResearchClaw', 'USER.md'), 'user profile\n');
    const files = await runHook(wsRoot, [
      { name: 'BOOTSTRAP.md', path: path.join(wsRoot, 'BOOTSTRAP.md'), content: 'residual', missing: false },
      { name: 'USER.md', path: path.join(wsRoot, 'USER.md'), missing: true },
    ]);
    expect(files[0]).toEqual({ name: 'BOOTSTRAP.md', path: path.join(wsRoot, 'BOOTSTRAP.md'), missing: true });
    expect(files[1]).toMatchObject({ name: 'USER.md', content: 'user profile\n', missing: false });
    fs.rmSync(wsRoot, { recursive: true, force: true });
  });
});

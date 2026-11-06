import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProbeInput } from '../self-check/activation-probe.js';
import {
  auditRuntimeMounts,
  readSessionPromptReport,
  runtimeMountAuditSkipReason,
  selectModelVisibleEligibleSkills,
  type SkillsCliReport,
  type SystemPromptReportLike,
} from '../self-check/runtime-probe.js';

const plugins: ProbeInput[] = [
  {
    id: 'research-claw-core',
    dir: '/project/extensions/research-claw-core',
    manifest: {
      id: 'research-claw-core',
      main: 'dist/index.js',
      activation: { onStartup: true },
      contracts: { tools: ['lit_search', 'task_create'] },
    },
  },
  {
    id: 'research-plugins',
    dir: '/state/extensions/research-plugins',
    manifest: {
      id: 'research-plugins',
      main: 'index.ts',
      activation: { onStartup: true },
      contracts: { tools: ['citation_graph', 'paper_download'] },
    },
  },
];

function report(overrides: Partial<SystemPromptReportLike> = {}): SystemPromptReportLike {
  return {
    source: 'run',
    generatedAt: 1_753_400_000_000,
    sessionKey: 'agent:main:main',
    skills: {
      promptChars: 120,
      entries: [{ name: 'alpha', blockChars: 120 }],
    },
    tools: {
      listChars: 20,
      schemaChars: 400,
      entries: [
        { name: 'lit_search' },
        { name: 'task_create' },
        { name: 'citation_graph' },
        { name: 'paper_download' },
      ],
    },
    ...overrides,
  };
}

const skillsCliReport: SkillsCliReport = {
  workspaceDir: '/workspace',
  managedSkillsDir: '/state/skills',
  skills: [
    {
      name: 'alpha',
      eligible: true,
      blockedByAgentFilter: false,
      modelVisible: true,
    },
    {
      name: 'bravo',
      eligible: true,
      blockedByAgentFilter: false,
      modelVisible: true,
    },
    {
      name: 'hidden-command',
      eligible: true,
      blockedByAgentFilter: false,
      modelVisible: false,
    },
    {
      name: 'missing-binary',
      eligible: false,
      blockedByAgentFilter: false,
      modelVisible: true,
    },
  ],
};

describe('runtime mount reconciliation', () => {
  it('reports budget-truncated model-visible skills with count and names', () => {
    const findings = auditRuntimeMounts({
      plugins,
      systemPromptReport: report(),
      indexedSkillNames: selectModelVisibleEligibleSkills(skillsCliReport),
    });
    const finding = findings.find((item) => item.kind === 'skills-truncated');
    expect(finding?.missingNames).toEqual(['bravo']);
    expect(finding?.message).toContain('1');
    expect(finding?.message).toContain('bravo');
    expect(finding?.message).not.toContain('hidden-command');
  });

  it('reports manifest-declared tools absent from the actual runtime tool entries', () => {
    const findings = auditRuntimeMounts({
      plugins,
      systemPromptReport: report({
        tools: {
          listChars: 10,
          schemaChars: 100,
          entries: [{ name: 'lit_search' }, { name: 'paper_download' }],
        },
      }),
      indexedSkillNames: ['alpha'],
    });
    const finding = findings.find((item) => item.kind === 'tools-not-mounted');
    expect(finding?.missingNames).toEqual(['citation_graph', 'task_create']);
    expect(finding?.message).toContain('2');
    expect(finding?.message).toContain('citation_graph');
    expect(finding?.message).toContain('task_create');
  });

  // skill_search is declared unconditionally (OpenClaw rejects registering an
  // undeclared tool) but registered only when the research-plugins catalog
  // exists, so its absence is the plugin's decision, not a mount failure.
  it('excludes tools the plugin deliberately did not register', () => {
    const partialReport = report({
      tools: {
        listChars: 10,
        schemaChars: 100,
        entries: [{ name: 'lit_search' }, { name: 'paper_download' }],
      },
    });
    const findings = auditRuntimeMounts({
      plugins,
      systemPromptReport: partialReport,
      indexedSkillNames: ['alpha'],
      intentionallyUnregisteredTools: ['citation_graph'],
    });
    const finding = findings.find((item) => item.kind === 'tools-not-mounted');
    expect(finding?.missingNames).toEqual(['task_create']);

    expect(
      auditRuntimeMounts({
        plugins,
        systemPromptReport: partialReport,
        indexedSkillNames: ['alpha'],
        intentionallyUnregisteredTools: ['citation_graph', 'task_create'],
      }).find((item) => item.kind === 'tools-not-mounted'),
    ).toBeUndefined();
  });

  it('has no findings for a fully reconciled real run report', () => {
    expect(
      auditRuntimeMounts({
        plugins,
        systemPromptReport: report(),
        indexedSkillNames: ['alpha'],
      }),
    ).toEqual([]);
  });

  it('refuses estimate reports because they do not prove actual mounts', () => {
    expect(
      auditRuntimeMounts({
        plugins,
        systemPromptReport: report({ source: 'estimate' }),
        indexedSkillNames: ['alpha', 'bravo'],
      }),
    ).toEqual([]);
  });
});

describe('runtime mount audit admissibility', () => {
  it('admits the canonical foreground session under no tool projection', () => {
    expect(
      runtimeMountAuditSkipReason({ sessionKey: 'agent:main:main', agentId: 'main', config: {} }),
    ).toBeNull();
  });

  // A cron job may carry its own toolsAllow allowlist, so its run legitimately
  // sees a restricted tool set — auditing it would flag every product tool.
  it.each([
    ['agent:main:cron:0fd87fdc-f563-4f74-b119-802b1df0d9db', 'cron'],
    ['agent:main:main:heartbeat', 'heartbeat'],
    ['agent:main:project-d9f76242', 'project-scoped'],
  ])('skips the %s (%s) session', (sessionKey) => {
    expect(
      runtimeMountAuditSkipReason({ sessionKey, agentId: 'main', config: {} }),
    ).toContain('canonical foreground session');
  });

  it('honours a non-default agentId', () => {
    expect(
      runtimeMountAuditSkipReason({ sessionKey: 'agent:writer:main', agentId: 'writer', config: {} }),
    ).toBeNull();
    expect(
      runtimeMountAuditSkipReason({ sessionKey: 'agent:main:main', agentId: 'writer', config: {} }),
    ).not.toBeNull();
  });

  // These modes replace the model-facing tool list wholesale before the report is
  // written, so absence there says nothing about what is mounted. Every config
  // below is a shape OpenClaw's own schema accepts, and the expectations follow
  // its resolvers (resolveToolSearchConfig / resolveCodeModeConfig) rather than a
  // guess at what the keys look like — the two disagree in both directions.
  it.each([
    ['toolSearch: true is the documented shorthand', { tools: { toolSearch: true } }, 'toolSearch'],
    ['toolSearch object opts in without naming enabled', { tools: { toolSearch: { mode: 'tools' } } }, 'toolSearch'],
    ['toolSearch explicit enable', { tools: { toolSearch: { enabled: true } } }, 'toolSearch'],
    ['codeMode: true shorthand', { tools: { codeMode: true } }, 'codeMode'],
    ['codeMode explicit enable', { tools: { codeMode: { enabled: true } } }, 'codeMode'],
    [
      'agent-level codeMode enables it for this agent alone',
      { agents: { list: [{ id: 'main', tools: { codeMode: true } }] } },
      'codeMode',
    ],
    [
      'agent-level codeMode overrides a global off',
      {
        tools: { codeMode: { enabled: false } },
        agents: { list: [{ id: 'other' }, { id: 'MAIN ', tools: { codeMode: { enabled: true } } }] },
      },
      'codeMode',
    ],
  ])('skips when %s', (_label, config, expected) => {
    expect(
      runtimeMountAuditSkipReason({ sessionKey: 'agent:main:main', agentId: 'main', config }),
    ).toContain(expected);
  });

  // The mirror image, and the more dangerous direction: a skip that fires when no
  // projection is active disables the audit silently.
  it.each([
    ['nothing is configured', {}],
    ['both are explicitly off', { tools: { toolSearch: { enabled: false }, codeMode: false } }],
    ['toolSearch enabled: false wins over other options', { tools: { toolSearch: { enabled: false, mode: 'tools' } } }],
    ['an empty toolSearch object opts in to nothing', { tools: { toolSearch: {} } }],
    ['codeMode has no implicit opt-in', { tools: { codeMode: { timeoutMs: 5_000 } } }],
    ['codeMode enabled: false is off, not "present"', { tools: { codeMode: { enabled: false } } }],
    [
      'an agent-level codeMode off overrides a global on',
      {
        tools: { codeMode: true },
        agents: { list: [{ id: 'main', tools: { codeMode: { enabled: false } } }] },
      },
    ],
    [
      'another agent enabling codeMode does not implicate this one',
      { agents: { list: [{ id: 'writer', tools: { codeMode: true } }] } },
    ],
    // Lean local-model mode only drops browser/cron/message, so it must audit
    // normally on both of its real config paths.
    ['lean local-model mode is on for all agents', { agents: { defaults: { experimental: { localModelLean: true } } } }],
    [
      'lean local-model mode is on for this agent',
      { agents: { list: [{ id: 'main', experimental: { localModelLean: true } }] } },
    ],
  ])('does not skip when %s', (_label, config) => {
    expect(
      runtimeMountAuditSkipReason({ sessionKey: 'agent:main:main', agentId: 'main', config }),
    ).toBeNull();
  });

  // The premise that lets lean local-model mode go unskipped above: it removes
  // exactly these three OpenClaw built-ins, and no product manifest declares
  // them. If one ever does, the audit would start reporting it as unmounted on
  // lean agents — fail here instead, where the reason is legible.
  it('declares none of the tools lean local-model mode removes', () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, '../../openclaw.plugin.json'), 'utf8'),
    ) as { contracts?: { tools?: string[] } };
    const declared = manifest.contracts?.tools ?? [];
    expect(declared.length).toBeGreaterThan(0);
    expect(
      declared.filter((name) => ['browser', 'cron', 'message'].includes(name.toLowerCase())),
    ).toEqual([]);
  });
});

describe('persisted session report reader', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function tempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-runtime-probe-'));
    tempDirs.push(dir);
    return dir;
  }

  function defaultStorePath(stateDir: string, agentId = 'main'): string {
    return path.join(stateDir, 'agents', agentId, 'agent', 'openclaw-agent.sqlite');
  }

  // Mirrors the 2026.9.2 per-agent SQLite store: `session_nodes.entry_json`
  // holds the whole session entry (the same object the legacy sessions.json
  // held), including `systemPromptReport`. Only the columns the reader touches
  // are created; the production DDL carries many more.
  function writeSessionStore(databasePath: string, entries: Record<string, unknown>): void {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    const database = new DatabaseSync(databasePath);
    try {
      database.exec(
        'CREATE TABLE session_nodes (session_key TEXT NOT NULL PRIMARY KEY, entry_json TEXT NOT NULL)',
      );
      const insert = database.prepare(
        'INSERT INTO session_nodes (session_key, entry_json) VALUES (?, ?)',
      );
      for (const [sessionKey, entry] of Object.entries(entries)) {
        insert.run(sessionKey, JSON.stringify(entry));
      }
    } finally {
      database.close();
    }
  }

  it('reads the requested session from session_nodes.entry_json in the 2026.9.2 SQLite store', () => {
    const stateDir = tempDir();
    writeSessionStore(defaultStorePath(stateDir), {
      'agent:main:older': {
        sessionId: 'older',
        updatedAt: 1,
        systemPromptReport: report({ generatedAt: 10, sessionKey: 'agent:main:older' }),
      },
      'agent:main:main': {
        sessionId: 'current',
        updatedAt: 2,
        systemPromptReport: report({ generatedAt: 20 }),
      },
    });

    expect(
      readSessionPromptReport({
        stateDir,
        agentId: 'main',
        sessionKey: 'agent:main:main',
      })?.generatedAt,
    ).toBe(20);
  });

  // Before this run's report is persisted, a concurrent isolated run may hold
  // the newest report. Falling back to it would audit an unrelated tool policy.
  it('returns null rather than another session report when the requested one is absent', () => {
    const stateDir = tempDir();
    writeSessionStore(defaultStorePath(stateDir), {
      'agent:main:cron:0fd87fdc': {
        sessionId: 'cron',
        updatedAt: 9,
        systemPromptReport: report({
          generatedAt: 90,
          sessionKey: 'agent:main:cron:0fd87fdc',
        }),
      },
    });

    expect(
      readSessionPromptReport({
        stateDir,
        agentId: 'main',
        sessionKey: 'agent:main:main',
      }),
    ).toBeNull();
  });

  it('supports a configured store path with the {agentId} placeholder', () => {
    const root = tempDir();
    const storeTemplate = path.join(root, 'stores', '{agentId}', 'sessions.json');
    // 2026.9.2 maps a configured legacy sessions.json path to the SQLite
    // database it actually writes (session-sqlite-target.ts), so that is the
    // store the configured placeholder must resolve to.
    const storePath = path.join(root, 'stores', 'main', 'openclaw-agent.sqlite');
    writeSessionStore(storePath, {
      'agent:main:main': {
        sessionId: 'current',
        updatedAt: 2,
        systemPromptReport: report({ generatedAt: 30 }),
      },
    });

    expect(
      readSessionPromptReport({
        stateDir: path.join(root, 'unused-state'),
        agentId: 'main',
        sessionKey: 'agent:main:main',
        configuredStore: storeTemplate,
      })?.generatedAt,
    ).toBe(30);
  });

  it('uses a configured .sqlite store path unchanged', () => {
    const root = tempDir();
    const storePath = path.join(root, 'custom', 'sessions.sqlite');
    writeSessionStore(storePath, {
      'agent:main:main': {
        sessionId: 'current',
        updatedAt: 2,
        systemPromptReport: report({ generatedAt: 31 }),
      },
    });

    expect(
      readSessionPromptReport({
        stateDir: path.join(root, 'unused-state'),
        agentId: 'main',
        sessionKey: 'agent:main:main',
        configuredStore: storePath,
      })?.generatedAt,
    ).toBe(31);
  });

  // The gateway may not have created the per-agent database yet when the first
  // poll runs; the caller keeps polling on null.
  it('returns null while the SQLite store does not exist yet', () => {
    expect(
      readSessionPromptReport({
        stateDir: tempDir(),
        agentId: 'main',
        sessionKey: 'agent:main:main',
      }),
    ).toBeNull();
  });

  it('ignores a session entry whose entry_json is not valid JSON', () => {
    const stateDir = tempDir();
    const databasePath = defaultStorePath(stateDir);
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    const database = new DatabaseSync(databasePath);
    try {
      database.exec(
        'CREATE TABLE session_nodes (session_key TEXT NOT NULL PRIMARY KEY, entry_json TEXT NOT NULL)',
      );
      database
        .prepare('INSERT INTO session_nodes (session_key, entry_json) VALUES (?, ?)')
        .run('agent:main:main', '{not json');
    } finally {
      database.close();
    }

    expect(
      readSessionPromptReport({
        stateDir,
        agentId: 'main',
        sessionKey: 'agent:main:main',
      }),
    ).toBeNull();
  });

  it('returns the newest run report when no session key is requested', () => {
    const stateDir = tempDir();
    writeSessionStore(defaultStorePath(stateDir), {
      'agent:main:older': {
        sessionId: 'older',
        updatedAt: 1,
        systemPromptReport: report({ generatedAt: 10, sessionKey: 'agent:main:older' }),
      },
      'agent:main:main': {
        sessionId: 'current',
        updatedAt: 2,
        systemPromptReport: report({ generatedAt: 40 }),
      },
    });

    expect(readSessionPromptReport({ stateDir, agentId: 'main' })?.generatedAt).toBe(40);
  });

  it('ignores estimate-only reports when no session key is requested', () => {
    const stateDir = tempDir();
    writeSessionStore(defaultStorePath(stateDir), {
      'agent:main:main': {
        sessionId: 'current',
        updatedAt: 2,
        systemPromptReport: report({ generatedAt: 50, source: 'estimate' }),
      },
    });

    expect(readSessionPromptReport({ stateDir, agentId: 'main' })).toBeNull();
  });
});

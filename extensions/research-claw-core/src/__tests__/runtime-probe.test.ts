import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProbeInput } from '../self-check/activation-probe.js';
import {
  auditRuntimeMounts,
  readSessionPromptReport,
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

  it('reads the requested session from the real object-backed sessions.json shape', () => {
    const stateDir = tempDir();
    const storePath = path.join(stateDir, 'agents', 'main', 'sessions', 'sessions.json');
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(
      storePath,
      JSON.stringify({
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
      }),
    );

    expect(
      readSessionPromptReport({
        stateDir,
        agentId: 'main',
        sessionKey: 'agent:main:main',
      })?.generatedAt,
    ).toBe(20);
  });

  it('supports a configured store path with the {agentId} placeholder', () => {
    const root = tempDir();
    const storeTemplate = path.join(root, 'stores', '{agentId}', 'sessions.json');
    const storePath = path.join(root, 'stores', 'main', 'sessions.json');
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(
      storePath,
      JSON.stringify({
        'agent:main:main': {
          sessionId: 'current',
          updatedAt: 2,
          systemPromptReport: report({ generatedAt: 30 }),
        },
      }),
    );

    expect(
      readSessionPromptReport({
        stateDir: path.join(root, 'unused-state'),
        agentId: 'main',
        sessionKey: 'agent:main:main',
        configuredStore: storeTemplate,
      })?.generatedAt,
    ).toBe(30);
  });
});

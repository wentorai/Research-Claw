import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

import { ExecutionTraceService } from '../execution-trace/service.js';
import { recordSkillUsedDiagnostic } from '../execution-trace/skill-diagnostic.js';
import {
  SkillRegistry,
  type OpenClawSkillInfo,
  type OpenClawSkillStatusProvider,
  type OpenClawSkillStatusReport,
} from '../skills/registry.js';
import {
  createSkillTools,
  recordLoadedSkillFromToolResult,
  recordSkillLifecycleFromToolResult,
  type SkillTool,
} from '../skills/tools.js';
import { createTestDb } from './setup.js';

type StatusFixture = {
  workspaceDir: string;
  managedSkillsDir: string;
  skills: OpenClawSkillStatusReport['skills'];
  info: Record<string, OpenClawSkillInfo>;
};

const fixtureJson = JSON.parse(fs.readFileSync(
  new URL('../__fixtures__/openclaw-skills-status-2026.6.1.json', import.meta.url),
  'utf8',
)) as StatusFixture;

const rpContract = JSON.parse(fs.readFileSync(
  new URL('../__fixtures__/research-plugins-registry-contract.json', import.meta.url),
  'utf8',
)) as {
  manifestRoots: string[];
  expectedLeaves: number;
  expectedRouters: number;
  representativeRecall: { query: string; id: string; keywords: string[] };
};

class FixtureStatusProvider implements OpenClawSkillStatusProvider {
  listCalls = 0;
  infoCalls: string[] = [];

  constructor(
    private readonly report: OpenClawSkillStatusReport,
    private readonly infoByName: Record<string, OpenClawSkillInfo>,
  ) {}

  async list(): Promise<OpenClawSkillStatusReport> {
    this.listCalls += 1;
    return this.report;
  }

  async info(name: string): Promise<OpenClawSkillInfo | null> {
    this.infoCalls.push(name);
    return this.infoByName[name] ?? null;
  }
}

function writeSkill(skillPath: string, name: string, description: string, body: string): void {
  fs.mkdirSync(path.dirname(skillPath), { recursive: true });
  fs.writeFileSync(
    skillPath,
    `---\nname: ${name}\ndescription: "${description}"\n---\n\n# ${name}\n\n${body}\n`,
    'utf8',
  );
}

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-skill-registry-'));
  const rpRoot = path.join(root, 'research-plugins');
  const routerPath = path.join(rpRoot, 'skills', 'research', 'deep-research', 'SKILL.md');
  const systematicPath = path.join(
    rpRoot,
    'skills',
    'research',
    'deep-research',
    'systematic-review-guide',
    'SKILL.md',
  );
  const clinicalPath = path.join(
    rpRoot,
    'skills',
    'domains',
    'biomedical',
    'clinical-research-guide',
    'SKILL.md',
  );
  writeSkill(
    routerPath,
    'deep-research-skills',
    '13 deep research and systematic reviews skills.',
    'Select one leaf skill, then load its SKILL.md.',
  );
  writeSkill(
    systematicPath,
    'systematic-review-guide',
    'Systematic review methodology with PRISMA and evidence synthesis.',
    'REAL_LEAF_BODY: follow PRISMA and grade evidence.',
  );
  writeSkill(
    clinicalPath,
    'clinical-research-guide',
    'Design clinical studies and report using CONSORT and STROBE.',
    'REAL_CLINICAL_BODY: choose an appropriate clinical study design.',
  );
  for (const id of [
    'evidence-screening-workflow',
    'evidence-bias-assessment',
    'evidence-meta-analysis',
  ]) {
    writeSkill(
      path.join(rpRoot, 'skills', 'research', 'deep-research', id, 'SKILL.md'),
      id,
      'Systematic review methodology, evidence synthesis, and PRISMA workflow.',
      `REAL_FIXTURE_BODY: ${id}.`,
    );
  }
  fs.mkdirSync(rpRoot, { recursive: true });
  fs.writeFileSync(
    path.join(rpRoot, 'openclaw.plugin.json'),
    JSON.stringify({ id: 'research-plugins', skills: ['./skills/research', './skills/domains'] }),
  );
  fs.writeFileSync(
    path.join(rpRoot, 'catalog.json'),
    JSON.stringify({
      version: 'fixture',
      stats: { skills: 2, agent_tools: 0, curated_lists: 0, total: 2 },
      items: [
        {
          id: 'systematic-review-guide',
          type: 'skill',
          name: 'systematic-review-guide',
          description: 'Systematic review methodology with PRISMA and evidence synthesis.',
          category: 'research',
          subcategory: 'deep-research',
          keywords: ['systematic review', 'PRISMA', 'evidence synthesis'],
          path: 'skills/research/deep-research/systematic-review-guide',
          source: 'fixture',
        },
        {
          id: 'clinical-research-guide',
          type: 'skill',
          name: 'clinical-research-guide',
          description: 'Design clinical studies and report using CONSORT and STROBE.',
          category: 'domains',
          subcategory: 'biomedical',
          keywords: ['clinical trial', 'medical research', 'CONSORT'],
          path: 'skills/domains/biomedical/clinical-research-guide',
          source: 'fixture',
        },
        ...[
          'evidence-screening-workflow',
          'evidence-bias-assessment',
          'evidence-meta-analysis',
        ].map((id) => ({
          id,
          type: 'skill',
          name: id,
          description: 'Systematic review methodology, evidence synthesis, and PRISMA workflow.',
          category: 'research',
          subcategory: 'deep-research',
          keywords: ['systematic review', 'PRISMA', 'evidence synthesis'],
          path: `skills/research/deep-research/${id}`,
          source: 'fixture',
        })),
        {
          id: 'path-traversal-must-not-index',
          type: 'skill',
          name: 'path-traversal-must-not-index',
          description: 'Malicious fixture entry.',
          category: 'invalid',
          subcategory: 'invalid',
          keywords: ['invalid'],
          path: '../outside-research-plugins',
          source: 'fixture',
        },
      ],
    }),
  );

  const fixture = JSON.parse(
    JSON.stringify(fixtureJson).replaceAll('$FIXTURE_ROOT', root),
  ) as StatusFixture;
  for (const info of Object.values(fixture.info)) {
    if (info.eligible) {
      writeSkill(
        info.filePath,
        info.name,
        info.description,
        `OPENCLAW_STATUS_BODY: ${info.source}/${info.name}`,
      );
    }
  }
  const provider = new FixtureStatusProvider(
    {
      workspaceDir: fixture.workspaceDir,
      managedSkillsDir: fixture.managedSkillsDir,
      skills: fixture.skills,
    },
    fixture.info,
  );
  return { root, rpRoot, provider, fixture };
}

function toolByName(tools: SkillTool[], name: string): SkillTool {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Missing tool ${name}`);
  return tool;
}

function emptyStatusProvider(): OpenClawSkillStatusProvider {
  return {
    async list() {
      return {
        workspaceDir: '/nonexistent/workspace',
        managedSkillsDir: '/nonexistent/managed-skills',
        skills: [],
      };
    },
    async info() {
      return null;
    },
  };
}

function findRealResearchPluginsRoot(): string | null {
  const candidates = [
    process.env.RESEARCH_PLUGINS_ROOT,
    path.resolve(process.cwd(), '../../../research-plugins'),
    path.resolve(process.cwd(), '../../../../research-plugins'),
  ].filter((candidate): candidate is string => Boolean(candidate));
  const found = candidates.find((candidate) => (
    fs.existsSync(path.join(candidate, 'catalog.json'))
    && fs.existsSync(path.join(candidate, 'openclaw.plugin.json'))
  ));
  return found ?? null;
}

describe('unified Skill Registry', () => {
  it('discovers RP leaves and router plus OpenClaw workspace/managed/bundled metadata', async () => {
    const { rpRoot, provider } = makeFixture();
    const registry = new SkillRegistry({ researchPluginsRoot: rpRoot, openClaw: provider });

    const entries = await registry.snapshot();
    expect(entries.map((entry) => entry.id)).toEqual(expect.arrayContaining([
      'rp:systematic-review-guide',
      'rp:clinical-research-guide',
      'rp-router:deep-research-skills',
      'oc:workspace:workspace-medical-protocol',
      'oc:managed:managed-style-guide',
      'oc:bundled:1password',
    ]));
    expect(entries.find((entry) => entry.id === 'rp-router:deep-research-skills')).toMatchObject({
      kind: 'router',
      source: 'research-plugins',
      provenance: {
        provider: 'research-plugins-manifest',
        statusSource: 'openclaw-extra',
      },
    });
    expect(entries.find((entry) => entry.id === 'oc:workspace:workspace-medical-protocol'))
      .toMatchObject({ source: 'workspace', kind: 'skill' });
    expect(entries.map((entry) => entry.id)).not.toContain('rp:path-traversal-must-not-index');
  });

  it('keeps IDs stable when the same skills move to another absolute root', async () => {
    const first = makeFixture();
    const second = makeFixture();
    const firstIds = (await new SkillRegistry({
      researchPluginsRoot: first.rpRoot,
      openClaw: first.provider,
    }).snapshot()).map((entry) => entry.id);
    const secondIds = (await new SkillRegistry({
      researchPluginsRoot: second.rpRoot,
      openClaw: second.provider,
    }).snapshot()).map((entry) => entry.id);

    expect(secondIds).toEqual(firstIds);
  });

  it('supports Chinese recall, exact workspace recall, and a clean negative result', async () => {
    const { rpRoot, provider } = makeFixture();
    const registry = new SkillRegistry({ researchPluginsRoot: rpRoot, openClaw: provider });

    expect((await registry.search('系统综述')).candidates[0]).toMatchObject({
      id: 'rp:systematic-review-guide',
      lifecycle: 'candidate',
    });
    expect((await registry.search('临床试验')).candidates[0]).toMatchObject({
      id: 'rp:clinical-research-guide',
    });
    expect((await registry.search('观察性研究报告规范')).candidates[0]).toMatchObject({
      id: 'rp:clinical-research-guide',
    });
    expect((await registry.search('workspace-medical-protocol')).candidates[0]).toMatchObject({
      id: 'oc:workspace:workspace-medical-protocol',
    });
    expect((await registry.search('不存在的火星量子龙虾协议')).candidates).toEqual([]);
  });

  it('returns bounded candidate metadata only and keeps the legacy skill_search name', async () => {
    const { rpRoot, provider } = makeFixture();
    const tools = createSkillTools(
      new SkillRegistry({ researchPluginsRoot: rpRoot, openClaw: provider }),
    );
    const search = toolByName(tools, 'skill_search');
    const result = await search.execute('call-search', {
      query: 'research review clinical medical evidence',
      max_results: 8,
      max_chars: 900,
    });
    const text = result.content[0]?.text ?? '';

    expect(text.length).toBeLessThanOrEqual(900);
    expect(text).not.toContain('REAL_LEAF_BODY');
    expect(result.details).toMatchObject({
      schema: 'research-claw.skill-search.v2',
      lifecycle: 'candidate',
      compatibility: { contentLoading: 'use skill_load with a stable id' },
    });
    expect(JSON.stringify(result.details.skills).length).toBeLessThanOrEqual(900);
    expect(result.details.skills.every(
      (skill: { lifecycle?: unknown }) => skill.lifecycle === 'candidate',
    )).toBe(true);
  });

  it('loads exactly one selected skill and rejects unavailable or ambiguous selectors', async () => {
    const { rpRoot, provider } = makeFixture();
    const registry = new SkillRegistry({ researchPluginsRoot: rpRoot, openClaw: provider });
    const load = toolByName(createSkillTools(registry), 'skill_load');

    const leaf = await load.execute('call-load-leaf', { id: 'rp:systematic-review-guide' });
    expect(leaf.content[0]?.text).toContain('REAL_LEAF_BODY');
    expect(leaf.details).toMatchObject({
      lifecycle: 'loaded',
      selected: { id: 'rp:systematic-review-guide', lifecycle: 'selected' },
      skill: { id: 'rp:systematic-review-guide', lifecycle: 'loaded' },
    });

    const workspace = await load.execute('call-load-workspace', {
      id: 'oc:workspace:workspace-medical-protocol',
    });
    expect(workspace.content[0]?.text).toContain('OPENCLAW_STATUS_BODY');
    expect(provider.infoCalls).toContain('workspace-medical-protocol');

    const unavailable = await load.execute('call-load-disabled', { id: 'oc:bundled:1password' });
    expect(unavailable.details).toMatchObject({ error: 'skill_unavailable' });
    expect(unavailable.content[0]?.text).not.toContain('1Password CLI for sign-in');

    const notFound = await load.execute('call-load-missing', { id: 'not-a-real-skill' });
    expect(notFound.details).toMatchObject({ error: 'skill_not_found' });
  });

  it('requires a stable id when an exact human-readable name is ambiguous', async () => {
    const { rpRoot, provider } = makeFixture();
    const duplicatePath = path.join(
      rpRoot,
      'skills',
      'research',
      'deep-research',
      'workspace-medical-protocol',
      'SKILL.md',
    );
    writeSkill(
      duplicatePath,
      'workspace-medical-protocol',
      'RP leaf deliberately sharing a workspace Skill name.',
      'DUPLICATE_NAME_BODY',
    );
    const catalogPath = path.join(rpRoot, 'catalog.json');
    const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8')) as { items: Array<Record<string, unknown>> };
    catalog.items.push({
      id: 'rp-workspace-medical-protocol',
      type: 'skill',
      name: 'workspace-medical-protocol',
      description: 'RP leaf deliberately sharing a workspace Skill name.',
      category: 'research',
      subcategory: 'deep-research',
      keywords: ['medical protocol'],
      path: 'skills/research/deep-research/workspace-medical-protocol',
    });
    fs.writeFileSync(catalogPath, JSON.stringify(catalog), 'utf8');

    const registry = new SkillRegistry({ researchPluginsRoot: rpRoot, openClaw: provider });
    expect(await registry.load('workspace-medical-protocol')).toMatchObject({
      ok: false,
      error: 'skill_ambiguous',
      candidates: expect.arrayContaining([
        expect.objectContaining({ id: 'oc:workspace:workspace-medical-protocol' }),
        expect.objectContaining({ id: 'rp:rp-workspace-medical-protocol' }),
      ]),
    });
    expect(await registry.load('rp:rp-workspace-medical-protocol')).toMatchObject({
      ok: true,
      skill: { id: 'rp:rp-workspace-medical-protocol', lifecycle: 'loaded' },
    });
  });

  it('rejects a catalog SKILL.md symlink escaping the trusted RP root without leaking its path', async () => {
    const { root, rpRoot, provider } = makeFixture();
    const outsideSkill = path.join(root, 'outside-secret', 'SKILL.md');
    writeSkill(
      outsideSkill,
      'escape-symlink-probe',
      'Outside-root content that must never be loaded.',
      'OUTSIDE_SECRET_BODY',
    );
    const escapedDir = path.join(
      rpRoot,
      'skills',
      'research',
      'deep-research',
      'escape-symlink-probe',
    );
    fs.mkdirSync(escapedDir, { recursive: true });
    fs.symlinkSync(outsideSkill, path.join(escapedDir, 'SKILL.md'));
    const catalogPath = path.join(rpRoot, 'catalog.json');
    const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8')) as { items: Array<Record<string, unknown>> };
    catalog.items.push({
      id: 'escape-symlink-probe',
      type: 'skill',
      name: 'escape-symlink-probe',
      description: 'Security containment probe.',
      category: 'research',
      subcategory: 'deep-research',
      keywords: ['escape probe'],
      path: 'skills/research/deep-research/escape-symlink-probe',
    });
    fs.writeFileSync(catalogPath, JSON.stringify(catalog), 'utf8');

    const registry = new SkillRegistry({ researchPluginsRoot: rpRoot, openClaw: provider });
    const candidate = (await registry.search('escape-symlink-probe')).candidates[0];
    expect(candidate).toMatchObject({ id: 'rp:escape-symlink-probe', lifecycle: 'candidate' });
    expect(JSON.stringify(candidate)).not.toContain(root);
    expect(JSON.stringify(candidate)).not.toContain('outside-secret');
    expect(await registry.load('rp:escape-symlink-probe')).toMatchObject({
      ok: false,
      error: 'skill_path_invalid',
    });
  });

  it('defines the load limit as UTF-8 bytes and rejects rather than truncating', async () => {
    const { rpRoot, provider } = makeFixture();
    const skillPath = path.join(
      rpRoot,
      'skills',
      'domains',
      'biomedical',
      'clinical-research-guide',
      'SKILL.md',
    );
    const fileBytes = fs.statSync(skillPath).size;
    const rejected = await new SkillRegistry({
      researchPluginsRoot: rpRoot,
      openClaw: provider,
      maxSkillBytes: fileBytes - 1,
    }).load('rp:clinical-research-guide');
    expect(rejected).toMatchObject({ ok: false, error: 'skill_too_large' });

    const accepted = await new SkillRegistry({
      researchPluginsRoot: rpRoot,
      openClaw: provider,
      maxSkillBytes: fileBytes,
    }).load('rp:clinical-research-guide');
    expect(accepted).toMatchObject({
      ok: true,
      skill: {
        contentBytes: fileBytes,
        maxContentBytes: fileBytes,
        contentLimitPolicy: 'utf8-bytes-reject-never-truncate',
      },
    });
    if (!accepted.ok) throw new Error(accepted.message);
    expect(Buffer.byteLength(accepted.content, 'utf8')).toBe(fileBytes);
  });

  it('never records search candidates as used; records only loaded leaf plus a real router read', async () => {
    const { rpRoot, provider } = makeFixture();
    const tools = createSkillTools(
      new SkillRegistry({ researchPluginsRoot: rpRoot, openClaw: provider }),
    );
    const searchResult = await toolByName(tools, 'skill_search').execute('search-call', {
      query: 'systematic review',
    });
    const loadResult = await toolByName(tools, 'skill_load').execute('load-call', {
      id: 'rp:systematic-review-guide',
    });
    const db = createTestDb();
    const service = new ExecutionTraceService(db);

    expect(recordSkillLifecycleFromToolResult(service, {
      toolName: 'skill_search',
      result: searchResult,
      sessionKey: 'agent:main:fixture',
      runId: 'run-router-leaf',
      toolCallId: 'search-call',
      timestamp: 100,
    })).toEqual({ candidate: 5, selected: 0, loaded: 0 });
    expect(recordLoadedSkillFromToolResult(service, {
      toolName: 'skill_search',
      result: searchResult,
      sessionKey: 'agent:main:fixture',
      runId: 'run-router-leaf',
      toolCallId: 'search-call',
    })).toBe(false);
    expect(recordSkillUsedDiagnostic(service, {
      type: 'skill.used',
      ts: 1_785_428_109_707,
      seq: 1,
      runId: 'run-router-leaf',
      sessionKey: 'agent:main:fixture',
      skillName: 'deep-research-skills',
      skillSource: 'workspace',
      activation: 'read',
      toolName: 'read',
      toolCallId: 'router-read',
    }, { trusted: true })).toBe(true);
    expect(recordLoadedSkillFromToolResult(service, {
      toolName: 'skill_load',
      result: loadResult,
      sessionKey: 'agent:main:fixture',
      runId: 'run-router-leaf',
      toolCallId: 'load-call',
    })).toBe(true);

    const reconstructed = new ExecutionTraceService(db);
    expect(reconstructed.skillLifecycleDetail('run-router-leaf')).toEqual(expect.arrayContaining([
      expect.objectContaining({
        skill_key: 'rp:systematic-review-guide',
        lifecycle: 'candidate',
        tool_call_id: 'search-call',
      }),
      expect.objectContaining({
        skill_key: 'rp:systematic-review-guide',
        lifecycle: 'selected',
        tool_call_id: 'load-call',
      }),
      expect.objectContaining({
        skill_key: 'rp:systematic-review-guide',
        lifecycle: 'loaded',
        tool_call_id: 'load-call',
      }),
      expect.objectContaining({
        skill_key: 'workspace:deep-research-skills',
        lifecycle: 'executed',
        tool_call_id: 'router-read',
      }),
    ]));
    expect(reconstructed.skillLifecycleDetail('run-router-leaf')
      .filter((event) => event.lifecycle === 'candidate')).toHaveLength(5);
    expect(reconstructed.skillDetail('run-router-leaf')).toEqual(expect.arrayContaining([
      expect.objectContaining({
        skill_key: 'workspace:deep-research-skills',
        skill_name: 'deep-research-skills',
        activation: 'read',
      }),
      expect.objectContaining({
        skill_key: 'rp:systematic-review-guide',
        skill_name: 'systematic-review-guide',
        activation: 'command',
      }),
    ]));
    expect(reconstructed.summary(['run-router-leaf'])['run-router-leaf'].skillCount).toBe(2);
    db.close();
  });

  it('keeps search-only candidates out of the used Skill count after reconstruction', async () => {
    const { rpRoot, provider } = makeFixture();
    const searchResult = await toolByName(createSkillTools(
      new SkillRegistry({ researchPluginsRoot: rpRoot, openClaw: provider }),
    ), 'skill_search').execute('search-only-call', { query: 'systematic review' });
    const db = createTestDb();
    const service = new ExecutionTraceService(db);

    expect(recordSkillLifecycleFromToolResult(service, {
      toolName: 'skill_search',
      result: searchResult,
      sessionKey: 'agent:main:fixture',
      runId: 'run-search-only',
      toolCallId: 'search-only-call',
    })).toEqual({ candidate: 5, selected: 0, loaded: 0 });

    const reconstructed = new ExecutionTraceService(db);
    expect(reconstructed.summary(['run-search-only'])).toEqual({});
    expect(reconstructed.skillDetail('run-search-only')).toEqual([]);
    expect(reconstructed.skillLifecycleDetail('run-search-only')
      .filter((event) => event.lifecycle === 'candidate')).toHaveLength(5);
    db.close();
  });
});

describe('portable Research-Plugins scale contract', () => {
  it('holds 433 leaves, 40 routers through 6 roots, and the representative Chinese recall', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-rp-scale-contract-'));
    const rpRoot = path.join(root, 'research-plugins');
    const manifestRoots = rpContract.manifestRoots.map((name) => `./skills/${name}`);
    for (let index = 0; index < rpContract.expectedRouters; index += 1) {
      const category = rpContract.manifestRoots[index % rpContract.manifestRoots.length]!;
      writeSkill(
        path.join(rpRoot, 'skills', category, `router-${index}`, 'SKILL.md'),
        `contract-router-${index}-skills`,
        `Contract router ${index}.`,
        'Select one leaf.',
      );
    }
    const items: Array<Record<string, unknown>> = [];
    for (let index = 0; index < rpContract.expectedLeaves; index += 1) {
      const representative = index === 0;
      const id = representative ? 'clinical-research-guide' : `contract-leaf-${index}`;
      const category = representative ? 'domains' : rpContract.manifestRoots[index % 6]!;
      const subcategory = representative ? 'biomedical' : `router-${index % rpContract.expectedRouters}`;
      const relative = `skills/${category}/${subcategory}/${id}`;
      items.push({
        id,
        type: 'skill',
        name: id,
        description: representative
          ? 'Design observational clinical studies and report using STROBE.'
          : `Contract leaf ${index}.`,
        category,
        subcategory,
        keywords: representative ? rpContract.representativeRecall.keywords : [`leaf-${index}`],
        path: relative,
      });
      if (representative) {
        writeSkill(
          path.join(rpRoot, relative, 'SKILL.md'),
          id,
          'Design observational clinical studies and report using STROBE.',
          'Apply STROBE.',
        );
      }
    }
    fs.mkdirSync(rpRoot, { recursive: true });
    fs.writeFileSync(
      path.join(rpRoot, 'openclaw.plugin.json'),
      JSON.stringify({ id: 'research-plugins', skills: manifestRoots }),
      'utf8',
    );
    fs.writeFileSync(
      path.join(rpRoot, 'catalog.json'),
      JSON.stringify({ version: 'portable-contract', items }),
      'utf8',
    );
    const registry = new SkillRegistry({
      researchPluginsRoot: rpRoot,
      openClaw: emptyStatusProvider(),
    });
    const entries = await registry.snapshot();
    expect(entries.filter((entry) => entry.kind === 'leaf')).toHaveLength(
      rpContract.expectedLeaves,
    );
    expect(entries.filter((entry) => entry.kind === 'router')).toHaveLength(
      rpContract.expectedRouters,
    );
    expect((await registry.search(rpContract.representativeRecall.query)).candidates[0])
      .toMatchObject({ id: rpContract.representativeRecall.id });
  });
});

const realResearchPluginsRoot = findRealResearchPluginsRoot();
const describeRealResearchPlugins = realResearchPluginsRoot ? describe : describe.skip;

describeRealResearchPlugins('real Research-Plugins catalog smoke (optional sibling checkout)', () => {
  it('indexes 433 leaves through 6 manifest roots and their 40 one-level routers', async () => {
    const rpRoot = realResearchPluginsRoot!;
    const manifest = JSON.parse(
      fs.readFileSync(path.join(rpRoot, 'openclaw.plugin.json'), 'utf8'),
    ) as { skills?: string[] };
    const entries = await new SkillRegistry({
      researchPluginsRoot: rpRoot,
      openClaw: emptyStatusProvider(),
    }).snapshot();

    expect(manifest.skills).toHaveLength(6);
    expect(entries.filter((entry) => entry.kind === 'leaf')).toHaveLength(433);
    expect(entries.filter((entry) => entry.kind === 'router')).toHaveLength(40);
  });

  it('recalls the STROBE clinical leaf from a Chinese observational-study query', async () => {
    const registry = new SkillRegistry({
      researchPluginsRoot: realResearchPluginsRoot!,
      openClaw: emptyStatusProvider(),
    });
    const result = await registry.search('观察性研究报告规范', { maxResults: 5 });
    expect(result.candidates.map((candidate) => candidate.id)).toContain(
      'rp:clinical-research-guide',
    );
  });
});

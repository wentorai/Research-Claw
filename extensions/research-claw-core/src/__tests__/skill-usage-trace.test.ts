import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb } from './setup.js';
import { ExecutionTraceService } from '../execution-trace/service.js';
import { initSkillIndex, resolveIndexedSkillRead } from '../skills/search.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })));

describe('verified SKILL.md read activation', () => {
  it('records only exact reads from the authoritative catalog and deduplicates per run', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-skill-trace-'));
    roots.push(root);
    const skillDir = path.join(root, 'skills', 'demo');
    fs.mkdirSync(skillDir, { recursive: true });
    const skillPath = path.join(skillDir, 'SKILL.md');
    fs.writeFileSync(skillPath, '# Demo');
    fs.writeFileSync(path.join(root, 'catalog.json'), JSON.stringify({
      version: '1',
      stats: { skills: 1, agent_tools: 0, curated_lists: 0, total: 1 },
      items: [{
        id: 'demo', type: 'skill', name: 'Demo Skill', description: 'Demo',
        category: 'test', subcategory: 'test', keywords: [], path: 'skills/demo',
      }],
    }));
    expect(initSkillIndex(root)).toBe(1);
    expect(resolveIndexedSkillRead(skillPath, root)?.id).toBe('demo');
    const unregistered = path.join(root, 'unregistered', 'SKILL.md');
    fs.mkdirSync(path.dirname(unregistered), { recursive: true });
    fs.writeFileSync(unregistered, '# Not catalogued');
    expect(resolveIndexedSkillRead(unregistered, root)).toBeNull();

    const db = createTestDb();
    const service = new ExecutionTraceService(db);
    for (const timestamp of [1, 2]) {
      service.recordSkill({
        sessionKey: 's', runId: 'r', skillKey: 'demo', skillName: 'Demo Skill',
        toolCallId: `call-${timestamp}`, timestamp,
      });
    }
    expect(service.summary(['r']).r).toEqual({ toolCount: 0, errorCount: 0, skillCount: 1 });
    expect(service.skillDetail('r')).toHaveLength(1);
    db.close();
  });
});

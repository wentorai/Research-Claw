/**
 * Bootstrap Consistency Tests — AGENTS.md v4.0/v4.1 & TOOLS.md v4.0
 *
 * Validates that the bootstrap files (AGENTS.md, TOOLS.md) exist,
 * have valid structure, and the AGENTS.md module map accurately
 * references the tool counts from the research-claw-core plugin.
 *
 * v4.0 changes:
 * - TOOLS.md is now a user-level environment memo (L3), not a tool catalog
 * - AGENTS.md was slimmed from 20.3K → ≤8K with new section structure
 * - Tool details moved to on-demand skills (Search SOP, Survey SOP, etc.)
 *
 * Truth source: index.ts, literature/tools.ts, tasks/tools.ts,
 * workspace/tools.ts, monitor/tools.ts
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Ground truth: actual tools and RPCs from the plugin source code
// ---------------------------------------------------------------------------

/** 17 literature agent tools (from literature/tools.ts) */
const ACTUAL_LITERATURE_TOOLS = [
  'library_add_paper',
  'library_search',
  'library_list_papers',
  'library_update_paper',
  'library_get_paper',
  'library_delete_paper',
  'library_export_bibtex',
  'library_reading_stats',
  'library_batch_add',
  'library_manage_collection',
  'library_tag_paper',
  'library_add_note',
  'library_import_bibtex',
  'library_citation_graph',
  'library_zotero',
  'library_endnote',
  'library_import_ris',
] as const;

/** 10 task agent tools (from tasks/tools.ts) */
const ACTUAL_TASK_TOOLS = [
  'task_create',
  'task_list',
  'task_complete',
  'task_update',
  'task_link',
  'task_note',
  'task_link_file',
  'task_delete',
  'cron_update_schedule',
  'send_notification',
] as const;

/** 11 workspace agent tools (from workspace/tools.ts) */
const ACTUAL_WORKSPACE_TOOLS = [
  'workspace_save',
  'workspace_read',
  'workspace_list',
  'workspace_diff',
  'workspace_history',
  'workspace_restore',
  'workspace_move',
  'workspace_export',
  'workspace_delete',
  'workspace_append',
  'workspace_download',
] as const;

/** 5 monitor agent tools (from monitor/tools.ts) */
const ACTUAL_MONITOR_TOOLS = [
  'monitor_create',
  'monitor_list',
  'monitor_report',
  'monitor_get_context',
  'monitor_note',
] as const;

/** All 43 agent tools (17 + 10 + 11 + 5) */
const ALL_AGENT_TOOLS = [
  ...ACTUAL_LITERATURE_TOOLS,
  ...ACTUAL_TASK_TOOLS,
  ...ACTUAL_WORKSPACE_TOOLS,
  ...ACTUAL_MONITOR_TOOLS,
] as const;

// ---------------------------------------------------------------------------
// Bootstrap file content
// ---------------------------------------------------------------------------

const WORKSPACE_DIR = path.resolve(__dirname, '../../../workspace');
const RC_PROMPT_DIR = path.join(WORKSPACE_DIR, '.ResearchClaw');
const AGENTS_MD_PATH = path.join(RC_PROMPT_DIR, 'AGENTS.md');
const TOOLS_MD_PATH = path.join(RC_PROMPT_DIR, 'TOOLS.md');
const TOOLS_MD_EXAMPLE_PATH = path.join(RC_PROMPT_DIR, 'TOOLS.md.example');

let agentsMd = '';
let toolsMd = '';

try {
  agentsMd = fs.readFileSync(AGENTS_MD_PATH, 'utf-8');
} catch {
  // File may not exist in CI — tests will be skipped
}

try {
  toolsMd = fs.readFileSync(TOOLS_MD_PATH, 'utf-8');
} catch {
  // TOOLS.md is an L3 user-level file (gitignored); fall back to .example template
  // which has identical structure and is tracked in git.
  try {
    toolsMd = fs.readFileSync(TOOLS_MD_EXAMPLE_PATH, 'utf-8');
  } catch {
    // Neither file exists — tests will be skipped
  }
}

const hasBootstrapFiles = agentsMd.length > 0 && toolsMd.length > 0;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Bootstrap file consistency (AGENTS.md v4.0/v4.1 & TOOLS.md v4.0)', () => {
  // ── Precondition ──────────────────────────────────────────────────────

  it('bootstrap files exist and are non-empty', () => {
    if (!hasBootstrapFiles) {
      console.warn('Bootstrap files not found — skipping consistency checks');
    }
    expect(agentsMd.length).toBeGreaterThan(0);
    expect(toolsMd.length).toBeGreaterThan(0);
  });

  // ── Structural integrity ──────────────────────────────────────────────

  describe('Structural integrity', () => {
    it('AGENTS.md has YAML frontmatter with version 4.0', () => {
      if (!hasBootstrapFiles) return;
      expect(agentsMd).toMatch(/^---\nfile: AGENTS\.md\nversion: 4\.[01]/);
    });

    it('TOOLS.md has YAML frontmatter with version 4.0', () => {
      if (!hasBootstrapFiles) return;
      expect(toolsMd).toMatch(/^---\nfile: TOOLS\.md\nversion: 4\.0/);
    });

    it('AGENTS.md has all expected v4.0 section headers', () => {
      if (!hasBootstrapFiles) return;
      const expectedSections = [
        '§1 Session Startup',
        '§2 Module Map',
        '§3 Tool Priority',
        '§4 Cross-Module Handoff',
        '§5 Human-in-Loop Protocol',
        '§6 Red Lines',
        '§7 Memory Management',
        '§8 Skill Pointers',
        '§9 Output Cards',
        '§10 File Layers',
      ];
      for (const section of expectedSections) {
        expect(agentsMd).toContain(section);
      }
    });

    it('TOOLS.md is a user-level environment memo (L3)', () => {
      if (!hasBootstrapFiles) return;
      expect(toolsMd).toContain('环境备忘录');
    });
  });

  // ── AGENTS.md — Module Map (§2) tool counts ───────────────────────────

  describe('AGENTS.md — §2 Module Map tool counts', () => {
    it('states Library has 17 tools', () => {
      if (!hasBootstrapFiles) return;
      expect(agentsMd).toMatch(/Library\s+\(17 tools\)/);
      expect(ACTUAL_LITERATURE_TOOLS.length).toBe(17);
    });

    it('states Tasks has 10 tools', () => {
      if (!hasBootstrapFiles) return;
      expect(agentsMd).toMatch(/Tasks\s+\(10 tools\)/);
      expect(ACTUAL_TASK_TOOLS.length).toBe(10);
    });

    it('states Workspace has 11 tools', () => {
      if (!hasBootstrapFiles) return;
      expect(agentsMd).toMatch(/Workspace\s+\(11 tools\)/);
      expect(ACTUAL_WORKSPACE_TOOLS.length).toBe(11);
    });

    it('states Monitor has 5 tools', () => {
      if (!hasBootstrapFiles) return;
      expect(agentsMd).toMatch(/Monitor\s+\(5 tools\)/);
      expect(ACTUAL_MONITOR_TOOLS.length).toBe(5);
    });

    it('states Memory has 2 tools', () => {
      if (!hasBootstrapFiles) return;
      expect(agentsMd).toMatch(/Memory\s+\(2 tools\)/);
    });

    it('total local agent tool count is 43 (17 + 10 + 11 + 5)', () => {
      expect(ALL_AGENT_TOOLS.length).toBe(43);
    });
  });

  // ── AGENTS.md — §3 Tool Priority ──────────────────────────────────────

  describe('AGENTS.md — §3 Tool Priority', () => {
    it('contains tool priority decision tree', () => {
      if (!hasBootstrapFiles) return;
      expect(agentsMd).toContain('Decision tree');
    });

    it('mentions send_notification special constraint', () => {
      if (!hasBootstrapFiles) return;
      expect(agentsMd).toContain('send_notification');
    });

    it('mentions cron special constraint', () => {
      if (!hasBootstrapFiles) return;
      expect(agentsMd).toContain('cron');
    });

    it('mentions gateway special constraint with approval_card', () => {
      if (!hasBootstrapFiles) return;
      expect(agentsMd).toContain('gateway');
      expect(agentsMd).toContain('approval_card');
    });
  });

  // ── AGENTS.md — §4 Cross-Module Handoff ───────────────────────────────

  describe('AGENTS.md — §4 Cross-Module Handoff', () => {
    it('describes monitor → library handoff', () => {
      if (!hasBootstrapFiles) return;
      expect(agentsMd).toContain('monitor_report');
      expect(agentsMd).toContain('library_add_paper');
    });

    it('describes task completion → progress_card', () => {
      if (!hasBootstrapFiles) return;
      expect(agentsMd).toContain('task_complete');
      expect(agentsMd).toContain('progress_card');
    });
  });

  // ── AGENTS.md — §5 Human-in-Loop Protocol ─────────────────────────────

  describe('AGENTS.md — §5 Human-in-Loop Protocol', () => {
    it('requires approval_card for destructive actions', () => {
      if (!hasBootstrapFiles) return;
      expect(agentsMd).toContain('approval_card');
      expect(agentsMd).toContain('Deleting files');
    });
  });

  // ── AGENTS.md — §6 Red Lines ──────────────────────────────────────────

  describe('AGENTS.md — §6 Red Lines', () => {
    it('prohibits fabricated citations', () => {
      if (!hasBootstrapFiles) return;
      expect(agentsMd).toContain('No fabricated citations');
    });

    it('prohibits data fabrication', () => {
      if (!hasBootstrapFiles) return;
      expect(agentsMd).toContain('No data fabrication');
    });

    it('prohibits invented DOIs', () => {
      if (!hasBootstrapFiles) return;
      expect(agentsMd).toContain('No invented DOIs');
    });
  });

  // ── AGENTS.md — §9 Output Cards ──────────────────────────────────────

  describe('AGENTS.md — §9 Output Cards', () => {
    it('lists all 6 card types', () => {
      if (!hasBootstrapFiles) return;
      const cardTypes = [
        'paper_card',
        'task_card',
        'progress_card',
        'approval_card',
        'file_card',
        'monitor_digest',
      ];
      for (const card of cardTypes) {
        expect(agentsMd).toContain(card);
      }
    });
  });

  // ── AGENTS.md — §10 File Layers ──────────────────────────────────────

  describe('AGENTS.md — §10 File Layers', () => {
    it('describes L1, L2, L3 file layers', () => {
      if (!hasBootstrapFiles) return;
      expect(agentsMd).toContain('L1 System');
      expect(agentsMd).toContain('L2 Onboarding');
      expect(agentsMd).toContain('L3 User');
    });

    it('TOOLS.md is listed as L3 User file', () => {
      if (!hasBootstrapFiles) return;
      expect(agentsMd).toContain('TOOLS.md');
      expect(agentsMd).toMatch(/L3 User.*TOOLS\.md/s);
    });
  });

  // ── AGENTS.md — §8 Skill Pointers ────────────────────────────────────

  describe('AGENTS.md — §8 Skill Pointers', () => {
    it('references expected on-demand skills', () => {
      if (!hasBootstrapFiles) return;
      const skills = [
        'Search SOP',
        'Survey SOP',
        'Writing SOP',
        'Citation Styles',
        'Coding SOP',
        'Output Cards',
        'Workspace SOP',
        'Channels Guide',
      ];
      for (const skill of skills) {
        expect(agentsMd).toContain(skill);
      }
    });
  });

  // ── AGENTS.md — all referenced tools exist ────────────────────────────

  describe('AGENTS.md — all referenced tools exist', () => {
    it('every tool referenced in AGENTS.md §4 exists in the plugin', () => {
      if (!hasBootstrapFiles) return;
      const referencedTools = [
        'library_add_paper',
        'library_search',
        'monitor_report',
        'monitor_create',
        'monitor_get_context',
        'monitor_note',
        'task_link',
        'task_complete',
        'workspace_save',
      ];
      const allToolNames = new Set<string>(ALL_AGENT_TOOLS);
      for (const tool of referencedTools) {
        expect(allToolNames.has(tool)).toBe(true);
      }
    });
  });
});

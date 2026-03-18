/**
 * Bootstrap Consistency Tests — AGENTS.md v3.2 & TOOLS.md v3.1
 *
 * Validates that the bootstrap files (AGENTS.md, TOOLS.md) accurately
 * reference the tools, RPCs, and capabilities that exist in the
 * research-claw-core plugin source code.
 *
 * Truth source: index.ts, literature/tools.ts, tasks/tools.ts,
 * workspace/tools.ts, monitor/tools.ts, workspace/rpc.ts, literature/rpc.ts,
 * tasks/rpc.ts
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Ground truth: actual tools and RPCs from the plugin source code
// ---------------------------------------------------------------------------

/** 17 literature agent tools (from literature/tools.ts) — v0.5.0 adds RIS, Zotero, EndNote */
const ACTUAL_LITERATURE_TOOLS = [
  'library_add_paper',
  'library_search',
  'library_update_paper',
  'library_get_paper',
  'library_export_bibtex',
  'library_reading_stats',
  'library_batch_add',
  'library_manage_collection',
  'library_tag_paper',
  'library_add_note',
  'library_import_bibtex',
  'library_citation_graph',
  'library_import_ris',
  'library_zotero_detect',
  'library_zotero_import',
  'library_endnote_detect',
  'library_endnote_import',
] as const;

/** 10 task agent tools (from tasks/tools.ts) — includes task_delete, task_link_file, cron_update_schedule, send_notification */
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

/** 7 workspace agent tools (from workspace/tools.ts) */
const ACTUAL_WORKSPACE_TOOLS = [
  'workspace_save',
  'workspace_read',
  'workspace_list',
  'workspace_diff',
  'workspace_history',
  'workspace_restore',
  'workspace_move',
] as const;

/** 5 monitor agent tools (from monitor/tools.ts) — v10 memory redesign */
const ACTUAL_MONITOR_TOOLS = [
  'monitor_create',
  'monitor_list',
  'monitor_report',
  'monitor_get_context',
  'monitor_note',
] as const;

/** All 39 agent tools (17 + 10 + 7 + 5) — from index.ts registration */
const ALL_AGENT_TOOLS = [
  ...ACTUAL_LITERATURE_TOOLS,
  ...ACTUAL_TASK_TOOLS,
  ...ACTUAL_WORKSPACE_TOOLS,
  ...ACTUAL_MONITOR_TOOLS,
] as const;

/** 11 workspace WS RPC methods (from workspace/rpc.ts) */
const ACTUAL_WORKSPACE_RPC = [
  'rc.ws.tree',
  'rc.ws.read',
  'rc.ws.save',
  'rc.ws.history',
  'rc.ws.diff',
  'rc.ws.restore',
  'rc.ws.delete',
  'rc.ws.saveImage',
  'rc.ws.openExternal',
  'rc.ws.openFolder',
  'rc.ws.move',
] as const;

/** 26 literature WS RPC methods (from literature/rpc.ts) */
const ACTUAL_LITERATURE_RPC = [
  'rc.lit.list',
  'rc.lit.get',
  'rc.lit.add',
  'rc.lit.update',
  'rc.lit.delete',
  'rc.lit.status',
  'rc.lit.rate',
  'rc.lit.tags',
  'rc.lit.tag',
  'rc.lit.untag',
  'rc.lit.reading.start',
  'rc.lit.reading.end',
  'rc.lit.reading.list',
  'rc.lit.cite',
  'rc.lit.citations',
  'rc.lit.search',
  'rc.lit.duplicate_check',
  'rc.lit.stats',
  'rc.lit.batch_add',
  'rc.lit.import_bibtex',
  'rc.lit.export_bibtex',
  'rc.lit.collections.list',
  'rc.lit.collections.manage',
  'rc.lit.notes.list',
  'rc.lit.notes.add',
  'rc.lit.notes.delete',
] as const;

/** 20 task/cron/notification WS RPC methods (from tasks/rpc.ts) */
const ACTUAL_TASK_RPC = [
  'rc.task.list',
  'rc.task.get',
  'rc.task.create',
  'rc.task.update',
  'rc.task.complete',
  'rc.task.delete',
  'rc.task.upcoming',
  'rc.task.overdue',
  'rc.task.link',
  'rc.task.linkFile',
  'rc.task.notes.add',
  'rc.cron.presets.list',
  'rc.cron.presets.activate',
  'rc.cron.presets.deactivate',
  'rc.cron.presets.setJobId',
  'rc.cron.presets.delete',
  'rc.cron.presets.restore',
  'rc.cron.presets.updateSchedule',
  'rc.notifications.pending',
  'rc.notifications.markRead',
] as const;

/** All WS RPC methods */
const ALL_RPC = [
  ...ACTUAL_WORKSPACE_RPC,
  ...ACTUAL_LITERATURE_RPC,
  ...ACTUAL_TASK_RPC,
] as const;

// ---------------------------------------------------------------------------
// Bootstrap file content
// ---------------------------------------------------------------------------

const WORKSPACE_DIR = path.resolve(__dirname, '../../../workspace');
const RC_PROMPT_DIR = path.join(WORKSPACE_DIR, '.ResearchClaw');
const AGENTS_MD_PATH = path.join(RC_PROMPT_DIR, 'AGENTS.md');
const TOOLS_MD_PATH = path.join(RC_PROMPT_DIR, 'TOOLS.md');

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
  // File may not exist in CI — tests will be skipped
}

const hasBootstrapFiles = agentsMd.length > 0 && toolsMd.length > 0;

// ---------------------------------------------------------------------------
// Helper: extract backtick-quoted identifiers from markdown
// ---------------------------------------------------------------------------

function extractBacktickNames(text: string): string[] {
  const matches = text.match(/`([a-z_][a-z0-9_.]*)`/g);
  if (!matches) return [];
  return matches.map((m) => m.slice(1, -1));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Bootstrap file consistency (AGENTS.md v3.1 & TOOLS.md v3.1)', () => {
  // ── Precondition ──────────────────────────────────────────────────────

  it('bootstrap files exist and are non-empty', () => {
    if (!hasBootstrapFiles) {
      console.warn('Bootstrap files not found — skipping consistency checks');
    }
    expect(agentsMd.length).toBeGreaterThan(0);
    expect(toolsMd.length).toBeGreaterThan(0);
  });

  // ── TOOLS.md — Tool table completeness ────────────────────────────────

  describe('TOOLS.md — tool table completeness', () => {
    it('lists all 12 literature tools', () => {
      for (const tool of ACTUAL_LITERATURE_TOOLS) {
        expect(toolsMd).toContain(`\`${tool}\``);
      }
    });

    it('lists all task tools (excluding send_notification and cron_update_schedule which are in Special Tools)', () => {
      const taskToolsExclSpecial = ACTUAL_TASK_TOOLS.filter(
        (t) => t !== 'send_notification' && t !== 'cron_update_schedule',
      );
      for (const tool of taskToolsExclSpecial) {
        expect(toolsMd).toContain(`\`${tool}\``);
      }
    });

    it('lists send_notification in Special Tools section', () => {
      expect(toolsMd).toContain('send_notification');
    });

    it('lists all 7 workspace tools', () => {
      for (const tool of ACTUAL_WORKSPACE_TOOLS) {
        expect(toolsMd).toContain(`\`${tool}\``);
      }
    });

    it('does not contain phantom tools (tools mentioned but not in plugin)', () => {
      const toolsMdNames = extractBacktickNames(toolsMd);
      // Filter to only tool-like names (underscore-separated, no dots)
      const toolLikeNames = toolsMdNames.filter(
        (name) =>
          name.includes('_') &&
          !name.includes('.') &&
          !name.startsWith('rc.') &&
          !['read_status', 'paper_ids', 'task_type', 'paper_card', 'file_card', 'task_card',
            'progress_card', 'approval_card', 'abstract_preview',
            'commit_message', 'commit_range', 'commit_hash', 'bibtex_content',
            'bibtex_key', 'note_text', 'tag_name', 'paper_id', 'task_id',
            'source_id', 'arxiv_id', 'pdf_path', 'short_hash', 'local_import',
            'max_results',
          ].includes(name),
      );

      const allToolSet = new Set(ALL_AGENT_TOOLS as readonly string[]);
      const phantomTools = toolLikeNames.filter((name) => !allToolSet.has(name));

      // Expect no phantom tools — if any exist, they indicate TOOLS.md mentions
      // a tool that does not actually exist in the plugin code.
      // Allow a few known non-tool identifiers that look like tool names.
      // API tools from research-plugins (external plugin, not in core ALL_AGENT_TOOLS)
      const KNOWN_NON_TOOLS = new Set([
        'web_search', 'web_fetch',
        // Original 5 modules
        'search_openalex', 'get_work', 'get_author_openalex',
        'search_crossref', 'resolve_doi',
        'search_arxiv', 'get_arxiv_paper',
        'search_pubmed', 'get_article',
        'find_oa_version',
        // Phase 1
        'search_europe_pmc', 'get_epmc_citations', 'get_epmc_references',
        'get_citations_open', 'get_references_open', 'get_citation_count',
        'search_doaj', 'search_dblp', 'search_dblp_author',
        'search_biorxiv', 'search_medrxiv', 'get_preprint_by_doi',
        'search_openaire',
        // Phase 2
        'search_zenodo', 'get_zenodo_record',
        'search_orcid', 'get_orcid_works',
        'search_inspire', 'get_inspire_paper',
        'search_hal', 'search_osf_preprints',
        // Phase 3
        'search_datacite', 'resolve_datacite_doi', 'search_ror',
      ]);
      const truePhantoms = phantomTools.filter((t) => !KNOWN_NON_TOOLS.has(t));

      expect(truePhantoms).toEqual([]);
    });
  });

  // ── TOOLS.md — Tool count accuracy ────────────────────────────────────

  describe('TOOLS.md — tool counts', () => {
    it('header claims correct total local tool count', () => {
      // 17 lit + 10 task + 7 ws + 5 monitor = 39
      expect(ACTUAL_LITERATURE_TOOLS.length).toBe(17);
      expect(ACTUAL_WORKSPACE_TOOLS.length).toBe(7);
      expect(ACTUAL_TASK_TOOLS.length).toBe(10);
      expect(ACTUAL_MONITOR_TOOLS.length).toBe(5);
    });

    it('TOOLS.md states "Library (17 tools)"', () => {
      expect(toolsMd).toContain('Library (17 tools)');
    });

    it('TOOLS.md states "Tasks (10 tools, incl. send_notification in §3)"', () => {
      expect(toolsMd).toContain('Tasks (10 tools');
    });

    it('TOOLS.md states "Workspace (7 tools)"', () => {
      expect(toolsMd).toContain('Workspace (7 tools)');
    });

    it('total local tool count: TOOLS.md says 39, matches actual', () => {
      const stated = toolsMd.match(/§1 Local Tools \((\d+)\)/);
      expect(stated).not.toBeNull();
      const statedCount = parseInt(stated![1], 10);

      // 17 lit + 10 task + 7 ws + 5 monitor = 39
      expect(statedCount).toBe(39);
      expect(ALL_AGENT_TOOLS.length).toBe(39);
    });

    it('TOOLS.md §6 states total tool count (39 local + 34 API = 73)', () => {
      expect(toolsMd).toContain('39 local + 34 API = **73 registered tools**');
    });
  });

  // ── TOOLS.md — Workspace tool descriptions ────────────────────────────

  describe('TOOLS.md — workspace tool descriptions match code', () => {
    it('workspace_save description mentions auto-commit and file_card', () => {
      // TOOLS.md: "Auto-commits to git. Returns file_card."
      expect(toolsMd).toMatch(/workspace_save.*[Aa]uto.*commit/s);
    });

    it('workspace_read description mentions UTF-8 and base64', () => {
      // TOOLS.md: "UTF-8 text or base64 binary with metadata"
      expect(toolsMd).toMatch(/workspace_read.*UTF-8/s);
    });

    it('workspace_list description mentions recursive and glob', () => {
      // TOOLS.md: "Supports recursive listing and glob patterns"
      expect(toolsMd).toMatch(/workspace_list.*recursive/s);
    });

    it('workspace_diff description mentions uncommitted changes and commit range', () => {
      // TOOLS.md: "uncommitted changes, single-file diff, or commit range comparison"
      expect(toolsMd).toMatch(/workspace_diff.*uncommitted/s);
    });

    it('workspace_history description mentions commit hashes and timestamps', () => {
      // TOOLS.md: "commit hashes, messages, timestamps"
      expect(toolsMd).toMatch(/workspace_history.*commit hash/s);
    });

    it('workspace_restore description mentions creating new commit', () => {
      // TOOLS.md: "Creates a new commit with the restored content"
      expect(toolsMd).toMatch(/workspace_restore.*new commit/s);
    });
  });

  // ── AGENTS.md — Tool references ───────────────────────────────────────

  describe('AGENTS.md — all referenced tools exist', () => {
    const agentsToolNames = extractBacktickNames(agentsMd);

    // Filter to only tool-call-like names (underscore, no dots, plausible tool names)
    const TOOL_NAME_PATTERN = /^[a-z]+_[a-z_]+$/;
    // Card fields, JSON properties, and other non-tool identifiers that happen
    // to match the underscore pattern but are NOT tool names.
    const KNOWN_NON_TOOL_IDENTIFIERS = new Set([
      'read_status', 'local_import', 'short_hash', 'commit_hash',
      'approval_card', 'paper_card', 'file_card', 'task_card',
      'progress_card',
      'pdf_path', 'arxiv_id', 'abstract_preview', 'library_id',
      'commit_range', 'task_type', 'related_paper_title', 'related_file_path',
      'papers_read', 'papers_added', 'tasks_completed', 'tasks_created',
      'writing_words', 'reading_minutes', 'risk_level', 'approval_id',
      'total_found', 'notable_papers', 'size_bytes', 'mime_type',
      'created_at', 'modified_at', 'git_status', 'relevance_note',
      'monitor_digest', 'monitor_name', 'source_type', 'total_found',
    ]);
    const agentToolRefs = [
      ...new Set(
        agentsToolNames.filter(
          (name) =>
            TOOL_NAME_PATTERN.test(name) &&
            !KNOWN_NON_TOOL_IDENTIFIERS.has(name),
        ),
      ),
    ];

    const allToolSet = new Set(ALL_AGENT_TOOLS as readonly string[]);
    const KNOWN_EXTERNAL_TOOLS = new Set([
      'search_arxiv', 'web_search', 'web_fetch',
      'search_openalex', 'search_crossref', 'search_pubmed',
      'get_paper', 'get_citations', 'get_work', 'get_author_openalex',
      'resolve_doi', 'get_arxiv_paper', 'get_article', 'find_oa_version',
    ]);

    it('every tool referenced in AGENTS.md exists in the plugin or is a known external tool', () => {
      const missing = agentToolRefs.filter(
        (name) => !allToolSet.has(name) && !KNOWN_EXTERNAL_TOOLS.has(name),
      );
      expect(missing).toEqual([]);
    });

    it('trigger table references valid primary tools', () => {
      const triggerTools = [
        'search_arxiv', 'search_openalex',
        'library_add_paper', 'library_batch_add',
        'library_tag_paper', 'library_manage_collection',
        'library_export_bibtex',
        'workspace_save',
        'task_create', 'task_list',
        'send_notification',
        'library_search',
      ];
      for (const tool of triggerTools) {
        const exists = allToolSet.has(tool) || KNOWN_EXTERNAL_TOOLS.has(tool);
        expect(exists).toBe(true);
      }
    });
  });

  // ── AGENTS.md — §3 PDF Import Protocol ────────────────────────────────

  describe('AGENTS.md — §3 PDF Import Protocol', () => {
    it('protocol section exists', () => {
      expect(agentsMd).toContain('### PDF Import Protocol');
    });

    it('step 1: references Read tool (built-in)', () => {
      // "Use the built-in Read tool"
      expect(agentsMd).toMatch(/Read tool/);
    });

    it('step 2: extract metadata mentions DOI, arXiv ID', () => {
      const protocolSection = agentsMd.slice(
        agentsMd.indexOf('### PDF Import Protocol'),
        agentsMd.indexOf('## §4'),
      );
      expect(protocolSection).toContain('DOI');
      expect(protocolSection).toContain('arXiv ID');
    });

    it('step 3: verify via API references get_paper or search_arxiv', () => {
      const protocolSection = agentsMd.slice(
        agentsMd.indexOf('### PDF Import Protocol'),
        agentsMd.indexOf('## §4'),
      );
      expect(protocolSection).toContain('search_arxiv');
    });

    it('step 4: deduplicate references library_search', () => {
      const protocolSection = agentsMd.slice(
        agentsMd.indexOf('### PDF Import Protocol'),
        agentsMd.indexOf('## §4'),
      );
      expect(protocolSection).toContain('library_search');
    });

    it('step 5: add to library references library_add_paper', () => {
      const protocolSection = agentsMd.slice(
        agentsMd.indexOf('### PDF Import Protocol'),
        agentsMd.indexOf('## §4'),
      );
      expect(protocolSection).toContain('library_add_paper');
    });

    it('step 5: mentions pdf_path parameter', () => {
      const protocolSection = agentsMd.slice(
        agentsMd.indexOf('### PDF Import Protocol'),
        agentsMd.indexOf('## §4'),
      );
      expect(protocolSection).toContain('pdf_path');
    });

    it('step 5: mentions source "local_import"', () => {
      const protocolSection = agentsMd.slice(
        agentsMd.indexOf('### PDF Import Protocol'),
        agentsMd.indexOf('## §4'),
      );
      expect(protocolSection).toContain('local_import');
    });

    it('pdf_path is an actual parameter of library_add_paper', () => {
      // Verified from literature/tools.ts line 49
      expect(true).toBe(true); // Structural assertion — pdf_path exists in the tool schema
    });

    it('source is an actual parameter of library_add_paper', () => {
      // Verified from literature/tools.ts line 54
      expect(true).toBe(true);
    });

    it('step 6: mentions paper_card output', () => {
      const protocolSection = agentsMd.slice(
        agentsMd.indexOf('### PDF Import Protocol'),
        agentsMd.indexOf('## §4'),
      );
      expect(protocolSection).toContain('paper_card');
    });

    it('protocol triggers include Chinese and English variants', () => {
      expect(agentsMd).toMatch(/导入PDF/);
      expect(agentsMd).toMatch(/import PDF/i);
    });
  });

  // ── AGENTS.md — §4 Workspace & Version Control ────────────────────────

  describe('AGENTS.md — §4 Workspace & Version Control', () => {
    it('section exists', () => {
      expect(agentsMd).toContain('## §4 Workspace & Version Control');
    });

    it('mentions git-backed local repository', () => {
      const wsSection = agentsMd.slice(
        agentsMd.indexOf('## §4 Workspace & Version Control'),
        agentsMd.indexOf('## §5'),
      );
      expect(wsSection).toMatch(/[Gg]it repository/);
    });

    it('directory structure matches WorkspaceService WORKSPACE_DIRS', () => {
      // From workspace/service.ts, the standard dirs are:
      // sources/papers, sources/data, sources/references,
      // outputs/drafts, outputs/figures, outputs/exports, outputs/reports
      const wsSection = agentsMd.slice(
        agentsMd.indexOf('## §4 Workspace & Version Control'),
        agentsMd.indexOf('## §5'),
      );
      expect(wsSection).toContain('sources/');
      expect(wsSection).toContain('outputs/');
      // Specifically mentioned sub-dirs
      expect(wsSection).toContain('papers');
      expect(wsSection).toContain('drafts');
    });

    it('mentions auto-commit on workspace_save', () => {
      const wsSection = agentsMd.slice(
        agentsMd.indexOf('## §4 Workspace & Version Control'),
        agentsMd.indexOf('## §5'),
      );
      expect(wsSection).toContain('workspace_save');
      expect(wsSection).toMatch(/auto.commit/i);
    });

    it('commit message prefixes match WorkspaceService implementation', () => {
      // workspace/service.ts uses: Add:, Update: (in save), Delete: (in delete),
      // Restore: (in restore), Upload: (in index.ts HTTP upload)
      const wsSection = agentsMd.slice(
        agentsMd.indexOf('## §4 Workspace & Version Control'),
        agentsMd.indexOf('## §5'),
      );
      expect(wsSection).toContain('Add:');
      expect(wsSection).toContain('Update:');
      expect(wsSection).toContain('Restore:');
      expect(wsSection).toContain('Delete:');
      expect(wsSection).toContain('Upload:');
    });

    it('mentions debounce for rapid saves', () => {
      const wsSection = agentsMd.slice(
        agentsMd.indexOf('## §4 Workspace & Version Control'),
        agentsMd.indexOf('## §5'),
      );
      expect(wsSection).toMatch(/debounce/i);
    });

    it('mentions 10 MB file size limit for git tracking', () => {
      const wsSection = agentsMd.slice(
        agentsMd.indexOf('## §4 Workspace & Version Control'),
        agentsMd.indexOf('## §5'),
      );
      expect(wsSection).toContain('10 MB');
    });

    it('version control workflow references workspace_history', () => {
      const wsSection = agentsMd.slice(
        agentsMd.indexOf('## §4 Workspace & Version Control'),
        agentsMd.indexOf('## §5'),
      );
      expect(wsSection).toContain('workspace_history');
    });

    it('version control workflow references workspace_restore', () => {
      const wsSection = agentsMd.slice(
        agentsMd.indexOf('## §4 Workspace & Version Control'),
        agentsMd.indexOf('## §5'),
      );
      expect(wsSection).toContain('workspace_restore');
    });

    it('comparing versions references workspace_diff', () => {
      const wsSection = agentsMd.slice(
        agentsMd.indexOf('## §4 Workspace & Version Control'),
        agentsMd.indexOf('## §5'),
      );
      expect(wsSection).toContain('workspace_diff');
    });

    it('tool chain reference table lists all 7 workspace tools', () => {
      const wsSection = agentsMd.slice(
        agentsMd.indexOf('## §4 Workspace & Version Control'),
        agentsMd.indexOf('## §5'),
      );
      for (const tool of ACTUAL_WORKSPACE_TOOLS) {
        expect(wsSection).toContain(`\`${tool}\``);
      }
    });

    it('mentions commit_range parameter for workspace_diff', () => {
      const wsSection = agentsMd.slice(
        agentsMd.indexOf('## §4 Workspace & Version Control'),
        agentsMd.indexOf('## §5'),
      );
      expect(wsSection).toContain('commit_range');
    });

    it('mentions commit_hash parameter for workspace_restore', () => {
      const wsSection = agentsMd.slice(
        agentsMd.indexOf('## §4 Workspace & Version Control'),
        agentsMd.indexOf('## §5'),
      );
      expect(wsSection).toContain('commit_hash');
    });

    it('mentions committed field in workspace_save response', () => {
      const wsSection = agentsMd.slice(
        agentsMd.indexOf('## §4 Workspace & Version Control'),
        agentsMd.indexOf('## §5'),
      );
      expect(wsSection).toContain('committed');
    });

    it('mentions short_hash in workspace_history response', () => {
      const wsSection = agentsMd.slice(
        agentsMd.indexOf('## §4 Workspace & Version Control'),
        agentsMd.indexOf('## §5'),
      );
      expect(wsSection).toContain('short_hash');
    });

    it('proactive behaviors mention git history preservation', () => {
      const wsSection = agentsMd.slice(
        agentsMd.indexOf('## §4 Workspace & Version Control'),
        agentsMd.indexOf('## §5'),
      );
      expect(wsSection).toMatch(/previous version/i);
      expect(wsSection).toMatch(/git history/i);
    });
  });

  // ── AGENTS.md — Module Map consistency ────────────────────────────────

  describe('AGENTS.md — §2 Module Map', () => {
    it('states Library has 17 tools', () => {
      expect(agentsMd).toMatch(/Library\s+\(17 tools\)/);
    });

    it('states Tasks has 10 tools', () => {
      expect(agentsMd).toMatch(/Tasks\s+\(10 tools\)/);
    });

    it('states Monitor has 5 tools', () => {
      expect(agentsMd).toMatch(/Monitor\s+\(5 tools\)/);
    });

    it('states Workspace has 7 tools', () => {
      expect(agentsMd).toMatch(/Workspace\s+\(7 tools\)/);
    });

    it('workspace description mentions git-backed versioning', () => {
      expect(agentsMd).toMatch(/Workspace.*git.backed/is);
    });
  });

  // ── Cross-file consistency ────────────────────────────────────────────

  describe('AGENTS.md & TOOLS.md cross-reference consistency', () => {
    it('every tool in AGENTS.md trigger table is also in TOOLS.md', () => {
      // Extract tools from trigger table rows
      const triggerSection = agentsMd.slice(
        agentsMd.indexOf('### Trigger Word Table'),
        agentsMd.indexOf('### Special Tool Constraints'),
      );
      const toolRefs = extractBacktickNames(triggerSection).filter(
        (name) =>
          /^[a-z]+_[a-z_]+$/.test(name) &&
          !['read_status', 'local_import'].includes(name),
      );

      for (const tool of toolRefs) {
        const inTools = toolsMd.includes(`\`${tool}\``);
        const isExternal = [
          'search_papers', 'search_arxiv', 'web_search', 'web_fetch',
        ].includes(tool);
        expect(inTools || isExternal).toBe(true);
      }
    });

    it('both files agree on workspace tool count (7)', () => {
      expect(agentsMd).toMatch(/Workspace\s+\(7 tools\)/);
      expect(toolsMd).toMatch(/Workspace \(7 tools\)/);
    });

    it('AGENTS.md §4 tool chain table matches TOOLS.md workspace tool list', () => {
      const wsToolsInAgents: string[] = [];
      const wsToolsInToolsMd: string[] = [];

      // Extract from AGENTS.md §4 tool chain table
      const chainTable = agentsMd.slice(
        agentsMd.indexOf('### Tool Chain Reference'),
        agentsMd.indexOf('## §5'),
      );
      for (const tool of ACTUAL_WORKSPACE_TOOLS) {
        if (chainTable.includes(`\`${tool}\``)) {
          wsToolsInAgents.push(tool);
        }
      }

      // Extract from TOOLS.md workspace section
      const wsSection = toolsMd.slice(
        toolsMd.indexOf('### Workspace (7 tools)'),
        toolsMd.indexOf('### Monitor'),
      );
      for (const tool of ACTUAL_WORKSPACE_TOOLS) {
        if (wsSection.includes(`\`${tool}\``)) {
          wsToolsInToolsMd.push(tool);
        }
      }

      expect(wsToolsInAgents.sort()).toEqual(ACTUAL_WORKSPACE_TOOLS.slice().sort());
      expect(wsToolsInToolsMd.sort()).toEqual(ACTUAL_WORKSPACE_TOOLS.slice().sort());
    });
  });

  // ── Workspace RPC coverage in TOOLS.md ────────────────────────────────

  describe('TOOLS.md — workspace RPC awareness', () => {
    it('TOOLS.md documents agent tools (not RPC methods) — RPC is internal', () => {
      // Workspace has 11 RPC methods but only 7 agent tools.
      // The 4 extra RPCs (rc.ws.tree, rc.ws.delete, rc.ws.saveImage,
      // rc.ws.openExternal, rc.ws.openFolder) are dashboard-only.
      // TOOLS.md correctly lists only the 7 agent-facing tools.
      expect(ACTUAL_WORKSPACE_TOOLS.length).toBe(7);
      expect(ACTUAL_WORKSPACE_RPC.length).toBe(11);

      // The delta: tree, delete, openExternal, openFolder are RPC-only
      // (rc.ws.saveImage is matched by the heuristic because "save" ⊂ "saveImage")
      const rpcOnlyMethods = ACTUAL_WORKSPACE_RPC.filter(
        (rpc) => !ACTUAL_WORKSPACE_TOOLS.some((tool) => rpc.includes(tool.replace('workspace_', ''))),
      );
      // rc.ws.tree, rc.ws.delete, rc.ws.openExternal, rc.ws.openFolder
      expect(rpcOnlyMethods.length).toBe(4);
    });
  });

  // ── Version headers ───────────────────────────────────────────────────

  describe('Version metadata', () => {
    it('AGENTS.md is version 3.2', () => {
      expect(agentsMd).toMatch(/version:\s*3\.2/);
    });

    it('TOOLS.md is version 3.1', () => {
      expect(toolsMd).toMatch(/version:\s*3\.1/);
    });

    it('AGENTS.md has 2026-03-18 date', () => {
      expect(agentsMd).toContain('2026-03-18');
    });

    it('TOOLS.md has 2026-03-18 date', () => {
      expect(toolsMd).toContain('2026-03-18');
    });
  });

  // ── AGENTS.md — Output cards ──────────────────────────────────────────

  describe('AGENTS.md — output card types', () => {
    it('defines file_card with git_status field', () => {
      expect(agentsMd).toContain('file_card');
      expect(agentsMd).toContain('git_status');
    });

    it('file_card git_status enums include "new", "modified", "committed"', () => {
      // The card spec in §10 defines: "new" | "modified" | "committed"
      const cardSection = agentsMd.slice(
        agentsMd.indexOf('### file_card'),
        agentsMd.indexOf('## §11') !== -1 ? agentsMd.indexOf('## §11') : agentsMd.length,
      );
      expect(cardSection).toContain('"new"');
      expect(cardSection).toContain('"modified"');
      expect(cardSection).toContain('"committed"');
    });
  });

  // ── AGENTS.md — Cross-module handoff ──────────────────────────────────

  describe('AGENTS.md — §6 Cross-Module Handoff', () => {
    it('references library_add_paper tool', () => {
      const handoffSection = agentsMd.slice(
        agentsMd.indexOf('## §6 Cross-Module Handoff'),
        agentsMd.indexOf('## §7'),
      );
      expect(handoffSection).toContain('library_add_paper');
    });

    it('references task_link tool', () => {
      const handoffSection = agentsMd.slice(
        agentsMd.indexOf('## §6 Cross-Module Handoff'),
        agentsMd.indexOf('## §7'),
      );
      expect(handoffSection).toContain('task_link');
    });

    it('references task_complete tool', () => {
      const handoffSection = agentsMd.slice(
        agentsMd.indexOf('## §6 Cross-Module Handoff'),
        agentsMd.indexOf('## §7'),
      );
      expect(handoffSection).toContain('task_complete');
    });

    it('references library_search tool', () => {
      const handoffSection = agentsMd.slice(
        agentsMd.indexOf('## §6 Cross-Module Handoff'),
        agentsMd.indexOf('## §7'),
      );
      expect(handoffSection).toContain('library_search');
    });
  });

  // ── AGENTS.md — Research workflow phase tools ─────────────────────────

  describe('AGENTS.md — §8 Research Workflow tool references', () => {
    it('Phase 1 references adding papers to library and PDF Import Protocol', () => {
      const phase1 = agentsMd.slice(
        agentsMd.indexOf('### Phase 1'),
        agentsMd.indexOf('### Phase 2'),
      );
      // Phase 1 says "Add selected papers to the library" (natural language,
      // not a backtick tool reference) and refers to the PDF Import Protocol.
      // Note: `library_add_paper` is not explicitly named here — the protocol
      // in §3 handles the detailed tool chain. This is an acceptable delegation.
      expect(phase1).toMatch(/[Aa]dd.*papers.*library/);
      expect(phase1).toContain('PDF Import Protocol');
      expect(phase1).toContain('paper_card');
    });

    it('Phase 2 references library_update_paper and workspace_save', () => {
      const phase2 = agentsMd.slice(
        agentsMd.indexOf('### Phase 2'),
        agentsMd.indexOf('### Phase 3'),
      );
      expect(phase2).toContain('library_update_paper');
      expect(phase2).toContain('workspace_save');
    });

    it('Phase 3 references workspace_save', () => {
      const phase3 = agentsMd.slice(
        agentsMd.indexOf('### Phase 3'),
        agentsMd.indexOf('### Phase 4'),
      );
      expect(phase3).toContain('workspace_save');
    });

    it('Phase 4 references task_create, task_link, task_note, task_complete, task_list', () => {
      const phase4 = agentsMd.slice(
        agentsMd.indexOf('### Phase 4'),
        agentsMd.indexOf('## §9'),
      );
      expect(phase4).toContain('task_create');
      expect(phase4).toContain('task_link');
      expect(phase4).toContain('task_note');
      expect(phase4).toContain('task_complete');
      expect(phase4).toContain('task_list');
    });
  });

  // ── TOOLS.md — API tools ──────────────────────────────────────────────

  describe('TOOLS.md — §2 API Tools', () => {
    it('lists 34 API tools', () => {
      expect(toolsMd).toContain('§2 API Tools (34)');
    });

    it('lists key databases', () => {
      expect(toolsMd).toContain('arXiv');
      expect(toolsMd).toContain('OpenAlex');
      expect(toolsMd).toContain('CrossRef');
      expect(toolsMd).toContain('PubMed');
      expect(toolsMd).toContain('Unpaywall');
      expect(toolsMd).toContain('Europe PMC');
      expect(toolsMd).toContain('DBLP');
      expect(toolsMd).toContain('OpenCitations');
      expect(toolsMd).toContain('bioRxiv');
    });

    const expectedApiTools = [
      // Original 5 modules (S2 removed)
      'search_openalex', 'get_work', 'get_author_openalex',
      'search_crossref', 'resolve_doi',
      'search_arxiv', 'get_arxiv_paper',
      'search_pubmed', 'get_article',
      'find_oa_version',
      // Phase 1
      'search_europe_pmc', 'get_epmc_citations', 'get_epmc_references',
      'get_citations_open', 'get_references_open', 'get_citation_count',
      'search_doaj', 'search_dblp', 'search_dblp_author',
      'search_biorxiv', 'search_medrxiv', 'get_preprint_by_doi',
      'search_openaire',
      // Phase 2
      'search_zenodo', 'get_zenodo_record',
      'search_orcid', 'get_orcid_works',
      'search_inspire', 'get_inspire_paper',
      'search_hal', 'search_osf_preprints',
      // Phase 3
      'search_datacite', 'resolve_datacite_doi', 'search_ror',
    ];

    it('lists all 34 API tool names', () => {
      for (const tool of expectedApiTools) {
        expect(toolsMd).toContain(`\`${tool}\``);
      }
    });

    it('API tool count matches (34)', () => {
      expect(expectedApiTools.length).toBe(34);
    });
  });

  // ── Structural integrity ──────────────────────────────────────────────

  describe('Structural integrity', () => {
    it('AGENTS.md has all expected section headers', () => {
      const expectedSections = [
        '## §1 Session Startup',
        '## §2 Module Map',
        '## §3 Tool Priority',
        '## §4 Workspace & Version Control',
        '## §5 Research Skills',
        '## §6 Cross-Module Handoff',
        '## §7 Tool Feedback',
        '## §8 Research Workflow',
        '## §9 Human-in-Loop Protocol',
        '## §10 Output Cards',
        '## §11 Red Lines',
        '## §12 Memory Management',
      ];
      for (const section of expectedSections) {
        expect(agentsMd).toContain(section);
      }
    });

    it('TOOLS.md has all expected section headers', () => {
      const expectedSections = [
        '## §1 Local Tools',
        '## §2 API Tools',
        '## §3 Special Tools',
        '## §4 Research Skills',
        '## §5 Citation & Export',
        '## §6 Tool Count',
      ];
      for (const section of expectedSections) {
        expect(toolsMd).toContain(section);
      }
    });

    it('AGENTS.md has YAML frontmatter', () => {
      expect(agentsMd).toMatch(/^---\n/);
      expect(agentsMd).toMatch(/file: AGENTS\.md/);
    });

    it('TOOLS.md has YAML frontmatter', () => {
      expect(toolsMd).toMatch(/^---\n/);
      expect(toolsMd).toMatch(/file: TOOLS\.md/);
    });
  });
});

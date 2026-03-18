# 03f --- research-claw-core Plugin Aggregation Spec

> **Status:** Draft v1.0
> **Depends on:** 03a (Literature), 03b (Tasks), 03c (Workspace), 03d (Message Cards)
> **Consumed by:** 05 (Plugin Integration Guide), 06 (Install & Startup)

---

## Table of Contents

1. [Overview](#1-overview)
2. [Plugin Manifest](#2-plugin-manifest)
3. [Configuration Schema](#3-configuration-schema)
4. [Entry Point Registration Flow](#4-entry-point-registration-flow)
5. [Complete Tool Registry](#5-complete-tool-registry)
6. [Complete RPC Method Registry](#6-complete-rpc-method-registry)
7. [HTTP Routes](#7-http-routes)
8. [SQLite Lifecycle](#8-sqlite-lifecycle)
9. [Service Definition](#9-service-definition)
10. [Hook Registrations](#10-hook-registrations)
11. [Inter-Module Data Flow](#11-inter-module-data-flow)
12. [Testing Strategy](#12-testing-strategy)
13. [Appendix: Plugin SDK Quick Reference](#13-appendix-plugin-sdk-quick-reference)

---

## 1. Overview

`research-claw-core` is the single OpenClaw plugin that aggregates all Research-Claw
functionality. It acts as the central wiring layer: it owns the SQLite database, registers
every agent tool (28), every gateway RPC method (57), the HTTP file-upload route, and seven
lifecycle hooks. Individual feature modules (literature, tasks, workspace) are plain
TypeScript modules with no plugin awareness -- this plugin imports them and connects them
to the OpenClaw runtime via the `PluginApi` interface.

### Design Principles

- **Single plugin, multiple modules.** One `openclaw.plugin.json`, one `index.ts` entry
  point. Feature code lives in `src/literature/`, `src/tasks/`, `src/workspace/`, `src/db/`, `src/cards/`.
- **Database ownership.** Only this plugin opens the SQLite connection. Modules receive a
  `Database` handle -- they never construct one.
- **Zero coupling to OpenClaw internals.** All integration goes through the documented
  Plugin SDK (`api.registerTool`, `api.on`, etc.). The only exception is the pnpm patch
  for branding (~20 lines, 7 files), which is outside this plugin.
- **Fail-open on missing DB.** If the database file does not exist on first access, it is
  created with the full schema. If migrations are pending, they run automatically.

### File Layout

```
research-claw-core/
  openclaw.plugin.json        # Plugin manifest (section 2)
  index.ts                    # Entry point — PluginDefinition export with register() (section 4)
  src/
    types.ts                  # Shared type definitions (ToolDefinition, RegisterMethod)
    db/
      connection.ts           # SQLite open/close, WAL pragma
      migrations.ts           # Versioned migration runner
    literature/
      service.ts              # LiteratureService class
      tools.ts                # 12 agent tool definitions
      rpc.ts                  # 26 RPC method handlers
    tasks/
      service.ts              # TaskService class (tasks + cron presets + notifications)
      tools.ts                # 9 agent tool definitions (6 task + cron_update_schedule + task_link_file + send_notification)
      rpc.ts                  # 11 task + 7 cron + 2 notification RPC method handlers
    workspace/
      service.ts              # WorkspaceService class
      tools.ts                # 7 agent tool definitions
      rpc.ts                  # 11 RPC method handlers
    cards/
      templates.ts            # Message card JSON templates
    __tests__/
      literature.test.ts
      tasks.test.ts
      workspace.test.ts
```

> **Note:** Hooks are registered inline in `index.ts` (not in a separate `hooks/` directory).
> The HTTP upload route handler is also inline in `index.ts`.

---

## 2. Plugin Manifest

File: `openclaw.plugin.json`

```json
{
  "id": "research-claw-core",
  "name": "Research-Claw Core",
  "version": "0.4.1",
  "description": "Literature library, task management, and workspace tracking for academic research",
  "main": "dist/index.js",
  "openclaw": ">=0.6.0",
  "configSchema": {
    "type": "object",
    "properties": {
      "dbPath": {
        "type": "string",
        "default": ".research-claw/library.db",
        "description": "Path to SQLite database file, relative to workspace root."
      },
      "autoTrackGit": {
        "type": "boolean",
        "default": true,
        "description": "Automatically track workspace file changes via git."
      },
      "defaultCitationStyle": {
        "type": "string",
        "enum": ["apa", "mla", "chicago", "ieee", "bibtex"],
        "default": "apa",
        "description": "Default citation format for bibliography export."
      },
      "heartbeatDeadlineWarningHours": {
        "type": "number",
        "default": 48,
        "minimum": 1,
        "maximum": 720,
        "description": "Hours before a task deadline to include it in heartbeat warnings."
      }
    },
    "additionalProperties": false
  }
}
```

### Manifest Field Notes

| Field | Purpose |
|-------|---------|
| `id` | Unique plugin identifier. Used in `api.pluginConfig` key lookup. |
| `main` | Resolved relative to the plugin root. OpenClaw uses `jiti` to load TypeScript directly. |
| `openclaw` | Semver range for compatible OpenClaw versions. |
| `configSchema` | JSON Schema validated at load time. Invalid config prevents plugin activation. |

---

## 3. Configuration Schema

### TypeScript Types

```typescript
// src/config.ts

export interface PluginConfig {
  /** Path to SQLite database, relative to workspace root. */
  dbPath?: string;

  /** Auto-track workspace file changes via git. */
  autoTrackGit?: boolean;

  /** Default citation export format. */
  defaultCitationStyle?: string;

  /** Hours before deadline to flag tasks in heartbeat context. */
  heartbeatDeadlineWarningHours?: number;

  /** Workspace-specific configuration. */
  workspace?: {
    root?: string;
    commitDebounceMs?: number;
    maxGitFileSize?: number;
    maxUploadSize?: number;
    gitAuthorName?: string;
    gitAuthorEmail?: string;
  };
}

// Defaults are applied inline in register():
//   dbPath: '.research-claw/library.db'
//   autoTrackGit: true
//   defaultCitationStyle: 'apa'
//   heartbeatDeadlineWarningHours: 48
//   workspace.root: 'workspace'
//   workspace.commitDebounceMs: 5000
//   workspace.gitAuthorName: 'Research-Claw'
//   workspace.gitAuthorEmail: 'research-claw@wentor.ai'

export function resolveConfig(
  raw: Partial<ResearchClawConfig> | undefined
): ResearchClawConfig {
  return {
    ...DEFAULT_CONFIG,
    ...raw,
  };
}
```

### Configuration Sources

Users set config in their OpenClaw project config (`openclaw.config.json` or per-project
settings):

```json
{
  "plugins": {
    "research-claw-core": {
      "dbPath": ".research-claw/library.db",
      "autoTrackGit": true,
      "defaultCitationStyle": "ieee",
      "heartbeatDeadlineWarningHours": 24
    }
  }
}
```

The `api.pluginConfig` property returns the validated object at runtime. The
`resolveConfig` helper merges defaults for any omitted fields.

---

## 4. Entry Point Registration Flow

File: `index.ts` (at plugin root, **not** in `src/`)

The entry point exports a default `PluginDefinition` object with a `register(api)` method.
OpenClaw calls `register()` once during plugin loading. All registration is synchronous
except workspace init (fire-and-forget, completes before any dashboard connection).

```typescript
// index.ts

import { createDatabaseManager } from './src/db/connection.js';
import { runMigrations } from './src/db/migrations.js';
import { LiteratureService } from './src/literature/service.js';
import { createLiteratureTools } from './src/literature/tools.js';
import { registerLiteratureRpc } from './src/literature/rpc.js';
import { TaskService } from './src/tasks/service.js';
import { createTaskTools } from './src/tasks/tools.js';
import { registerTaskRpc } from './src/tasks/rpc.js';
import { WorkspaceService } from './src/workspace/service.js';
import { createWorkspaceTools } from './src/workspace/tools.js';
import { registerWorkspaceRpc } from './src/workspace/rpc.js';
const plugin: PluginDefinition = {
  id: 'research-claw-core',
  name: 'Research-Claw Core',
  description: 'Literature library, task management, and workspace tracking for academic research',
  version: '0.4.1',

  register(api) {
    const cfg = (api.pluginConfig ?? {}) as PluginConfig;

    // ── 1. Initialize database ──────────────────────────────
    const dbManager = createDatabaseManager(api.resolvePath(cfg.dbPath ?? '.research-claw/library.db'));
    runMigrations(dbManager.db);

    // ── 2. Initialize services ──────────────────────────────
    const litService = new LiteratureService(dbManager.db);
    const taskService = new TaskService(dbManager.db);
    const wsService = new WorkspaceService(wsConfig);

    // ── 3. Register database lifecycle service ──────────────
    api.registerService({ id: 'research-claw-db', start() { ... }, stop() { ... } });

    // ── 4. Register tools (28 total) ────────────────────────
    //   12 literature + 9 task + 7 workspace
    for (const tool of createLiteratureTools(litService)) api.registerTool(tool);
    for (const tool of createTaskTools(taskService)) api.registerTool(tool);
    for (const tool of createWorkspaceTools(wsService)) api.registerTool(tool);
    for (const tool of createRadarTools(dbManager.db)) api.registerTool(tool);

    // ── 5. Register RPC methods (61 WS total) ───────────────
    registerLiteratureRpc(registerMethod, litService);   // 26 methods
    registerTaskRpc(registerMethod, taskService);         // 11 task + 7 cron + 2 notifications = 20
    registerWorkspaceRpc(registerMethod, wsService);      // 11 methods
    registerRadarRpc(registerMethod, dbManager.db);       // 4 methods

    // ── 6. Register HTTP route: POST /rc/upload ─────────────
    api.registerHttpRoute({ path: '/rc/upload', auth: 'gateway', ... });

    // ── 7. Register hooks (7) ───────────────────────────────
    //   before_prompt_build, session_start, session_end,
    //   before_tool_call, agent_end, after_tool_call, gateway_start
    api.on('before_prompt_build', () => { ... });
    api.on('session_start', () => { ... });
    api.on('session_end', () => { ... });
    api.on('before_tool_call', (event) => { ... });
    api.on('agent_end', () => { ... });
    api.on('after_tool_call', (event) => { ... });
    api.on('gateway_start', () => { ... });

    api.logger.info('Research-Claw Core registered (31 tools, 61 WS RPC + 1 HTTP = 62 interfaces, 7 hooks)');
  },
};

export default plugin;
```

### Registration Order Rationale

The order is intentional:

1. **Config first** -- all subsequent steps depend on resolved config values.
2. **DB service before tools/RPC** -- tools and RPC handlers receive a reference to the
   service. They call `dbService.getDb()` at invocation time (not at registration time),
   so the service does not need to be started yet.
3. **Tools before RPC** -- no hard dependency, but tools are the primary interface; listing
   them first keeps the mental model clear.
4. **Hooks last** -- hooks often reference tools/services registered above.

---

## 5. Complete Tool Registry

All 31 agent tools registered via `api.registerTool()`. Grouped by module.

### 5.1 Literature Tools (12)

Defined in `src/literature/tools.ts`. Canonical schemas in doc `03a`.

| # | Tool Name | Parameters Summary | Returns | Notes |
|---|-----------|-------------------|---------|-------|
| 1 | `library_add_paper` | `title`, `authors`, `year`, `doi?`, `abstract?`, `url?`, `venue?`, `tags?` | `{ id, title, created_at }` | Creates `rc_papers` row. Auto-generates BibTeX key. |
| 2 | `library_search` | `query`, `filters?` (`year_range`, `tags`, `read_status`, `collection`), `limit?`, `offset?` | `{ results: Paper[], total }` | Full-text search on title + abstract + authors. SQLite FTS5. |
| 3 | `library_update_paper` | `id`, `fields` (partial paper object) | `{ id, updated_fields }` | Only provided fields are overwritten. |
| 4 | `library_get_paper` | `id` | `Paper` (full object with tags, notes, reading sessions) | Returns 404-equivalent error if not found. |
| 5 | `library_export_bibtex` | `paper_ids?`, `collection?`, `style?` | `{ bibtex: string, count }` | Uses `config.defaultCitationStyle` as fallback. |
| 6 | `library_reading_stats` | `period?` (`7d`, `30d`, `90d`, `all`), `paper_id?` | `{ total_hours, sessions, papers_read, streak_days }` | Aggregates from `rc_reading_sessions`. |
| 7 | `library_batch_add` | `papers: PaperInput[]` | `{ added: number, skipped: number, errors: string[] }` | Deduplicates on DOI. Max 100 per call. |
| 8 | `library_manage_collection` | `action` (`create` / `rename` / `delete` / `add_paper` / `remove_paper`), `collection`, `paper_id?`, `new_name?` | `{ ok, collection }` | Collection is a string tag with `collection:` prefix in `rc_tags`. |
| 9 | `library_add_note` | `paper_id`, `content`, `page?`, `highlight?` | `{ note_id }` | Stored in `rc_paper_notes` table. |
| 10 | `library_tag_paper` | `paper_id`, `tags: string[]`, `action?` (`add` / `remove` / `set`) | `{ paper_id, tags }` | `set` replaces all tags; `add`/`remove` are incremental. |
| 11 | `library_citation_graph` | `paper_id`, `depth?` (1-3), `direction?` (`cites` / `cited_by` / `both`) | `{ nodes: Node[], edges: Edge[] }` | Traverses `rc_citations` table. Max depth 3 to bound query cost. |
| 12 | `library_import_bibtex` | `bibtex: string` | `{ imported: number, skipped: number, errors: string[] }` | Parses BibTeX string, creates papers. Deduplicates on DOI/title. |

### 5.2 Task Tools (9)

Defined in `src/tasks/tools.ts`. Canonical schemas in doc `03b`.

| # | Tool Name | Parameters Summary | Returns | Notes |
|---|-----------|-------------------|---------|-------|
| 13 | `task_create` | `title`, `task_type`, `description?`, `priority?`, `deadline?`, `tags?`, `related_paper_id?`, `related_file_path?` | `Task` | Priority defaults to `medium`. Actor: agent. |
| 14 | `task_list` | `status?`, `priority?`, `task_type?`, `sort_by?`, `include_completed?` | `{ items: Task[], total }` | Default: active tasks only. |
| 15 | `task_complete` | `id`, `notes?` | `Task` | Sets `status = 'done'`, records completion time. |
| 16 | `task_update` | `id`, plus any task fields | `Task` | State-machine validated status transitions. |
| 17 | `task_link` | `task_id`, `paper_id` | `{ ok }` | Sets `related_paper_id` on task. |
| 18 | `task_note` | `task_id`, `note` | `{ activity entry }` | Appends timestamped note. Actor: agent. |
| 19 | `task_link_file` | `task_id`, `file_path` | `{ ok }` | Links task to a workspace file. |
| 20 | `cron_update_schedule` | `preset_id`, `schedule` | `CronPreset` | Updates cron schedule expression. |
| 21 | `send_notification` | `type`, `title`, `body?` | `Notification` | Pushes notification to dashboard bell. |

### 5.3 Workspace Tools (7)

Defined in `src/workspace/tools.ts`. Canonical schemas in doc `03c`.

| # | Tool Name | Parameters Summary | Returns | Notes |
|---|-----------|-------------------|---------|-------|
| 22 | `workspace_save` | `path`, `content`, `commit_message?` | `{ path, size, committed }` | Writes file, auto-commits to git. Emits file_card JSON. |
| 23 | `workspace_read` | `path` | `{ content, size, mime_type, git_status }` | Reads current file. UTF-8 or base64. |
| 24 | `workspace_list` | `directory?`, `pattern?`, `recursive?` | `{ files: FileEntry[], total }` | Glob-based listing with tree flattening. |
| 25 | `workspace_diff` | `path?`, `commit_range?` | `{ diff, files_changed, insertions, deletions }` | Unified diff. |
| 26 | `workspace_history` | `path?`, `limit?` | `{ commits, total, has_more }` | Git log for file or entire workspace. |
| 27 | `workspace_restore` | `path`, `commit_hash` | `{ path, restored_from, new_commit }` | Checks out specific version. Creates new commit. |
| 28 | `workspace_move` | `from`, `to` | `{ from, to, committed }` | Move/rename file or directory. Auto-commits. |

### Tool Registration Pattern

Every tool follows the same registration pattern:

```typescript
// Example: src/literature/tools.ts (excerpt)

import type { ToolDefinition } from '../types.js';
import { LiteratureService } from './service.js';

export function createLiteratureTools(service: LiteratureService): ToolDefinition[] {
  const tools: ToolDefinition[] = [
    {
      name: 'library_add_paper',
      description:
        'Add a paper to the research library. Provide at minimum a title and authors.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Paper title' },
          authors: {
            type: 'array',
            items: { type: 'string' },
            description: 'List of author names',
          },
          year: { type: 'number', description: 'Publication year' },
          doi: { type: 'string', description: 'DOI identifier' },
          abstract: { type: 'string', description: 'Paper abstract' },
          url: { type: 'string', description: 'URL to paper' },
          venue: { type: 'string', description: 'Publication venue' },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Tags to attach',
          },
        },
        required: ['title', 'authors', 'year'],
      },
      execute: async (_toolCallId: string, params: Record<string, unknown>) => {
        const conn = db.getDb();
        const id = crypto.randomUUID();
        const bibtexKey = generateBibtexKey(params.authors, params.year);

        conn.prepare(`
          INSERT INTO rc_papers (id, title, authors, year, doi, abstract, url, venue, bibtex_key, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        `).run(
          id,
          params.title,
          JSON.stringify(params.authors),
          params.year,
          params.doi ?? null,
          params.abstract ?? null,
          params.url ?? null,
          params.venue ?? null,
          bibtexKey,
        );

        if (params.tags?.length) {
          attachTags(conn, id, params.tags);
        }

        return { id, title: params.title, created_at: new Date().toISOString() };
      },
    },
    // ... remaining 11 literature tools
  ];

  for (const tool of tools) {
    api.registerTool(tool);
  }
}
```

---

## 6. Complete RPC Method Registry

All RPC methods registered via `api.registerGatewayMethod()`. These are callable over the
gateway WebSocket (protocol v3) by the dashboard UI.

### 6.1 Literature RPC Methods (26)

Namespace: `rc.lit.*`. Defined in `src/literature/rpc.ts`. Canonical schemas in doc `03a`.

| # | Method | Params | Returns | Notes |
|---|--------|--------|---------|-------|
| 1 | `rc.lit.list` | `{ filters?, sort?, limit?, offset? }` | `{ papers: Paper[], total }` | Paginated listing with optional filters. |
| 2 | `rc.lit.get` | `{ id }` | `Paper` | Full paper with tags, notes, reading sessions. |
| 3 | `rc.lit.add` | `{ paper: PaperInput }` | `{ id }` | Same logic as `library_add_paper` tool. |
| 4 | `rc.lit.update` | `{ id, fields }` | `{ ok }` | Partial update. |
| 5 | `rc.lit.delete` | `{ id }` | `{ ok }` | Soft delete (sets `deleted_at`). |
| 6 | `rc.lit.status` | `{ id, status }` | `{ ok }` | Update reading status (unread/reading/read). |
| 7 | `rc.lit.rate` | `{ id, rating }` | `{ ok }` | Set paper rating. |
| 8 | `rc.lit.tags` | `{}` | `{ tags: Tag[] }` | All tags with paper counts. |
| 9 | `rc.lit.tag` | `{ paperId, tag }` | `{ ok }` | Add a tag to a paper. |
| 10 | `rc.lit.untag` | `{ paperId, tag }` | `{ ok }` | Remove a tag from a paper. |
| 11 | `rc.lit.reading.start` | `{ paperId }` | `{ sessionId }` | Opens reading session. |
| 12 | `rc.lit.reading.end` | `{ sessionId }` | `{ duration_minutes }` | Closes session, records duration. |
| 13 | `rc.lit.reading.list` | `{ paperId?, period? }` | `{ sessions: ReadingSession[] }` | Reading session history. |
| 14 | `rc.lit.cite` | `{ paperId, style? }` | `{ citation: string }` | Generate formatted citation. |
| 15 | `rc.lit.citations` | `{ paperIds, style? }` | `{ citations: string[] }` | Batch citation generation. |
| 16 | `rc.lit.stats` | `{ period? }` | `{ total_papers, total_hours, streak }` | Aggregated library stats. |
| 17 | `rc.lit.search` | `{ query, filters?, limit?, offset? }` | `{ results: Paper[], total }` | FTS5 search. |
| 18 | `rc.lit.duplicate_check` | `{ paper: PaperInput }` | `{ duplicates: Paper[] }` | Check for existing duplicates by DOI/title. |
| 19 | `rc.lit.batch_add` | `{ papers: PaperInput[] }` | `{ added, skipped, errors }` | Max 100. |
| 20 | `rc.lit.import_bibtex` | `{ bibtex: string }` | `{ imported, skipped, errors }` | Parses and inserts. |
| 21 | `rc.lit.export_bibtex` | `{ paperIds?, collection?, style? }` | `{ bibtex: string }` | Formatted output. |
| 22 | `rc.lit.collections.list` | `{}` | `{ collections: string[] }` | Collection names. |
| 23 | `rc.lit.collections.manage` | `{ action, collection, paperId?, newName? }` | `{ ok }` | Create/rename/delete/add/remove. |
| 24 | `rc.lit.notes.list` | `{ paperId }` | `{ notes: Note[] }` | All notes for a paper. |
| 25 | `rc.lit.notes.add` | `{ paperId, content, page?, highlight? }` | `{ noteId }` | Creates note. |
| 26 | `rc.lit.notes.delete` | `{ noteId }` | `{ ok }` | Hard delete. |

### 6.2 Task RPC Methods (11)

Namespace: `rc.task.*`. Defined in `src/tasks/rpc.ts`. Canonical schemas in doc `03b`.

| # | Method | Params | Returns | Notes |
|---|--------|--------|---------|-------|
| 27 | `rc.task.list` | `{ status?, priority?, task_type?, sort?, direction?, limit?, offset?, include_completed? }` | `{ items: Task[], total }` | Filterable list with pagination. |
| 28 | `rc.task.get` | `{ id }` | `Task` (with activity log + subtasks) | Full task details. |
| 29 | `rc.task.create` | `{ task: TaskInput }` | `Task` | Actor: human. |
| 30 | `rc.task.update` | `{ id, patch }` | `Task` | State-machine validated. Actor: human. |
| 31 | `rc.task.complete` | `{ id, notes? }` | `Task` | Sets status to done. Actor: human. |
| 32 | `rc.task.delete` | `{ id }` | `{ ok, deleted, id }` | Hard delete. |
| 33 | `rc.task.upcoming` | `{ hours? }` | `{ items, total, hours }` | Tasks due within N hours (default 48). |
| 34 | `rc.task.overdue` | `{}` | `{ items, total }` | Tasks past deadline. |
| 35 | `rc.task.link` | `{ task_id, paper_id }` | `{ ok, linked }` | Links task to paper. |
| 36 | `rc.task.linkFile` | `{ task_id, file_path }` | `{ ok, linked }` | Links task to workspace file. |
| 37 | `rc.task.notes.add` | `{ task_id, content }` | `{ activity entry }` | Appends note. Actor: human. |

### 6.3 Cron Preset RPC Methods (7)

Namespace: `rc.cron.presets.*`. Defined in `src/tasks/rpc.ts`. These provide
pre-configured cron job templates for common research workflows.

| # | Method | Params | Returns | Notes |
|---|--------|--------|---------|-------|
| 38 | `rc.cron.presets.list` | `{}` | `{ presets: CronPreset[] }` | Returns all presets with state. |
| 39 | `rc.cron.presets.activate` | `{ preset_id, config? }` | `CronPreset` | Activates a preset cron job. |
| 40 | `rc.cron.presets.deactivate` | `{ preset_id }` | `CronPreset` | Deactivates a preset cron job. |
| 41 | `rc.cron.presets.setJobId` | `{ preset_id, job_id }` | `{ ok }` | Store gateway cron job ID mapping. |
| 42 | `rc.cron.presets.delete` | `{ preset_id }` | `{ ok }` | Delete a cron preset from DB. |
| 43 | `rc.cron.presets.restore` | `{ preset_id }` | `CronPreset` | Restore a deleted preset from PRESET_DEFINITIONS. |
| 44 | `rc.cron.presets.updateSchedule` | `{ preset_id, schedule }` | `{ preset }` | Update schedule expression. |

### 6.4 Notification RPC Methods (2)

Namespace: `rc.notifications.*`. Defined in `src/tasks/rpc.ts`.

| # | Method | Params | Returns | Notes |
|---|--------|--------|---------|-------|
| 45 | `rc.notifications.pending` | `{ hours? }` | `{ overdue, upcoming, custom, timestamp }` | Dashboard notification bell data. |
| 46 | `rc.notifications.markRead` | `{ id }` | `{ ok }` | Mark a custom notification as read. |

### 6.5 Workspace RPC Methods (11)

Namespace: `rc.ws.*`. Defined in `src/workspace/rpc.ts`. Canonical schemas in doc `03c`.
`rc.ws.upload` is HTTP POST (see §7) -- not registered here.

| # | Method | Params | Returns | Notes |
|---|--------|--------|---------|-------|
| 47 | `rc.ws.tree` | `{ root?, depth? }` | `{ tree: TreeNode[] }` | Directory tree listing. |
| 48 | `rc.ws.read` | `{ path }` | `{ content, size, mime_type, git_status }` | File contents (UTF-8 or base64). |
| 49 | `rc.ws.save` | `{ path, content, message? }` | `{ path, size, committed }` | Write + optional commit. |
| 50 | `rc.ws.history` | `{ path?, limit?, offset? }` | `{ commits, total, has_more }` | Git log. |
| 51 | `rc.ws.diff` | `{ path?, from?, to? }` | `{ diff, files_changed, insertions, deletions }` | Unified diff. |
| 52 | `rc.ws.restore` | `{ path, commit }` | `{ path, restored_from, new_commit }` | Checkout + commit. |
| 53 | `rc.ws.delete` | `{ path }` | `{ ok }` | Delete a file from workspace. |
| 54 | `rc.ws.saveImage` | `{ path, base64, mimeType? }` | `{ path, size }` | Save base64 image (for chat uploads). |
| 55 | `rc.ws.openExternal` | `{ path }` | `{ ok }` | Open file in system default app. |
| 56 | `rc.ws.openFolder` | `{ path }` | `{ ok }` | Open containing folder in file manager. |
| 57 | `rc.ws.move` | `{ from, to }` | `{ from, to, committed }` | Move/rename within workspace. |

**Total: 57 WS RPC methods** (26 lit + 11 task + 7 cron + 2 notifications + 11 ws)
plus 1 HTTP route (`POST /rc/upload`). Note: `rc.ws.upload` is HTTP POST only (see §7) and
is not registered as a gateway RPC method.

### RPC Registration Pattern

```typescript
// Example: src/literature/rpc.ts (excerpt)

import type { LiteratureService } from './service.js';
import type { RegisterMethod } from '../types.js';

export function registerLiteratureRpc(registerMethod: RegisterMethod, service: LiteratureService): void {
  registerMethod('rc.lit.search', async (params: Record<string, unknown>) => {
    const query = params.query as string;
    return service.search(query);
  });

  registerMethod('rc.lit.get', async (params: Record<string, unknown>) => {
    const id = params.id as string;
    const paper = service.get(id);
    if (!paper) throw new Error(`Paper not found: ${id}`);
    return paper;
  });

  registerMethod('rc.lit.add', async (params: Record<string, unknown>) => {
    return service.add(params as any);
  });

  // ... remaining 23 methods follow identical pattern
}
```

---

## 7. HTTP Routes

A single HTTP route is registered for file upload. Dashboard and external tools use this
to upload PDFs, BibTeX files, and attachments.

| Method | Path | Auth | Match | Handler | Content-Type |
|--------|------|------|-------|---------|-------------|
| `POST` | `/rc/upload` | gateway | exact | `handleUpload` | `multipart/form-data` |

### Route Registration

```typescript
// src/http/upload.ts

import type { OpenClawPluginApi } from 'openclaw';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join, extname } from 'node:path';

const ALLOWED_EXTENSIONS = new Set(['.pdf', '.bib', '.md', '.txt', '.csv', '.json']);
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB

export function registerUploadRoute(api: OpenClawPluginApi, dbPath: string): void {
  const uploadsDir = join(dbPath, '..', 'uploads');

  api.registerHttpRoute({
    method: 'POST',
    path: '/rc/upload',
    match: 'exact',
    handler: async (req, res) => {
      // Ensure uploads directory exists
      await mkdir(uploadsDir, { recursive: true });

      const file = req.file;
      if (!file) {
        res.status(400).json({ error: 'No file provided' });
        return;
      }

      const ext = extname(file.originalname).toLowerCase();
      if (!ALLOWED_EXTENSIONS.has(ext)) {
        res.status(400).json({
          error: `File type not allowed: ${ext}`,
          allowed: [...ALLOWED_EXTENSIONS],
        });
        return;
      }

      if (file.size > MAX_FILE_SIZE) {
        res.status(413).json({
          error: `File too large: ${file.size} bytes (max ${MAX_FILE_SIZE})`,
        });
        return;
      }

      const fileId = crypto.randomUUID();
      const destPath = join(uploadsDir, `${fileId}${ext}`);

      const writeStream = createWriteStream(destPath);
      writeStream.write(file.buffer);
      writeStream.end();

      res.json({
        id: fileId,
        filename: file.originalname,
        path: destPath,
        size: file.size,
        extension: ext,
      });
    },
  });
}
```

### Upload Response Schema

```typescript
interface UploadResponse {
  id: string;           // UUID for the uploaded file
  filename: string;     // Original filename
  path: string;         // Absolute path on disk
  size: number;         // File size in bytes
  extension: string;    // Normalized extension (e.g., '.pdf')
}
```

---

## 8. SQLite Lifecycle

### 8.1 Location

The database lives at `{workspaceDir}/.research-claw/library.db`. The path is resolved
through `api.resolvePath(config.dbPath)`, which converts the relative path to an absolute
workspace-rooted path. The `.research-claw/` directory is created automatically on first
access.

### 8.2 Creation

On first access (service start), if the database file does not exist:

1. Create the `.research-claw/` directory with `mkdir -p` semantics.
2. Open the SQLite connection (this creates the file).
3. Execute the full initial schema from `src/db/schema.sql`.
4. Insert migration version record: `(1, 'initial', datetime('now'))`.

### 8.3 WAL Mode

WAL (Write-Ahead Logging) is enabled immediately after connection open:

```sql
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
PRAGMA foreign_keys = ON;
PRAGMA cache_size = -8000;  -- 8 MB
```

WAL allows concurrent reads while a write is in progress -- important because the gateway
(RPC reads from dashboard) and the agent (tool writes) can operate simultaneously.

### 8.4 Migration System

Migrations are stored in `src/db/migrations.ts` as an ordered array of versioned steps.
The migration runner is called on every service start.

```typescript
// src/db/migrations.ts

export interface Migration {
  version: number;
  name: string;
  up: string; // SQL to apply
}

export const migrations: Migration[] = [
  {
    version: 1,
    name: 'initial',
    up: '', // Initial schema is applied via schema.sql, not a migration
  },
  {
    version: 2,
    name: 'add_paper_notes',
    up: `
      CREATE TABLE IF NOT EXISTS rc_paper_notes (
        id TEXT PRIMARY KEY,
        paper_id TEXT NOT NULL REFERENCES rc_papers(id),
        content TEXT NOT NULL,
        page INTEGER,
        highlight TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_paper_notes_paper ON rc_paper_notes(paper_id);
    `,
  },
  {
    version: 3,
    name: 'add_task_notes',
    up: `
      CREATE TABLE IF NOT EXISTS rc_task_notes (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES rc_tasks(id),
        content TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_task_notes_task ON rc_task_notes(task_id);
    `,
  },
  // Future migrations appended here
];
```

Migration runner:

```typescript
// src/db/connection.ts (excerpt)

import { migrations } from './migrations.js';

function runMigrations(db: Database): void {
  // Ensure migration tracking table exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS rc_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  const applied = db
    .prepare('SELECT version FROM rc_migrations ORDER BY version')
    .all()
    .map((r: any) => r.version as number);

  const maxApplied = applied.length > 0 ? Math.max(...applied) : 0;

  for (const migration of migrations) {
    if (migration.version > maxApplied && migration.up) {
      db.exec(migration.up);
      db.prepare('INSERT INTO rc_migrations (version, name) VALUES (?, ?)').run(
        migration.version,
        migration.name,
      );
    }
  }
}
```

### 8.5 Backup

The `scripts/backup.sh` script copies the database file and its WAL/SHM companions:

```bash
#!/bin/bash
# scripts/backup.sh — Back up the Research-Claw SQLite database
set -euo pipefail

DB_PATH="${1:-.research-claw/library.db}"
BACKUP_DIR="${2:-.research-claw/backups}"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

mkdir -p "$BACKUP_DIR"

# Use SQLite backup API via sqlite3 CLI for consistency
sqlite3 "$DB_PATH" ".backup '${BACKUP_DIR}/library_${TIMESTAMP}.db'"

echo "Backup created: ${BACKUP_DIR}/library_${TIMESTAMP}.db"

# Prune backups older than 30 days
find "$BACKUP_DIR" -name "library_*.db" -mtime +30 -delete
```

---

## 9. Service Definition

The `research-claw-db` service manages the SQLite connection lifecycle. It is the only
component that opens or closes the database.

```typescript
// src/db/connection.ts

import Database from 'better-sqlite3';
import type { ServiceDefinition } from 'openclaw';
import type { ResearchClawConfig } from '../config.js';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface DbService {
  /** Returns the open database handle. Throws if service not started. */
  getDb(): Database.Database;

  /** The service definition to register with OpenClaw. */
  service: ServiceDefinition;
}

export function createDbService(
  dbAbsPath: string,
  config: ResearchClawConfig
): DbService {
  let db: Database.Database | null = null;

  const service: ServiceDefinition = {
    id: 'research-claw-db',

    start: async (ctx) => {
      ctx.logger.info(`Opening database: ${dbAbsPath}`);

      // Ensure parent directory exists
      const dir = dirname(dbAbsPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
        ctx.logger.info(`Created directory: ${dir}`);
      }

      // Determine if this is a fresh database
      const isNew = !existsSync(dbAbsPath);

      // Open connection
      db = new Database(dbAbsPath);

      // Configure pragmas
      db.pragma('journal_mode = WAL');
      db.pragma('busy_timeout = 5000');
      db.pragma('foreign_keys = ON');
      db.pragma('cache_size = -8000');

      // Apply initial schema if new database
      if (isNew) {
        const schemaPath = join(__dirname, 'schema.sql');
        const schema = readFileSync(schemaPath, 'utf-8');
        db.exec(schema);
        ctx.logger.info('Applied initial schema');
      }

      // Run pending migrations
      runMigrations(db);
      ctx.logger.info('Migrations complete');

      // Initialize git tracker if configured
      if (config.autoTrackGit) {
        initGitTracker(dir, ctx.logger);
      }
    },

    stop: async (ctx) => {
      if (db) {
        ctx.logger.info('Closing database connection');

        // Flush WAL to main database file
        db.pragma('wal_checkpoint(TRUNCATE)');

        db.close();
        db = null;
      }
    },
  };

  return {
    getDb() {
      if (!db) {
        throw new Error(
          'research-claw-db service not started. ' +
          'Database is only available after gateway_start.'
        );
      }
      return db;
    },
    service,
  };
}

function initGitTracker(dbDir: string, logger: any): void {
  const gitignorePath = join(dbDir, '.gitignore');
  if (!existsSync(gitignorePath)) {
    const content = [
      '# Research-Claw data files',
      'library.db-wal',
      'library.db-shm',
      'uploads/',
      'backups/',
      '',
    ].join('\n');
    require('node:fs').writeFileSync(gitignorePath, content);
    logger.info('Created .gitignore for research-claw data directory');
  }
}
```

### Service Lifecycle Diagram

```
Plugin activate()
    |
    +-- registerService(dbService)    // Deferred start
    |
    ... (gateway initializes) ...
    |
gateway_start hook fires
    |
    +-- Service.start()
    |       +-- mkdir if needed
    |       +-- new Database(path)
    |       +-- PRAGMA journal_mode = WAL
    |       +-- Apply schema if new DB
    |       +-- runMigrations()
    |       +-- initGitTracker() if autoTrackGit
    |
    ... (agent sessions, tool calls, RPC requests) ...
    |
    +-- getDb() --> returns open handle
    |
gateway_stop (or process exit)
    |
    +-- Service.stop()
            +-- PRAGMA wal_checkpoint(TRUNCATE)
            +-- db.close()
```

---

## 10. Hook Registrations

Seven hooks are registered, all inline in `index.ts` (not in separate files).

### 10.1 `before_prompt_build` -- Research Context Injection

Injects a compact (~200 character) research context summary into the agent prompt. This
gives the agent awareness of the user's current research state without consuming
significant context window.

```typescript
// src/hooks/prompt-context.ts

import type { OpenClawPluginApi } from 'openclaw';
import type { DbService } from '../db/connection.js';
import type { ResearchClawConfig } from '../config.js';

export function registerPromptContextHook(
  api: OpenClawPluginApi,
  db: DbService,
  config: ResearchClawConfig,
): void {
  api.on('before_prompt_build', async (ctx) => {
    const conn = db.getDb();

    // Paper counts
    const { total, unread } = conn.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN read_status = 'unread' THEN 1 ELSE 0 END) as unread
      FROM rc_papers
      WHERE deleted_at IS NULL
    `).get() as { total: number; unread: number };

    // Task urgency
    const warningThreshold = config.heartbeatDeadlineWarningHours;
    const { overdue, due_soon } = conn.prepare(`
      SELECT
        SUM(CASE WHEN deadline < datetime('now') THEN 1 ELSE 0 END) as overdue,
        SUM(CASE WHEN deadline >= datetime('now')
          AND deadline <= datetime('now', '+${warningThreshold} hours')
          THEN 1 ELSE 0 END) as due_soon
      FROM rc_tasks
      WHERE status = 'open' AND deleted_at IS NULL
    `).get() as { overdue: number; due_soon: number };

    // Last reading session
    const lastReading = conn.prepare(`
      SELECT p.title, rs.ended_at
      FROM rc_reading_sessions rs
      JOIN rc_papers p ON rs.paper_id = p.id
      WHERE rs.ended_at IS NOT NULL
      ORDER BY rs.ended_at DESC
      LIMIT 1
    `).get() as { title: string; ended_at: string } | undefined;

    // Build context string (~200 chars)
    let context = `Library: ${total} papers (${unread} unread).`;
    context += ` Tasks: ${overdue} overdue, ${due_soon} due within ${warningThreshold}h.`;
    if (lastReading) {
      const shortTitle =
        lastReading.title.length > 40
          ? lastReading.title.slice(0, 37) + '...'
          : lastReading.title;
      const date = lastReading.ended_at.split('T')[0];
      context += ` Last reading: "${shortTitle}" on ${date}.`;
    }

    return { prependContext: context };
  });
}
```

**Injected context example:**

```
Library: 47 papers (12 unread). Tasks: 2 overdue, 5 due within 48h. Last reading: "Attention Is All You Need" on 2026-03-10.
```

### 10.2 `session_start` -- Database Warm-Up

Opens the database connection (if not already open from gateway_start) and runs any
pending migrations. This is a safety net -- normally the service starts before any session.

```typescript
// src/hooks/session.ts

import type { OpenClawPluginApi } from 'openclaw';
import type { DbService } from '../db/connection.js';

export function registerSessionHooks(
  api: OpenClawPluginApi,
  db: DbService,
): void {
  api.on('session_start', async (ctx) => {
    // Verify DB is accessible (service should already be started)
    try {
      const conn = db.getDb();
      // Quick sanity check
      conn.prepare('SELECT 1').get();
      api.logger.debug('session_start: DB connection verified');
    } catch (err) {
      api.logger.error('session_start: DB not available', { error: err });
    }
  });

  api.on('session_end', async (ctx) => {
    const conn = db.getDb();

    // Close any open reading sessions (user left without stopping)
    const openSessions = conn.prepare(`
      UPDATE rc_reading_sessions
      SET ended_at = datetime('now')
      WHERE ended_at IS NULL
    `).run();

    if (openSessions.changes > 0) {
      api.logger.info(
        `session_end: Closed ${openSessions.changes} orphaned reading session(s)`
      );
    }

    // Flush any pending writes
    conn.pragma('wal_checkpoint(PASSIVE)');
  });
}
```

### 10.3 `agent_end` -- Run Summary Recording

Records an activity log entry summarizing what the agent did during the run. This feeds
the dashboard activity timeline.

```typescript
// src/hooks/agent-end.ts

import type { OpenClawPluginApi } from 'openclaw';
import type { DbService } from '../db/connection.js';

export function registerAgentEndHook(
  api: OpenClawPluginApi,
  db: DbService,
): void {
  api.on('agent_end', async (ctx) => {
    const conn = db.getDb();

    const toolsUsed = ctx.toolCalls?.map((t: any) => t.name) ?? [];
    const rcToolsUsed = toolsUsed.filter(
      (name: string) =>
        name.startsWith('library_') ||
        name.startsWith('task_') ||
        name.startsWith('workspace_'),
    );

    // Extract paper IDs referenced during the session
    const papersReferenced = new Set<string>();
    for (const call of ctx.toolCalls ?? []) {
      if (call.params?.paper_id) papersReferenced.add(call.params.paper_id);
      if (call.params?.id && call.name.startsWith('library_')) {
        papersReferenced.add(call.params.id);
      }
    }

    conn.prepare(`
      INSERT INTO rc_activity_log (
        id, event_type, summary, tools_used, papers_referenced,
        duration_ms, created_at
      )
      VALUES (?, 'agent_run', ?, ?, ?, ?, datetime('now'))
    `).run(
      crypto.randomUUID(),
      `Agent run completed. ${rcToolsUsed.length} RC tools used.`,
      JSON.stringify(rcToolsUsed),
      JSON.stringify([...papersReferenced]),
      ctx.durationMs ?? 0,
    );
  });
}
```

### 10.4 `after_tool_call` -- Cross-Plugin Paper Discovery

When the agent calls tools from `research-plugins` (the external skill/MCP package) that
return paper metadata -- such as `semantic_scholar_search`, `arxiv_search`, or
`crossref_search` -- this hook checks whether those papers already exist in the local
library. If not, it adds a suggestion to the chat.

```typescript
// src/hooks/tool-intercept.ts

import type { OpenClawPluginApi } from 'openclaw';
import type { DbService } from '../db/connection.js';

const PAPER_SEARCH_TOOLS = new Set([
  'semantic_scholar_search',
  'arxiv_search',
  'crossref_search',
  'pubmed_search',
  'google_scholar_search',
]);

export function registerToolInterceptHook(
  api: OpenClawPluginApi,
  db: DbService,
): void {
  api.on('after_tool_call', async (ctx) => {
    const { toolName, result } = ctx;

    if (!PAPER_SEARCH_TOOLS.has(toolName)) return;

    const conn = db.getDb();
    const papers = extractPapersFromResult(result);

    if (papers.length === 0) return;

    const newPapers: Array<{ title: string; doi?: string }> = [];

    for (const paper of papers) {
      // Check if already in library by DOI or title
      const existing = paper.doi
        ? conn.prepare('SELECT id FROM rc_papers WHERE doi = ? AND deleted_at IS NULL').get(paper.doi)
        : conn.prepare('SELECT id FROM rc_papers WHERE title = ? AND deleted_at IS NULL').get(paper.title);

      if (!existing) {
        newPapers.push({ title: paper.title, doi: paper.doi });
      }
    }

    if (newPapers.length > 0) {
      const titles = newPapers
        .slice(0, 3)
        .map((p) => `"${p.title}"`)
        .join(', ');
      const extra = newPapers.length > 3 ? ` and ${newPapers.length - 3} more` : '';

      return {
        chatSuggestion:
          `Found ${newPapers.length} paper(s) not in your library: ${titles}${extra}. ` +
          `Would you like me to add them?`,
      };
    }
  });
}

function extractPapersFromResult(
  result: unknown
): Array<{ title: string; doi?: string }> {
  if (!result || typeof result !== 'object') return [];

  // Handle common response shapes from research-plugins tools
  const data = result as any;
  const items = data.results ?? data.papers ?? data.data ?? [];

  if (!Array.isArray(items)) return [];

  return items
    .filter((item: any) => item.title && typeof item.title === 'string')
    .map((item: any) => ({
      title: item.title,
      doi: item.doi ?? item.DOI ?? undefined,
    }));
}
```

### 10.5 `gateway_start` -- Database Integrity Check

Runs a `PRAGMA integrity_check` on the database at gateway start. If the check fails, it
logs an error but does not prevent startup -- the user can still attempt recovery or
restore from backup.

```typescript
// src/hooks/gateway.ts

import type { OpenClawPluginApi } from 'openclaw';
import type { DbService } from '../db/connection.js';

export function registerGatewayStartHook(
  api: OpenClawPluginApi,
  db: DbService,
): void {
  api.on('gateway_start', async () => {
    try {
      const conn = db.getDb();
      const result = conn.pragma('integrity_check') as Array<{ integrity_check: string }>;

      const status = result[0]?.integrity_check ?? 'unknown';

      if (status === 'ok') {
        api.logger.info('gateway_start: Database integrity check passed');
      } else {
        api.logger.error(
          'gateway_start: Database integrity check FAILED',
          { result }
        );
        api.logger.error(
          'Consider restoring from backup: scripts/backup.sh'
        );
      }
    } catch (err) {
      api.logger.error('gateway_start: Could not run integrity check', {
        error: err,
      });
    }
  });
}
```

### Hook Summary Table

| # | Hook | Location | Purpose | Side Effects |
|---|------|----------|---------|-------------|
| 1 | `before_prompt_build` | `index.ts` (inline) | Inject research context (library stats, overdue/upcoming tasks, active tasks, cron) | Read-only DB queries |
| 2 | `session_start` | `index.ts` (inline) | Re-run migrations on DB | None (safety net) |
| 3 | `session_end` | `index.ts` (inline) | Close orphaned reading sessions (>24h stale + current) | Updates `rc_reading_sessions` |
| 4 | `before_tool_call` | `index.ts` (inline) | Exec safety guard (block catastrophic rm/dd/mkfs) + cron schedule sync | May block exec tool; updates `rc_cron_state` |
| 5 | `agent_end` | `index.ts` (inline) | Record agent run summary | Placeholder (no-op currently) |
| 6 | `after_tool_call` | `index.ts` (inline) | Sync native cron schedule changes back to rc_cron_state | Updates `rc_cron_state` |
| 7 | `gateway_start` | `index.ts` (inline) | Run `PRAGMA integrity_check` | Read-only; logs result |

---

## 11. Inter-Module Data Flow

### 11.1 Entity Relationships

```
rc_papers ──────┐
  |              |  related_paper_id (FK)
  |  rc_tags     |
  |  rc_paper_tags (junction)
  |  rc_paper_notes
  |  rc_reading_sessions
  |  rc_citations
  |              |
  |         rc_tasks ──── rc_task_notes
  |              |
  |         rc_activity_log
  |
  +-- referenced by workspace files (via tool calls, not FK)
```

### 11.2 Cross-Module Interactions

| Interaction | From | To | Mechanism |
|------------|------|-----|-----------|
| Task links to paper | `task_link` tool / `rc.task.link` RPC | `rc_tasks.related_paper_id` | Foreign key to `rc_papers.id` |
| Workspace file mentions task | `workspace_save` tool | `rc_tasks` (via description/notes) | Convention, not enforced by FK |
| Library search feeds chat | `library_search` tool | Chat output | Returns data formatted as `paper_card` (doc 03d) |
| Heartbeat reads tasks + reading | HEARTBEAT.md cron | `rc_tasks` + `rc_reading_sessions` | `before_prompt_build` hook aggregation |
| Agent run logged | `agent_end` hook | `rc_activity_log` | Insert with tool names, paper IDs, duration |
| External search discovers papers | `after_tool_call` hook | Chat suggestion | Checks `rc_papers` for DOI/title match |

### 11.3 Data Flow: Paper Discovery to Library

```
User says "find papers on transformer architectures"
    |
    v
Agent calls semantic_scholar_search (research-plugins tool)
    |
    v
after_tool_call hook fires
    |  - Extracts paper titles + DOIs from result
    |  - Queries rc_papers for matches
    |  - Finds 3 papers not in library
    |
    v
Returns chatSuggestion: "Found 3 papers not in library..."
    |
    v
Agent presents suggestion to user
    |
    v (user approves)
Agent calls library_batch_add with the 3 papers
    |
    v
Papers stored in rc_papers with tags, BibTeX keys generated
    |
    v
Dashboard RPC rc.lit.search now returns these papers
```

### 11.4 Data Flow: Task Lifecycle

```
Agent creates task via task_create
    |  - Optionally links to paper via related_paper_id
    |  - Stored in rc_tasks
    v
before_prompt_build hook includes task in context
    |  - "Tasks: 0 overdue, 1 due within 48h"
    v
User works on task, agent calls task_note to record progress
    v
User completes work, agent calls task_complete
    |  - Sets status = 'done', records completed_at
    v
agent_end hook records the full run in rc_activity_log
    |  - Lists tools used, papers referenced
    v
Dashboard displays activity timeline via rc.task.list RPC
```

---

## 12. Testing Strategy

### 12.1 Framework

All tests use **Vitest** (already the standard in the OpenClaw ecosystem). Tests live in
`tests/` alongside the source.

### 12.2 Database Tests

Use in-memory SQLite (`:memory:`) for fast, isolated tests. Each test gets a fresh
database with the full schema applied.

```typescript
// tests/db.test.ts

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { migrations } from '../src/db/migrations.js';

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Apply initial schema
  const schema = readFileSync(
    join(__dirname, '../src/db/schema.sql'),
    'utf-8',
  );
  db.exec(schema);

  return db;
}

describe('migrations', () => {
  it('should apply all migrations without error', () => {
    const db = createTestDb();

    // Simulate migration runner
    db.exec(`
      CREATE TABLE IF NOT EXISTS rc_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    for (const m of migrations) {
      if (m.up) {
        db.exec(m.up);
        db.prepare('INSERT INTO rc_migrations (version, name) VALUES (?, ?)').run(
          m.version,
          m.name,
        );
      }
    }

    const applied = db
      .prepare('SELECT version FROM rc_migrations ORDER BY version')
      .all();
    expect(applied.length).toBeGreaterThan(0);

    db.close();
  });
});
```

### 12.3 Tool Tests

Each tool is tested in isolation with a mock `ToolContext` and an in-memory database.

```typescript
// tests/lit.test.ts

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { registerLitTools } from '../src/lit/tools.js';

describe('library_add_paper', () => {
  let db: Database.Database;
  let tools: Map<string, any>;

  beforeEach(() => {
    db = createTestDb(); // in-memory
    tools = new Map();

    // Mock api.registerTool to capture tool definitions
    const mockApi = {
      registerTool: (tool: any) => tools.set(tool.name, tool),
      logger: { info: () => {}, debug: () => {}, error: () => {} },
    };

    const dbService = {
      getDb: () => db,
      service: { id: 'test', start: async () => {}, stop: async () => {} },
    };

    registerLitTools(mockApi as any, dbService);
  });

  it('should insert a paper and return id', async () => {
    const tool = tools.get('library_add_paper');
    const result = await tool.execute(
      {
        title: 'Attention Is All You Need',
        authors: ['Vaswani, A.', 'Shazeer, N.'],
        year: 2017,
        doi: '10.48550/arXiv.1706.03762',
      },
      {},
    );

    expect(result.id).toBeDefined();
    expect(result.title).toBe('Attention Is All You Need');

    // Verify in database
    const row = db
      .prepare('SELECT * FROM rc_papers WHERE id = ?')
      .get(result.id) as any;
    expect(row.title).toBe('Attention Is All You Need');
    expect(row.year).toBe(2017);
  });

  it('should attach tags when provided', async () => {
    const tool = tools.get('library_add_paper');
    const result = await tool.execute(
      {
        title: 'BERT',
        authors: ['Devlin, J.'],
        year: 2019,
        tags: ['nlp', 'transformer'],
      },
      {},
    );

    const tags = db
      .prepare(
        `SELECT t.name FROM rc_tags t
         JOIN rc_paper_tags pt ON pt.tag_id = t.id
         WHERE pt.paper_id = ?`,
      )
      .all(result.id)
      .map((r: any) => r.name);

    expect(tags).toContain('nlp');
    expect(tags).toContain('transformer');
  });
});
```

### 12.4 RPC Method Tests

RPC methods are tested with a mock gateway context.

```typescript
// tests/rpc.test.ts (excerpt)

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { registerLitRpc } from '../src/lit/rpc.js';

describe('rc.lit.search', () => {
  let db: Database.Database;
  let methods: Map<string, Function>;

  beforeEach(() => {
    db = createTestDb();
    methods = new Map();

    const mockApi = {
      registerGatewayMethod: (name: string, handler: Function) =>
        methods.set(name, handler),
      logger: { info: () => {}, debug: () => {}, error: () => {} },
    };

    const dbService = { getDb: () => db, service: { id: 'test' } as any };
    registerLitRpc(mockApi as any, dbService);

    // Seed test data
    db.prepare(`
      INSERT INTO rc_papers (id, title, authors, year, created_at)
      VALUES (?, ?, ?, ?, datetime('now'))
    `).run('p1', 'Attention Is All You Need', '["Vaswani"]', 2017);
  });

  it('should return matching papers', async () => {
    const search = methods.get('rc.lit.search')!;
    const result = await search({ query: 'Attention' });

    expect(result.results).toHaveLength(1);
    expect(result.results[0].title).toBe('Attention Is All You Need');
  });

  it('should return empty for non-matching query', async () => {
    const search = methods.get('rc.lit.search')!;
    const result = await search({ query: 'nonexistent' });

    expect(result.results).toHaveLength(0);
    expect(result.total).toBe(0);
  });
});
```

### 12.5 Hook Tests

```typescript
// tests/hooks.test.ts (excerpt)

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { registerPromptContextHook } from '../src/hooks/prompt-context.js';

describe('before_prompt_build hook', () => {
  let db: Database.Database;
  let hookHandler: Function;

  beforeEach(() => {
    db = createTestDb();
    const hooks: Map<string, Function> = new Map();

    const mockApi = {
      on: (name: string, handler: Function) => hooks.set(name, handler),
      logger: { info: () => {}, debug: () => {}, error: () => {} },
    };

    const dbService = { getDb: () => db, service: { id: 'test' } as any };
    const config = {
      dbPath: ':memory:',
      autoTrackGit: false,
      defaultCitationStyle: 'apa' as const,
      heartbeatDeadlineWarningHours: 48,
    };

    registerPromptContextHook(mockApi as any, dbService, config);
    hookHandler = hooks.get('before_prompt_build')!;
  });

  it('should return context with paper and task counts', async () => {
    // Seed papers
    db.prepare(`
      INSERT INTO rc_papers (id, title, authors, year, read_status, created_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
    `).run('p1', 'Paper A', '["Author"]', 2024, 'unread');

    const result = await hookHandler({});

    expect(result.prependContext).toContain('Library: 1 papers (1 unread)');
    expect(result.prependContext).toContain('Tasks: 0 overdue');
  });
});
```

### 12.6 Test Coverage Targets

| Module | Target Coverage | Key Scenarios |
|--------|----------------|---------------|
| `db/` | 90%+ | Schema creation, migration ordering, WAL mode, integrity check |
| `lit/tools.ts` | 85%+ | CRUD, search, batch add, deduplication, tag management |
| `lit/rpc.ts` | 85%+ | All 18 methods, error cases, pagination |
| `tasks/tools.ts` | 85%+ | Create, complete, link, deadline handling |
| `tasks/rpc.ts` | 85%+ | All 8 methods, filters, sorting |
| `ws/tools.ts` | 80%+ | Save/read/diff, git integration (mocked) |
| `ws/rpc.ts` | 80%+ | All 6 methods |
| `hooks/` | 80%+ | Context injection, session cleanup, tool intercept |

---

## 13. Appendix: Plugin SDK Quick Reference

Summary of `OpenClawPluginApi` methods used by this plugin. Full reference in doc `05`.

### Methods Used

| Method | Signature | Usage in This Plugin |
|--------|-----------|---------------------|
| `registerTool` | `(tool: ToolDefinition, opts?: ToolOpts) => void` | 24 calls (12 lit + 6 task + 6 ws) |
| `registerGatewayMethod` | `(method: string, handler: RpcHandler) => void` | 46 calls across 4 namespaces |
| `registerHttpRoute` | `(params: HttpRouteParams) => void` | 1 call (file upload) |
| `registerService` | `(service: ServiceDefinition) => void` | 1 call (research-claw-db) |
| `on` | `(hookName: HookName, handler: HookHandler) => void` | 6 calls |
| `pluginConfig` | `Readonly<Record<string, unknown>>` | Read once at activation |
| `resolvePath` | `(input: string) => string` | 1 call (dbPath resolution) |
| `logger` | `Logger` | Used throughout for info/debug/error |

### Hook Reference (Available Hooks)

The 24 hooks available in OpenClaw. This plugin uses 6 (marked with **bold**).

| Hook | Fires When | This Plugin |
|------|-----------|-------------|
| `before_model_resolve` | Before model selection | -- |
| `before_prompt_build` | Before system prompt assembly | **Injects research context** |
| `before_agent_start` | Before agent loop begins | -- |
| `llm_input` | Before LLM API call | -- |
| `llm_output` | After LLM API response | -- |
| `agent_end` | After agent loop completes | **Records run summary** |
| `before_compaction` | Before context compaction | -- |
| `after_compaction` | After context compaction | -- |
| `before_reset` | Before session reset | -- |
| `message_received` | Inbound message from user | -- |
| `message_sending` | Outbound message being prepared | -- |
| `message_sent` | Outbound message delivered | -- |
| `before_tool_call` | Before a tool executes | **Exec safety guard + cron sync** |
| `after_tool_call` | After a tool executes | **Cron schedule sync** |
| `tool_result_persist` | When tool result is stored | -- |
| `before_message_write` | Before message written to log | -- |
| `session_start` | Session begins | **DB connection verify** |
| `session_end` | Session ends | **Close orphaned sessions, flush** |
| `subagent_spawning` | Before subagent created | -- |
| `subagent_delivery_target` | Subagent target resolution | -- |
| `subagent_spawned` | After subagent created | -- |
| `subagent_ended` | After subagent completes | -- |
| `gateway_start` | Gateway process starts | **DB integrity check** |
| `gateway_stop` | Gateway process stops | -- |

### ToolDefinition Shape

```typescript
interface ToolDefinition {
  name: string;
  description: string;
  parameters: JSONSchema7;
  execute: (toolCallId: string, params: Record<string, unknown>) => Promise<unknown>;
}
```

### ServiceDefinition Shape

```typescript
interface ServiceDefinition {
  id: string;
  start: (ctx: ServiceContext) => Promise<void>;
  stop: (ctx: ServiceContext) => Promise<void>;
}
```

### HttpRouteParams Shape

```typescript
interface HttpRouteParams {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  path: string;
  match: 'exact' | 'prefix';
  handler: (req: Request, res: Response) => Promise<void> | void;
}
```

---

## Cross-References

| Document | Relationship |
|----------|-------------|
| `03a` Literature Library | Defines the 12 literature tools and 26 `rc.lit.*` RPC methods aggregated here |
| `03b` Task System | Defines the 9 task tools, 11 `rc.task.*` RPC methods, 7 `rc.cron.presets.*` methods, and 2 `rc.notifications.*` methods |
| `03c` Workspace & Git | Defines the 7 workspace tools and 11 `rc.ws.*` RPC methods (+ 1 HTTP upload) |
| `03d` Message Card Protocol | Defines card types (`paper_card`, `task_card`, etc.) rendered in dashboard |
| `05` Plugin Integration Guide | Full Plugin SDK reference, plugin development workflow |
| `02` Engineering Architecture | Gateway protocol, coupling tiers, overall system design |
| `06` Install & Startup | How the plugin is bundled with Research-Claw distribution |

---

*End of document. For implementation questions, see the canonical module docs (03a-03d)
for feature-specific schemas and the Plugin Integration Guide (05) for SDK details.*

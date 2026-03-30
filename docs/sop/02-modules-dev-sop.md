# S2 — Plugin Modules Development SOP

> Development standards and operation log for Research-Claw Core Plugin modules
> Covers: 03a (Literature) + 03b (Tasks) + 03c (Workspace) + 03d (Cards) + 03f (Plugin Core)

---

## 1. Scope

This SOP governs all development on the **research-claw-core** plugin — the MVP plugin that aggregates literature management, task tracking, workspace/git operations, and message card serialization.

**Owner track:** Modules team / agent
**Source files:** `extensions/research-claw-core/`
**Design docs:** `docs/modules/03a-03f`

---

## 2. Architecture Summary

### 2.1 Plugin Identity

| Field | Value |
|-------|-------|
| ID | `research-claw-core` |
| Version | 0.4.1 |
| Entry | `extensions/research-claw-core/index.ts` |
| Manifest | `openclaw.plugin.json` |
| Peer dependency | `openclaw@>=2026.3.0` |

### 2.2 Module Structure

```
extensions/research-claw-core/
+-- index.ts                 # Plugin entry, register all services
+-- openclaw.plugin.json     # Manifest + config schema
+-- package.json
+-- tsconfig.json
+-- src/
    +-- literature/
    |   +-- service.ts       # LiteratureService class (all DB ops)
    |   +-- tools.ts         # Agent tool definitions (TypeBox)
    |   +-- rpc.ts           # Gateway RPC handlers (rc.lit.*)
    |   +-- zotero.ts        # Zotero read-only bridge
    +-- tasks/
    |   +-- service.ts       # TaskService class
    |   +-- tools.ts         # Task agent tools
    |   +-- rpc.ts           # Task RPC handlers (rc.task.*)
    +-- workspace/
    |   +-- service.ts       # WorkspaceService class
    |   +-- tools.ts         # Workspace agent tools
    |   +-- rpc.ts           # Workspace RPC handlers (rc.ws.*)
    |   +-- git-tracker.ts   # Auto-commit workspace changes
    +-- cards/
    |   +-- protocol.ts      # Message card type definitions
    |   +-- serializer.ts    # Card serialization/parsing
    +-- db/
        +-- schema.ts        # DDL constants (15 tables + FTS5)
        +-- migrations.ts    # Versioned migrations (SCHEMA_VERSION 6)
        +-- connection.ts    # better-sqlite3 manager
```

### 2.3 Database (SQLite via better-sqlite3)

**Location:** `.research-claw/library.db` (configurable via `config.dbPath`)

**14 tables + FTS5** (all prefixed `rc_`):

| Table | Module | Purpose |
|-------|--------|---------|
| `rc_schema_version` | DB | Migration version tracking |
| `rc_papers` | Literature | Paper metadata |
| `rc_tags` | Literature | Tag definitions |
| `rc_paper_tags` | Literature | Paper-tag junction |
| `rc_collections` | Literature | Named paper collections |
| `rc_collection_papers` | Literature | Collection-paper junction |
| `rc_smart_groups` | Literature | Saved query filters |
| `rc_reading_sessions` | Literature | Reading time tracking |
| `rc_citations` | Literature | Inter-paper citation links |
| `rc_paper_notes` | Literature | Annotation notes on papers |
| `rc_tasks` | Tasks | Task items (deadline-sorted) |
| `rc_activity_log` | Tasks | Event tracking / audit |
| `rc_agent_notifications` | Notifications | Agent-pushed bell notifications |
| `rc_cron_state` | Cron | Preset enable/disable + gateway job IDs |
| `rc_papers_fts` | Literature | FTS5 virtual table (title, authors, abstract, notes) |

### 2.4 RPC Methods (58 WS + 1 HTTP = 59 total)

| Namespace | Count | Module Doc |
|-----------|------:|-----------|
| `rc.lit.*` | 26 | 03a |
| `rc.task.*` | 11 | 03b |
| `rc.ws.*` | 11 | 03c |
| `rc.cron.*` | 7 | 03b |
| `rc.notifications.*` | 2 | — |
| **WS total** | **57** | |
| `POST /rc/upload` | 1 | 03c (HTTP) |

Full canonical method list: see `docs/00-reference-map.md` SS3.2.

### 2.5 Agent Tools (28 allowlisted)

**Literature (12):**
- `library_add_paper`, `library_search`, `library_update_paper`, `library_get_paper`, `library_export_bibtex`, `library_reading_stats`
- `library_batch_add`, `library_manage_collection`, `library_tag_paper`, `library_add_note`, `library_import_bibtex`, `library_citation_graph`

**Tasks (9):**
- `task_create`, `task_list`, `task_complete`, `task_update`, `task_link`, `task_note`
- `task_link_file`, `cron_update_schedule`, `send_notification`

**Workspace (7):**
- `workspace_save`, `workspace_read`, `workspace_list`, `workspace_diff`, `workspace_history`, `workspace_restore`, `workspace_move`

### 2.6 HTTP Endpoints

| Route | Method | Purpose |
|-------|--------|---------|
| `/rc/upload` | POST | Multipart file upload for workspace |

### 2.7 Message Card Types (6)

| Type | Rendering | Spec |
|------|-----------|------|
| `paper_card` | Rich paper metadata | 03d SS3.1 |
| `task_card` | Task summary | 03d SS3.2 |
| `progress_card` | Session stats | 03d SS3.3 |
| `approval_card` | HiL request | 03d SS3.4 |
| `monitor_digest` | Monitoring update | 03d SS3.5 |
| `file_card` | Workspace file ref | 03d SS3.6 |

Note: `code_block` is not a custom card type. Standard fenced code blocks are handled by the default markdown renderer (see 03d SS3.7).

---

## 3. Development Standards

### 3.1 Module Implementation Order

Each module follows this sequence:
1. **Schema** — Define DDL in `db/schema.ts`, add migration in `db/migrations.ts`
2. **Service** — Implement service class (all DB operations)
3. **Tools** — Define agent tools with TypeBox schemas
4. **RPC** — Register gateway RPC handlers
5. **Tests** — Unit tests for service + integration tests for RPC
6. **Dashboard wiring** — Verify RPC calls from dashboard work end-to-end

**Recommended parallel execution:**
- Literature (03a) + Tasks (03b) + Workspace (03c) can develop concurrently
- Cards (03d) depends on all three
- Plugin aggregation (03f) depends on all modules

### 3.2 Coding Standards

- TypeScript strict mode
- Schema validation: `@sinclair/typebox` for all tool params and RPC payloads
- Database: `better-sqlite3` synchronous API (no async needed for local SQLite)
- IDs: ULID format (`01HX...`) for all new records
- Timestamps: ISO 8601 strings (`datetime('now')` in SQLite)
- Error handling: throw typed errors with `code` + `message` fields
- Task priority enum: `urgent | high | medium | low` (NOT `critical`)

### 3.3 Plugin SDK Contract

```typescript
// Plugin entry point pattern
export async function activate(api: PluginRuntime): Promise<void> {
  // 1. Initialize database
  const db = new DatabaseManager(api.config.dbPath);
  db.migrate();

  // 2. Initialize services
  const litService = new LiteratureService(db);
  const taskService = new TaskService(db);
  const wsService = new WorkspaceService(db, api.config);

  // 3. Register tools
  api.registerTool(createLiteratureTools(litService), { names: [...] });
  api.registerTool(createTaskTools(taskService), { names: [...] });
  api.registerTool(createWorkspaceTools(wsService), { names: [...] });

  // 4. Register RPC handlers
  registerLiteratureRPC(api, litService);
  registerTaskRPC(api, taskService);
  registerWorkspaceRPC(api, wsService);

  // 5. Register HTTP routes
  api.registerHttpRoute({
    path: "/rc/upload",
    method: "POST",
    handler: createUploadHandler(wsService),
  });
}
```

### 3.4 Testing Requirements

- Unit tests: vitest
- Service tests: in-memory SQLite (`:memory:`)
- RPC tests: mock PluginRuntime
- Tool tests: verify TypeBox schema validation
- Coverage target: 90%+ for service classes, 80%+ for RPC handlers

### 3.5 PR Checklist

- [ ] Schema migration versioned correctly
- [ ] All RPC method names match canonical list in 00-reference-map
- [ ] TypeBox schemas validate edge cases (empty strings, nulls, max lengths)
- [ ] Service methods are pure (no side effects outside DB)
- [ ] Zotero bridge is read-only (no writes)
- [ ] Task priority uses `urgent` (not `critical`)
- [ ] FTS5 index updated on paper add/update/delete
- [ ] Git auto-tracking respects `config.autoTrackGit` flag
- [ ] Card serialization matches 03d format exactly

---

## 4. Module-Specific Notes

### 4.1 Literature (03a)

- **FTS5**: `rc_papers_fts` virtual table on `title`, `abstract`, `authors`. Rebuild on schema change.
- **Zotero bridge**: Read-only via local Zotero database (~/.zotero/). Use `better-sqlite3` to read.
- **Citation style**: Default APA. Support: APA, MLA, Chicago, IEEE, Vancouver, Harvard, Nature, ACM, ACS, custom CSL.
- **Duplicate detection**: Match by DOI first, then title fuzzy match (Levenshtein < 3).
- **Paper notes**: New `rc_paper_notes` table (03a SS2.10). Notes are Markdown, optional page reference + highlight.

### 4.2 Tasks (03b)

- **Deadline-sorted**: Tasks always sorted by deadline ASC (soonest first). Null deadlines at bottom.
- **Priority**: `urgent | high | medium | low` (NOT `critical`).
- **Linking**: `rc.task.link` creates paper-task association. One task can link to multiple papers.
- **Cron presets**: 3 RPC methods for managing periodic tasks (arXiv scan, citation tracking, deadline reminders).

### 4.3 Workspace (03c)

- **Git auto-tracking**: When `config.autoTrackGit` is true, auto-commit on file save with generated message.
- **File structure**: `sources/` (input files) + `outputs/` (generated files).
- **Upload**: HTTP POST `/rc/upload` (multipart form-data). **Not WS RPC.**
- **`rc.ws.save`**: New method (Plan 2 fix). Writes file + optional auto-commit.

### 4.4 Message Cards (03d)

- **Format**: Fenced code blocks with card type as language tag.
- **Unknown types**: Graceful fallback to default code block rendering.
- **Serializer**: Must handle both JSON parse and string template rendering.

### 4.5 Plugin Core (03f)

- **Lifecycle**: `activate()` called once at gateway start. `deactivate()` on shutdown.
- **Config schema**: Validated by OpenClaw plugin loader via manifest `configSchema`.
- **Total RPC**: 58 WS + 1 HTTP = 59 methods (26 lit + 11 task + 11 ws + 7 cron + 2 notifications + 1 model).

---

## 5. Operation Log

> Append entries as work progresses.

### 5.1 Scaffold

- [2026-03-11] [Claude] Initial scaffold: 16 TS files, plugin manifest, package.json. All files are TODO stubs.
- [2026-03-11] [Claude] Plan 2 consistency fixes: added rc_paper_notes table, 8+2+1 new RPC methods, priority enum fix.

### 5.2 Literature Module

<!-- Append implementation entries here -->

### 5.3 Task Module

<!-- Append implementation entries here -->

### 5.4 Workspace Module

<!-- Append implementation entries here -->

### 5.5 Cards Module

<!-- Append implementation entries here -->

### 5.6 Plugin Core

<!-- Append implementation entries here -->

### 5.7 Issues & Fixes

<!-- Append bug fixes here -->

---

## 6. Dependencies on Other Tracks

| Dependency | Track | Blocks |
|------------|-------|--------|
| Card rendering components | Dashboard (S1) | Visual verification |
| Gateway WS RPC protocol | — (OpenClaw built-in) | RPC handler registration |
| Plugin SDK types | — (openclaw/plugin-sdk) | Tool + RPC registration |
| research-plugins skills | Plugin Integration (S3) | Skill-tool coordination |
| Bootstrap file AGENTS.md | Prompt (S4) | Agent knows how to use tools |

---

*Document: S2 | Track: Modules | Created: 2026-03-11*

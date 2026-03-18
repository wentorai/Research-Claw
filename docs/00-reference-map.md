# 00 — Master Reference Map

> Research-Claw Documentation Index
> Status: Complete | OpenClaw base: `2026.3.8` (commit `62d5df28d`) | Protocol: v3

---

## 1. Document Inventory

| # | Path | Lines | Purpose | Dependencies |
|---|------|------:|---------|-------------|
| 00 | `docs/00-reference-map.md` | — | Master index & cross-reference | All others |
| 01 | `docs/01-interaction-design.md` | 1867 | Global UI/UX design spec | 02 |
| 02 | `docs/02-engineering-architecture.md` | 2056 | Global engineering spec | — |
| 03a | `docs/modules/03a-literature-library.md` | 2049 | Literature library module | 02 |
| 03b | `docs/modules/03b-task-system.md` | 733 | Task system module | 02, 03a |
| 03c | `docs/modules/03c-workspace-git-tracking.md` | 1172 | Workspace & git tracking | 02 |
| 03d | `docs/modules/03d-message-card-protocol.md` | 1494 | Message card protocol | — |
| 03e | `docs/modules/03e-dashboard-ui.md` | 952 | Dashboard UI engineering | 01, 02, 03d |
| 03f | `docs/modules/03f-research-claw-core-plugin.md` | 1681 | Plugin aggregation spec | 03a–03d |
| 04 | `docs/04-prompt-design-framework.md` | 1561 | Bootstrap file system | 02 |
| 05 | `docs/05-plugin-integration-guide.md` | 2151 | Plugin development guide | 02 |
| 06 | `docs/06-install-startup-design.md` | 1818 | Scripts & deployment | 02 |
| S1 | `docs/sop/01-dashboard-dev-sop.md` | — | Dashboard development SOP & operation log | 01, 03d, 03e |
| S2 | `docs/sop/02-modules-dev-sop.md` | — | Plugin modules development SOP & operation log | 03a–03f |
| S3 | `docs/sop/03-plugin-integration-sop.md` | — | Plugin ecosystem integration SOP | 05 |
| S4 | `docs/sop/04-prompt-behavior-sop.md` | — | Prompt/bootstrap development SOP | 04 |
| CL | `docs/CHANGELOG.md` | — | Global operation log (all tracks, merged from sop/CHANGELOG + CHANGELOG-model-provider-config) | All |

**Total:** ~17,534 lines across 12 design documents + 5 SOP documents.

---

## 2. Dependency DAG

```
                    +--------+
                    |   02   |  Engineering Architecture (root)
                    +---+----+
           +------------+------------+-----------+
           v            v            v           v
        +------+    +------+    +------+    +------+
        |  01  |    |  04  |    |  03d |    |  05  |
        +--+---+    +--+---+    +--+---+    +------+
           |           |           |
    +------+-----------+           |
    |      |                       |
    v      v                       v
 +-----++-----++-----+         +-----+
 | 03a || 03b || 03c |         | 03e |
 +--+--++--+--++--+--+         +-----+
    |      |      |
    +------+------+
           v
        +------+
        |  03f |  Plugin Aggregation
        +--+---+
           v
        +------+
        |  06  |  Install & Startup
        +------+
```

**Phase execution order** (parallel within phase):
1. `02`, `00` (skeleton)
2. `01`, `04`, `03d`
3. `03a`, `03b`, `03c`
4. `03e`, `03f`, `05`
5. `06`
6. `00` (finalize)

---

## 3. Canonical Interface Registry

> Single source of truth for each interface definition. Module docs (03a/03b/03c) are
> canonical for their respective interfaces. 03f aggregates them — in case of conflict,
> module docs take precedence.

### 3.1 SQLite Tables

| # | Table | Defining Doc | Purpose |
|---|-------|-------------|---------|
| 1 | `rc_schema_version` | 03a §2.12 | Migration version tracking (version + applied_at) |
| 2 | `rc_papers` | 03a §2.1 | Paper metadata (title, authors, DOI, abstract, etc.) |
| 3 | `rc_tags` | 03a §2.2 | Tag definitions (name, color) |
| 4 | `rc_paper_tags` | 03a §2.3 | Paper–tag junction |
| 5 | `rc_collections` | 03a §2.4 | Named paper collections |
| 6 | `rc_collection_papers` | 03a §2.5 | Collection–paper junction (with sort_order) |
| 7 | `rc_smart_groups` | 03a §2.6 | Dynamic filter groups (saved queries as JSON) |
| 8 | `rc_reading_sessions` | 03a §2.7 | Reading time tracking (duration_minutes, pages_read) |
| 9 | `rc_citations` | 03a §2.8 | Inter-paper citation links (citing/cited with context) |
| 10 | `rc_paper_notes` | 03a §2.10 | Annotation notes on papers (page, highlight) |
| 11 | `rc_tasks` | 03b §2 | Task items (deadline-sorted, linked to papers via related_paper_id) |
| 12 | `rc_activity_log` | 03b §2 | Task event tracking / audit log |
| — | `rc_papers_fts` | 03a §2.9 | FTS5 virtual table on papers (title, authors, abstract, notes) |

| 13 | `rc_agent_notifications` | — | Agent-sent notifications for dashboard bell (type, title, body, read) |
| 14 | `rc_cron_state` | — | Cron preset state (enabled, config, schedule, gateway_job_id) |

All tables prefixed `rc_` to avoid collision with OpenClaw internals. Database located at `.research-claw/library.db` (configured in `openclaw.json`). **14 regular tables + 1 FTS5 virtual table, 3 FTS sync triggers, 23 indexes.** Schema version: 7. Schema source of truth: `extensions/research-claw-core/src/db/schema.ts`.

**Obsolete tables from earlier specs** (do NOT exist in the actual schema):
- ~~`rc_meta`~~ — replaced by `rc_schema_version`
- ~~`rc_task_links`~~ — tasks link to papers directly via `rc_tasks.related_paper_id`
- ~~`rc_workspace_versions`~~ / ~~`rc_workspace_files`~~ — workspace uses git tracking, not DB tables (see 03c)
- ~~`rc_config`~~ — config loaded from JSON file (`openclaw.json`), not DB
- ~~`rc_radar_config`~~ — removed in v0.5.2; radar replaced by universal monitor system

### 3.2 RPC Methods (Custom `rc.*` Namespace)

| Namespace | Count | Defining Doc | Notes |
|-----------|------:|-------------|-------|
| `rc.lit.*` | 26 | 03a §5 | Literature CRUD, search, tags, reading sessions, citations, notes, collections, batch/import/export |
| `rc.task.*` | 11 | 03b §5 | Task CRUD, complete, upcoming, overdue, link, linkFile, notes |
| `rc.ws.*` | 11 | 03c §4 | Workspace tree, read, save, history, diff, restore, delete, saveImage, openExternal, openFolder, move (upload is HTTP — see §3.6) |
| `rc.cron.presets.*` | 7 | 03b §5 | Cron preset list, activate, deactivate, setJobId, delete, restore, updateSchedule |
| `rc.notifications.*` | 2 | — | Pending notifications (tasks + custom) + mark-read for dashboard bell |

**Full RPC method list** (canonical names from module docs):

```
rc.lit.list             rc.lit.get              rc.lit.add              rc.lit.update
rc.lit.delete           rc.lit.status           rc.lit.rate             rc.lit.tags
rc.lit.tag              rc.lit.untag            rc.lit.reading.start    rc.lit.reading.end
rc.lit.reading.list     rc.lit.cite             rc.lit.citations        rc.lit.stats
rc.lit.search           rc.lit.duplicate_check
rc.lit.batch_add        rc.lit.import_bibtex    rc.lit.export_bibtex
rc.lit.collections.list rc.lit.collections.manage
rc.lit.notes.list       rc.lit.notes.add        rc.lit.notes.delete
                                                                        (26 methods)

rc.task.list            rc.task.get             rc.task.create          rc.task.update
rc.task.complete        rc.task.delete          rc.task.upcoming        rc.task.overdue
rc.task.link            rc.task.linkFile        rc.task.notes.add
                                                                        (11 methods)

rc.ws.tree              rc.ws.read              rc.ws.save              rc.ws.history
rc.ws.diff              rc.ws.restore           rc.ws.delete            rc.ws.saveImage
rc.ws.openExternal      rc.ws.openFolder        rc.ws.move
(rc.ws.upload is HTTP POST, not WS RPC — see §3.6)
                                                                        (11 methods)

rc.cron.presets.list         rc.cron.presets.activate    rc.cron.presets.deactivate
rc.cron.presets.setJobId     rc.cron.presets.delete      rc.cron.presets.restore
rc.cron.presets.updateSchedule
                                                                        (7 methods)

rc.notifications.pending     rc.notifications.markRead
                                                                        (2 methods)
```

### 3.3 Agent Tools

| Tool | Defining Doc | Description |
|------|-------------|-------------|
| `library_add_paper` | 03a §3 | Add paper by DOI, title, or BibTeX |
| `library_search` | 03a §3 | Search library by keyword, author, tag, status |
| `library_update_paper` | 03a §3 | Update metadata, status, annotations |
| `library_get_paper` | 03a §3 | Retrieve full paper details |
| `library_export_bibtex` | 03a §3 | Export library subset as BibTeX |
| `library_reading_stats` | 03a §3 | Reading activity summary |
| `library_batch_add` | 03a §3 | Batch import multiple papers |
| `library_manage_collection` | 03a §3 | Create/update/delete collections |
| `library_tag_paper` | 03a §3 | Add/remove tags on papers |
| `library_add_note` | 03a §3 | Add annotation note to paper |
| `library_import_bibtex` | 03a §3 | Import from BibTeX file |
| `library_citation_graph` | 03a §3 | Query citation relationships |
| `task_create` | 03b §3 | Create task with optional deadline |
| `task_list` | 03b §3 | List tasks, filter by status/project/deadline |
| `task_complete` | 03b §3 | Mark task as done |
| `task_update` | 03b §3 | Update task details |
| `task_link` | 03b §3 | Link task to a paper (sets related_paper_id) |
| `task_note` | 03b §3 | Add note/comment to task |
| `workspace_save` | 03c §3 | Save content to workspace file |
| `workspace_read` | 03c §3 | Read a workspace file |
| `workspace_list` | 03c §3 | List files in workspace |
| `workspace_diff` | 03c §3 | Show changes to file |
| `workspace_history` | 03c §3 | Show file edit history |
| `workspace_restore` | 03c §3 | Restore previous file version |
| `workspace_move` | 03c §3 | Move or rename a file/directory within workspace |
| `task_link_file` | 03b §3 | Link a task to a workspace file |
| `cron_update_schedule` | 03b §3 | Update cron preset schedule expression |
| `send_notification` | — | Push a notification to the dashboard bell icon |

**28 tools total** (12 literature + 9 task + 7 workspace). Config `tools.alsoAllow` lists 41 entries (28 RC tools + 13 external API tools). Three RC tools (task_link_file, cron_update_schedule, workspace_move) are registered by the plugin but not yet in alsoAllow — they work because the agent can call any registered tool, while alsoAllow only gates tools that require explicit pre-approval.

### 3.4 Message Card Types

| Card Type | Defining Doc | React Component | Description |
|-----------|-------------|-----------------|-------------|
| `paper_card` | 03d §3.1 | `PaperCard.tsx` | Paper metadata + action buttons |
| `task_card` | 03d §3.2 | `TaskCard.tsx` | Task summary + panel link |
| `progress_card` | 03d §3.3 | `ProgressCard.tsx` | Session/period summary stats |
| `approval_card` | 03d §3.4 | `ApprovalCard.tsx` | Human-in-Loop approval request |
| `monitor_digest` | 03d §3.5 | `MonitorDigest.tsx` | Monitoring update, notable papers |
| `file_card` | 03d §3.6 | `FileCard.tsx` | Workspace file reference |

Convention: fenced code blocks with card type as language tag. Standard code blocks (e.g., `python`, `typescript`) are handled by the default markdown renderer, not as custom card types (see 03d §3.7). Unknown types degrade gracefully to default code block.

### 3.5 Bootstrap Files

| File | Defining Doc | Chars | Purpose |
|------|-------------|------:|---------|
| `SOUL.md` | 04 §3 | 4,058 | Research persona, core principles, red lines |
| `AGENTS.md` | 04 §4 | 17,316 | Session workflow, SOP, HiL protocol, output formatting, card examples |
| `HEARTBEAT.md` | 04 §5 | 3,312 | Periodic checks: deadlines, digest, reading reminders |
| `BOOTSTRAP.md` | 04 §6 | 6,363 | First-run onboarding (self-deletes after setup) |
| `IDENTITY.md` | 04 §7 | 703 | Product identity, persona |
| `USER.md` | 04 §8 | 970 | User profile template |
| `TOOLS.md` | 04 §9 | 4,676 | API reference, local tools |
| `MEMORY.md` | 04 §10 | 964 | Persistent memory template (v1.1: Global + Current Focus + Projects) |

**Total:** ~38,362 chars (limit: 150K total, 20K per file).

### 3.6 HTTP Endpoints

| Route | Method | Defining Doc | Purpose |
|-------|--------|-------------|---------|
| `/rc/upload` | POST | 03c §5 | Multipart file upload for workspace |

---

## 4. Glossary

| Term | Definition |
|------|-----------|
| **Satellite** | Architecture pattern: OpenClaw as npm dependency + config overlay + patch, avoiding a fork |
| **Bootstrap File** | Markdown files (SOUL.md, AGENTS.md, etc.) loaded into agent context at session start |
| **Coupling Tier** | Dependency depth: L0 (filesystem) → L1 (Plugin SDK) → L2 (WS RPC) → L3 (pnpm patch) |
| **Human-in-Loop (HiL)** | Agent must request human approval before irreversible actions |
| **Gateway** | OpenClaw's local server providing WS RPC and HTTP endpoints on port 28789 |
| **Message Card** | Structured data in fenced code blocks that the dashboard renders as rich UI components |
| **Project (Workstream)** | Shared attention focus — NOT an isolated container. All projects share global MEMORY.md |
| **Research-Claw** | English product name (科研龙虾 in Chinese). Local academic AI research assistant. |
| **RPC Method** | Gateway WebSocket request/response function call (e.g., `rc.lit.search`) |
| **FTS5** | SQLite Full-Text Search extension used for paper search |
| **pnpm Patch** | ~20-line patch across 7 files for branding (CLI name, process title, system prompt, etc.) |
| **HashMind** | Design language: Dark Cyberpunk Terminal Aesthetic. Lobster Red (#EF4444) + Academic Blue (#3B82F6) |
| **Control UI** | Gateway-served web dashboard at `./dashboard/dist` |
| **Cron Preset** | Pre-configured periodic tasks: arXiv scan, citation tracking, deadline reminders, group meeting prep, weekly report (5 total) |
| **Exec SafeGuard** | `before_tool_call` hook blocking catastrophic CLI commands (rm -rf /, dd, mkfs, shred, fork bomb) outside workspace |
| **Security Model** | 4-layer: L1 Network (local-only gateway) → L2 Workspace Sandbox (init scaffold + git) → L3 Exec Guard (before_tool_call hook) → L4 Git Versioning (auto-commit + restore) + Prompt HiL (AGENTS.md approval protocol) |

---

## 5. Quick-Start Decision Tree

**"I want to..."**

- **...understand the overall architecture** → Read `02` first, then `README.md`
- **...design a UI component** → Read `01` (visual spec) + `03e` (engineering) + `03d` (card protocol)
- **...implement a literature feature** → Read `03a` (canonical spec) + `03f` (plugin wiring)
- **...implement a task feature** → Read `03b` (canonical spec) + `03f` (plugin wiring)
- **...implement a workspace feature** → Read `03c` (canonical spec) + `03f` (plugin wiring)
- **...add a new message card type** → Read `03d` (protocol) + `03e` §component tree
- **...write or modify a bootstrap file** → Read `04` (framework) + existing files in `workspace/`
- **...build a new plugin** → Read `05` (dev guide) + `02` §6 (SDK contract)
- **...set up the dev environment** → Read `06` (install/startup) + `README.md`
- **...add a new RPC method** → Read `02` §4 (protocol) + the relevant module doc (03a/03b/03c)
- **...understand the config** → Read `02` §9 (build pipeline) + `config/openclaw.json`
- **...add a cron preset** → Read `03b` §5 (cron integration) + `04` §5 (HEARTBEAT.md)

---

## 6. Cross-Reference Matrix

Which docs reference which:

| Doc | References | Referenced By |
|-----|-----------|---------------|
| 02 | — | 01, 03a–03f, 04, 05, 06 |
| 01 | 02, 03d | 03e |
| 04 | 01, 02, 03d | — |
| 03d | — | 01, 03a, 03b, 03e, 03f, 04 |
| 03a | 02, 03d | 03b, 03f |
| 03b | 02, 03a, 04 | 03f |
| 03c | 02 | 03b, 03e, 03f |
| 03e | 01, 02, 03d | — |
| 03f | 03a–03d, 05 | 06 |
| 05 | 02, 03f | — |
| 06 | 02, 04 | — |

---

## 7. Key Design Decisions

Finalized decisions that all docs must respect:

| Decision | Value | Origin |
|----------|-------|--------|
| Setup wizard | 1 step (API key only) | User confirmed |
| Task display | Deadline-sorted list, NOT Kanban | User confirmed |
| Projects model | Shared workstreams, NOT isolated containers | User confirmed |
| Global search | NO command-K for MVP | User confirmed |
| Status bar | Token count only, NO cost/money | User confirmed |
| CRUD routing | Simple → direct RPC; Complex → chat | User confirmed |
| Dashboard framework | React 18 + Ant Design 5 (NOT Lit) | Team expertise |
| Literature ownership | Agent's own SQLite DB, NOT Zotero tab | User confirmed |
| Zotero interop | Read-only import via NL command | User confirmed |
| Theme | Dark default (terminal), light option (warm paper) | User confirmed |
| Heartbeat thresholds | Configurable defaults (48h deadline, 23–08 quiet, 7d stale) | Design-proposed |
| wentor-connect plugin | Placeholder / future scope, no MVP spec | Architecture decision |

---

## 8. Security Model

Research-Claw operates **entirely local** with a 4-layer defense model:

| Layer | Mechanism | Scope |
|-------|-----------|-------|
| **L1 — Network** | Gateway binds to `loopback` only, auth mode `none` (local trust) | No remote access possible |
| **L2 — Workspace Sandbox** | `workspace_save/read/list` enforce resolved-path boundary; scaffold created on init | Agent file writes contained |
| **L3 — Exec Guard** | `before_tool_call` hook on `exec` tool: blocks catastrophic patterns (`rm -rf /`, `dd of=/dev/`, `mkfs`, `shred`, fork bomb) unless command targets workspace root | Prevents irreversible CLI ops |
| **L4 — Git Versioning** | GitTracker auto-commits workspace changes; `workspace_restore` recovers any version | All writes reversible |
| **L+ — Prompt HiL** | AGENTS.md §7 approval protocol: agent must ask before delete/bulk/destructive actions | Human confirmation gate |

**Design principles:**
- Block only catastrophic/irreversible operations; trust OpenClaw's agentic self-correction loop for recoverable errors
- No `tools.deny` list — native tools (write, edit, exec) remain fully available for normal workflow
- Security must never degrade normal user experience
- Workspace path validation uses absolute resolved path, not string matching

**Plugin hooks** (7 total): `before_prompt_build`, `session_start`, `session_end`, `before_tool_call` (exec guard + cron sync), `agent_end`, `after_tool_call` (cron sync), `gateway_start`.

---

*Updated: 2026-03-18 | OpenClaw: 2026.3.8 | Protocol: v3 | RPC: 57 WS + 1 HTTP = 58 methods | Tables: 14 + FTS5 | Tools: 28 | Cards: 6 | Hooks: 7 | Indexes: 23*

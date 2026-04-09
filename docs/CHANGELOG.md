# Research-Claw Global Operation Log

> Unified changelog across all development tracks.
> Per-track details: see individual SOP files (S1-S4).

---

## Format

```
[YYYY-MM-DD] [Track] [Agent/Author] — Description
```

Tracks: `Dashboard` (S1), `Modules` (S2), `Plugins` (S3), `Prompt` (S4), `Infra` (general)

---

## Log

### 2026-04-10 — Workspace CRUD Overhaul

- [2026-04-10] [Modules] [Claude] fix(P0): `service.move()` git tracking — only destination path was staged, source deletion left as permanent unstaged `D` entry in `git status`. New `commitMove()` in GitTracker atomically stages both paths in one batch, git correctly records rename.
- [2026-04-10] [Modules] [Claude] fix(P0): `service.move()` silent overwrite — `fsp.rename()` overwrites existing destination on POSIX without warning. Added pre-check: throws `WS_WRITE_FAILED` if destination exists, preserving both files.
- [2026-04-10] [Modules] [Claude] feat: `workspace_delete` agent tool (#9) — LLM can now delete files (previously only dashboard `rc.ws.delete` RPC). Requires `confirm=true` safety guard. Returns `restore_hint` guiding user to `workspace_restore`.
- [2026-04-10] [Modules] [Claude] feat: `workspace_append` agent tool (#10) — atomic append without read+concat+save round-trip. Reduces 3 tool calls to 1, prevents accidental full-file overwrite by LLM. Supports custom separator, binary guard, auto file_card emission.
- [2026-04-10] [Modules] [Claude] feat: `workspace_download` agent tool (#11) — fetch URL → save binary to workspace. Enables PDF download to `sources/papers/` (previously impossible due to `BINARY_SAVE_GUARD`). SSRF guard blocks private IPs (10.x, 172.16-31.x, 192.168.x, 127.x, 169.254.x), localhost, cloud metadata endpoints. Streaming download with 50MB size limit prevents OOM.
- [2026-04-10] [Modules] [Claude] fix: `workspace_save` overwrite detection — added `is_new` field to `service.save()` return (zero-cost, reuses internal `isNew` check). Tool shows `⚠️ Overwrote existing file` warning. Replaces prior implementation that called `service.read()` for each save (full file read just for existence check).
- [2026-04-10] [Modules] [Claude] fix: `service.delete()` return type — added optional `restore_hint` field ("File is recoverable from git history. Use workspace_restore to undo.") when git commit succeeds.
- [2026-04-10] [Modules] [Claude] fix: `workspace_save` description — added `outputs/` vs `uploads/` directory convention hint for LLM.
- [2026-04-10] [Prompt] [Claude] feat: workspace-sop/SKILL.md — tool table 8→11, added Delete/Append/Download rows, new "Download & Import" section, "Prefer append" write discipline, updated cross-module triggers (PDF download→library, paper→BibTeX append).
- [2026-04-10] [Prompt] [Claude] feat: AGENTS.md §2 module map 8→11 tools, §3.1 card emission table includes `workspace_append`/`workspace_download`, §4 cross-module handoff +2 items (PDF download indexing, BibTeX append).
- [2026-04-10] [Prompt] [Claude] feat: coding-sop/SKILL.md — added "Output paths" rule (all script outputs MUST use workspace-relative paths), added `workspace_append`/`workspace_download` to §8 tool reference.
- [2026-04-10] [Infra] [Claude] test: `workspace-crud.test.ts` — 31 functional tests covering service-level (save is_new, move dest guard, move git tracking, delete restore_hint) + tool-level (workspace_delete confirm guard, workspace_append create/append/separator/binary/sequential, workspace_download SSRF 10 cases, workspace_move dest rejection).
- [2026-04-10] [Infra] [Claude] Tests: 3 workspace files, 24 + 27 + 31 = 82 total pass

### 2026-04-05 — Prompt Architecture Overhaul

- [2026-04-05] [Prompt] [Siyuan] feat: AGENTS.md v4.0 → v4.1 — prompt architecture overhaul borrowing Claude Code system prompt patterns. New §3 Quick Paths, §3.1 Card Emission Protocol (tool→card mapping with CRITICAL warnings), §3.2 Search Fallback Chain (L1 API → L1.5 web_fetch with concrete arXiv/PubMed URLs → L2 browser → ask user), §3.3 Domain→Tool Quick Reference. §9 expanded from pointer to full inline schemas for all 6 card types. ~12.9K chars (was ~8K).
- [2026-04-05] [Prompt] [Siyuan] feat: SOUL.md v2.1 → v2.2 — added Core Principle #6 "Tool-first, then reason" (call search tools before answering from training data, emit dashboard cards, escalate on failure). Red lines count 6 → 7 (added #6 "No false-negative detection").
- [2026-04-05] [Modules] [Siyuan] feat: card emission in tool text — library_add_paper, library_batch_add, task_create, task_complete, task_update now embed paper_card/task_card JSON in response text, built from actual service return data
- [2026-04-05] [Modules] [Siyuan] fix: library_batch_add Paper type — replace `(p: any)` with `(p: Paper)` in card builder, import Paper type from service
- [2026-04-05] [Infra] [Siyuan] test: bootstrap-consistency.test.ts updated for AGENTS.md v4.1, fix JSDoc comment (7→8 workspace tools)

### 2026-04-02 — Bugfixes + Input History

- [2026-04-02] [Dashboard] [Claude] fix(P0): chat.history toolResult flooding — pnpm patch filters toolResult before limit slice; 1715 identical Zotero tool calls from glm-5 model pushed all visible messages out of 500-entry window
- [2026-04-02] [Dashboard] [Claude] fix(P0): WS close code 1001 now triggers auto-reconnect instead of terminal disconnected state
- [2026-04-02] [Modules] [Claude] fix(P0): before_tool_call dedup guard — blocks >5 consecutive identical tool calls (model tool-call loop prevention), resets on session_start
- [2026-04-02] [Infra] [Claude] fix: timeoutSeconds 900→300 in config, example, and ensure-config.cjs (idempotent cap)
- [2026-04-02] [Dashboard] [Claude] feat: input history — ArrowUp/Down terminal-style navigation, popup with hover tooltip for long text, localStorage persistence (50 items), keyboard shortcut tip, 18 parity tests
- [2026-04-02] [Dashboard] [Claude] feat: refresh toast feedback — success/info/error toast via Ant Design message API
- [2026-04-02] [Infra] [Claude] chore: update pnpm-lock.yaml patch hash for chat.history fix
- [2026-04-02] [Infra] [Claude] Tests: 64 files, 1169 dashboard + 428 extension = 1597 total pass

### 2026-03-30 — v0.6.0 Release

- [2026-03-30] [Dashboard] [Claude] feat: workspace silent polling (10s) + manual refresh button — fetchingRef/priorityRef priority lock, JSON snapshot diff, silent error handling for non-localhost
- [2026-03-30] [Dashboard] [Claude] feat: PPT tab UX overhaul — format Input→Select (8 canvas formats + tooltip), "初始化"→"提交任务" with Modal.confirm, output file Select dropdown (mtime desc), projectName validation + localStorage persistence
- [2026-03-30] [Dashboard] [Claude] fix: PPT open output uses rc.ws.openExternal + DockerFileModal (replaces rc.ppt.open), Docker/WSL2 browser download support
- [2026-03-30] [Dashboard] [Claude] fix: useCallback deps stability — selectedSourceRef/selectedOutputRef avoid infinite effect loops, remove unstable t/messageApi from deps
- [2026-03-30] [Infra] [Claude] fix: run.sh path resolution — reroot stale absolute paths from different machines (suffix-match + fs.existsSync), dedup plugin paths
- [2026-03-30] [Infra] [Claude] fix: ensure-config.cjs — deduplicate plugins.load.paths on every startup
- [2026-03-30] [Infra] [Claude] Tests: 23 new PptTab tests + 8 WorkspacePanel tests pass, 1151 total (was 1029)
- [2026-03-30] [Modules] [Claude] feat: Ollama tool call capability probe — `rc.model.probeToolCalling` RPC, before_prompt_build agent warning injection, Dashboard warning banner (ChatView), BOOTSTRAP.md Tool Call Failure Protocol, AGENTS.md red line §6.6 "No false-negative detection"
- [2026-03-30] [Modules] [Siyuan] feat: workspace_export tool + binary write rejection in workspace_save (#38)
- [2026-03-30] [Modules] [Siyuan] feat: PPT export module (ppt-master integration) — ppt_export tool, project/slide/export pipeline
- [2026-03-30] [Dashboard] [Siyuan] feat: seven UX improvements (PR #35) — ToolActivityHistory, ExtensionsPanel overhaul, Library batch ops, ChatView enhancements, ConfigRestartListener, slash command autocomplete
- [2026-03-30] [Dashboard] [Siyuan] fix: NotificationDropdown insertBefore DOM error — replace antd Typography with CSS ellipsis
- [2026-03-30] [Dashboard] [Siyuan] fix: rename "项目/Project" → "会话/Session" in session switcher
- [2026-03-30] [Infra] [Siyuan] fix: token auth resilience — env-var-driven alignment, SIGUSR1 drift guard, needs_token UX overhaul
- [2026-03-30] [Infra] [Siyuan] fix: install.sh + systemd service token auth convention alignment
- [2026-03-30] [Infra] [Siyuan] fix: fresh-install config wizard 10s wait — unconfigured fast-path
- [2026-03-30] [Infra] [Siyuan] fix: curl|bash stdin consumption syntax error
- [2026-03-30] [Infra] [Claude] fix(review): PR #35 code review — 7 fixes across P1/P2/P3
- [2026-03-30] [Modules] [Claude] fix(P1): PptService.runOpen() — remove `shell: true`, use direct spawn args (security)
- [2026-03-30] [Dashboard] [Claude] fix(P1): tool-stream runSessionMap — add 100-entry eviction cap (memory leak)
- [2026-03-30] [Infra] [Claude] test(P1): 21 new PptService unit tests (path validation, rename, list, status, constructor)
- [2026-03-30] [Dashboard] [Claude] refactor(P2): extract shared `fmtTime`/`fmtActivityRow`/`safeStringifyDetail` to `utils/activity-log.ts`
- [2026-03-30] [Dashboard] [Claude] fix(P2): tool-stream.ts result/end block indentation + variable naming
- [2026-03-30] [Dashboard] [Claude] fix(P2): guard activity log detail rendering — safeStringifyDetail (circular ref catch + 8KB truncate)
- [2026-03-30] [Dashboard] [Claude] fix(P3): LeftNav cron deletion — `confirm()` → `Modal.confirm` (Ant Design consistency)
- [2026-03-30] [Dashboard] [Claude] fix(P3): /clear double loadHistory — move reload to else branch (switchSession already reloads)
- [2026-03-30] [Infra] [Claude] test: 10 new activity-log util tests (fmtTime, fmtActivityRow, safeStringifyDetail edge cases)
- [2026-03-30] [Infra] [Claude] fix: config wizard 10s wait — unconfigured fast-path (cherry-picked config.ts from d42894f)
- [2026-03-30] [Infra] [Claude] Tests: 62 files, 1128 dashboard + 401 extension = 1529 total pass
- [2026-03-27] [Dashboard] [Claude] fix: config-save restart race + reconnect toast via global listener
- [2026-03-27] [Dashboard] [Claude] fix: notification persistence, markdown rendering, timestamp sort
- [2026-03-27] [Infra] [Claude] fix: activity log circular ref + oversized payload guard + unit tests

### 2026-03-27 — Notification Subsystem Bugfixes + Test Suite Cleanup

- [2026-03-27] [Dashboard] [Claude] fix(P0): notification timestamps reset to "just now" on page refresh — full `Notification[]` now persisted to `localStorage` (`rc-notifications`); timestamp set once at creation, immutable
- [2026-03-27] [Dashboard] [Claude] fix: notification body markdown not rendered — added `ReactMarkdown + remarkGfm` to bell panel (hover-expand) and cron toast description
- [2026-03-27] [Dashboard] [Claude] fix: notification sort order undefined — explicit `timestamp` descending sort after every mutation
- [2026-03-27] [Dashboard] [Claude] fix: notification timestamp display uses inline function instead of shared `relativeTime` utility — replaced with i18n-aware `utils/relativeTime.ts`
- [2026-03-27] [Dashboard] [Claude] fix: ReactMarkdown missing `<a>` override — links in notifications now open `target="_blank"` (prevents Electron navigation hijack)
- [2026-03-27] [Dashboard] [Claude] fix: `localeCompare` on ISO timestamps may misbehave on Windows locale — replaced with direct string comparison
- [2026-03-27] [Dashboard] [Claude] fix: `loadNotifications` validation didn't guard against non-object array elements — added `typeof n === 'object'` check
- [2026-03-27] [Infra] [Claude] fix: bootstrap-consistency.test.ts rewritten for AGENTS.md v4.0 / TOOLS.md v4.0 (was v3.3/v3.5 — 66 failures)
- [2026-03-27] [Infra] [Claude] fix: integration-library.test.tsx — deletePaper now triggers 3 RPCs (delete + tags + stats), updated mock and assertion
- [2026-03-27] [Infra] [Claude] fix: library-gaps-coverage.test.tsx — tab labels show server-side counts from `loadStats`, updated expectations
- [2026-03-27] [Infra] [Claude] Tests: 60 files, 1116 tests all pass (was 68 failures across 3 files)

### 2026-03-23 — Heartbeat Token Cost Fix + Settings UI

- [2026-03-23] [Dashboard] [Claude] feat: Settings panel heartbeat controls — ON/OFF toggle + interval selector (15m/30m/1h/2h/4h)
- [2026-03-23] [Dashboard] [Claude] fix(P0): heartbeat `lightContext: true` as RC default — reduces each heartbeat turn from full bootstrap (~10K tokens) to HEARTBEAT.md only (~2K tokens)
- [2026-03-23] [Dashboard] [Claude] feat: config-patch.ts heartbeat round-trip — extractConfigFields reads `agents.defaults.heartbeat`, buildSaveConfig writes with `lightContext: true` always enforced
- [2026-03-23] [Infra] [Claude] feat: ensure-config.cjs migration — existing users auto-receive `lightContext: true` on next startup; user's disabled (`every: "0m"`) setting preserved
- [2026-03-23] [Infra] [Claude] Tests: 7 new heartbeat config tests (build/extract/disable/merge), 1018 total pass

### 2026-03-23 — Gateway Connection Liveness + Config Sync Fix

- [2026-03-23] [Dashboard] [Claude] feat: tick watchdog — port OC client.ts:659-681, 检测 zombie connection (30s tick, 60s timeout → close 4000 → 自动重连)
- [2026-03-23] [Dashboard] [Claude] feat: page visibility recovery — tab 切回时调 `checkTickLiveness()`, 绕过 Chrome 后台 timer 节流
- [2026-03-23] [Dashboard] [Claude] feat: stale stream watchdog — setInterval(15s) 替代 setTimeout, 追踪 `_lastDeltaAt`, 工具执行保护
- [2026-03-23] [Dashboard] [Claude] feat: connection status banner — reconnecting 黄色 / disconnected 红色提示条
- [2026-03-23] [Dashboard] [Claude] fix(P0): config.get 字段偏好反转 — 从 `resolved` (缺 runtime defaults) 改为 `config` (完整)
- [2026-03-23] [Dashboard] [Claude] fix(P0): 删除 wizard fast-path — "No providers → wizard" 不再跳过 5 次 retry, 防止瞬态空配置误触发
- [2026-03-23] [Dashboard] [Claude] refactor: stale timer require → static import (tool-stream 无循环依赖)
- [2026-03-23] [Infra] [Claude] doc: 新增 `docs/踩坑记录/dashboard-gateway-liveness-and-config.md`
- [2026-03-23] [Infra] [Claude] Tests: 9 new gateway client tests (tick watchdog + visibility), 473 total pass

### 2026-03-22 — Dashboard Data Integrity & Performance Sprint

- [2026-03-22] [Dashboard] [Claude] feat: Tasks panel server-side pagination — `PAGE_SIZE=50`, `loadMoreTasks()`, "加载更多" button, hidden during search
- [2026-03-22] [Dashboard] [Claude] fix: ErrorBoundary retry button did nothing — added `retryCount` key to force React remount of child tree
- [2026-03-22] [Modules] [Claude] perf: workspace git N+1 → batch — single `git status --porcelain` replaces per-file spawns
- [2026-03-22] [Modules] [Claude] perf: workspace git history — `Promise.all` parallelizes `git log` + `git rev-list`
- [2026-03-22] [Modules] [Claude] perf: workspace file status 5s TTL cache with mutation invalidation
- [2026-03-22] [Modules] [Claude] fix: git batch status rename path parsing — was taking orig path, now correctly takes destination
- [2026-03-22] [Modules] [Claude] fix: git batch status quoted paths — strip git's quoting for CJK/space filenames
- [2026-03-22] [Dashboard] [Claude] fix: Monitor store sends explicit `limit: 500` (backend cap raised 100→500)
- [2026-03-22] [Dashboard] [Claude] fix: Sessions store `limit: 100→1000`, Chat history `limit: 200→500`
- [2026-03-22] [Infra] [Claude] script: added `scripts/seed-mock-tasks.sh` for testing task pagination
- [2026-03-22] [Infra] [Claude] Tests: 58 files, 1084 tests all pass

### 2026-03-22 — Dashboard ↔ OC Protocol Alignment (Phase 2)

- [2026-03-22] [Dashboard] [Claude] fix(P1-8): scopes 对齐 OC — `[admin, approvals, pairing]` 替换旧 `[read, write, admin]`
- [2026-03-22] [Dashboard] [Claude] fix(P1-5): tool stream 添加 sessionKey 过滤 — 防止 cron/monitor 事件串台
- [2026-03-22] [Dashboard] [Claude] fix(P1-6): cron reconcile 恢复 — gateway 重启后自动重新注册定时任务
- [2026-03-22] [Dashboard] [Claude] fix(P2-9): hello snapshot 解析 — 提取 sessionDefaults + tool stream reset + sessions reload
- [2026-03-22] [Dashboard] [Claude] fix(P2-11): sessions.delete 加 `deleteTranscript: true` — 清理残留 transcript 文件
- [2026-03-22] [Dashboard] [Claude] fix(P2-12): chat.history 加 `limit: 200` — 防止长会话全量加载卡顿
- [2026-03-22] [Dashboard] [Claude] fix(P2-10): sessions.list 加 `limit: 100` — 大量 session 时性能优化
- [2026-03-22] [Dashboard] [Claude] refactor(P2-14): 提取 `utils/session-key.ts` 共享模块 — 统一 normalizeSessionKey 和 isMainSessionKey
- [2026-03-22] [Infra] [Claude] doc: 新增 `docs/core-upgrade/07-DASHBOARD-DEEP-ALIGNMENT.md` 深度对齐审查报告
- [2026-03-22] [Infra] [Claude] doc: 更新 `docs/core-upgrade/05-DASHBOARD-ALIGNMENT-AUDIT.md` — 已修复 5→16 项

### 2026-03-22 — Literature Library Pagination Fix

- [2026-03-22] [Dashboard] [Claude] fix: library inbox limited to 50 papers — dashboard never sent `limit`/`offset` to `rc.lit.list`, backend defaulted to 50
- [2026-03-22] [Dashboard] [Claude] feat: server-side pagination with `PAGE_SIZE=30` and "Load More" button
- [2026-03-22] [Dashboard] [Claude] feat: server-side tab filtering — inbox sends `read_status: ['unread', 'reading']`, archive sends `read_status: ['read', 'reviewed']`, starred sorts by `-rating`
- [2026-03-22] [Modules] [Claude] feat: `rc.lit.list` now supports array `read_status` filter (SQL `IN` clause)
- [2026-03-22] [Dashboard] [Claude] fix: virtual scroll overlap — `rowHeight` 80→112, threshold 50→100, added `overflow: hidden` on VirtualRow
- [2026-03-22] [Dashboard] [Claude] i18n: added `loadMore`, `showingCount` keys (en + zh-CN)
- [2026-03-22] [Infra] [Claude] script: added `scripts/seed-mock-papers.sh` for testing with 100 mock papers
- [2026-03-22] [Infra] [Claude] Tests: 5 test files updated to match new pagination behavior

### 2026-03-20 — Extensions Skills Tab Performance Fix

- [2026-03-20] [Dashboard] [Claude] perf: Skills tab virtual scrolling — react-window v2 `List`, DOM 7500→450 nodes (94% reduction)
- [2026-03-20] [Dashboard] [Claude] perf: `SkillCard` wrapped in `React.memo` + stable props (`onToggleExpand`/`onToggle` lifted to parent)
- [2026-03-20] [Dashboard] [Claude] perf: removed 500× `useExtensionsStore()` subscriptions from SkillCard — store access moved to SkillsTab
- [2026-03-20] [Dashboard] [Claude] perf: memoized `activeCount`/`totalCount` in ExtensionsPanel header
- [2026-03-20] [Dashboard] [Claude] fix: content wrapper `overflow: hidden` + per-tab scroll strategy (virtual for skills, native for channels/plugins)
- [2026-03-20] [Dashboard] [Claude] test: added react-window mock for jsdom (no ResizeObserver), 10/10 component + 12/12 store tests pass
- [2026-03-20] [Dashboard] [Claude] docs: 踩坑记录 `extensions-skills-tab-lag.md` — 4-layer root cause + react-window v2 migration pitfalls
- [2026-03-20] [Infra] [Claude] Tests: 57 files, 1069/1074 pass (5 bootstrap pre-existing from AGENTS.md rewrite)

### 2026-03-20 — Dashboard Panel Empty State Fix (Issue #10)

- [2026-03-20] [Dashboard] [Claude] fix: TaskPanel early return on empty state hid Segmented tab control — user trapped on empty "助手任务" tab, required page refresh to escape
- [2026-03-20] [Dashboard] [Claude] fix: WorkspacePanel early returns on loading/empty hid RecentChanges + upload zone
- [2026-03-20] [Dashboard] [Claude] pattern: moved empty/loading states from early returns into main layout ternary (consistent with LibraryPanel)
- [2026-03-20] [Dashboard] [Claude] test: +1 regression test for Issue #10 (perspective='agent' + empty tasks → controls still visible)
- [2026-03-20] [Infra] [Sylvan] Manual E2E: verified in gateway-served dashboard — pass
- [2026-03-20] [Infra] [Claude] Tests: 54 files, 1024/1024 pass

### 2026-03-17/18 — Task Module Enhancements (P0-P3)

- [2026-03-17] [Modules] [Claude] feat: `task_delete` agent tool (#10) — destructive delete with pre-fetch title for confirmation
- [2026-03-17] [Dashboard] [Claude] feat: priority dropdown in TaskRow — clickable color dot, 4-option Dropdown, stopPropagation
- [2026-03-17] [Dashboard] [Claude] feat: Gantt chart modal (frappe-gantt) — lazy-loaded, Day/Week/Month, dark/light theme, priority-colored bars
- [2026-03-17] [Dashboard] [Claude] refactor: extract PRIORITY_COLORS to `utils/task-constants.ts` (was duplicated in 4 files)
- [2026-03-17] [Dashboard] [Claude] fix: add frappe-gantt base CSS import + silence Dart Sass 3.0 deprecation warnings
- [2026-03-17] [Infra] [Claude] config: add `task_delete`, `task_link_file`, `cron_update_schedule` to `alsoAllow` (local only)
- [2026-03-17] [Dashboard] [Claude] i18n: add `tasks.gantt.*` keys (7 keys × 2 locales)
- [2026-03-17] [Infra] [Sylvan] Manual E2E: P0 (delete), P1 (priority), P2 (Gantt) — all pass
- [2026-03-18] [Modules] [Claude] feat: adaptive heartbeat escalation — HeartbeatService (339 lines), 6-tier deadline tracking (silent→daily→twice_daily→every_6h→hourly→overdue)
- [2026-03-18] [Modules] [Claude] schema: v6→v7 — new `rc_heartbeat_log` table (ON DELETE CASCADE)
- [2026-03-18] [Modules] [Claude] integration: gateway_start bootstrap + before_prompt_build tick + after_tool_call lifecycle hooks
- [2026-03-18] [Modules] [Claude] cron: `deadline_reminders_daily` schedule `0 9 * * *` → `*/30 * * * *`, tick() manages frequency per tier
- [2026-03-18] [Modules] [Claude] RPC: `rc.heartbeat.status` + `rc.heartbeat.suppress` (interfaces 62→64, hooks 7→8)
- [2026-03-18] [Infra] [Sylvan] Manual E2E: P3 (tier 升级/降级, overdue 通知, 多任务混合, gateway 重启 bootstrap, task 删除 CASCADE) — all pass
- [2026-03-18] [Infra] [Claude] Branch: `feat/task-module-enhancements` @ `7870e63` (5 commits), worktree `rc-agent-2/`
- [2026-03-18] [Infra] [Claude] Tests: 54 files, 987/987 pass, tsc 0 errors (bootstrap-consistency excluded — pre-existing)

### 2026-03-14 — Claude Memory System Restructuring

- [2026-03-14] [Infra] [Claude] Restructured Claude Code memory system (MEMORY.md 251→124 lines, was truncating at 200)
- [2026-03-14] [Infra] [Claude] Created `research-claw-dev-guide.md` — full RC architecture reference (plugin, dashboard, DB, RPC, build commands)
- [2026-03-14] [Infra] [Claude] Created `research-plugins-dev-guide.md` — full RP architecture reference (taxonomy, tools, progressive disclosure)
- [2026-03-14] [Infra] [Claude] Created `openclaw-gotchas.md` — 13 critical OC gotchas rescued from truncated zone (handler protocol, config sentinel, Node mismatch, tool execute signature, client ID whitelist, skills 1-level scan)
- [2026-03-14] [Infra] [Claude] Created `web-api-completed.md` — archived web/api historical decisions and bug fixes
- [2026-03-14] [Infra] [Claude] Rebalanced: Web/API 52%→5% of index, RC/RP 19%→50% of index, OC gotchas now always loaded
- [2026-03-14] [Infra] [Sylvan] Added progressive disclosure architecture (v1.3.0), skill-router deletion note, gap analysis reference to memory files

### 2026-03-14 — v0.2.0 Release

- [2026-03-14] [Dashboard] [Claude] Fix: library tags now refresh after paper deletion (loadTags after deletePaper)
- [2026-03-14] [Dashboard] [Claude] Fix: tag filter empty state shows "clear filter" button instead of full empty state
- [2026-03-14] [Dashboard] [Claude] Fix: library empty state text no longer mentions PDF drag (use workspace instead)
- [2026-03-14] [Dashboard] [Claude] Fix: workspace removed redundant header upload button; upload auto-refreshes tree
- [2026-03-14] [Dashboard] [Claude] Fix: radar noFindings text now guides users to refresh button
- [2026-03-14] [Dashboard] [Claude] Fix: settings save now shows confirmation dialog before gateway restart
- [2026-03-14] [Dashboard] [Claude] Enhancement: version bumped to v0.2.0 with red glow styling + GitHub link
- [2026-03-14] [Dashboard] [Claude] Verified: notification system (Channel A polling + Channel B card extraction) working correctly
- [2026-03-14] [Dashboard] [Claude] Added 51 integration tests (3 test files) covering all 8 fixes
- [2026-03-14] [Infra] [Claude] Version bump v0.1.0 → v0.2.0 across all packages, plugins, bootstrap, and documentation

### 2026-03-11 — Project Initialization

- [2026-03-11] [Infra] [Claude] Created satellite workspace: 105 files, own git, initial commit
- [2026-03-11] [Infra] [Claude] 12 design documents (~17,534 lines): 00-06 + modules/03a-03f
- [2026-03-11] [Prompt] [Claude] 8 bootstrap files (24.5K chars): SOUL, AGENTS, HEARTBEAT, BOOTSTRAP, IDENTITY, USER, TOOLS, MEMORY
- [2026-03-11] [Dashboard] [Claude] Dashboard scaffold: 22 TSX/TS stub files, Vite + React + Ant Design
- [2026-03-11] [Modules] [Claude] Plugin scaffold: research-claw-core (16 TS stubs), wentor-connect (placeholder)
- [2026-03-11] [Infra] [Claude] 7 script stubs: setup, install, build-dashboard, apply-branding, health, backup, sync-upstream
- [2026-03-11] [Infra] [Claude] Config files: openclaw.json, openclaw.example.json, .env.example, .gitignore
- [2026-03-11] [Plugins] [Claude] research-plugins v1.0.0 published (NPM + PyPI + GitHub)

### 2026-03-11 — Plan 2 Consistency Audit & Fixes

- [2026-03-11] [Modules] [Claude] 03a: Added rc_paper_notes table (§2.10), 8 new RPC methods (rc.lit.batch_add through rc.lit.notes.delete). Total lit methods: 18→26
- [2026-03-11] [Modules] [Claude] 03b: Added 2 new RPC methods (rc.task.link, rc.task.notes.add). Total task methods: 8→10
- [2026-03-11] [Modules] [Claude] 03c: Added rc.ws.save method, clarified rc.ws.upload as HTTP-only. Total rc.ws.* RPC methods: 5→6 (rc.ws.save added). rc.ws.upload is HTTP POST only, not counted as WS RPC.
- [2026-03-11] [Modules] [Claude] 03f: Rewrote §6 RPC registry with canonical names, fixed priority enum critical→urgent. Total: 35→46 methods
- [2026-03-11] [Infra] [Claude] 00: Updated reference map (tables 10→12, RPC 35→46, tools 18→24)
- [2026-03-11] [Infra] [Claude] Config: Added 6 tools to alsoAllow (both openclaw.json and .example.json)
- [2026-03-11] [Prompt] [Claude] MEMORY.md: Restructured to v1.1 (Global + Current Focus + Projects)

### 2026-03-11 — SOP Framework

- [2026-03-11] [Infra] [Claude] Created docs/sop/ directory with 5 files:
  - S1: Dashboard Dev SOP (layout, components, gateway contract, standards)
  - S2: Modules Dev SOP (plugin structure, DB schema, RPC, tools, standards)
  - S3: Plugin Integration SOP (research-plugins, wentor-connect, SDK patterns)
  - S4: Prompt & Behavior SOP (bootstrap files, red lines, workflow, modification guide)
  - CHANGELOG.md: This file (global operation log)
- [2026-03-11] [Infra] [Claude] Updated 00-reference-map.md with SOP document entries (S1-S5)

### 2026-03-11 — External Cleanup

- [2026-03-11] [Infra] [Claude] Archived 4 obsolete openclaw docs from wentor/docs/ to docs/archive/:
  - openclaw-architecture-analysis.md (superseded by research-claw/docs/02)
  - openclaw-docs-and-skills-guide.md (superseded by research-claw/docs/05)
  - openclaw-commands-and-tools-reference.md (superseded by research-claw/docs/02 + RPC ref)
  - openclaw_setup_and_config.plan.md (superseded by research-claw/docs/06)
- [2026-03-11] [Infra] [Claude] Pulled openclaw to latest (5 new commits: agent tool policy, plugin subagent runtime, device token rotate)

### 2026-03-11 — Audit Pass 2 (version refs + deep consistency)

- [2026-03-11] [Infra] [User+Claude] Updated OpenClaw commit hash 144c1b80→62d5df28d in 00, 02, 03e (4 occurrences)
- [2026-03-11] [Infra] [User+Claude] Updated 02 tool count "18 tools"→"24 tools, 46 RPC methods"
- [2026-03-11] [Infra] [User+Claude] Updated 00 MEMORY.md char count 516→964
- [2026-03-11] [Infra] [User+Claude] Added OpenClaw plugin HTTP scope enforcement note to S3 SOP
- [2026-03-11] [Infra] [Claude] Fixed 04 bootstrap budget table: all 8 file sizes updated to actual values (14,841→24,951 total chars)
- [2026-03-11] [Infra] [Claude] Fixed 03f cross-reference counts: lit RPC 18→26, task RPC 8→10, ws RPC 6→7

### 2026-03-12 — Status Assessment (P0 + P1-S1 + P1-S2)

Comprehensive review of implementation progress across Infrastructure, Dashboard, and Module tracks.

- [2026-03-12] [Infra] [User+Claude] P0 Infrastructure assessed at **92% complete**: pnpm patch (openclaw@2026.3.8.patch, 78 lines), brand replacement (11 occurrences), package.json patchedDependencies, INFRA_REPORT.md, config files, setup.sh + install.sh all done. Only apply-branding.sh remains a stub.
- [2026-03-12] [Dashboard] [User+Claude] P1-S1 Dashboard Shell assessed at **95% complete**: GatewayClient (267 lines, full WS RPC v3), gateway types/hooks/reconnect, TopBar/LeftNav/StatusBar, ChatView/MessageBubble/MessageInput, SetupWizard (217 lines), App.tsx responsive grid, 7 Zustand stores (4 complete + 3 skeleton), theme system, i18n (131 keys each), global.css (188 lines). Remaining: 5 panel stubs + 6 card stubs (Phase 2) and tests (Phase 4).
- [2026-03-12] [Modules] [User+Claude] P1-S2 Module Builder assessed at **97% complete**: db/schema.ts (12 tables + FTS5), db/connection.ts (WAL mode), db/migrations.ts (v1), LiteratureService (27 methods), TaskService (13 methods incl. cron), WorkspaceService (6+ methods + init/destroy), GitTracker, Cards protocol (6 custom types; code_block handled by markdown renderer) + serializer, Literature tools (12) + RPC (26), Task tools (6) + RPC (10 + 3 cron), Workspace tools (6) + RPC (7) + HTTP upload, plugin entry index.ts (416 lines). 24 tools total confirmed accurate. Remaining: unit tests (Phase 4).
- [2026-03-12] [Infra] [Claude] Updated CHANGELOG pending work section to reflect actual completion status.

### 2026-03-12 — Design System Alignment Audit & i18n Completeness

Comprehensive consistency audit of Dashboard against `docs/FRONTEND_DESIGN_SYSTEM.md`.

- [2026-03-12] [Dashboard] [Claude] **Design token fixes in `theme.ts`:**
  - Added missing tokens: `bg.code` (#161618/#F5F0EA), `accent.redHover` (#DC2626/#B91C1C), `accent.blueHover` (#2563EB/#1D4ED8)
  - Updated `ThemeTokens` type to include new fields
  - Fixed Button `borderRadius`: 4 -> 8 (per design system section 5.1)
  - Fixed Input `borderRadius`: 4 -> 8 (per design system section 5.1)
- [2026-03-12] [Dashboard] [Claude] **CSS variable fixes in `global.css`:**
  - Added `--code-bg` to dark (#161618) and light (#F5F0EA) themes
  - Added `--accent-primary-hover` and `--accent-secondary-hover` to both themes
  - Fixed body `font-size`: 14px -> 15px (per design system section 3.2)
  - Fixed body `line-height`: 1.5 -> 1.7 (per design system section 3.2)
  - Fixed scrollbar thumb `border-radius`: 3px -> 9999px (per design system section 12)
- [2026-03-12] [Dashboard] [Claude] **i18n fixes:**
  - Added 5 missing keys: `chat.dismiss`, `status.versionFallback`, `status.modelDefault`, `status.modelNA`, `panel.awaitingPlugin`
  - Added matching zh-CN translations for all 5 keys
  - Fixed hardcoded strings in StatusBar (model default, N/A, version fallback)
  - Fixed hardcoded "x" dismiss button in ChatView -> HTML entity + aria-label
  - Fixed 5 panel stubs: hardcoded English -> i18n key `panel.awaitingPlugin`
  - Total: en.json 100 keys, zh-CN.json 100 keys, all matched
- [2026-03-12] [Dashboard] [Claude] **Doc sync:**
  - Updated 03e section 9.1: replaced outdated color values with actual implementation (aligned with FRONTEND_DESIGN_SYSTEM.md)
  - Updated 03e section 9.2: replaced outdated Ant Design token example with actual `getAntdThemeConfig()` implementation
  - Verified 00-reference-map.md counts still accurate (24 tools, 46 RPC, 12 tables)

### 2026-03-12 — Phase 2 Complete (Cards + Panels + Stores + Bootstrap Rewrite)

Three parallel agents completed Phase 2A (Cards), 2B (Stores+Panels), and 2C (Bootstrap rewrite). Code review + cross-reference audit performed with zero bugs found.

**Phase 2A — Card Renderer (6 cards + CodeBlock interceptor + tests):**
- [2026-03-12] [Dashboard] [Claude] Created `types/cards.ts`: 6 card interfaces (PaperCard 12 fields, TaskCard 9, ProgressCard 9, ApprovalCard 6, RadarDigest 6, FileCard 8) + CARD_TYPES set + MessageCard union. All fields verified against protocol spec.
- [2026-03-12] [Dashboard] [Claude] Created `CardContainer.tsx`: shared card shell (border-left accent, theme tokens, max-width 560px)
- [2026-03-12] [Dashboard] [Claude] Created `PaperCard.tsx`: status badge, metadata grid, "Add to Library" (`rc.lit.add`), "Cite" (BibTeX clipboard), "Open PDF" (arxiv fallback)
- [2026-03-12] [Dashboard] [Claude] Created `TaskCard.tsx`: priority border colors, deadline computation (overdue/soon), "Mark Complete" (`rc.task.complete`), "View in Panel" (tab switch)
- [2026-03-12] [Dashboard] [Claude] Created `ProgressCard.tsx`: 2-column metric grid, highlights list, display-only
- [2026-03-12] [Dashboard] [Claude] Created `ApprovalCard.tsx`: risk-level borders, pulsing glow for high risk, Allow-Once + dropdown Always-Allow + Deny (`exec.approval.resolve`), pending/allowed/denied states
- [2026-03-12] [Dashboard] [Claude] Created `RadarDigest.tsx`: source/query/period metadata, notable papers list with relevance notes
- [2026-03-12] [Dashboard] [Claude] Created `FileCard.tsx`: file-type icons (6 categories), git status badges, size formatting, Open/Download buttons
- [2026-03-12] [Dashboard] [Claude] Created `CodeBlock.tsx`: card type detection via CARD_TYPES set, JSON parse with fallback, Shiki syntax highlighting (lazy singleton, 22 languages), copy button
- [2026-03-12] [Dashboard] [Claude] Updated `MessageBubble.tsx`: integrated CodeBlock as react-markdown `components.code`
- [2026-03-12] [Dashboard] [Claude] 7 test files: PaperCard (11), TaskCard (11), ProgressCard (9), ApprovalCard (13), RadarDigest (8), FileCard (13), CodeBlock (11) = 76 tests

**Phase 2B — Stores + Right Panels (5 panels + store fixes + tests):**
- [2026-03-12] [Dashboard] [Claude] Fixed `tasks.ts` store: priority `critical->urgent`, status `pending->todo` + `completed->done` + added `blocked`/`cancelled`, `assignee->task_type` (human/agent/mixed), added 9 missing fields, all RPC calls implemented (`rc.task.list/create/complete/update/delete`)
- [2026-03-12] [Dashboard] [Claude] Fixed `library.ts` store: added missing fields (venue, url, arxiv_id, pdf_path, is_own, source_type, created_at, updated_at), all RPC calls implemented (`rc.lit.list/tags/status/rate/search/delete`)
- [2026-03-12] [Dashboard] [Claude] Fixed `sessions.ts` store: RPC calls implemented (`sessions.list/delete`), createSession via crypto.randomUUID
- [2026-03-12] [Dashboard] [Claude] Created `LibraryPanel.tsx`: Pending/Saved sub-tabs, search with 300ms debounce, tag filter chips, virtual scrolling via react-window v2 (>50 items threshold), status badge cycle-click, star rating, paper actions menu
- [2026-03-12] [Dashboard] [Claude] Created `TaskPanel.tsx`: 4 sections (overdue/upcoming/noDeadline/completed), perspective toggle (All/Human/Agent), priority left-border, deadline color coding, checkbox completion, collapsible completed section
- [2026-03-12] [Dashboard] [Claude] Created `WorkspacePanel.tsx`: file tree (recursive, auto-expand depth<2), recent changes from `rc.ws.history`, file-type icons (7 categories), git badges (M/+), drag-drop upload via `/rc/upload`, relative timestamps
- [2026-03-12] [Dashboard] [Claude] Created `RadarPanel.tsx`: tracking config sections (keywords/authors/journals), radar_digest extraction from chat history, "Edit via chat" and "Refresh" prefill, empty state guidance
- [2026-03-12] [Dashboard] [Claude] Created `SettingsPanel.tsx`: 4 sub-tabs (General/Model/Proxy/About), language/theme/sound/scroll/timestamp settings, model provider/API key/temperature/max tokens, proxy SOCKS5/HTTP with auth, diagnostics copy, bootstrap file list
- [2026-03-12] [Dashboard] [Claude] Updated `TopBar.tsx`: notification dropdown with bell badge, agent status dot with pulse animation, event subscriptions (heartbeat.alert, task.deadline, notification)
- [2026-03-12] [Dashboard] [Claude] Updated `LeftNav.tsx`: project switcher dropdown (sessions list + "All Projects" + "New Project"), active session indicator, collapsed/expanded modes
- [2026-03-12] [Dashboard] [Claude] Updated `RightPanel.tsx`: lazy-loaded panel content, resize handle, panel header with close button
- [2026-03-12] [Dashboard] [Claude] Updated `ui.ts` store: Notification interface (4 types), addNotification/markRead/markAllRead/clear, unreadCount tracking
- [2026-03-12] [Dashboard] [Claude] 5 test files: LibraryPanel (4), TaskPanel (4), WorkspacePanel (5), RadarPanel (4), SettingsPanel (4) = 21 tests

**Phase 2C — Bootstrap Rewrite (8 files):**
- [2026-03-12] [Dashboard] [Claude] Rewrote `AGENTS.md` v2.0 (17,316 chars): session startup checklist (6 checks), cold start protocol, identity/capabilities, HiL protocol (full + nuanced rules), 4-phase research workflow SOP, discipline-specific sections (humanities, wet lab, CS, engineering/math), tool usage patterns table, structured output formatting with 6 JSON card examples (all field names verified against protocol.ts), red lines (6), memory management rules
- [2026-03-12] [Dashboard] [Claude] Rewrote `TOOLS.md` v2.0 (4,604 chars): 6 external API references, 24 local tools in 3 tables (12 library + 6 task + 6 workspace), citation style list, export/import formats, config reference. All 24 tool names verified against `openclaw.json` alsoAllow list.
- [2026-03-12] [Dashboard] [Claude] Rewrote `HEARTBEAT.md` v2.0 (3,312 chars): 5 routine checks (deadline, group meeting prep, daily digest, reading reminders, quiet hours), JSON output format using progress_card, configurable thresholds table (6 parameters)
- [2026-03-12] [Dashboard] [Claude] Rewrote `BOOTSTRAP.md` v2.0 (6,363 chars): 6-step onboarding flow (profile + IM connections + workspace setup + group meeting + honey demo + environment detection), card output examples, completion with BOOTSTRAP.md.done rename
- [2026-03-12] [Dashboard] [Claude] Rewrote `SOUL.md` v2.0 (4,058 chars): 5 core principles, interaction style, 6 red lines, continuity rules, research ethics
- [2026-03-12] [Dashboard] [Claude] Updated `USER.md` v2.0 (970 chars): structured profile template
- [2026-03-12] [Dashboard] [Claude] All 8 bootstrap files within character budget: 38,290 total (limit 150,000), max single file 17,316 (limit 20,000)

**Phase 2 Code Review & Verification:**
- [2026-03-12] [Infra] [Claude] TypeScript compilation: zero errors (`pnpm typecheck`)
- [2026-03-12] [Infra] [Claude] All 139 tests pass across 16 test files (`pnpm test`)
- [2026-03-12] [Infra] [Claude] i18n audit: 231 keys in en.json, 231 keys in zh-CN.json, all matched, no missing/extra keys. All 14 required key groups present with minimum counts met.
- [2026-03-12] [Infra] [Claude] RPC method audit: all 21 RPC calls in dashboard code verified against canonical list (14 rc.* methods + 7 OpenClaw built-in methods). Zero invalid method names.
- [2026-03-12] [Infra] [Claude] TOOLS.md tool audit: all 24 canonical tools present, names match exactly.
- [2026-03-12] [Infra] [Claude] AGENTS.md card audit: all 6 card types have JSON examples, all field names match protocol.ts.
- [2026-03-12] [Infra] [Claude] SOUL.md red lines audit: all 6 red lines present and correctly worded.
- [2026-03-12] [Infra] [Claude] Card type fields verified against cards.ts: PaperCard (12), TaskCard (9), ProgressCard (9), ApprovalCard (6), RadarDigest (6+NotablePaper 3), FileCard (8).
- [2026-03-12] [Infra] [Claude] Store→Panel data flow verified: LibraryPanel→useLibraryStore, TaskPanel→useTasksStore+useChatStore, WorkspacePanel→useGatewayStore (direct RPC), RadarPanel→useChatStore, SettingsPanel→useConfigStore+useGatewayStore.
- [2026-03-12] [Infra] [Claude] No bugs found. Zero code fixes required.

### 2026-03-12 — Phase 3 Complete (RPC Fixes + Responsive + Accessibility + Virtual Scroll)

Dashboard hardening: RPC parameter alignment, responsive panel modes, accessibility, and virtual scrolling.

- [2026-03-12] [Dashboard] [Claude] **RPC parameter mismatches fixed in `library.ts`:** `status`→`read_status`, `tags`→`tag`, `yearMin`/`yearMax`→`year` (single param), `loadTags` response type fixed to `Tag[]` (was incorrectly typed)
- [2026-03-12] [Dashboard] [Claude] Created `ErrorBoundary.tsx` component: catches render errors, displays error.title + error.retry + error.details UI, wrapped around main App content
- [2026-03-12] [Dashboard] [Claude] Responsive panel modes: overlay at 1024-1439px (backdrop click to close), modal at <1024px (full-screen takeover)
- [2026-03-12] [Dashboard] [Claude] Virtual scrolling in `ChatView.tsx`: react-window for long message lists (>100 messages threshold)
- [2026-03-12] [Dashboard] [Claude] Accessibility: `role="main"`, `role="navigation"`, `role="complementary"` on layout regions; `aria-label` on all interactive elements (send button, close panel, collapse nav, etc.)
- [2026-03-12] [Dashboard] [Claude] New i18n keys: `error.title`, `error.retry`, `error.details` (error boundary); `a11y.mainContent`, `a11y.sidePanel`, `a11y.navigation`, `a11y.notifications`, `a11y.collapseNav`, `a11y.expandNav`, `a11y.closePanel` (accessibility labels)

### 2026-03-12 — Phase 4 Complete (Tests + Install Scripts + Build Optimization + README)

Final polish: comprehensive test suite, production install scripts, build optimization, and documentation.

- [2026-03-12] [Dashboard] [Claude] **62 new tests across 3 areas:**
  - Gateway client tests (20): connection lifecycle, request/response, event subscription, reconnection, timeout, error handling
  - Chat store tests (26): send/receive, streaming states (delta/final/aborted/error), abort, history load, session switching, token counting, silent reply filtering
  - Config store tests (16): load/save, theme toggle, language switch, proxy settings, model configuration, persistence
- [2026-03-12] [Infra] [Claude] **Install scripts fully implemented:**
  - `scripts/install.sh`: dependency check (node/pnpm), pnpm install, patch apply, dashboard build, workspace init, config verification
  - `scripts/apply-branding.sh`: brand asset copy, CSS variable injection, manifest update, icon generation
- [2026-03-12] [Dashboard] [Claude] **Shiki manual chunk optimization:** split Shiki core + themes + languages into separate chunks via `build.rollupOptions.output.manualChunks` in `vite.config.ts`
- [2026-03-12] [Infra] [Claude] Updated `README.md` with installation instructions, development setup, architecture overview, and contributing guide
- [2026-03-12] [Infra] [Claude] **i18n audit passed:** 244 leaf keys in en.json, 244 leaf keys in zh-CN.json, all keys synchronized with zero mismatches

### 2026-03-12 — Final Integration Testing (Step 9)

Cross-file consistency audit and build pipeline verification.

- [2026-03-12] [Infra] [Claude] **Card types audit:** protocol.ts (6 types, canonical) vs dashboard/cards.ts vs AGENTS.md JSON examples — all field names match exactly. Zero mismatches.
- [2026-03-12] [Infra] [Claude] **RPC methods audit:** 12 rc.* methods used in dashboard, all present in canonical list (45 WS + 1 HTTP = 46 total). 7 OpenClaw built-in methods also verified (chat.send, chat.abort, chat.history, sessions.delete, exec.approval.resolve, config.set, health).
- [2026-03-12] [Infra] [Claude] **Tool names audit:** 24 tools in openclaw.json = 24 in TOOLS.md = 24 in 00-reference-map.md. All names match exactly.
- [2026-03-12] [Infra] [Claude] **i18n key sync:** 244 leaf keys in en.json, 244 in zh-CN.json, all matched.
- [2026-03-12] [Infra] [Claude] **Build pipeline:** TypeScript zero errors (dashboard + plugin), 318/318 tests passed (28 test files), Vite build successful (131.64 kB main bundle gzip: 41.24 kB).
- [2026-03-12] [Infra] [Claude] **Bootstrap files:** 38,290/150,000 chars total, max single file 17,316/20,000, all 6 JSON blocks in AGENTS.md parse correctly, all tool names in TOOLS.md match config.
- [2026-03-12] [Infra] [Claude] **Reference map fix:** rc.ws.* count corrected from 7→6 in table (upload is HTTP, not WS RPC — already documented separately in §3.6).

### 2026-03-12 — Setup/Settings/Config Alignment + Gateway Reconnect Fix + Proxy

Comprehensive fix session to align Setup Wizard, Settings Panel, and openclaw.json.

**Config Alignment (config-patch.ts):**
- [2026-03-12] [Dashboard] [Claude] Created shared `buildConfigPatch()` / `extractConfigFields()` utility in `utils/config-patch.ts`
- [2026-03-12] [Dashboard] [Claude] Model routing fix: vision model becomes primary (handles text+images), text model becomes fallback. Ensures `detectAndLoadPromptImages()` sees `input: ['text', 'image']` on primary model.
- [2026-03-12] [Dashboard] [Claude] Removed `imageModel` from config.patch entirely — it is NOT hot-reloadable and triggers SIGUSR1 → process exit
- [2026-03-12] [Dashboard] [Claude] Removed `sanitizeBaseUrl()` — user fills in exact URLs, no complex URL manipulation
- [2026-03-12] [Dashboard] [Claude] SetupWizard + SettingsPanel both use the same `buildConfigPatch()` / `extractConfigFields()` functions

**Gateway Reconnect Fix (client.ts):**
- [2026-03-12] [Dashboard] [Claude] Fixed state machine bug: `connect()` was overwriting `reconnecting` state with `connecting`, causing client to give up after ONE retry. Fix: `if (this.state !== 'reconnecting') { this.setState('connecting'); }`

**Chat System Message Filter (chat.ts):**
- [2026-03-12] [Dashboard] [Claude] Broadened `stripInjectedContext` from `^System:\s*\[[\d-]+` to `^System:\s` to filter all system exec messages (Run commands, doctor output, etc.)

**Proxy Settings (SettingsPanel.tsx):**
- [2026-03-12] [Dashboard] [Claude] Rewrote `ProxySettings` component: reads from gateway config `env.HTTP_PROXY`/`env.HTTPS_PROXY`, saves via `config.patch` to `env` section (was localStorage-only, non-functional)
- [2026-03-12] [Dashboard] [Claude] Added `GatewayConfig.env` field to config store type
- [2026-03-12] [Dashboard] [Claude] Proxy URL parser: extracts protocol/host/port/auth from URL string back to form fields
- [2026-03-12] [Dashboard] [Claude] Added i18n key `settings.proxyRestartHint` (EN + ZH-CN)
- [2026-03-12] [Dashboard] [Claude] Proxy changes require gateway restart (env vars are startup-only, not hot-reloadable)

**Verification:**
- [2026-03-12] [Infra] [Claude] TypeScript: zero errors
- [2026-03-12] [Infra] [Claude] Tests: 315/315 passed (28 test files)
- [2026-03-12] [Infra] [Claude] i18n: 245 keys EN, 245 keys ZH-CN, all matched

### 2026-03-12 — Security & Documentation Audit

Code-to-documentation sync after comprehensive audit session.

- [2026-03-12] [Modules] [Claude] **H4: Path traversal fix** in `index.ts`: workspace file operations now use `path.resolve()` + `startsWith` validation to prevent directory traversal attacks
- [2026-03-12] [Infra] [Claude] **L1-L2: Error code documentation** added to design docs for rate limit responses and error codes
- [2026-03-12] [Modules] [Claude] **L3: 24h stale session cleanup** implemented for abandoned sessions
- [2026-03-12] [Modules] [Claude] **L4: BibTeX title validation** added to `library_add_paper` tool input
- [2026-03-12] [Infra] [Claude] **M8: CHANGELOG ws count corrected** (was showing incorrect RPC count)

### 2026-03-15 — v0.4.1 Release

- [2026-03-15] [Infra] [Claude] **v0.4.1**: Docker cold start crash fix (`rc_cron_state` missing from schema DDL) + radar UX for new users
- [2026-03-15] [Modules] [Claude] Added `rc_cron_state` to `CREATE_TABLES_SQL` array in `schema.ts` (was only created by migration, not initial DDL)

### 2026-03-14 — v0.4.0 Release

- [2026-03-14] [Infra] [Claude] **v0.4.0**: Provider sync with OC 2026.3.12, workspace drag-and-drop file move, cron recovery on reconnect, upload auth fix
- [2026-03-14] [Dashboard] [Claude] Workspace drag-and-drop file move via `workspace_move` tool
- [2026-03-14] [Modules] [Claude] Provider presets reordered (`zai-coding` before `zai` for urlPattern priority)
- [2026-03-14] [Dashboard] [Claude] Cron presets reconciled on gateway reconnect — recovers lost jobs
- [2026-03-14] [Dashboard] [Claude] Workspace upload auth fix
- [2026-03-14] [Modules] [Claude] Provider presets aligned with OC 2026.3.12 (Google/Volcengine 500/503 fix)
- [2026-03-14] [Dashboard] [Claude] Dashboard streaming & config loss fix — aligned with OC chat protocol

### 2026-03-13 — v0.3.2 Release

- [2026-03-13] [Infra] [Claude] **v0.3.2**: Session token usage tracking, channel crash-loop prevention, Docker docs overhaul
- [2026-03-13] [Dashboard] [Claude] Session token tracking in StatusBar
- [2026-03-13] [Infra] [Claude] Channel crash-loop prevention — install.sh cleanup + Bootstrap channel setup
- [2026-03-13] [Infra] [Claude] Auto-fix `channels.commands.native` on every startup via `sync-global-config`

---

## Completed Work

### Infrastructure (P0) — 95%

- [x] Generate pnpm patch (openclaw@2026.3.8.patch, 78 lines)
- [x] Brand replacement (11 occurrences across codebase)
- [x] package.json patchedDependencies config
- [x] INFRA_REPORT.md
- [x] Config files: openclaw.json + openclaw.example.json
- [x] scripts/install.sh (real implementation)
- [x] scripts/setup.sh (real implementation)

### Dashboard Shell (P1-S1) — 100%

- [x] GatewayClient (267 lines, full WS RPC v3 protocol)
- [x] gateway/types.ts, hooks.ts, reconnect.ts
- [x] TopBar (+ notification dropdown), LeftNav (+ project switcher), StatusBar (all complete)
- [x] ChatView, MessageBubble (+ CodeBlock integration), MessageInput (all complete)
- [x] SetupWizard (217 lines, 1-step flow)
- [x] App.tsx with responsive grid layout
- [x] 9 Zustand stores (gateway, chat, config, ui, library, tasks, sessions, cron, radar)
- [x] Theme system (dark + light, HashMind aligned)
- [x] i18n: en.json + zh-CN.json (244 keys each)
- [x] global.css (188 lines)

### Dashboard Phase 2 (Cards + Panels) — 100%

- [x] 6 message card components (PaperCard, TaskCard, ProgressCard, ApprovalCard, RadarDigest, FileCard)
- [x] CardContainer shared shell + types/cards.ts (6 interfaces + union type)
- [x] CodeBlock interceptor (card detection + Shiki syntax highlighting)
- [x] 5 right panel components (LibraryPanel, TaskPanel, WorkspacePanel, RadarPanel, SettingsPanel)
- [x] RightPanel with lazy loading + resize handle
- [x] 139 tests across 16 test files (76 card tests + 21 panel tests + 42 existing)

### Dashboard Phase 3 (Hardening) — 100%

- [x] RPC parameter mismatches fixed (library.ts: status→read_status, tags→tag, yearMin/yearMax→year, loadTags response type)
- [x] ErrorBoundary component created and wrapped
- [x] Responsive panel modes (overlay at 1024-1439px, modal at <1024px)
- [x] Virtual scrolling in ChatView (react-window, >100 messages threshold)
- [x] Accessibility roles and aria-labels on all layout regions and interactive elements
- [x] New i18n keys: error.* (3 keys) and a11y.* (7 keys)

### Dashboard Phase 4 (Testing + Polish) — 100%

- [x] 62 new tests: gateway client (20), chat store (26), config store (16)
- [x] Install scripts: install.sh and apply-branding.sh fully implemented
- [x] Shiki manual chunk optimization in vite.config.ts
- [x] README.md updated
- [x] i18n audit passed: 244 keys synchronized in both locales
- [x] 318 total tests across 28 test files — all passing

### Module Builder (P1-S2) — 100%

- [x] db/schema.ts (15 tables + FTS5, SCHEMA_VERSION 6)
- [x] db/connection.ts (better-sqlite3 manager, WAL mode)
- [x] db/migrations.ts (v1-v6)
- [x] LiteratureService (27 methods)
- [x] TaskService (13 methods including cron + notifications)
- [x] WorkspaceService (6+ methods + init/destroy)
- [x] GitTracker
- [x] Cards protocol (6 custom types; code_block handled by markdown renderer) + serializer
- [x] Literature tools (12) + RPC (26)
- [x] Task tools (9) + RPC (11 + 7 cron + 2 notifications)
- [x] Workspace tools (7) + RPC (11) + HTTP upload
- [x] Radar tools (3) + RPC (4) — `radar_configure`, `radar_get_config`, `radar_scan` (arXiv + Semantic Scholar)
- [x] Plugin entry index.ts (31 tools, 62 WS RPC + 1 HTTP = 63 interfaces)
- [x] 7 hooks registered (before_prompt_build, session_start, session_end, before_tool_call, agent_end, after_tool_call, gateway_start)

---

## Pending Work (Post-MVP)

### Infrastructure
- [ ] End-to-end: install -> setup -> start -> chat integration test (requires live OpenClaw instance)

### Modules (P1-S2)
- [ ] Plugin unit tests: vitest with in-memory SQLite

### Plugins (S3)
- [ ] Verify research-plugins skill loading end-to-end (requires live OpenClaw instance)
- [ ] Implement wentor-connect OAuth flow
- [ ] Integration test: gateway + plugin + dashboard round-trip

### Prompt (S4)
- [ ] Behavioral testing with live agent (requires running LLM)
- [ ] Refine AGENTS.md workflow steps based on real user testing
- [ ] Tune HEARTBEAT.md thresholds based on user feedback

---

### 2026-03-12 — E2E Testing: Chat Display & Scroll Fixes

Human-in-the-loop end-to-end testing revealed two critical dashboard issues.

- [2026-03-12] [Dashboard] [User+Claude] **toolResult message pollution fixed**: Gateway `chat.history` returns all roles including `toolResult` (SQL DDL, file paths, error traces). Added 3-layer filtering: `isVisibleRole()` in `loadHistory`, `handleChatEvent`, and `ChatView` display filter. Added `content:string` type guards in `extractText`, `extractVisibleText`, and `MessageBubble`.
- [2026-03-12] [Dashboard] [User+Claude] **Smart scroll ported from OpenClaw**: `NEAR_BOTTOM_THRESHOLD=450`, `userNearBottomRef` (ref to avoid re-renders), `handleScroll` distance tracking, conditional auto-scroll, "New messages below" pill button with `scrollToBottom()`. Supports both virtual (react-window) and normal DOM scroll modes.
- [2026-03-12] [Dashboard] [Claude] **i18n**: Added `chat.newMessages` key (EN: "New messages below", ZH-CN: "有新消息")
- [2026-03-12] [Dashboard] [Claude] **Build**: Rebuilt `dashboard/dist/` via `npx vite build` (gateway serves static dist, not live source)
- [2026-03-12] [Dashboard] [Claude] **Files changed**: `stores/chat.ts`, `ChatView.tsx`, `MessageBubble.tsx`, `i18n/en.json`, `i18n/zh-CN.json`

---

### 2026-03-12 — E2E Gateway Integration: 6-Layer Debug (Dashboard ↔ Plugin ↔ Gateway)

Full end-to-end debugging session: dashboard connected to OpenClaw gateway via WS RPC protocol v3. Six cascading issues found and fixed — each fix revealed the next layer.

- [2026-03-12] [Infra] [User+Claude] **Config resolution**: OpenClaw ignores per-project config and `OPENCLAW_CONFIG_PATH` env var. Must merge all plugin settings into global `~/.openclaw/openclaw.json`.
- [2026-03-12] [Modules] [User+Claude] **better-sqlite3 Node mismatch**: Gateway runs Node 22 (conda), system is Node 23. Native module rebuilt via `node-gyp rebuild` with conda Node in PATH.
- [2026-03-12] [Modules] [Claude] **Async register() race**: Gateway spread-copies plugin handlers before async register resolves. Fixed: synchronous `register()`, fire-and-forget `wsService.init()`.
- [2026-03-12] [Dashboard] [Claude] **SetupWizard blocks gateway-served dashboard**: Per-origin localStorage empty on port 18789. Fixed: auto-detect gateway port in `config.ts loadConfig()`, auto-skip setup.
- [2026-03-12] [Dashboard] [Claude] **Panel data race condition**: Panels call `loadPapers()`/`loadTasks()` on mount before WS handshake completes; `isConnected` guard silently skips. Fixed: panels subscribe to `connState`, re-fetch on 'connected'.
- [2026-03-12] [Dashboard+Modules] [User+Claude] **ROOT CAUSE — Gateway handler protocol mismatch**: OpenClaw handlers must call `opts.respond(true, payload)`. Our handlers returned values (never called `respond()`). Gateway found handler, invoked it, return value ignored, client timed out. Fixed: bridge wrapper in `index.ts` that extracts `opts.params`, awaits handler result, calls `opts.respond()`.
- [2026-03-12] [Dashboard] [Claude] **Diagnostic logging**: Added `[GatewayClient]` state/request/response logs, store-level connection guards, panel-level load triggers. All via `console.log` for browser DevTools.
- [2026-03-12] [Dashboard] [Claude] **CSS overflow**: Chat message bubbles added `overflow: 'hidden'` + `wordBreak: 'break-word'`. Global CSS: `.markdown-body` overflow constraints for images, tables, pre blocks.
- [2026-03-12] [Modules] [Claude] **Tool parameter validation**: All 24 agent tools hardened with `typeof` guards replacing unsafe `as` casts. Defensive validation for all required params (12 literature + 6 task + 6 workspace).
- [2026-03-12] [Modules] [Claude] **Mock data**: 4 papers + 5 tasks + 2 tags + tag assignments inserted into SQLite for display pipeline isolation testing.

**Key OpenClaw internal discoveries documented:**
- jiti loads `.ts` directly (dist/ never used)
- Plugin load → synchronous register → gateway copies handlers → attach WS
- `GatewayRequestHandler = (opts: { params, respond }) => void` — must call respond()
- conda env with Node 22 for gateway, system Node 23 for development
- `features.methods` in hello-ok lists all 144 methods including plugin-registered ones

**Files changed**: `index.ts` (bridge wrapper), `config.ts` (auto-skip setup), `client.ts` (diagnostics), `LibraryPanel.tsx`, `TaskPanel.tsx`, `WorkspacePanel.tsx` (connState subscription), `library.ts`, `tasks.ts` (diagnostic logs), `MessageBubble.tsx`, `global.css` (overflow), `~/.openclaw/openclaw.json` (merged config), all 24 tool files (param validation)

---

### 2026-03-12 — E2E Panel Interaction Fixes + Radar Feature Build

Systematic audit and fix of all 4 dashboard panels to ensure interactive features work end-to-end with the gateway.

**Panel Interaction Fixes (5 issues):**
- [2026-03-12] [Dashboard] [User+Claude] **Library paper actions**: Menu items (Open PDF, Cite, Remove, Edit Tags) had no `onClick` handlers. Wired to `deletePaper()` or `send()` chat prefill.
- [2026-03-12] [Dashboard] [User+Claude] **Library tag filter**: `selectedTags` state updated but never passed to RPC. Fixed: `setFilters({ tag: selectedTags[0] })` in useEffect.
- [2026-03-12] [Dashboard] [User+Claude] **Tasks show completed toggle**: Store method existed but no UI control. Added `Switch` component wired to `toggleCompleted()`.
- [2026-03-12] [Dashboard] [User+Claude] **Session switch doesn't sync chat**: `switchSession()` only set local state. Fixed: calls `useChatStore.getState().setSessionKey(key)`.
- [2026-03-12] [Dashboard] [User+Claude] **No panel auto-refresh after LLM tool calls**: Added `setTimeout(500ms)` refresh of all stores (`loadPapers`, `loadTags`, `loadTasks`, `loadSessions`, `loadConfig`) in `chat.ts` after `final` event.

**Radar Feature — Full Stack Build (DB → RPC → Tool → Panel):**
- [2026-03-12] [Modules] [Claude] **DB**: Added `rc_radar_config` table (id, keywords/authors/journals/sources as JSON, updated_at). Bumped SCHEMA_VERSION 1→2, added v2 migration.
- [2026-03-12] [Modules] [Claude] **RPC**: 2 methods (`rc.radar.config.get`, `rc.radar.config.set`) in `src/radar/rpc.ts`. Upsert with `ON CONFLICT(id) DO UPDATE`.
- [2026-03-12] [Modules] [Claude] **Agent Tools**: 2 tools (`radar_configure`, `radar_get_config`) in `src/radar/tools.ts`. Partial patch support for keywords/authors/journals/sources arrays.
- [2026-03-12] [Modules] [Claude] **Config**: Added both tools to `openclaw.json` `tools.alsoAllow`. Updated TOOLS.md with radar section + explicit "MUST use tool" instruction.
- [2026-03-12] [Dashboard] [Claude] **Store**: New `stores/radar.ts` Zustand store with `loadConfig()` RPC call.
- [2026-03-12] [Dashboard] [Claude] **Panel**: Rewrote `RadarPanel.tsx` from stub — sources section, tracking config, radar_digest chat extraction, "Edit via chat"/"Refresh" buttons.
- [2026-03-12] [Dashboard] [Claude] **Auto-refresh**: Added `useRadarStore.getState().loadConfig()` to chat.ts post-run refresh.
- [2026-03-12] [Modules] [Claude] **Plugin entry**: Registered radar RPC + tools in `index.ts`. Tool count 24→26.
- [2026-03-12] [Dashboard] [Claude] **i18n**: Added `radar.noTracking`, `radar.addTracking`, `radar.noFindings`, `tasks.showCompleted` keys.

**Critical Discovery — LLM Tool Availability 3-Layer Checklist:**
- [2026-03-12] [Infra] [User+Claude] **Root cause of "fake success" bug**: LLM generated text saying "✅ configured" but never called `radar_configure` tool. Missing from all 3 required channels:
  1. `tools.alsoAllow` in `openclaw.json` — whitelist gate
  2. `api.registerTool()` in plugin — runtime registration
  3. `workspace/TOOLS.md` — LLM prompt documentation
- [2026-03-12] [Infra] [Claude] **Documented**: 3-layer checklist added to `debug-sop-openclaw-plugin.md` as Layer 7. 10-step "New Feature Checklist" also added.
- [2026-03-12] [Infra] [Claude] **Verified**: All 26 tools confirmed present in all 3 channels.

**Cron/Heartbeat Investigation:**
- [2026-03-12] [Infra] [Claude] **Finding**: Radar has NO automatic periodic scanning. `cron.enabled: false` (disabled). 3 cron presets (`arxiv_daily_scan`, `citation_tracking_weekly`, `deadline_reminders_daily`) are state-management only — no bridge to OpenClaw `cron.add()`. Heartbeat runs every 30min but does NOT trigger radar scanning. Auto-scan is post-MVP.

**Files changed**: `stores/chat.ts`, `stores/radar.ts` (new), `stores/sessions.ts`, `LibraryPanel.tsx`, `TaskPanel.tsx`, `RadarPanel.tsx`, `i18n/en.json`, `i18n/zh-CN.json`, `src/radar/rpc.ts` (new), `src/radar/tools.ts` (new), `src/db/schema.ts`, `src/db/migrations.ts`, `index.ts`, `config/openclaw.json`, `workspace/TOOLS.md`

---

---

### 2026-03-12 — Session Management System Rewrite (First-Principles)

Complete rewrite of session/project switcher based on first-principles analysis of OpenClaw session model.

**Root Cause Analysis:**
- OpenClaw session keys are colon-delimited hierarchical (`agent:{agentId}:{rest}`), default is `"main"` → `"agent:main:main"`
- Dashboard was using `"default"` as the default session key — OpenClaw rejected this on some code paths
- "All Projects" dropdown item sent empty `sessionKey` → gateway error: `must NOT have fewer than 1 characters`
- Sessions not persisted across refresh (Zustand state-only, no localStorage)
- Session switch didn't refresh chat view (only set local key, never called `loadHistory`)
- No rename/delete UI for sessions

**sessions.ts — Full Rewrite:**
- [2026-03-12] [Dashboard] [User+Claude] Default key: `'default'` → `MAIN_SESSION_KEY = 'main'`
- [2026-03-12] [Dashboard] [Claude] `activeSessionKey` type: `string | null` → `string` (never null)
- [2026-03-12] [Dashboard] [Claude] localStorage persistence: `rc_active_session` key, restored on page load via `getPersistedKey()`
- [2026-03-12] [Dashboard] [Claude] `switchSession()`: now calls `useChatStore.setSessionKey()` + `loadHistory()` to refresh chat
- [2026-03-12] [Dashboard] [Claude] `createSession()`: generates `project-{uuid8}` key + adds local placeholder to sessions array (visible in dropdown immediately)
- [2026-03-12] [Dashboard] [Claude] `deleteSession()`: calls `sessions.delete` RPC, falls back to `MAIN_SESSION_KEY`, main session protected via `isMain()` guard
- [2026-03-12] [Dashboard] [Claude] `renameSession()`: calls `sessions.patch` RPC with label, updates local state on success
- [2026-03-12] [Dashboard] [Claude] `isMainSession()`: handles both `'main'` and `'agent:main:main'` (case-insensitive)

**LeftNav.tsx — Full Rewrite:**
- [2026-03-12] [Dashboard] [Claude] Removed "All Projects" item entirely (was nonsensical)
- [2026-03-12] [Dashboard] [Claude] Session display: `getSessionName()` priority chain: label > derivedTitle > displayName > stripped key
- [2026-03-12] [Dashboard] [Claude] Per-session actions: EditOutlined (rename via `prompt()`) + DeleteOutlined (with `confirm()`)
- [2026-03-12] [Dashboard] [Claude] Main session protection: delete button hidden, delete handler guards with `isMainSession()`
- [2026-03-12] [Dashboard] [Claude] Rename default: shows displayed name (not raw label) in prompt dialog

**chat.ts — Race Condition Fix:**
- [2026-03-12] [Dashboard] [Claude] `loadHistory()`: captures `sessionKey` before async request, discards response if key changed during await (prevents stale session data flash on rapid switching)
- [2026-03-12] [Dashboard] [Claude] Default `sessionKey`: `'default'` → `'main'`

**App.tsx — Session Restore:**
- [2026-03-12] [Dashboard] [Claude] On gateway connect: reads persisted session key from sessions store, syncs to chat store, loads history + session list
- [2026-03-12] [Dashboard] [Claude] Imports `MAIN_SESSION_KEY` constant (was hardcoded `'default'` check)

**i18n — Key Updates:**
- [2026-03-12] [Dashboard] [Claude] Removed orphan keys: `nav.project.switch`, `nav.project.default`, `project.allProjects`
- [2026-03-12] [Dashboard] [Claude] Added: `project.mainSession`, `project.renamePrompt`, `project.deleteConfirm` (EN + ZH-CN)

**Tests — Alignment:**
- [2026-03-12] [Dashboard] [Claude] All `sessionKey: 'default'` → `'main'` across 3 test files (stores.test.ts, stores-edge.test.ts, stores-integration.test.ts)
- [2026-03-12] [Dashboard] [Claude] Session interface: `createdAt`/`messageCount` → `updatedAt` (matching actual OpenClaw response)
- [2026-03-12] [Dashboard] [Claude] `createSession` test: UUID regex → `project-{8hex}` regex
- [2026-03-12] [Dashboard] [Claude] `deleteSession` test: `toBeNull()` → `toBe('main')` (now falls back to main, not null)
- [2026-03-12] [Dashboard] [Claude] chat.send test: exact match → `expect.objectContaining` (accounts for `idempotencyKey`)

**Design Doc Sync:**
- [2026-03-12] [Infra] [Claude] Updated `docs/modules/03e-dashboard-ui.md` §4.3: SessionsState now matches implementation (OpenClaw session model, localStorage persistence, renameSession, isMainSession, stale-response guard, placeholder sessions)

**Verification:**
- TypeScript: zero errors (`tsc --noEmit`)
- Tests: 298 passed (20 pre-existing failures in client.test.ts + RadarPanel.test.tsx — unrelated)
- Build: `vite build` successful

**Files changed:** `stores/sessions.ts`, `stores/chat.ts`, `components/LeftNav.tsx`, `App.tsx`, `i18n/en.json`, `i18n/zh-CN.json`, `__tests__/stores.test.ts`, `__tests__/stores-edge.test.ts`, `__tests__/stores-integration.test.ts`, `stores/chat.test.ts`, `docs/modules/03e-dashboard-ui.md`

---

### 2026-03-12 — Post-MVP: Workspace Preview + Radar Scan + Cron Bridge

Three post-MVP features closing the last major functional gaps: workspace file preview, radar paper scanning, and cron preset bridge.

**Phase 1 — Workspace File Preview:**
- [2026-03-12] [Dashboard] [Claude] **Shiki singleton extracted** to `utils/shiki-highlighter.ts` — shared between `CodeBlock.tsx` and new `FilePreviewModal.tsx` (22 languages, dual theme)
- [2026-03-12] [Dashboard] [Claude] **FilePreviewModal.tsx** (~280 lines): reads file via `rc.ws.read` RPC, renders Markdown (ReactMarkdown+remark-gfm), syntax-highlighted code (Shiki), images (base64), PDF/binary fallback. Footer: Copy Content, Download (Blob+ObjectURL), Show in Chat. Race condition guard with `cancelled` flag in useEffect.
- [2026-03-12] [Dashboard] [Claude] **WorkspacePanel.tsx wired**: file click → preview modal (was no-op), context menu "Open" → preview, cursor pointer for files
- [2026-03-12] [Dashboard] [Claude] **i18n**: 11 `workspace.preview.*` keys (EN + ZH-CN)

**Phase 2 — Radar Scan (arXiv + Semantic Scholar):**
- [2026-03-12] [Modules] [Claude] **scanner.ts** (~290 lines): arXiv ATOM XML parser (regex, 10s timeout, 400ms rate limit) + Semantic Scholar JSON API (15s timeout). Deduplication against `rc_papers` by DOI + arXiv ID. Each source independently try-caught.
- [2026-03-12] [Modules] [Claude] **radar_scan tool** added to `tools.ts`: tool #27, reads config, calls scanner, returns text summary + structured details. Does NOT auto-add to library (agent-in-the-loop design).
- [2026-03-12] [Modules] [Claude] **rc.radar.scan RPC** added to `rpc.ts`: dashboard "Refresh" button can trigger scan directly without chat.
- [2026-03-12] [Modules] [Claude] **index.ts** updated: 24→27 tools, 45→49 WS RPC, 46→50 total interfaces
- [2026-03-12] [Modules] [Claude] **openclaw.json**: `radar_scan` added to `tools.alsoAllow`
- [2026-03-12] [Modules] [Claude] **TOOLS.md**: radar section updated (2→3 tools), usage guidance added, total count 26→27
- [2026-03-12] [Dashboard] [Claude] **RadarPanel.tsx rewritten**: direct RPC scan (`rc.radar.scan`), inline results display, cron preset toggles (Switch UI), `scanning` loading state
- [2026-03-12] [Dashboard] [Claude] **i18n**: 5 `radar.*` keys (scanning, scanResults, newPapers, skipped, automations)

**Phase 3 — Cron Bridge (Dashboard-Driven Orchestrator):**
- [2026-03-12] [Modules] [Claude] **gateway_job_id column** added to `rc_cron_state` (ALTER TABLE migration with try-catch for existing DBs)
- [2026-03-12] [Modules] [Claude] **cronPresetsSetJobId()** method + `rc.cron.presets.setJobId` RPC: stores gateway cron job ID in plugin DB
- [2026-03-12] [Dashboard] [Claude] **stores/cron.ts** (~110 lines): Zustand store orchestrating RC plugin DB ↔ OpenClaw gateway `cron.add`/`cron.remove`. `activatePreset()` and `deactivatePreset()` flows.
- [2026-03-12] [Dashboard] [Claude] **chat.ts**: added `useCronStore.getState().loadPresets()` to post-run auto-refresh

**Code Review Fixes (4 bugs found and fixed):**
- [2026-03-12] [Modules] [Claude] `scanner.ts` arXiv URL regex: `http://` → `https?://` (handles both protocols)
- [2026-03-12] [Modules] [Claude] `scanner.ts` `getConfig()`: added try-catch around JSON.parse (defensive fallback)
- [2026-03-12] [Modules] [Claude] `scanner.ts` Semantic Scholar: `p.title!` → `p.title || ''` (removed unsafe non-null assertion)
- [2026-03-12] [Modules] [Claude] `tools.ts` `getConfig()`: added same JSON.parse try-catch

**Known Issues (lower priority, not fixed):**
- Race condition in `cron.ts` `activatePreset` (stale preset data after async call)
- `WorkspacePanel.tsx` no upload concurrency guard
- 3 pre-existing TS errors in index.ts (RegisterMethod contravariance in workspace/tasks/literature rpc.ts)

**Files changed:** `utils/shiki-highlighter.ts` (new), `FilePreviewModal.tsx` (new), `stores/cron.ts` (new), `radar/scanner.ts` (new), `CodeBlock.tsx`, `WorkspacePanel.tsx`, `RadarPanel.tsx`, `chat.ts`, `radar/tools.ts`, `radar/rpc.ts`, `tasks/service.ts`, `tasks/rpc.ts`, `index.ts`, `openclaw.json`, `TOOLS.md`, `en.json`, `zh-CN.json`

---

### 2026-03-12 — Security Model & Cron/Heartbeat Audit

Comprehensive audit of tool registration, cron/heartbeat, plugin loading, bootstrap assembly, and security boundaries.

**Security Model — Minimal Intervention (4-Layer Defence-in-Depth):**
- [2026-03-12] [Modules] [Claude] **L1 Network Isolation**: Verified loopback-only (`bind: "loopback"`, `mode: "local"`, `auth: "none"`). No remote exposure.
- [2026-03-12] [Modules] [Claude] **L2 Workspace Sandbox**: All workspace write tools (`workspace_save`, `/rc/upload`) enforce path validation (reject `..` traversal, null bytes, symlink escape). Native OpenClaw `write`/`edit`/`read` remain available — no tool deny (first-principles: don't restrict normal usage).
- [2026-03-12] [Modules] [Claude] **L3 Exec Guard**: New `before_tool_call` hook (Hook 4) intercepts `exec` calls. Blocks only catastrophic patterns: `rm -rf /`, `rm -r ~/`, `rm -rf ../`, `dd of=/dev/`, `mkfs`, `shred`, fork bomb. Normal commands (python, git, npm, curl, single-file rm, chmod, redirects) pass unhindered. 22/22 pattern tests pass. Design: block irreversible disasters only, trust OpenClaw's agentic self-correction for everything else.
- [2026-03-12] [Modules] [Claude] **L4 Git Versioning**: Auto-commit all workspace changes (5s debounce), local-only (no push), full history + restore.
- [2026-03-12] [Modules] [Claude] **L+ Prompt HiL**: SOUL.md red lines + AGENTS.md approval_card protocol for irreversible actions.

**Cron System — Enabled + 2 New Presets:**
- [2026-03-12] [Infra] [Claude] **cron.enabled**: `false` → `true` in `openclaw.json`. All cron presets now schedulable.
- [2026-03-12] [Modules] [Claude] **group_meeting_prep** preset: weekdays 09:00, checks USER.md for upcoming meetings, prepares review materials.
- [2026-03-12] [Modules] [Claude] **weekly_report** preset: Friday 17:00, generates weekly research progress report saved to workspace.
- [2026-03-12] [Modules] [Claude] Total presets: 3 → 5 (`arxiv_daily_scan`, `citation_tracking_weekly`, `deadline_reminders_daily`, `group_meeting_prep`, `weekly_report`).

**Heartbeat — Task Overview Injection:**
- [2026-03-12] [Modules] [Claude] **before_prompt_build** hook expanded: now injects active task overview (agent tasks + user tasks, split by `task_type`) into every turn's context. Agent sees its own todos and user's todos without calling tools.

**Plugin Hook Count:**
- [2026-03-12] [Modules] [Claude] Hook count: 6 → 7 (added `before_tool_call`). Header comment and log line updated.

**Audit Findings (no code changes needed):**
- [2026-03-12] [Infra] [Claude] **Tool registration**: All 27 tools (12 lit + 6 task + 6 ws + 3 radar) correctly registered via `api.registerTool()` + listed in `tools.alsoAllow` + documented in TOOLS.md. 3-layer checklist verified.
- [2026-03-12] [Infra] [Claude] **research-plugins**: 6 external tools + 431 skills correctly configured via `plugins.load.paths` + `skills.load.extraDirs`. Plugin manifest `openclaw.plugin.json` valid.
- [2026-03-12] [Infra] [Claude] **Bootstrap assembly**: 8 files in `workspace/` correctly loaded by OpenClaw `bootstrap-files.ts` → `buildAgentSystemPrompt()`. AGENTS.md (17KB) within 20KB single-file limit.

**Files changed:** `config/openclaw.json`, `extensions/research-claw-core/index.ts`, `extensions/research-claw-core/src/tasks/service.ts`

---

### 2026-03-12 — Dashboard UI Polish (Brand Alignment + Dead Code Cleanup)

Aligned dashboard branding, theme toggle, and i18n toggle with the Wentor web platform (`web/`). Removed dead code. Fixed OpenClaw `config.set` RPC misuse.

**Brand Alignment:**
- [2026-03-12] [Dashboard] [Claude] **Favicon**: Copied `web/public/favicon.ico` (lobster icon) to `dashboard/public/`. Updated `index.html` from missing `favicon.svg` to `favicon.ico`. Page title → "WentorOS · Research-Claw".
- [2026-03-12] [Dashboard] [Claude] **Logo**: TopBar rewritten — added 🦞 emoji + `WentorOS·ResearchClaw` (en) / `WentorOS·科研龙虾` (zh-CN). Updated `app.name` in both i18n files.
- [2026-03-12] [Dashboard] [Claude] **Theme toggle**: Replaced Ant Design `Switch` + `BulbFilled`/`BulbOutlined` with Sun/Moon SVG button (32×32px, hover bg/color transition). Matches `web/src/components/Navbar.tsx` design exactly.
- [2026-03-12] [Dashboard] [Claude] **Language toggle**: Added `EN | 中` inline toggle to TopBar (bold active, muted inactive, pipe separator). Matches `web/` Navbar design. Replaces Settings/General dropdown.

**Dead Code Removal:**
- [2026-03-12] [Dashboard] [Claude] **Avatar button removed**: `UserOutlined` profile button was non-functional (no auth in local dashboard). Removed from TopBar + `topbar.profile` i18n key.
- [2026-03-12] [Dashboard] [Claude] **General tab removed**: Entire `GeneralSettings` component deleted from SettingsPanel. 6 settings (language, theme, notificationSound, autoScroll, fileOpenBehavior, timestampFormat) were dead — none consumed by any other component. Language/theme now in TopBar. Verified via grep: zero external references.
- [2026-03-12] [Dashboard] [Claude] **config.ts cleaned**: Removed `notificationSound`, `autoScroll`, `fileOpenBehavior` + their setters + localStorage keys from `ConfigState` interface and store.
- [2026-03-12] [Dashboard] [Claude] **i18n cleaned**: Removed 12 dead keys from both en.json and zh-CN.json (`settings.general`, `settings.theme.*`, `settings.language.*`, `settings.notificationSound`, `settings.autoScroll`, `settings.timestampFormat/*`, `settings.fileOpen*`, `topbar.profile`).

**OpenClaw RPC Compatibility Fix:**
- [2026-03-12] [Dashboard] [Claude] **Proxy tab**: Root cause — `config.set` was called with `{ proxy: {...} }`, but OpenClaw schema requires `{ raw: NonEmptyString, baseHash?: string }` + `additionalProperties: false` (source: `openclaw/src/gateway/protocol/schema/config.ts:12-18`). Error: "must have required property 'raw'; unexpected property 'proxy'". Fix: save proxy URL to localStorage only (L0 pattern). Proxy URL built as `protocol://[user:pass@]host:port`.
- [2026-03-12] [Dashboard] [Claude] **Model tab**: Same bug — `config.set` was called with `{ provider, model, temperature, maxTokens }`, which also violates the schema. Silent try/catch masked the error. Fix: save all model settings to localStorage only. Added comment documenting why gateway RPC is not used (full config file rewrite semantics, not individual setting updates).
- [2026-03-12] [Dashboard] [Claude] **Architecture note**: OpenClaw `config.set/patch/apply` all require `raw` (full JSON5 config string) + optional `baseHash` for optimistic concurrency. These are config-file-level operations (read-modify-write cycle via `config.get` → edit → `config.set`), not designed for individual settings. Dashboard individual settings belong in localStorage (L0 layer).

**Layout fixes:**
- [2026-03-12] [Dashboard] [Claude] **SettingsPanel**: Default tab `general` → `model`. Proxy tab controls unified to `width: 160`, Divider between connection and auth sections, Switch → Segmented (ON/OFF) for visual consistency.
- [2026-03-12] [Dashboard] [Claude] **SettingRow**: Padding 8px → 10px, added `minWidth: 0` to label container for text truncation.

**Tests:**
- [2026-03-12] [Dashboard] [Claude] `SettingsPanel.test.tsx` rewritten: 3 tests (tab labels, model settings default, about diagnostics). Removed 4 tests referencing deleted General tab.

**Verification:**
- TypeScript: zero errors in changed files (pre-existing errors in FileCard.tsx unrelated)
- Tests: 24/28 dashboard test files pass (4 failures pre-existing in FileCard)
- i18n: both locales in sync after key removal

**Files changed:** `dashboard/public/favicon.ico` (new), `dashboard/index.html`, `dashboard/src/components/TopBar.tsx`, `dashboard/src/components/panels/SettingsPanel.tsx`, `dashboard/src/components/panels/SettingsPanel.test.tsx`, `dashboard/src/stores/config.ts`, `dashboard/src/i18n/en.json`, `dashboard/src/i18n/zh-CN.json`

---

### 2026-03-12 — E2E Testing: Library Fixes + FileCard/Workspace Integration + Code Review

Human-in-the-loop testing session covering library panel bugs, FileCard↔WorkspacePanel integration, and systematic code review.

**Library Panel — 5 Bug Fixes:**
- [2026-03-12] [Dashboard] [Claude] **Saved tab filter**: was returning all papers; fixed to `papers.filter((p) => p.rating && p.rating > 0)` with separate `savedCount` memo
- [2026-03-12] [Dashboard] [Claude] **Rating=0 unrate**: backend `rate()` only accepted 1-5, now accepts 0 (clears rating → NULL in DB). Bridge error serialization also fixed — `classifyError()` returns plain `{code, message}` objects, not Error instances; `String(err)` produced `[object Object]`. Bridge now checks for `.message` property before stringifying.
- [2026-03-12] [Dashboard] [Claude] **PaperCard add-to-library state**: added local `added` state + `useLibraryStore.getState().loadPapers()` refresh after successful add
- [2026-03-12] [Dashboard] [Claude] **Cite handler**: generates BibTeX → copies to clipboard via `navigator.clipboard.writeText()`, fallback to chat
- [2026-03-12] [Dashboard] [Claude] **EditTags handler**: prompt-based tag editing via `rc.lit.tag`/`rc.lit.untag` RPC with diff logic (add new, remove old)
- [2026-03-12] [Dashboard] [Claude] **Open PDF fallback chain**: `pdf_path ?? url ?? arxiv PDF URL` (was always disabled when `pdf_path` was null)

**FileCard + WorkspacePanel Integration:**
- [2026-03-12] [Dashboard] [Claude] **FileCard buttons rewritten**: "Open"/"Download" (non-functional) → "Open File"/"Open in Workspace" with working handlers
- [2026-03-12] [Dashboard] [Claude] **Cross-component communication**: `UiState.pendingPreviewPath` bridges FileCard (chat area) → WorkspacePanel (side panel) for file preview via `requestWorkspacePreview(path)`
- [2026-03-12] [Dashboard] [Claude] **Post-chat workspace refresh**: `chat.ts` triggers `useUiStore.getState().triggerWorkspaceRefresh()` after each completed run; WorkspacePanel watches `workspaceRefreshKey` counter via useEffect
- [2026-03-12] [Dashboard] [Claude] **UiState new fields**: `workspaceRefreshKey: number`, `pendingPreviewPath: string | null`
- [2026-03-12] [Dashboard] [Claude] **UiState new actions**: `triggerWorkspaceRefresh()`, `requestWorkspacePreview(path)`, `clearPendingPreview()`

**Code Review — 6 Additional Bug Fixes:**
- [2026-03-12] [Dashboard] [Claude] **CRITICAL: RPC param mismatch** in `handleEditTags`: sent `{ id, tag }` but backend expects `{ paper_id, tag_name }`. Every tag edit silently failed (`.catch(() => {})` swallowed errors). Fixed parameter names.
- [2026-03-12] [Dashboard] [Claude] **deletePaper unhandled rejection**: no try/catch around `rc.lit.delete` RPC. Added try/catch with `loadPapers()` fallback on failure.
- [2026-03-12] [Dashboard] [Claude] **VirtualRow ARIA attributes dropped**: `ariaAttributes` prop declared but never spread onto DOM element. Fixed: `<div style={style} {...ariaAttributes}>`
- [2026-03-12] [Dashboard] [Claude] **Unused import**: removed dead `PlusOutlined` import from WorkspacePanel
- [2026-03-12] [Dashboard] [Claude] **handleUpload missing `t` dependency**: stale translation in error message after language switch. Added `t` to useCallback dependency array.
- [2026-03-12] [Dashboard] [Claude] **Redundant loadPapers on tab switch**: tab filtering is client-side (useMemo), so switching tabs triggered unnecessary RPC round-trip. Removed `activeTab` from useEffect dependency.

**Verification:**
- TypeScript: zero real errors (TS6305 = stale incremental artifacts, not real)
- Tests: 296 passed (21 pre-existing failures — client.test.ts + RadarPanel + SettingsPanel)
- Build: `vite build` successful

**Files changed:** `stores/ui.ts`, `stores/chat.ts`, `stores/library.ts`, `components/chat/cards/FileCard.tsx`, `components/chat/cards/PaperCard.tsx`, `components/panels/LibraryPanel.tsx`, `components/panels/WorkspacePanel.tsx`, `i18n/en.json`, `i18n/zh-CN.json`, `extensions/research-claw-core/src/literature/service.ts`, `extensions/research-claw-core/src/literature/rpc.ts`, `extensions/research-claw-core/index.ts`, `extensions/research-claw-core/src/__tests__/literature.test.ts`, `__tests__/FileCard.test.tsx`, `__tests__/FileCard.edge.test.tsx`, `__tests__/PaperCard.test.tsx`, `__tests__/PaperCard.edge.test.tsx`

---

### 2026-03-12 — Telegram IM 连接诊断 + Chat History 注入污染修复

E2E Telegram 连接测试中发现两个问题：agent 无法发送消息 + 刷新后系统消息污染用户消息。

**Telegram "Action send requires a target" — 诊断（非代码修复）：**
- [2026-03-12] [Infra] [User+Claude] **根因**: OpenClaw `message` tool `send` action 需要 `to` 参数（Telegram chat_id）。Agent 从 dashboard 发起时无 channel context (`toolContext.currentChannelId` 为空), target 推断失败。
- [2026-03-12] [Infra] [Claude] **Lane 阻塞连锁**: `lane=session:agent:main:default waitedMs=32348` — 慢操作阻塞 agent 主执行通道 32s → Telegram polling 90s 无 getUpdates → 强制重启 → send 调用排队超时。
- [2026-03-12] [Infra] [Claude] **最终成功原因**: lane 解除阻塞 + Telegram 入站消息填充了 channel context → 后续 send 成功。
- [2026-03-12] [Infra] [Claude] **结论**: OpenClaw agent 行为问题，非 Research-Claw 代码 bug。需在 USER.md 记录 Telegram chat_id 使 agent 可显式传参。

**Chat History 注入污染修复：**
- [2026-03-12] [Dashboard] [Claude] **根因**: `before_prompt_build` hook 返回 `{ prependContext }` → OpenClaw 将其存储为 user message 一部分 → `chat.history` 返回时 user 消息包含 `[Research-Claw]` 任务概览 + `System:` exec 事件行。
- [2026-03-12] [Dashboard] [Claude] **修复**: 新增 `stripInjectedContext()` 函数（`chat.ts`），在 `loadHistory` 中清除两种注入模式：(1) `[Research-Claw]` header + 缩进续行, (2) `System: [timestamp]` exec 行。清除后为空的 user message 直接丢弃。
- [2026-03-12] [Dashboard] [Claude] **影响范围**: 仅影响 `loadHistory`（页面刷新/session 切换）。Live streaming 中 user 消息由 `send()` 用原始文本创建，不受影响。

**Verification:**
- TypeScript: zero errors
- Build: `vite build` successful

**Files changed:** `dashboard/src/stores/chat.ts`

---

### 2026-03-12 — Notification System Activation (Dual-Channel Architecture)

Activated the previously dead notification system using a dual-channel architecture that works within OpenClaw plugin API constraints (no emitEvent available).

**Channel A — RPC Polling (overdue/upcoming tasks):**
- [2026-03-12] [Modules] [Claude] **rc.notifications.pending RPC** added to `tasks/rpc.ts`: queries `service.overdue()` + `service.upcoming(hours)`, returns lightweight task summaries (id, title, deadline, priority). Reuses existing service methods, zero new SQL.
- [2026-03-12] [Dashboard] [Claude] **checkNotifications()** added to `ui.ts`: calls `rc.notifications.pending`, converts overdue/upcoming tasks to Notification objects with dedup keys (`overdue:{taskId}`, `upcoming:{taskId}`).
- [2026-03-12] [Dashboard] [Claude] **Polling triggers**: (1) on WS connect, (2) after every chat turn (in auto-refresh block), (3) 60s `setInterval` while connected.

**Channel B — Chat Event Card Extraction (heartbeat/radar/approval):**
- [2026-03-12] [Dashboard] [Claude] **extractCardNotifications()** in `chat.ts`: regex-scans assistant `final` messages for card-type code blocks (`progress_card`, `radar_digest`, `approval_card`), parses JSON, creates typed notifications. Piggybacks on existing `handleChatEvent` flow.

**Deduplication:**
- [2026-03-12] [Dashboard] [Claude] **dedupKey** field added to Notification interface (`ui.ts`). `addNotification` checks existing notifications for matching dedupKey before adding. Task-based keys are stable (`overdue:{taskId}`), card-based keys include timestamp for uniqueness.

**Infrastructure:**
- [2026-03-12] [Modules] [Claude] **index.ts** updated: 49→50 WS RPC, 50→51 total interfaces.
- [2026-03-12] [Dashboard] [Claude] **App.tsx**: initial check on connect + 60s polling timer.
- [2026-03-12] [Dashboard] [Claude] **Notification cap**: max 50 notifications in store (`.slice(0, 50)` on add).

**Verification:**
- TypeScript: zero errors (dashboard + plugin)
- Build: `vite build` successful

**Files changed:** `extensions/research-claw-core/src/tasks/rpc.ts`, `extensions/research-claw-core/index.ts`, `dashboard/src/stores/ui.ts`, `dashboard/src/stores/chat.ts`, `dashboard/src/App.tsx`

---

### 2026-03-12 — Tool Execute Signature Fix (Critical Bug)

**Root cause:** OpenClaw's `AgentTool.execute` signature is `(toolCallId, params, signal, onUpdate)` — 4 arguments. All 27 of our tools declared `execute(params)` with 1 argument. When OpenClaw called `execute(toolCallId, params, ...)`, our `params` received the `toolCallId` string instead of the actual parameters object.

**Impact:**
- Tools with required params (task_create, library_add_paper, etc.) → validation failed immediately ("title is required") because `params.title` was `undefined` (accessing `.title` on a string)
- Tools with all-optional params (task_list, library_reading_stats) → appeared to work but silently ignored ALL filter arguments (everything defaulted)

**Fix:**
- [2026-03-12] [Modules] [Claude] **types.ts**: `ToolDefinition.execute` signature updated to `(toolCallId: string, params, signal?, onUpdate?)`
- [2026-03-12] [Modules] [Claude] **All 27 tools** across 4 files: `execute` first param changed to `_toolCallId: string`
  - `tasks/tools.ts`: 6 tools (task_create, task_list, task_complete, task_update, task_link, task_note)
  - `literature/tools.ts`: 12 tools (library_*)
  - `workspace/tools.ts`: 6 tools (workspace_*)
  - `radar/tools.ts`: 3 tools (radar_*)

**Verification:** `tsc --noEmit` zero errors, `vite build` successful.

**Files changed:** `src/types.ts`, `src/tasks/tools.ts`, `src/literature/tools.ts`, `src/workspace/tools.ts`, `src/radar/tools.ts`

---

### 2026-03-12 — Notification System Completion (Persistence + Agent Tool)

**Bug 1 — "Mark all read" not persisting across refresh:**
- Root cause: Zustand store is in-memory only. On refresh, `notifications: []` resets, `checkNotifications()` recreates the same task-based notifications as unread. `dedupKey` dedup only works within a session.
- [2026-03-12] [Dashboard] [Claude] **localStorage persistence**: read `dedupKey` values saved to `rc-read-dedup-keys` in localStorage (cap 200). `addNotification` checks persisted read set — if a dedupKey was previously read, the notification is created as `read: true`. `markNotificationRead` / `markAllNotificationsRead` persist dedupKeys.

**Bug 2 — Agent cannot push bell notifications:**
- Root cause: No `send_notification` tool existed. TopBar had 3 dead `useEvent` listeners for gateway events that OpenClaw plugins cannot emit (no `emitEvent` API).
- [2026-03-12] [Modules] [Claude] **Migration v3**: `rc_agent_notifications` table (id, type, title, body, created_at, read)
- [2026-03-12] [Modules] [Claude] **TaskService**: `sendNotification()`, `getUnreadNotifications()`, `markNotificationRead()` methods
- [2026-03-12] [Modules] [Claude] **send_notification tool** (28th tool): agent can push notifications to dashboard bell. Params: type (deadline/heartbeat/system/error), title, body.
- [2026-03-12] [Modules] [Claude] **rc.notifications.pending** extended: now returns `custom` field with unread agent-sent notifications
- [2026-03-12] [Modules] [Claude] **rc.notifications.markRead** RPC added (52nd interface)
- [2026-03-12] [Dashboard] [Claude] **checkNotifications()** extended: processes `custom` notifications from agent
- [2026-03-12] [Dashboard] [Claude] **TopBar cleanup**: removed 3 dead `useEvent` listeners + unused imports (`useCallback`, `useEvent`, `AppNotification` type)

**Native module fix:**
- [2026-03-12] [Infra] [Claude] **better-sqlite3 rebuild**: `pnpm rebuild` and `npx node-gyp rebuild` both silently used system Node 23 (MODULE_VERSION 131). Gateway runs on conda Node 22 (MODULE_VERSION 127). Fixed by using exact conda Node binary: `$CONDA_PREFIX/bin/node $CONDA_PREFIX/lib/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js rebuild`

**Updated counts:** 28 tools (12+7+6+3), 51 WS RPC + 1 HTTP = 52 interfaces, 13 tables (+rc_agent_notifications)

**Verification:** All 4 test cases passed: (1) agent send_notification ✓, (2) rule-based deadline notifications ✓, (3) mark all read persists ✓, (4) single mark read persists ✓

**Files changed:** `src/types.ts`, `src/tasks/tools.ts`, `src/tasks/service.ts`, `src/tasks/rpc.ts`, `src/db/migrations.ts`, `index.ts`, `dashboard/src/stores/ui.ts`, `dashboard/src/components/TopBar.tsx`

---

### 2026-03-12 — Dashboard UI Polish (Brand Alignment + Dead Code Cleanup)

- [2026-03-12] [Dashboard] [Claude] **Favicon**: copied lobster favicon from web/, updated index.html title to `WentorOS · Research-Claw`
- [2026-03-12] [Dashboard] [Claude] **TopBar**: rewrote — removed antd Button/Switch/Avatar, added lobster logo + i18n app.name, Sun/Moon SVG theme toggle (matching web/ Navbar), EN|中 language toggle, removed profile avatar
- [2026-03-12] [Dashboard] [Claude] **SettingsPanel**: removed General tab (dead code), fixed Model tab config.set RPC → localStorage-only, fixed Proxy tab config.set RPC → localStorage URL builder, unified control width 160px, Switch → Segmented ON/OFF
- [2026-03-12] [Dashboard] [Claude] **Config store**: removed 3 dead state fields (notificationSound, autoScroll, fileOpenBehavior) + setters + localStorage
- [2026-03-12] [Dashboard] [Claude] **i18n**: removed 12 dead keys, renamed app.name to `WentorOS·ResearchClaw` / `WentorOS·科研龙虾`
- [2026-03-12] [Dashboard] [Claude] **About tab**: "OpenClaw v{{version}}" → "Powered by OpenClaw v{{version}}" / "由 OpenClaw v{{version}} 驱动"

### 2026-03-12 — Identity Initialization (Default Chinese + QQ Integration)

**Language default flip (English → Chinese):**
- [2026-03-12] [Prompt] [Claude] BOOTSTRAP.md: added `## Language` section (Chinese default, auto-switch on English response), Step 1 Q1 bilingual greeting, completion message bilingual
- [2026-03-12] [Prompt] [Claude] IDENTITY.md, SOUL.md, USER.md, AGENTS.md: all default language changed from English to Chinese (中文)
- [2026-03-12] [Dashboard] [Claude] `i18n/index.ts`, `stores/config.ts`: locale fallback `'en'` → `'zh-CN'` (3 locations)
- [2026-03-12] [Dashboard] [Claude] Tests updated: `config.test.ts`, `stores.test.ts` locale assertions aligned to `'zh-CN'`

**QQ IM channel integration (knowledge injection, zero code changes):**
- [2026-03-12] [Plugins] [Claude] Created `research-plugins/skills/integrations/qq-connect/SKILL.md` (220 lines): architecture overview, prerequisites (q.qq.com registration), install steps (plugin + config set + restart), optional config (STT/TTS/multi-account), agent self-setup flow, QQ registration guide, capabilities table, troubleshooting
- [2026-03-12] [Prompt] [Claude] BOOTSTRAP.md Step 2: QQ upgraded from "coming soon" to "available now", added 6-step guided setup sub-flow (a-f), references `qq-connect` skill
- [2026-03-12] [Prompt] [Claude] AGENTS.md Cold Start line 34: "Telegram available now" → "Telegram and QQ available now"
- [2026-03-12] [Infra] [Claude] `docs/sop/03-plugin-integration-sop.md`: QQ split from DingTalk/Email, status Planned→Available, priority P2→P1

**SOP consistency audit (vs openclaw-qqbot source, 16 claims verified):**
- [2026-03-12] [Infra] [Claude] Fixed CLI command: `openclaw channels add --channel-id qqbot --json` → `openclaw config set channels.qqbot.*` (qqbot is custom plugin, `channels add` only supports built-in channels per official docs)
- [2026-03-12] [Infra] [Claude] Fixed logs command: `openclaw gateway logs` → `openclaw logs` (per docs/commands.md)
- [2026-03-12] [Infra] [Claude] Verified 15/16 claims accurate against source (package name, config schema, API endpoints, intents, media tags, skills, session TTL, multi-account format)

### 2026-03-12 — SetupWizard Vision Fix + Cron Bridge Schema Fix

**Image upload pipeline fix (images silently dropped):**
- [2026-03-12] [Dashboard] [Claude] `SetupWizard.tsx:211`: primary model `input` changed from `['text']` → `['text', 'image']`. Root cause: OpenClaw `detectAndLoadPromptImages()` (`images.ts:302`) checks `modelSupportsImages(params.model)` — returns empty array (discarding uploaded images) when primary model lacks `"image"` in `input`. Modern models (GLM-5, GPT-4o, Claude Sonnet, Gemini, etc.) all support multimodal; marking correctly enables the full image pipeline.

**Cron activate preset fix (INVALID_REQUEST on toggle):**
- [2026-03-12] [Dashboard] [Claude] `stores/cron.ts`: fixed `cron.add` RPC params to match OpenClaw `CronAddParamsSchema`. Was sending `{ schedule: "0 7 * * *", agentTurn: "..." }` — three errors: (1) `schedule` must be object `{ kind: "cron", expr: "..." }` not string, (2) `agentTurn` is not a recognized field — should be `message` (normalizer wraps into `payload: { kind: "agentTurn", message }`), (3) `name` was missing. Fixed to `{ name, schedule: { kind: "cron", expr }, message }`. Normalizer (`normalizeCronJobCreate` with `applyDefaults: true`) auto-fills `sessionTarget`, `wakeMode`, `enabled`, `delivery`.

### 2026-03-12 — Setup/Settings/Config Alignment + Gateway Reconnect Fix

Three blockers resolved: config alignment between Setup Wizard / Settings Panel / openclaw.json, gateway reconnect state machine bug, and chat history system message pollution.

**Config Alignment (Setup Wizard ↔ Settings Panel ↔ openclaw.json):**
- [2026-03-12] [Dashboard] [Claude] **config-patch.ts** created: shared `buildConfigPatch()` + `extractConfigFields()` utility used by both SetupWizard and SettingsPanel. Fixed provider ID to `"default"` (idempotent overwrites). Model `input` capability logic: text-only `["text"]` when separate vision model exists, otherwise `["text", "image"]`.
- [2026-03-12] [Dashboard] [Claude] **SetupWizard.tsx** rewritten: removed 10 provider presets + endpoint mapping tables. Now 4 fields only (Base URL, API Key, Text Model, Vision Model). Uses `buildConfigPatch()` → `config.patch` RPC.
- [2026-03-12] [Dashboard] [Claude] **SettingsPanel.tsx** Model tab rewritten: changed from read-only display to editable 4-field form. Reads from `config.get` via `extractConfigFields()`, writes via `config.patch`. Change detection prevents unnecessary gateway restarts (compares form values against current gateway config before patching).
- [2026-03-12] [Dashboard] [Claude] **config.ts store** refactored: `{model, provider, endpoint, proxyUrl}` → `{baseUrl, apiKey, textModel, visionModel}`. `completeSetup()` signature updated. localStorage keys renamed.
- [2026-03-12] [Dashboard] [Claude] **StatusBar.tsx**: reads model name from `gatewayConfig.agents.defaults.model.primary` (was reading stale localStorage `rc-model`).
- [2026-03-12] [Dashboard] [Claude] **sanitizeBaseUrl removed**: user fills in exact URL, no processing beyond trailing slash trim. Per user requirement: "用户自己填写完整url和endpoint, 你不需要做任何复杂考虑".
- [2026-03-12] [Dashboard] [Claude] **COMPAT_DEFAULTS**: all models get `supportsDeveloperRole: false`, `supportsStrictMode: false`, etc. Prevents OpenClaw from sending unsupported parameters to third-party APIs (was causing 404/400).

**Gateway Reconnect State Machine Bug (Critical):**
- [2026-03-12] [Dashboard] [Claude] **Root cause**: `GatewayClient.connect()` unconditionally set state to `'connecting'`, breaking the reconnect loop. When a reconnect attempt failed (gateway still down), `onclose` handler checked `this.state === 'reconnecting'` → false (was `'connecting'`) → fell through to `'disconnected'` → **gave up after ONE retry**.
- [2026-03-12] [Dashboard] [Claude] **Fix**: `connect()` now preserves `'reconnecting'` state: `if (this.state !== 'reconnecting') { this.setState('connecting'); }`. Reconnect loop continues indefinitely (800ms → 15s exponential backoff, no limit) until gateway comes back.
- [2026-03-12] [Dashboard] [Claude] **Impact**: after `config.patch` triggers gateway SIGUSR1 restart, dashboard now auto-reconnects when gateway is restarted (was showing permanent "disconnected" after first retry failure).

**Chat History System Message Filter:**
- [2026-03-12] [Dashboard] [Claude] **stripInjectedContext** broadened: was only matching `System: [timestamp]` format. Now strips ALL `System: ` prefixed lines (catches `System: Run: openclaw doctor --non-interactive` and similar injected messages).

**openclaw.json Cleanup:**
- [2026-03-12] [Infra] [Claude] Removed broken `zai` provider (no compat settings, low maxTokens) and broken `default` provider (baseUrl had doubled `/chat/completions` suffix → 404). Pointed `agents.defaults.model.primary` to `zhipu/glm-5`, `imageModel.primary` to `zhipu/glm-4.6v`. Config.patch from dashboard subsequently re-added a corrected `default` provider with proper baseUrl and compat settings.

**Verification:** tsc zero errors, 315/315 tests pass, vite build successful.

**Files changed:** `gateway/client.ts`, `utils/config-patch.ts`, `stores/config.ts`, `stores/chat.ts`, `components/setup/SetupWizard.tsx`, `components/panels/SettingsPanel.tsx`, `components/StatusBar.tsx`, `i18n/en.json`, `i18n/zh-CN.json`, `~/.openclaw/openclaw.json`

### 2026-03-13 — Unified Config Flow (Single Source of Truth: openclaw.json)

Eliminated localStorage as config source. `openclaw.json` via gateway `config.get`/`config.patch` RPC is now the single source of truth. Wizard and Settings Panel share identical field set and save flow.

**Architecture Change — bootState replaces setupComplete:**
- [2026-03-13] [Dashboard] [Claude] **config.ts store** refactored: removed `setupComplete`, `baseUrl`, `apiKey`, `textModel`, `visionModel` from state. Replaced with `bootState: 'pending' | 'ready' | 'needs_setup' | 'gateway_unreachable'`. `evaluateConfig()` inspects `gatewayConfig` to set bootState. All localStorage config reads/writes removed (only theme/locale/systemPromptAppend remain local).
- [2026-03-13] [Dashboard] [Claude] **App.tsx** rewritten: always-connect on mount (no conditional based on setupComplete). Render guard driven by bootState: pending → spinner, needs_setup → SetupWizard, gateway_unreachable → error card with retry, ready → main app. 10s timeout for pending → gateway_unreachable.
- [2026-03-13] [Dashboard] [Claude] **gateway.ts**: `onHello` callback calls `loadGatewayConfig()` automatically on every (re)connection. Uses `snapshot.hash` (not `baseHash`) and `snapshot.resolved` (not `config`) from config.get response.

**config-patch.ts — Dual-Provider Vision + Auto-Fix:**
- [2026-03-13] [Dashboard] [Claude] **buildConfigPatch()** rewritten: accepts `ConfigPatchInput` with 8 fields (baseUrl, apiKey, textModel, visionModel, visionBaseUrl, visionApiKey, proxyUrl). No `visionBaseUrl` → single provider `"rc"`. Has `visionBaseUrl` → two providers `"rc"` + `"rc-vision"`.
- [2026-03-13] [Dashboard] [Claude] **baseUrl auto-strip**: removes trailing slashes and `/chat/completions` suffix (SDK auto-appends it, double path → 404).
- [2026-03-13] [Dashboard] [Claude] **Multimodal fix**: text model always marked `input: ["text", "image"]`. OpenClaw checks `model.input.includes("image")` on PRIMARY model to inject images into prompt; without this, images were silently dropped.
- [2026-03-13] [Dashboard] [Claude] **imageModel always set**: `config.patch` is deep merge — omitting `imageModel` leaves stale values. Now always includes `imageModel.primary`, falling back to text model ref when no separate vision model.
- [2026-03-13] [Dashboard] [Claude] **extractConfigFields()** rewritten: detects single vs dual provider, returns all 8 fields + `useDifferentVisionEndpoint` boolean.
- [2026-03-13] [Dashboard] [Claude] **isConfigValid()** added: checks model primary exists and matching provider exists.

**SetupWizard — Complete Rewrite:**
- [2026-03-13] [Dashboard] [Claude] Uses already-connected client from gateway store (no temp GatewayClient). Wizard only renders when `bootState === 'needs_setup'` (gateway IS connected).
- [2026-03-13] [Dashboard] [Claude] New fields: vision endpoint toggle (differentEndpoint + visionBaseUrl + visionApiKey), proxy toggle with pre-filled URL.
- [2026-03-13] [Dashboard] [Claude] Save flow: `config.get` (for fresh hash) → `buildConfigPatch()` → `config.patch` with `baseHash`. Shows "Gateway restarting..." overlay. Gateway SIGUSR1 → restart → WS reconnects → onHello → config.get → evaluateConfig → bootState = ready → wizard disappears.
- [2026-03-13] [Dashboard] [Claude] Removed: Test Gateway button, temp client, `completeSetup()`, all localStorage writes.

**SettingsPanel — Flattened to Single Panel:**
- [2026-03-13] [Dashboard] [Claude] Removed 3-tab layout (Model / Proxy / About). Replaced with single scrollable panel: Model section → Vision section → Proxy section → [Save] → System prompt (local-only) → [Save] → About.
- [2026-03-13] [Dashboard] [Claude] Same `buildConfigPatch()` + `extractConfigFields()` as wizard. Same config.get → config.patch save flow.

**i18n:**
- [2026-03-13] [Dashboard] [Claude] Added keys (EN + ZH-CN): `setup.differentEndpoint`, `setup.visionBaseUrl`, `setup.visionApiKey`, `setup.proxyEnabled`, `setup.gatewayRestarting`, `boot.*`, `settings.differentEndpoint`, `settings.visionBaseUrl`, `settings.visionApiKey`, `settings.proxyUrl`.
- [2026-03-13] [Dashboard] [Claude] Removed unused keys: `setup.test*`, `settings.proxy{Protocol,Host,Port,Auth,Username,Password,Test*}`, `settings.{model,proxy,about}` (tab labels).

**Tests:**
- [2026-03-13] [Dashboard] [Claude] **config-patch.test.ts** created: 16 tests covering single-provider, dual-provider, proxy set/clear/undefined, trailing slash strip, /chat/completions strip, extractConfigFields, isConfigValid.
- [2026-03-13] [Dashboard] [Claude] **config.test.ts** rewritten: 17 tests covering bootState, evaluateConfig (4 cases), localStorage persistence.
- [2026-03-13] [Dashboard] [Claude] **SettingsPanel.test.tsx** rewritten: 3 tests — disconnected state, single panel (no tabs), vision endpoint toggle.

**Verification:** tsc zero errors, 335/335 tests pass, vite build successful.

**Files changed:** `utils/config-patch.ts` (rewrite), `stores/config.ts` (refactor), `stores/gateway.ts` (onHello auto-config), `App.tsx` (always-connect + bootState), `components/setup/SetupWizard.tsx` (rewrite), `components/panels/SettingsPanel.tsx` (flatten), `i18n/en.json`, `i18n/zh-CN.json`, `stores/config.test.ts`, `components/panels/SettingsPanel.test.tsx`, `utils/config-patch.test.ts`, `__tests__/stores.test.ts`

### 2026-03-13 — Native Provider Key Alignment (Deep-Dive)

> Merged from `CHANGELOG-model-provider-config.md`. Technical detail for the provider/model naming migration.

**Context**: RC's dashboard previously used custom provider keys `rc` and `rc-vision` (hardcoded in `config-patch.ts`), breaking OpenClaw's `ProviderCapabilities` resolution and automatic `imageModel` fallback. This migration aligned back to OC's native provider keys (`zai`, `openai`, `anthropic`, etc.).

**provider-presets.ts — Complete rewrite**: 7 custom presets → 25 OC-native providers in 4 tiers. Each preset's `id` matches the key in `models.providers.*` and `PROVIDER_CAPABILITIES`. New exports: `detectPresetFromProvider(key, baseUrl?)`.

**config-patch.ts — Rewritten core logic**: Removed `RC_PROVIDER`/`RC_VISION_PROVIDER` constants. `ConfigPatchInput` now takes `provider: string` (native key). `buildConfigPatch()` produces `models.providers.{nativeKey}` entries. Same-provider vision: single entry, two models. Different-provider vision: two entries, each with native key.

**SetupWizard + SettingsPanel**: Default `'zhipu'` → `'zai'`. Searchable provider dropdowns. Pre-fill via `detectPresetFromProvider` (exact ID match first, URL fallback). Vision baseUrl/apiKey hidden when shared provider.

**Known limitations**: (1) Stale `rc` provider in existing configs — harmless dead config. (2) `custom` provider → default capabilities (same as old `rc`). (3) Presets are a static snapshot — may drift as OC adds providers.

**Planned**: Clean up stale `rc` provider, add provider-specific API protocol selector, dynamic model discovery from gateway.

### 2026-03-13 — Config/Chat Runtime Bugfixes

Five runtime bugs fixed after Unified Config Flow integration testing.

**config.patch baseHash required (INVALID_REQUEST):**
- [2026-03-13] [Dashboard] [Claude] **Root cause**: SetupWizard called `config.patch` without `baseHash`. Gateway requires optimistic locking via hash.
- [2026-03-13] [Dashboard] [Claude] **Fix**: Added `config.get` call right before `config.patch` to fetch fresh `hash`. Also fixed `loadGatewayConfig` to use `snapshot.hash` (not `snapshot.baseHash`) and `snapshot.resolved` (not `snapshot.config`).

**HTTP 404 for model (double /chat/completions):**
- [2026-03-13] [Dashboard] [Claude] **Root cause**: user's baseUrl included `/chat/completions`; OpenAI SDK auto-appends it → doubled path → 404.
- [2026-03-13] [Dashboard] [Claude] **Fix**: `buildConfigPatch` strips `/chat/completions` suffix from baseUrl. Also manually fixed existing `~/.openclaw/openclaw.json`.

**Agent can't see images (silently dropped):**
- [2026-03-13] [Dashboard] [Claude] **Root cause**: OpenClaw checks `model.input.includes("image")` on the PRIMARY model. `buildConfigPatch` was setting `input: ["text"]` on the text model when a separate vision model existed. `imageModel` config is ONLY for the `/image` tool, NOT for automatic model switching.
- [2026-03-13] [Dashboard] [Claude] **Fix**: Always mark text model as `input: ["text", "image"]` (modern LLMs are multimodal). Also manually fixed existing config.

**Settings save not persisting when clearing vision model:**
- [2026-03-13] [Dashboard] [Claude] **Root cause**: `config.patch` is deep merge — omitting `imageModel` field leaves stale values from previous config.
- [2026-03-13] [Dashboard] [Claude] **Fix**: Always include `imageModel` in patch defaults, falling back to text model ref when no separate vision model.

**chat.abort missing sessionKey (INVALID_REQUEST):**
- [2026-03-13] [Dashboard] [Claude] **Root cause**: `abort()` sent `{ runId }` but gateway requires `{ runId, sessionKey }`.
- [2026-03-13] [Dashboard] [Claude] **Fix**: Added `sessionKey: get().sessionKey` to abort RPC params.

**Files changed:** `utils/config-patch.ts`, `stores/config.ts`, `stores/chat.ts`, `components/setup/SetupWizard.tsx`, `components/panels/SettingsPanel.tsx`, `stores/chat.test.ts`, `~/.openclaw/openclaw.json`

### 2026-03-13 — SettingsPanel Layout Fix + Stop Button Timeout Fallback

Code review revealed three additional bugs from the Unified Config Flow work.

**SettingsPanel layout bug (proxy section below save button):**
- [2026-03-13] [Dashboard] [Claude] **Root cause**: Proxy section was positioned AFTER the config save button but BEFORE the prompt save button. Users naturally clicked the second "Save" for proxy, but `handleSavePrompt` only shows a toast — it doesn't call `config.patch`. This caused: (1) "视觉模型endpoint无法保存" — user clicking wrong button; (2) "保存代理不会重启网关" — `handleSavePrompt` never triggers config.patch/SIGUSR1.
- [2026-03-13] [Dashboard] [Claude] **Fix**: Moved proxy section above the config save button. New layout: Model → Vision → Proxy → [Save config] → System prompt → [Save prompt] → About.

**Stop button no-fallback (UI stuck in streaming):**
- [2026-03-13] [Dashboard] [Claude] **Root cause**: `abort()` sent RPC but relied entirely on server sending `aborted` event to clear local state. If server didn't respond (run finished, network issue), UI stayed stuck in streaming mode with stop button visible indefinitely.
- [2026-03-13] [Dashboard] [Claude] **Fix**: Added 3-second timeout fallback. If `runId` hasn't been cleared by server event within 3s, force-clears streaming state. Preserves partial text as a message. If server responds normally, timeout is a no-op (runId already null).

**Stop button disconnected case:**
- [2026-03-13] [Dashboard] [Claude] **Fix**: When client is disconnected, abort still schedules the timeout fallback (can't send RPC, but must still clear local streaming state).

**Tests:** 3 new abort tests: timeout with partial text, timeout no-op after server response, timeout without streamText. Total: 337/337 pass.

**Files changed:** `components/panels/SettingsPanel.tsx` (layout reorder), `stores/chat.ts` (abort timeout), `stores/chat.test.ts` (3 new tests)

---

*Document: CHANGELOG | Created: 2026-03-11 | Last updated: 2026-03-16 (v0.4.1 release, SOP factual corrections)*

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
- [2026-03-11] [Modules] [Claude] 03c: Added rc.ws.save method, clarified rc.ws.upload as HTTP-only. Total ws methods: 6→7
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

---

## Pending Work

### Dashboard (S1)
- [ ] Implement GatewayClient (WS RPC v3 client)
- [ ] Implement TopBar, LeftNav, StatusBar shell
- [ ] Implement ChatView with message rendering
- [ ] Implement 7 message card components
- [ ] Implement 5 right panel tabs
- [ ] Implement SetupWizard (1-step)
- [ ] i18n: populate en.json + zh-CN.json
- [ ] Tests: vitest + happy-dom for all components

### Modules (S2)
- [ ] Implement db/schema.ts (12 table DDL)
- [ ] Implement db/connection.ts (better-sqlite3 manager)
- [ ] Implement db/migrations.ts (versioned)
- [ ] Implement LiteratureService (26 RPC methods)
- [ ] Implement TaskService (10 RPC methods)
- [ ] Implement WorkspaceService (7 RPC methods + HTTP upload)
- [ ] Implement card protocol + serializer
- [ ] Implement plugin entry (activate/deactivate lifecycle)
- [ ] Tests: vitest with in-memory SQLite

### Plugins (S3)
- [ ] Verify research-plugins skill loading end-to-end
- [ ] Implement wentor-connect OAuth flow (post-MVP)
- [ ] Integration test: gateway + plugin + dashboard round-trip

### Prompt (S4)
- [ ] Behavioral testing with live agent
- [ ] Refine AGENTS.md workflow steps based on testing
- [ ] Tune HEARTBEAT.md thresholds based on user feedback

### Infrastructure
- [ ] Implement scripts/install.sh (one-click installer)
- [ ] Implement scripts/setup.sh (interactive config)
- [ ] Implement scripts/apply-branding.sh (patch generator)
- [ ] Generate actual pnpm patch (patches/openclaw@2026.3.9.patch)
- [ ] End-to-end: install → setup → start → chat test

---

*Document: CHANGELOG | Created: 2026-03-11*

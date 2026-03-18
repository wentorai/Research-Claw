# S1 — Dashboard Development SOP

> Development standards and operation log for the Research-Claw Dashboard UI
> Covers: 01 (Interaction Design) + 03d (Message Cards) + 03e (Dashboard UI Engineering)

---

## 1. Scope

This SOP governs all development on the **Dashboard** — the React + Vite SPA served via `gateway.controlUi.root` at `http://127.0.0.1:28789`.

**Owner track:** Dashboard team / agent
**Source files:** `dashboard/` directory
**Design docs:** `docs/01-interaction-design.md`, `docs/modules/03d-message-card-protocol.md`, `docs/modules/03e-dashboard-ui.md`

---

## 2. Architecture Summary

### 2.1 Tech Stack (FINALIZED)

| Layer | Choice | Version |
|-------|--------|---------|
| Framework | React | 18 |
| UI Library | Ant Design | 5 |
| Styling | antd-style | — |
| Build | Vite | 6 |
| Language | TypeScript | 5.7 |
| State | Zustand | 5 |
| Markdown | react-markdown + remark-gfm + shiki | 9 |
| i18n | i18next + react-i18next | 24 / 15 |
| Dev port | 5175 (proxy WS to gateway 28789) | — |

### 2.2 Layout (FINALIZED — DO NOT ALTER)

- **3-column:** Left nav (240px, collapses to 56px) | Center chat (flex) | Right panel (320-480px, collapsible)
- **Responsive:** >=1440px 3-col, 1024-1439px 2-col (right overlay), <1024px 1-col (modals)
- **Top bar:** 48px — logo, spacer, notification bell, agent status dot, theme toggle, avatar
- **Status bar:** 28px — model name, token count (In/Out), heartbeat timer, version. **NO cost/money.**

### 2.3 Left Nav

- Project/focus switcher (**NOT** conversation list)
- Projects = shared workstreams (shared MEMORY.md), not isolated containers
- Function rail icons: Literature, Workspace, Tasks, Monitor, Settings
- Each project card: emoji + name + tags + status indicator

### 2.4 Center Chat

- Always visible, primary interface ("Chat is the OS")
- Message types: text, card (6 custom types), code, file attachment, approval request
- Slash command menu for shortcuts
- Drag-drop file upload
- Streaming rendering with delta/final/aborted states

### 2.5 Right Panel (5 tabs)

| Tab | Content | Notes |
|-----|---------|-------|
| Literature | Pending Review / Saved sub-tabs, search, filter, tag chips, read status badges | |
| Workspace | File tree (sources/ + outputs/) + output timeline (git log), drag-drop upload | |
| Tasks | Deadline-sorted list (**NOT Kanban**), human/agent perspective toggle, completed items folded | |
| Monitor | Active monitors, scan history, results digest | |
| Settings | 4 sub-tabs (General / Model / Proxy / About), proxy default 127.0.0.1:7890, connected software list in About | |

### 2.6 Setup Wizard

- **ONE step only:** provider + endpoint + API key + optional proxy + test button
- After setup -> direct to chat. BOOTSTRAP.md handles rest via conversation.

### 2.7 Agent Status

- 6 states: idle (green), thinking (amber), tool_running (amber), streaming (blue), error (red), disconnected (gray)
- 8px circle dot in top bar, pulse animation for active states

### 2.8 Notifications

- Bell icon with red badge count (max "99+")
- Sources: heartbeat, monitor, deadline, overdue, approval, error, setup
- Priority colors: Critical (red), High (amber), Medium (blue), Low (gray)
- Click -> scroll to related chat message

### 2.9 Message Cards (6 custom types)

| Card Type | Component | Spec |
|-----------|-----------|------|
| `paper_card` | `PaperCard.tsx` | 03d SS3.1 |
| `task_card` | `TaskCard.tsx` | 03d SS3.2 |
| `progress_card` | `ProgressCard.tsx` | 03d SS3.3 |
| `approval_card` | `ApprovalCard.tsx` | 03d SS3.4 |
| `monitor_digest` | `MonitorDigest.tsx` | 03d SS3.5 |
| `file_card` | `FileCard.tsx` | 03d SS3.6 |

Convention: fenced code blocks with card type as language tag. Standard code blocks (e.g., `python`, `typescript`) are handled by the default markdown renderer, not as custom card types (see 03d SS3.7). Unknown types degrade gracefully.

### 2.10 Theme (FINALIZED)

- Dark default (terminal aesthetic, matte surfaces, monospace accents)
- Light option (warm paper #FFFBF5)
- Lobster Red **#EF4444** (interactive), Academic Blue **#3B82F6** (informational)
- Typography: Inter (UI), JetBrains Mono (code/status)
- Elevation: no shadows, 1px borders with `rgba(255,255,255,0.06)`
- Border radius: 6px cards, 4px buttons, 2px badges

### 2.11 i18n

- EN default + zh-CN
- All UI strings externalized to JSON (`i18n/en.json`, `i18n/zh-CN.json`)

### 2.12 Explicitly Excluded from MVP

- NO Cmd+K command palette
- NO Kanban board
- NO Zotero real-time sync tab
- NO cost/money display
- NO 3-step setup wizard
- NO wentor-connect integration
- NO MCP in core agent

---

## 3. Component Tree

```
App.tsx (shell)
+-- TopBar.tsx
+-- LeftNav.tsx
+-- ChatView.tsx
|   +-- MessageBubble.tsx
|   +-- MessageInput.tsx
|   +-- cards/
|       +-- PaperCard.tsx
|       +-- TaskCard.tsx
|       +-- ProgressCard.tsx
|       +-- ApprovalCard.tsx
|       +-- MonitorDigest.tsx
|       +-- FileCard.tsx
+-- RightPanel.tsx
|   +-- panels/
|       +-- LibraryPanel.tsx
|       +-- WorkspacePanel.tsx
|       +-- TaskPanel.tsx
|       +-- MonitorPanel.tsx
|       +-- SettingsPanel.tsx
+-- setup/
|   +-- SetupWizard.tsx
+-- StatusBar.tsx
```

---

## 4. Zustand Stores

| Store | File | Responsibility |
|-------|------|---------------|
| gateway | `stores/gateway.ts` | WS connection state, RPC queue |
| chat | `stores/chat.ts` | Message history, sessions |
| library | `stores/library.ts` | Paper cache, search results |
| tasks | `stores/tasks.ts` | Task list, filters |
| config | `stores/config.ts` | User settings, bootState |
| sessions | `stores/sessions.ts` | Active session metadata |
| ui | `stores/ui.ts` | Theme, layout state, panel visibility, notifications |
| cron | `stores/cron.ts` | Cron preset orchestration (plugin DB + gateway bridge) |
| monitor | `stores/monitor.ts` | Monitor configuration and scan state |

---

## 5. Gateway Client Contract

**WS endpoint:** `ws://127.0.0.1:28789` (protocol v3)

### 5.1 Essential RPC Methods (Dashboard must call)

| Category | Methods |
|----------|---------|
| Chat | `chat.send`, `chat.history`, `chat.abort` |
| Config | `config.get`, `config.set`, `config.apply`, `config.schema` |
| Agent | `agents.list`, `agent.identity.get` |
| Agent Files | `agents.files.list`, `agents.files.get`, `agents.files.set` |
| Sessions | `sessions.list`, `sessions.patch`, `sessions.delete` |
| Cron | `cron.status`, `cron.list`, `cron.runs`, `cron.add`, `cron.update`, `cron.remove`, `cron.run` |
| Exec Approval | `exec.approval.resolve`, `exec.approvals.get`, `exec.approvals.set` |
| Skills/Tools | `skills.status`, `skills.update`, `skills.install`, `tools.catalog`, `models.list` |

### 5.2 Events Dashboard Monitors

| Event | Trigger | Dashboard Action |
|-------|---------|-----------------|
| `chat` | Agent reply stream | Render delta/final/error in chat |
| `agent` | Tool execution | Show tool progress indicator |
| `presence` | Client online/offline | Update status panel |
| `cron` | Task changes | Reload cron list |
| `exec.approval.requested` | Dangerous op | Pop approval dialog |
| `exec.approval.resolved` | Approval done | Close dialog |
| `update-available` | New version | Show update prompt |

### 5.3 Custom RPC Methods (from research-claw-core plugin)

All `rc.*` namespace — see `docs/00-reference-map.md` SS3.2 for full list (61 WS methods).

### 5.4 Handshake Flow

1. WebSocket connect to `ws://127.0.0.1:28789`
2. Gateway sends `event: connect.challenge` (nonce)
3. Client responds `req: connect` (auth info, device token, scopes)
4. Gateway replies `res: hello-ok` (snapshot: presence, health, defaults)
5. Bidirectional req/res + event streaming begins

---

## 6. Development Standards

### 6.1 File Organization

- Components: `dashboard/src/components/`
- Stores: `dashboard/src/stores/`
- Gateway client: `dashboard/src/gateway/`
- i18n: `dashboard/src/i18n/`
- Styles: `dashboard/src/styles/`
- Tests: co-located `*.test.tsx` files

### 6.2 Test Directory

Tests live in two locations:
- **Co-located store tests:** `stores/*.test.ts` (3 files: chat, config, cron)
- **Centralized test suite:** `__tests__/` (25 files), including:
  - `__tests__/parity/` — 13 gateway protocol parity tests (verify dashboard behavior matches OpenClaw internals)
  - Integration tests, store edge-case tests, theme tests, bootstrap consistency tests

### 6.3 Coding Standards

- Strict TypeScript (`strict: true`, no `any`)
- All UI strings via i18n (both en.json and zh-CN.json)
- CSS-in-JS via antd-style `createStyles`
- **No inline magic colors** — use theme tokens from `theme.ts`
- **ECharts gotcha:** CSS variables don't work on Canvas. Use `useTheme()` + hex values.
- **antd-style compound selectors:** Use separate class + `cx()` merge (not `&.plain-class`)
- Component props: explicit TypeScript interfaces
- State: Zustand stores only (no React Context for shared state)

### 6.4 Testing Requirements

- Unit tests: vitest + happy-dom
- Each component must have corresponding `.test.tsx`
- Gateway client mock: `vi.mock('../gateway/client')`
- Test i18n: use `i18n.changeLanguage('cimode')` for deterministic strings
- Coverage target: 80%+ for gateway client, stores, card rendering

### 6.5 Build & Preview

```bash
cd dashboard
pnpm dev          # Dev server at :5175 (proxy WS to :28789)
pnpm build        # Production build to dist/
pnpm typecheck    # tsc --noEmit
```

### 6.6 PR Checklist

- [ ] TypeScript strict-check passes (`pnpm typecheck`)
- [ ] Both en.json and zh-CN.json updated for new strings
- [ ] New components have tests
- [ ] No hardcoded colors (use theme tokens)
- [ ] No hardcoded strings (use i18n)
- [ ] Responsive layout verified at 1440px, 1024px, 768px
- [ ] Dark + light theme verified
- [ ] Card type rendering verified against 03d spec
- [ ] Gateway RPC calls match `docs/modules/03e-dashboard-ui.md` signatures

---

## 7. Operation Log

> Append entries as work progresses. Format: `[YYYY-MM-DD] [Agent/Author] Description`

### 7.1 Scaffold

- [2026-03-11] [Claude] Initial scaffold: 22 TSX/TS files, package.json, vite.config, tsconfig. All files are TODO stubs.

### 7.2 Implementation

<!-- Append implementation entries here -->

### 7.3 Issues & Fixes

<!-- Append bug fixes here -->

---

## 8. Dependencies on Other Tracks

| Dependency | Track | Blocks |
|------------|-------|--------|
| Message card JSON schema | Modules (03d) | Card rendering |
| RPC method signatures | Modules (03a-03c) | Gateway client calls |
| Plugin lifecycle events | Plugin Integration (05) | Approval card flow |
| Bootstrap file format | Prompt (04) | Settings → agent files editor |
| Theme tokens | — (self-contained in theme.ts) | — |

---

*Document: S1 | Track: Dashboard | Created: 2026-03-11*

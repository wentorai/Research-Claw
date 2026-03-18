# C2 — Global Engineering Specification

> **Research-Claw (科研龙虾) — Engineering Architecture**
>
> Status: DRAFT v1.0 | Last updated: 2026-03-11
>
> OpenClaw base: `2026.3.8` (commit `62d5df28d`) | Protocol: v3

---

## Table of Contents

1. [Architecture Diagram](#1-architecture-diagram)
2. [Coupling Tiers](#2-coupling-tiers)
3. [Tech Stack](#3-tech-stack)
4. [WS RPC Protocol v3](#4-ws-rpc-protocol-v3)
5. [RPC Method Inventory](#5-rpc-method-inventory)
6. [Plugin SDK Contract](#6-plugin-sdk-contract)
7. [SQLite Strategy](#7-sqlite-strategy)
8. [State Management](#8-state-management)
9. [Build Pipeline](#9-build-pipeline)
10. [Dev Workflow](#10-dev-workflow)
11. [Test Strategy](#11-test-strategy)
12. [Security](#12-security)
13. [Performance Budget](#13-performance-budget)
14. [pnpm Patch Scope](#14-pnpm-patch-scope)

Cross-references: [`05` Plugin SDK details](./modules/05-plugin-sdk.md) | [`03e` Dashboard impl](./modules/03e-dashboard-ui.md) | [`00` Reference map](./00-reference-map.md)

---

## 1. Architecture Diagram

```
                    ┌────────────────────────────────────────────────────────────────┐
                    │                       Research-Claw                            │
                    │                                                                │
 ┌─ L0 ────────────┼────────────────────────────────────────────────────────────┐   │
 │  Filesystem      │                                                            │   │
 │  Overlay         │  config/openclaw.json           AGENTS.md  SOUL.md         │   │
 │                  │  skills/_always/*                HEARTBEAT.md               │   │
 │                  │  .env  .research-claw/           SKILL.md frontmatter       │   │
 └──────────────────┼────────────────────────────────────────────────────────────┘   │
                    │          │                                                     │
 ┌─ L1 ────────────┼──────────┼─────────────────────────────────────────────────┐   │
 │  Plugin SDK      │          │                                                 │   │
 │                  │  ┌───────┴──────────────┐    ┌──────────────────────────┐  │   │
 │                  │  │  research-claw-core   │    │    wentor-connect       │  │   │
 │                  │  │  (L1 plugin)          │    │    (L1 plugin, future)  │  │   │
 │                  │  │                       │    │                         │  │   │
 │                  │  │  - 28 agent tools     │    │  - account sync         │  │   │
 │                  │  │  - 57 WS RPC methods  │    │  - skills sync          │  │   │
 │                  │  │  - 7 hooks            │    │  - telemetry            │  │   │
 │                  │  │  - 1 HTTP route       │    │                         │  │   │
 │                  │  │  - 1 service (SQLite) │    │  (deferred post-MVP)    │  │   │
 │                  │  └───────┬──────────────┘    └──────────────────────────┘  │   │
 │                  │          │                                                 │   │
 └──────────────────┼──────────┼─────────────────────────────────────────────────┘   │
                    │          │                                                     │
 ┌─ L2 ────────────┼──────────┼─────────────────────────────────────────────────┐   │
 │  WS RPC v3       │          │                                                 │   │
 │                  │  ┌───────┴──────────────┐    ┌──────────────────────────┐  │   │
 │                  │  │    Dashboard SPA      │◄──►│    Gateway WS RPC       │  │   │
 │                  │  │    React + Vite       │    │    ws://127.0.0.1:28789 │  │   │
 │                  │  │    (port 5175 dev)    │    │    Protocol v3          │  │   │
 │                  │  └──────────────────────┘    └──────────────────────────┘  │   │
 │                  │                                                            │   │
 └──────────────────┼────────────────────────────────────────────────────────────┘   │
                    │                                                                │
 ┌─ L3 ────────────┼────────────────────────────────────────────────────────────┐   │
 │  pnpm patch      │  openclaw@2026.3.8.patch   (~20 lines, 7 files)           │   │
 │  (branding)      │  CLI name · process title · system prompt · update URL    │   │
 │                  │  launchd label · systemd unit                              │   │
 └──────────────────┼────────────────────────────────────────────────────────────┘   │
                    │                                                                │
                    │  ┌────────────────────────────────────────────────────────┐    │
                    │  │              OpenClaw (npm dependency)                 │    │
                    │  │              Version: 2026.3.8                         │    │
                    │  │              Commit: 62d5df28d                          │    │
                    │  │              License: MIT                              │    │
                    │  │                                                        │    │
                    │  │  Gateway · Agent runtime · 40 extensions              │    │
                    │  │  52 built-in skills · Exec approvals · Cron           │    │
                    │  │  WS RPC v3 server · Plugin loader (jiti)              │    │
                    │  └────────────────────────────────────────────────────────┘    │
                    └────────────────────────────────────────────────────────────────┘

                    ┌────────────────────────────────────────────────────────────────┐
                    │              @wentorai/research-plugins (npm)                  │
                    │              431 Skills · 6 Tools · 150 MCP · 6 Lists         │
                    └────────────────────────────────────────────────────────────────┘
```

### Data Flow (runtime)

```
 User ─────► Dashboard SPA ────► WS RPC ────► Gateway ────► Agent ────► LLM
                  │                  │            │             │
                  │                  │            │             ├── Tool calls
                  │                  │            │             ├── Skill resolution
                  │                  │            │             └── Exec (Human-in-Loop)
                  │                  │            │
                  │                  │            ├── Plugin: research-claw-core
                  │                  │            │     ├── SQLite (library.db)
                  │                  │            │     ├── Agent tools
                  │                  │            │     └── RPC methods (rc.*)
                  │                  │            │
                  │                  │            └── Plugin: wentor-connect (future)
                  │                  │
                  │                  ├── Events (streaming)
                  │                  └── State snapshots
                  │
                  └── Zustand stores (gateway, chat, sessions, library, tasks, config, ui)
```

---

## 2. Coupling Tiers

Research-Claw uses a layered coupling model to minimize divergence from upstream OpenClaw while maximizing customization. Each tier has progressively tighter coupling and proportionally higher maintenance cost when OpenClaw releases new versions.

### L0 — Filesystem Overlay (Zero Coupling)

The filesystem tier requires **no code changes** to OpenClaw. All customization is through files that OpenClaw reads from the project directory at runtime.

| Category | Files | Purpose |
|----------|-------|---------|
| **Config** | `config/openclaw.json` | Gateway port, plugin entries, tool allowlist, skill dirs, heartbeat, cron |
| **Bootstrap** | `AGENTS.md`, `SOUL.md`, `HEARTBEAT.md` | Agent persona, research SOP, heartbeat templates |
| **Skills** | `skills/_always/research-sop/SKILL.md` | Always-loaded research methodology skill |
| **Skill Packs** | `node_modules/@wentorai/research-plugins/skills/*` | 431 research skills loaded via `extraDirs` |
| **Environment** | `.env` | API keys, proxy settings |
| **Data** | `.research-claw/library.db` | SQLite database (created by plugin at runtime) |

**Upgrade risk: NONE.** These files are external to OpenClaw's package. New OpenClaw versions may add config options but never remove existing ones without a major version bump.

**Key config paths** (from `config/openclaw.json`):

```jsonc
{
  "gateway.controlUi.root": "./dashboard/dist",     // Dashboard SPA
  "skills.load.extraDirs": [
    "./node_modules/@wentorai/research-plugins/skills",
    "./skills"
  ],
  "plugins.entries.research-claw-core.config.dbPath": ".research-claw/library.db"
}
```

### L1 — Plugin SDK (Stable API Coupling)

The plugin tier uses OpenClaw's documented Plugin SDK. Plugins are TypeScript packages loaded via jiti at gateway startup. They communicate through a versioned API contract.

| Plugin | Status | Description |
|--------|--------|-------------|
| `research-claw-core` | MVP (P0) | Literature library, task management, workspace tracking, 28 tools, 57 WS RPC + 1 HTTP = 58 interface methods |
| `wentor-connect` | Placeholder | Wentor platform sync (deferred post-MVP) |

**Upgrade risk: LOW.** Plugin SDK is semver-stable. Breaking changes only on OpenClaw major versions. TypeScript compilation catches interface drift at build time.

**Coupling surface:**
- Import: `openclaw/plugin-sdk` (types only, no runtime)
- Manifest: `openclaw.plugin.json` (declarative metadata)
- Config: injected via `api.pluginConfig`
- Lifecycle: `register(api)` called once at gateway startup

### L2 — WS RPC v3 (Protocol Coupling)

The dashboard communicates with the gateway exclusively through the WebSocket RPC protocol. This is the same protocol used by OpenClaw's built-in Lit UI, all mobile apps, and the macOS app.

**Coupling surface:**
- Frame format: `req` / `res` / `event` JSON frames (see [Section 4](#4-ws-rpc-protocol-v3))
- Handshake: `connect.challenge` → `connect` → `hello-ok`
- Method set: ~50 built-in + 61 custom `rc.*` WS methods + 1 HTTP route (see [Section 5](#5-rpc-method-inventory))

**Upgrade risk: MEDIUM.** Protocol version bumps (v3 → v4) require dashboard updates. However, OpenClaw maintains backward compatibility for at least one protocol version and announces changes in release notes.

### L3 — pnpm Patch (Source-Level Coupling)

The most tightly coupled tier. A pnpm patch modifies ~20 lines across 7 files in the installed `openclaw` package for branding purposes. See [Section 14](#14-pnpm-patch-scope) for exact scope.

**Upgrade risk: HIGH.** Each OpenClaw version bump requires patch regeneration. Mitigated by:
1. Patch is small and touches only string literals (no logic changes)
2. `scripts/sync-upstream.sh` automates update + re-patch + test
3. Patch file is version-locked: `patches/openclaw@2026.3.8.patch`
4. pnpm fails loudly if patch cannot apply (no silent breakage)

### Coupling Cost Matrix

| Tier | Files Changed | Lines Changed | Upgrade Effort | Breakage Risk |
|------|--------------|---------------|----------------|---------------|
| L0 | 0 (external) | 0 | None | None |
| L1 | 2 plugins | ~500 | Low (type check) | Low |
| L2 | 1 SPA | ~3000 | Medium (protocol) | Medium |
| L3 | 7 (patched) | ~20 | High (manual) | High |

---

## 3. Tech Stack

### Dashboard (L2)

| Layer | Technology | Version | Rationale |
|-------|-----------|---------|-----------|
| **Framework** | React | 18.3+ | Team expertise, ecosystem, design token sharing with Web Platform |
| **Build** | Vite | 6.0+ | Fast HMR, native ESM, small config surface |
| **UI Library** | Ant Design | 5.23+ | Consistent with Wentor Web Platform |
| **Styling** | antd-style | 3.7+ | Design token access, `createStyles`, `cx()` merging |
| **State** | Zustand | 5.0+ | Minimal boilerplate, no Provider overhead, devtools integration |
| **i18n** | i18next + react-i18next | 24.0+ / 15.0+ | EN default + zh-CN, consistent with Web Platform |
| **Markdown** | react-markdown + remark-gfm | 9.0+ / 4.0+ | Agent message rendering |
| **Syntax** | shiki | 1.24+ | Code block highlighting in chat |
| **Icons** | @ant-design/icons | 5.6+ | Consistent iconography |

**Design system:** Dark theme default (HashMind Terminal Aesthetic). Lobster Red `#EF4444` primary, Academic Blue `#3B82F6` accent. See `docs/FRONTEND_DESIGN_SYSTEM.md`.

```typescript
// Ant Design theme configuration (dashboard/src/App.tsx)
{
  algorithm: theme.darkAlgorithm,
  token: {
    colorPrimary: '#EF4444',   // Lobster Red
    colorInfo: '#3B82F6',       // Academic Blue
    borderRadius: 8,
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  },
}
```

**Why React over Lit (OpenClaw default):**

OpenClaw's built-in UI uses Lit web components. Research-Claw replaces this entirely with React for these reasons:

1. **Team expertise** — The Wentor team already maintains a React/UmiJS Web Platform
2. **Design token sharing** — Ant Design 5 tokens are reusable across Web Platform and Dashboard
3. **Ecosystem depth** — Rich accessibility, testing, and component libraries
4. **No migration cost** — Dashboard is built from scratch, not a fork of the Lit UI
5. **Feature parity** — Dashboard needs richer panels (library, tasks, workspace) that benefit from React's composition model

The switch is clean because OpenClaw's `gateway.controlUi.root` simply serves static files. The gateway does not care what framework generated them.

### Plugin Runtime (L1)

| Layer | Technology | Version | Rationale |
|-------|-----------|---------|-----------|
| **Language** | TypeScript | 5.7+ | Type safety, IDE support, Plugin SDK types |
| **Database** | better-sqlite3 | 11.7+ | Synchronous API, single-file, no server process |
| **Schema** | @sinclair/typebox | 0.34+ | Runtime type validation for tool inputs |
| **Loader** | jiti (via OpenClaw) | — | ESM/CJS interop, no pre-build needed for dev |

### Runtime

| Component | Technology | Version |
|-----------|-----------|---------|
| **Node.js** | Node.js LTS | 22.12+ |
| **Package Manager** | pnpm | 9.15+ |
| **Entry** | OpenClaw gateway | `node ./node_modules/openclaw/dist/entry.js gateway run --allow-unconfigured --auth token --port 28789 --force` (via `scripts/run.sh` auto-restart wrapper) |

### Repository Structure

```
research-claw/
├── config/
│   ├── openclaw.json              # Active config
│   └── openclaw.example.json      # Reference config (commented)
├── dashboard/                     # L2 — React SPA (pnpm workspace member)
│   ├── src/
│   │   ├── App.tsx                # Root shell (3-column layout)
│   │   ├── main.tsx               # React entry point
│   │   ├── components/            # UI components
│   │   │   ├── TopBar.tsx
│   │   │   ├── LeftNav.tsx
│   │   │   ├── RightPanel.tsx
│   │   │   ├── StatusBar.tsx
│   │   │   ├── chat/              # Chat interface components
│   │   │   ├── panels/            # Right panel tabs
│   │   │   └── setup/             # First-run wizard
│   │   ├── gateway/               # WS RPC client
│   │   │   ├── types.ts           # Frame type definitions
│   │   │   ├── client.ts          # GatewayClient class
│   │   │   ├── reconnect.ts       # Exponential backoff
│   │   │   └── hooks.ts           # useGateway, useRpc, useEvent, useChat
│   │   ├── stores/                # Zustand stores
│   │   │   ├── gateway.ts
│   │   │   ├── chat.ts
│   │   │   ├── sessions.ts
│   │   │   ├── library.ts
│   │   │   ├── tasks.ts
│   │   │   ├── config.ts
│   │   │   └── ui.ts
│   │   ├── i18n/                  # EN + zh-CN translations
│   │   └── styles/                # Global CSS, design tokens
│   ├── index.html
│   ├── package.json
│   ├── tsconfig.json
│   ├── tsconfig.node.json
│   └── vite.config.ts
├── extensions/                    # L1 — Plugin packages (pnpm workspace members)
│   ├── research-claw-core/
│   │   ├── index.ts               # Plugin entry point
│   │   ├── openclaw.plugin.json   # Plugin manifest
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── db/                # SQLite connection, schema, migrations
│   │       ├── literature/        # Paper library tools + RPC + Zotero integration
│   │       ├── tasks/             # Task system tools + RPC
│   │       ├── workspace/         # Workspace save/restore + git tracking
│   │       └── cards/             # Card serialization for dashboard
│   └── wentor-connect/            # Future platform integration
│       ├── index.ts
│       ├── openclaw.plugin.json
│       └── package.json
├── patches/
│   └── openclaw@2026.3.8.patch    # L3 — Branding patch
├── scripts/
│   ├── setup.sh                   # First-run interactive setup
│   ├── apply-branding.sh          # Generate/regenerate pnpm patch
│   ├── sync-upstream.sh           # Update OpenClaw + re-patch + test
│   ├── install.sh                 # Full install sequence
│   ├── build-dashboard.sh         # Dashboard build wrapper
│   ├── backup.sh                  # SQLite backup
│   └── health.sh                  # Health check
├── skills/
│   └── _always/
│       └── research-sop/          # Always-loaded research SOP skill
├── test/
│   ├── gateway-client.test.ts
│   ├── literature-tools.test.ts
│   └── task-tools.test.ts
├── workspace/                     # User workspace directory (gitignored contents)
├── docs/                          # Engineering documentation
│   └── modules/                   # Module-level specs
├── package.json                   # Root workspace config
├── pnpm-workspace.yaml            # Workspace member declaration
├── tsconfig.json                  # Root TS config with project references
├── .env.example                   # Environment variable template
├── .gitignore
├── LICENSE                        # MIT
└── README.md
```

---

## 4. WS RPC Protocol v3

The gateway exposes a WebSocket endpoint at `ws://127.0.0.1:28789`. All communication between the dashboard and gateway uses JSON-encoded frames over this single connection. The protocol version is `3` (constant `PROTOCOL_VERSION`).

### 4.1 Frame Types

Three frame types exist: **request** (client → server), **response** (server → client), and **event** (server → client, unsolicited).

```typescript
// === Frame Type Definitions ===
// Source: dashboard/src/gateway/types.ts
// Mirrors OpenClaw protocol-schemas.ts (PROTOCOL_VERSION = 3)

export const PROTOCOL_VERSION = 3;

// --- Request Frame (client → server) ---
export interface RequestFrame {
  type: 'req';
  /** UUID v4, used for response correlation */
  id: string;
  /** RPC method name (e.g., "sessions.list", "rc.lit.search") */
  method: string;
  /** Method-specific parameters */
  params?: unknown;
}

// --- Response Frame (server → client) ---
export interface ResponseFrame {
  type: 'res';
  /** Matches the request id */
  id: string;
  /** true = success, false = error */
  ok: boolean;
  /** Response data (present when ok=true) */
  payload?: unknown;
  /** Error info (present when ok=false) */
  error?: GatewayErrorInfo;
}

// --- Event Frame (server → client, push) ---
export interface EventFrame {
  type: 'event';
  /** Event name (e.g., "chat.stream", "agent.status", "presence.update") */
  event: string;
  /** Event-specific data */
  payload?: unknown;
  /** Monotonically increasing sequence number (per connection) */
  seq?: number;
  /** State version counters for delta sync */
  stateVersion?: {
    presence: number;
    health: number;
  };
}

// --- Error Info ---
export interface GatewayErrorInfo {
  /** Machine-readable error code (e.g., "NOT_FOUND", "UNAUTHORIZED") */
  code: string;
  /** Human-readable message */
  message: string;
  /** Optional structured details */
  details?: unknown;
}

// --- Union Type ---
export type GatewayFrame = ResponseFrame | EventFrame;
```

### 4.2 Wire Format

Each WebSocket message is a single JSON-serialized frame. No framing envelope, no length prefix, no binary encoding. One message = one frame.

```
Client sends:    {"type":"req","id":"a1b2c3d4","method":"sessions.list","params":{"limit":50}}
Server responds: {"type":"res","id":"a1b2c3d4","ok":true,"payload":{"sessions":[...]}}
Server pushes:   {"type":"event","event":"chat.stream","payload":{...},"seq":42}
```

Maximum frame size: 16 MB (OpenClaw default). Frames exceeding this are rejected with a `PAYLOAD_TOO_LARGE` error.

### 4.3 Handshake Sequence

The connection lifecycle follows a strict 3-step handshake:

```
 Dashboard                          Gateway
     │                                  │
     │──── WS connect ────────────────►│
     │                                  │
     │◄─── connect.challenge ──────────│  (1) Server sends challenge
     │     { type: "event",             │      with nonce and supported
     │       event: "connect.challenge",│      auth methods
     │       payload: {                 │
     │         nonce: "...",            │
     │         methods: ["loopback",    │
     │                   "device-token",│
     │                   "session-key"] │
     │       }                          │
     │     }                            │
     │                                  │
     │──── connect RPC ───────────────►│  (2) Client responds with
     │     { type: "req",               │      auth credentials
     │       id: "...",                 │
     │       method: "connect",         │
     │       params: {                  │
     │         protocol: 3,             │
     │         auth: {                  │
     │           method: "loopback",    │
     │           nonce: "..."           │
     │         },                       │
     │         client: {                │
     │           name: "rc-dashboard",  │
     │           version: "0.1.0"       │
     │         }                        │
     │       }                          │
     │     }                            │
     │                                  │
     │◄─── hello-ok ──────────────────│  (3) Server sends snapshot
     │     { type: "res",               │      and connection metadata
     │       id: "...",                 │
     │       ok: true,                  │
     │       payload: {                 │
     │         type: "hello-ok",        │
     │         protocol: 3,             │
     │         server: {                │
     │           version: "2026.3.8",   │
     │           connId: "..."          │
     │         },                       │
     │         features: {              │
     │           methods: [...],        │
     │           events: [...]          │
     │         },                       │
     │         snapshot: { ... },       │
     │         auth: {                  │
     │           role: "owner",         │
     │           scopes: ["*"]          │
     │         },                       │
     │         policy: {                │
     │           tickIntervalMs: 30000  │
     │         }                        │
     │       }                          │
     │     }                            │
     │                                  │
     │◄═══ Connected (events flow) ═══►│
```

```typescript
// HelloOk response payload type
export interface HelloOk {
  type: 'hello-ok';
  /** Protocol version confirmed by server */
  protocol: number;
  /** Server metadata */
  server?: {
    version?: string;
    connId?: string;
  };
  /** Available methods and subscribable events */
  features?: {
    methods?: string[];
    events?: string[];
  };
  /** Initial state snapshot (sessions, presence, health) */
  snapshot?: unknown;
  /** Auth result */
  auth?: {
    deviceToken?: string;
    role?: string;
    scopes?: string[];
    issuedAtMs?: number;
  };
  /** Server-dictated policies */
  policy?: {
    tickIntervalMs?: number;
  };
}
```

### 4.4 Auth Modes

| Mode | When | Mechanism |
|------|------|-----------|
| `loopback` | Dashboard served from `127.0.0.1:28789` | No credentials needed. Gateway verifies source IP is loopback. Nonce echoed back to prove WS connection is real. |
| `device-token` | Remote/mobile clients | Device identity token from prior pairing. Not used by dashboard. |
| `session-key` | API integrations | Bearer-style session key. Not used by dashboard. |

For Research-Claw, the dashboard always uses `loopback` auth because the gateway binds exclusively to `127.0.0.1`. The `device-token` and `session-key` modes exist in the protocol but are not exercised.

### 4.5 Reconnection Strategy

When the WebSocket disconnects unexpectedly, the dashboard uses exponential backoff with jitter to reconnect.

```typescript
// Source: dashboard/src/gateway/reconnect.ts

export interface ReconnectConfig {
  /** First retry delay (default: 800ms) */
  initialDelayMs?: number;
  /** Maximum delay cap (default: 15000ms) */
  maxDelayMs?: number;
  /** Backoff multiplier (default: 1.7) */
  multiplier?: number;
}
```

**Backoff sequence** (milliseconds): 800 → 1360 → 2312 → 3930 → 6681 → 11358 → 15000 → 15000 → ...

**Reconnection rules:**
1. On unexpected close (code !== 1000, 1001): schedule reconnect
2. On auth failure (`UNAUTHORIZED`, `FORBIDDEN`): **do not reconnect** — show error
3. On successful reconnect: reset delay to 800ms, request fresh snapshot
4. On page visibility change (hidden → visible): attempt immediate reconnect if disconnected
5. Maximum reconnect attempts: unlimited (user must manually stop the gateway)

### 4.6 Chat Streaming

Chat messages are streamed via events, not request/response. The client sends a `chat.send` request and receives a stream of `chat.stream` events.

```typescript
// Chat stream event payload
export interface ChatStreamEvent {
  /** Unique run identifier */
  runId: string;
  /** Session this message belongs to */
  sessionKey: string;
  /** Stream state */
  state: 'delta' | 'final' | 'aborted' | 'error';
  /** Message content (incremental for delta, complete for final) */
  message?: ChatMessage;
  /** Error description (when state=error) */
  errorMessage?: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content?: Array<{
    type: string;       // "text", "image", "tool_use", "tool_result"
    text?: string;
    source?: unknown;   // Image source for type="image"
  }>;
  text?: string;        // Convenience: plain text content
  timestamp?: number;
}

export interface ChatAttachment {
  dataUrl: string;      // base64 data URL
  mimeType: string;     // e.g., "image/png"
}
```

### 4.7 Event Ordering and Delivery

- Events carry a monotonically increasing `seq` number per connection
- If the client detects a gap in `seq`, it should request a full state refresh via `state.snapshot`
- `stateVersion` on events enables delta sync: the client tracks `{ presence, health }` counters and only fetches full state when its version falls behind
- Events are fire-and-forget from the server perspective — no ACK required

---

## 5. RPC Method Inventory

### 5.1 OpenClaw Built-in Methods

Methods the dashboard calls from OpenClaw's standard gateway. Grouped by domain.

#### Session Management

| Method | Direction | Description |
|--------|-----------|-------------|
| `sessions.list` | req/res | List all sessions with metadata |
| `sessions.get` | req/res | Get single session by key |
| `sessions.create` | req/res | Create a new session |
| `sessions.delete` | req/res | Delete a session |
| `sessions.rename` | req/res | Rename a session |
| `sessions.archive` | req/res | Archive a session |
| `sessions.unarchive` | req/res | Restore an archived session |
| `sessions.export` | req/res | Export session as JSON/Markdown |

#### Chat

| Method | Direction | Description |
|--------|-----------|-------------|
| `chat.send` | req/res | Send user message (triggers agent run) |
| `chat.abort` | req/res | Abort current agent run |
| `chat.history` | req/res | Fetch message history for session |
| `chat.retry` | req/res | Retry last assistant message |
| `chat.edit` | req/res | Edit a user message and re-run |
| `chat.feedback` | req/res | Submit thumbs up/down on message |

#### Agent Control

| Method | Direction | Description |
|--------|-----------|-------------|
| `agent.status` | req/res | Get current agent status (idle/running/etc.) |
| `agent.interrupt` | req/res | Interrupt running agent gracefully |
| `agent.reset` | req/res | Reset agent state (clear context) |
| `agent.config` | req/res | Get/set agent configuration |

#### Exec Approvals

| Method | Direction | Description |
|--------|-----------|-------------|
| `exec.approve` | req/res | Approve a pending exec request |
| `exec.deny` | req/res | Deny a pending exec request |
| `exec.approve-always` | req/res | Approve and add to allowlist |
| `exec.pending` | req/res | List pending approval requests |

#### Skills

| Method | Direction | Description |
|--------|-----------|-------------|
| `skills.list` | req/res | List all loaded skills |
| `skills.get` | req/res | Get skill by ID with full content |
| `skills.search` | req/res | Search skills by name/tag/category |
| `skills.enable` | req/res | Enable a skill |
| `skills.disable` | req/res | Disable a skill |
| `skills.install` | req/res | Install a skill from registry |

#### Tools

| Method | Direction | Description |
|--------|-----------|-------------|
| `tools.list` | req/res | List all registered tools |
| `tools.get` | req/res | Get tool definition by name |

#### Config

| Method | Direction | Description |
|--------|-----------|-------------|
| `config.get` | req/res | Get configuration value by path |
| `config.set` | req/res | Set configuration value |
| `config.schema` | req/res | Get configuration schema |

#### Cron

| Method | Direction | Description |
|--------|-----------|-------------|
| `cron.list` | req/res | List cron jobs |
| `cron.get` | req/res | Get cron job by ID |
| `cron.create` | req/res | Create a cron job |
| `cron.update` | req/res | Update a cron job |
| `cron.delete` | req/res | Delete a cron job |
| `cron.trigger` | req/res | Manually trigger a cron job |
| `cron.history` | req/res | Get execution history for a cron job |

#### State

| Method | Direction | Description |
|--------|-----------|-------------|
| `state.snapshot` | req/res | Full state snapshot (sessions, presence, health) |
| `state.presence` | req/res | Get/set client presence |

#### System

| Method | Direction | Description |
|--------|-----------|-------------|
| `system.health` | req/res | Health check |
| `system.version` | req/res | Server version info |
| `system.shutdown` | req/res | Graceful shutdown |

#### Events (server → client, subscribe via `hello-ok` features)

| Event | Description |
|-------|-------------|
| `connect.challenge` | Handshake challenge |
| `chat.stream` | Chat message delta/final/aborted/error |
| `agent.status` | Agent state change |
| `exec.request` | New exec approval request |
| `exec.resolved` | Exec request approved/denied |
| `session.updated` | Session metadata changed |
| `session.deleted` | Session removed |
| `presence.update` | Client presence change |
| `health.update` | System health change |
| `cron.triggered` | Cron job fired |
| `skill.loaded` | New skill loaded |
| `config.changed` | Configuration changed |

### 5.2 Custom Research-Claw Methods (rc.*)

Registered by the `research-claw-core` plugin via `api.registerGatewayMethod()`. These extend the RPC surface for dashboard-specific functionality. **57 WS methods + 1 HTTP route = 58 total.**

#### rc.lit.* — Literature Library (26 methods)

| Method | Params | Returns | Description |
|--------|--------|---------|-------------|
| `rc.lit.list` | `{ read_status?, year?, source?, tags?, collection_id?, has_pdf?, offset?, limit?, sort? }` | `{ items: Paper[], total, offset, limit }` | List/filter papers |
| `rc.lit.get` | `{ id }` | `Paper` (enriched with reading_sessions, citing_count, cited_by_count) | Get paper by ID |
| `rc.lit.add` | `{ paper: PaperInput }` or flat params | `Paper` | Add paper to library |
| `rc.lit.update` | `{ id, patch: PaperPatch }` | `Paper` | Update paper fields |
| `rc.lit.delete` | `{ id }` | `{ ok: true }` | Delete paper |
| `rc.lit.status` | `{ id, status }` | `Paper` | Set read status |
| `rc.lit.rate` | `{ id, rating }` | `Paper` | Rate paper (1-5, 0 to clear) |
| `rc.lit.tags` | `{}` | `Tag[]` | All tags |
| `rc.lit.tag` | `{ paper_id, tag_name, color? }` | `{ paper_id, tags }` | Add tag to paper |
| `rc.lit.untag` | `{ paper_id, tag_name }` | `{ paper_id, tags }` | Remove tag from paper |
| `rc.lit.reading.start` | `{ paper_id }` | `ReadingSession` | Start reading session |
| `rc.lit.reading.end` | `{ session_id, notes?, pages_read? }` | `ReadingSession` | End reading session |
| `rc.lit.reading.list` | `{ paper_id }` | `ReadingSession[]` | List reading sessions for paper |
| `rc.lit.cite` | `{ citing_id, cited_id, context?, section? }` | `Citation` | Record citation relationship |
| `rc.lit.citations` | `{ paper_id, direction? }` | `{ citing, cited_by }` | Get citations |
| `rc.lit.search` | `{ query, limit?, offset? }` | `{ items, total }` | Full-text search (FTS5) |
| `rc.lit.duplicate_check` | `{ doi?, title?, arxiv_id? }` | `DuplicateResult` | Check for duplicate paper |
| `rc.lit.stats` | `{}` | `LibraryStats` | Library statistics |
| `rc.lit.batch_add` | `{ papers: PaperInput[] }` | `BatchResult` | Batch import papers |
| `rc.lit.import_bibtex` | `{ bibtex }` | `ImportResult` | Import from BibTeX |
| `rc.lit.export_bibtex` | `{ paper_ids?, tag?, collection?, all? }` | `{ bibtex, count }` | Export as BibTeX |
| `rc.lit.collections.list` | `{}` | `Collection[]` | List collections |
| `rc.lit.collections.manage` | `{ action, id?, name?, description?, color?, paper_ids? }` | `CollectionResult` | CRUD collections |
| `rc.lit.notes.list` | `{ paper_id }` | `Note[]` | List notes on paper |
| `rc.lit.notes.add` | `{ paper_id, content, page?, highlight? }` | `Note` | Add note to paper |
| `rc.lit.notes.delete` | `{ note_id }` | `{ ok: true }` | Delete note |

#### rc.task.* — Task System (11 methods)

| Method | Params | Returns | Description |
|--------|--------|---------|-------------|
| `rc.task.list` | `{ status?, priority?, task_type?, sort?, direction?, offset?, limit?, include_completed? }` | `{ items, total }` | List/filter tasks |
| `rc.task.get` | `{ id }` | `Task` (with activity_log, subtasks) | Get task by ID |
| `rc.task.create` | `{ task: TaskInput }` | `Task` | Create task |
| `rc.task.update` | `{ id, patch: TaskPatch }` | `Task` | Update task fields |
| `rc.task.complete` | `{ id, notes? }` | `Task` | Mark task as done |
| `rc.task.delete` | `{ id }` | `{ ok, deleted, id }` | Delete task |
| `rc.task.upcoming` | `{ hours? }` | `{ items, total, hours }` | Tasks due within N hours |
| `rc.task.overdue` | `{}` | `{ items, total }` | All overdue tasks |
| `rc.task.link` | `{ task_id, paper_id }` | `{ ok, linked, task_id, paper_id }` | Link task to paper |
| `rc.task.linkFile` | `{ task_id, file_path }` | `{ ok, linked, task_id, file_path }` | Link task to workspace file |
| `rc.task.notes.add` | `{ task_id, content }` | `ActivityLogEntry` | Append note to task |

#### rc.cron.presets.* — Cron Presets (7 methods)

| Method | Params | Returns | Description |
|--------|--------|---------|-------------|
| `rc.cron.presets.list` | `{}` | `{ presets }` | List all cron presets with state |
| `rc.cron.presets.activate` | `{ preset_id, config? }` | `Preset` | Activate a cron preset |
| `rc.cron.presets.deactivate` | `{ preset_id }` | `Preset` | Deactivate a cron preset |
| `rc.cron.presets.setJobId` | `{ preset_id, job_id }` | `Preset` | Store gateway cron job ID |
| `rc.cron.presets.delete` | `{ preset_id }` | `{ ok }` | Delete a cron preset from DB |
| `rc.cron.presets.restore` | `{ preset_id }` | `Preset` | Restore a deleted preset from PRESET_DEFINITIONS |
| `rc.cron.presets.updateSchedule` | `{ preset_id, schedule }` | `{ preset }` | Update cron schedule expression |

#### rc.ws.* — Workspace (11 methods)

| Method | Params | Returns | Description |
|--------|--------|---------|-------------|
| `rc.ws.tree` | `{ root?, depth? }` | `{ tree: TreeNode[] }` | Directory tree listing |
| `rc.ws.read` | `{ path }` | `FileContent` | Read a single file |
| `rc.ws.save` | `{ path, content, message? }` | `{ path, size, committed }` | Write file with optional auto-commit |
| `rc.ws.history` | `{ path?, limit?, offset? }` | `{ commits, total, has_more }` | Paginated git log |
| `rc.ws.diff` | `{ path?, from?, to? }` | `{ diff, files_changed, insertions, deletions }` | Git diff |
| `rc.ws.restore` | `{ path, commit }` | `{ path, restored_from, new_commit }` | Restore file to historical version |
| `rc.ws.delete` | `{ path }` | `{ ok }` | Delete a file from workspace |
| `rc.ws.saveImage` | `{ path, base64, mimeType? }` | `{ path, size }` | Save base64-encoded image |
| `rc.ws.openExternal` | `{ path }` | `{ ok }` | Open file with system default app |
| `rc.ws.openFolder` | `{ path }` | `{ ok }` | Open containing folder in file manager |
| `rc.ws.move` | `{ from, to }` | `{ from, to, committed }` | Move or rename file/directory |

#### rc.notifications.* — Notifications (2 methods)

| Method | Params | Returns | Description |
|--------|--------|---------|-------------|
| `rc.notifications.pending` | `{ hours? }` | `{ overdue, upcoming, custom, timestamp }` | Pending notifications for dashboard bell |
| `rc.notifications.markRead` | `{ id }` | `{ ok }` | Mark a notification as read |

---

## 6. Plugin SDK Contract

The Plugin SDK is OpenClaw's extension point. Plugins are loaded at gateway startup and receive an `api` object with registration methods. The following signatures are derived from OpenClaw's `src/plugins/types.ts`.

### 6.1 Plugin Entry Point

```typescript
import type { OpenClawPluginDefinition } from 'openclaw/plugin-sdk';

const plugin: OpenClawPluginDefinition = {
  id: 'research-claw-core',
  name: 'Research-Claw Core',
  description: 'Literature library, task management, workspace tracking',
  version: '0.4.1',

  async register(api: OpenClawPluginApi) {
    // All registrations happen here
  },
};

export default plugin;
```

### 6.2 Registration Methods

#### `api.registerTool(tool, opts?)`

Register an agent tool (callable by the LLM).

```typescript
api.registerTool(
  tool: AnyAgentTool | OpenClawPluginToolFactory,
  opts?: {
    /** Override tool name */
    name?: string;
    /** Tool category for grouping */
    category?: string;
    /** Require explicit allowlisting in config */
    requireAllowlist?: boolean;
  }
): void;

// AnyAgentTool shape:
interface AnyAgentTool {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  execute(input: unknown, ctx: ToolContext): Promise<ToolResult>;
}

// Factory variant (deferred construction):
type OpenClawPluginToolFactory = (api: OpenClawPluginApi) => AnyAgentTool | AnyAgentTool[];
```

#### `api.registerGatewayMethod(method, handler)`

Register a custom RPC method on the gateway WebSocket.

```typescript
api.registerGatewayMethod(
  method: string,              // e.g., "rc.lit.list"
  handler: GatewayRequestHandler
): void;

type GatewayRequestHandler = (
  params: unknown,
  ctx: GatewayRequestContext
) => Promise<unknown>;

interface GatewayRequestContext {
  connId: string;
  auth: { role: string; scopes: string[] };
  logger: Logger;
}
```

#### `api.registerHttpRoute(params)`

Register an HTTP route on the gateway's HTTP server (e.g., for file uploads).

```typescript
api.registerHttpRoute(params: {
  /** HTTP method */
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  /** URL path pattern (e.g., "/rc/upload") */
  path: string;
  /** Route handler */
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  /** Auth requirement */
  auth?: 'none' | 'loopback' | 'device-token' | 'session-key';
  /** Path matching mode */
  match?: 'exact' | 'prefix';
}): void;
```

#### `api.registerHook(events, handler, opts?)`

Register a handler for one or more lifecycle hooks.

```typescript
api.registerHook(
  events: HookName | HookName[],
  handler: HookHandler,
  opts?: {
    /** Execution priority (lower = earlier, default: 100) */
    priority?: number;
    /** Only run for specific session keys */
    sessionFilter?: string[];
  }
): void;

type HookHandler = (event: HookEvent, ctx: HookContext) => Promise<HookResult | void>;
```

**All 24 available hooks:**

| # | Hook Name | Phase | Description |
|---|-----------|-------|-------------|
| 1 | `before_model_resolve` | Pre-agent | Intercept/override model selection |
| 2 | `before_prompt_build` | Pre-agent | Inject context into system prompt |
| 3 | `before_agent_start` | Pre-agent | Modify agent config before run |
| 4 | `llm_input` | Agent | Inspect/modify LLM request |
| 5 | `llm_output` | Agent | Inspect/modify LLM response |
| 6 | `agent_end` | Post-agent | Run after agent completes |
| 7 | `before_compaction` | Memory | Before context window compaction |
| 8 | `after_compaction` | Memory | After compaction with summary |
| 9 | `before_reset` | Memory | Before agent state reset |
| 10 | `message_received` | Chat | Incoming user message |
| 11 | `message_sending` | Chat | Before assistant message is sent |
| 12 | `message_sent` | Chat | After assistant message delivered |
| 13 | `before_tool_call` | Tool | Intercept/modify tool invocation |
| 14 | `after_tool_call` | Tool | Inspect tool result |
| 15 | `tool_result_persist` | Tool | Before tool result is saved |
| 16 | `before_message_write` | Storage | Before message persisted to disk |
| 17 | `session_start` | Session | New session created/resumed |
| 18 | `session_end` | Session | Session ending |
| 19 | `subagent_spawning` | Subagent | Before spawning a subagent |
| 20 | `subagent_delivery_target` | Subagent | Resolve subagent message target |
| 21 | `subagent_spawned` | Subagent | After subagent started |
| 22 | `subagent_ended` | Subagent | After subagent completed |
| 23 | `gateway_start` | Lifecycle | Gateway server started |
| 24 | `gateway_stop` | Lifecycle | Gateway server stopping |

#### `api.registerService(service)`

Register a background service with lifecycle management.

```typescript
api.registerService(service: {
  /** Unique service ID */
  id: string;
  /** Called on gateway start */
  start: () => Promise<void>;
  /** Called on gateway stop (graceful shutdown) */
  stop: () => Promise<void>;
}): void;
```

#### `api.on(hookName, handler, opts?)`

Typed shorthand for registering a single hook. Functionally identical to `registerHook` with a single event.

```typescript
api.on(
  hookName: HookName,
  handler: HookHandler,
  opts?: { priority?: number; sessionFilter?: string[] }
): void;
```

#### `api.registerCommand(command)`

Register a bypass-LLM command (e.g., `/export`, `/backup`). Commands are invoked directly by the user and do not go through the agent.

```typescript
api.registerCommand(command: {
  /** Command name (e.g., "export") — invoked as /export */
  name: string;
  /** Short description for help text */
  description: string;
  /** Argument schema */
  argsSchema?: JsonSchema;
  /** Command handler */
  execute: (args: unknown, ctx: CommandContext) => Promise<CommandResult>;
}): void;
```

#### `api.registerChannel(registration)`

Register a channel plugin (e.g., Slack, Discord, email integration).

```typescript
api.registerChannel(registration: {
  /** Channel type ID */
  id: string;
  /** Display name */
  name: string;
  /** Channel factory */
  create: (config: unknown) => ChannelInstance;
}): void;
```

#### `api.registerCli(registrar, opts?)`

Extend the OpenClaw CLI with custom commands.

```typescript
api.registerCli(
  registrar: (cli: CliProgram) => void,
  opts?: {
    /** CLI group name */
    group?: string;
  }
): void;
```

#### `api.registerProvider(provider)`

Register a custom model provider (e.g., local Ollama, custom API).

```typescript
api.registerProvider(provider: {
  /** Provider ID */
  id: string;
  /** Display name */
  name: string;
  /** Model resolution */
  resolveModel: (modelId: string) => ModelConfig | null;
  /** Create chat completion */
  createCompletion: (params: CompletionParams) => AsyncIterable<CompletionChunk>;
}): void;
```

#### `api.registerContextEngine(id, factory)`

Register a custom context engine for advanced RAG or retrieval.

```typescript
api.registerContextEngine(
  id: string,
  factory: (config: unknown) => ContextEngine
): void;

interface ContextEngine {
  /** Retrieve relevant context for a query */
  retrieve(query: string, opts?: { limit?: number }): Promise<ContextChunk[]>;
  /** Index new content */
  index?(content: string, metadata?: Record<string, unknown>): Promise<void>;
}
```

### 6.3 Utility APIs Available on `api`

```typescript
interface OpenClawPluginApi {
  // --- Registration methods (above) ---

  /** Plugin-specific configuration from openclaw.json */
  readonly pluginConfig: unknown;

  /** Structured logger (plugin-scoped) */
  readonly logger: Logger;

  /** Resolve a path relative to the project root */
  resolvePath(relativePath: string): string;

  /** Read a file relative to the project root */
  readFile(relativePath: string): Promise<string>;

  /** Write a file relative to the project root */
  writeFile(relativePath: string, content: string): Promise<void>;

  /** Get the project root directory */
  readonly projectRoot: string;

  /** Get the OpenClaw data directory */
  readonly dataDir: string;
}
```

---

## 7. SQLite Strategy

### 7.1 Database Location

```
.research-claw/library.db        # Main database
.research-claw/library.db-wal    # WAL journal (auto-created)
.research-claw/library.db-shm    # Shared memory (auto-created)
```

The path is configured in `config/openclaw.json` at `plugins.entries.research-claw-core.config.dbPath` and resolved relative to the project root by the plugin via `api.resolvePath()`.

The `.research-claw/` directory is created automatically on first run. The `.gitignore` excludes `*.sqlite*` patterns to prevent committing database files.

### 7.2 Connection Configuration

```typescript
import Database from 'better-sqlite3';

function openDatabase(dbPath: string): Database.Database {
  const db = new Database(dbPath);

  // WAL mode: concurrent reads, non-blocking writes
  db.pragma('journal_mode = WAL');

  // Synchronous NORMAL: safe with WAL, better perf than FULL
  db.pragma('synchronous = NORMAL');

  // Foreign keys enforcement
  db.pragma('foreign_keys = ON');

  // 64MB cache (sufficient for academic libraries)
  db.pragma('cache_size = -65536');

  // Busy timeout: 5 seconds (agent and dashboard may contend)
  db.pragma('busy_timeout = 5000');

  return db;
}
```

### 7.3 Table Schema (all prefixed `rc_`)

> **Source of truth:** `extensions/research-claw-core/src/db/schema.ts`
> **15 regular tables + 1 FTS5 virtual table, 3 triggers, 23 indexes. (SCHEMA_VERSION 6)**
>
> **Obsolete tables from this section's earlier version** (removed):
> - ~~`rc_meta`~~ — replaced by `rc_schema_version`
> - ~~`rc_task_links`~~ — tasks link to papers directly via `rc_tasks.related_paper_id`
> - ~~`rc_workspace_versions`~~ — workspace uses git tracking, not DB (see 03c)

```sql
-- 1. Schema version tracking
CREATE TABLE IF NOT EXISTS rc_schema_version (
  version    INTEGER NOT NULL,
  applied_at TEXT    NOT NULL
);

-- 2. Paper metadata
CREATE TABLE IF NOT EXISTS rc_papers (
  id              TEXT PRIMARY KEY,
  title           TEXT NOT NULL,
  authors         TEXT NOT NULL DEFAULT '[]',   -- JSON array of strings
  abstract        TEXT,
  doi             TEXT UNIQUE,
  url             TEXT,
  arxiv_id        TEXT,
  pdf_path        TEXT,
  source          TEXT,                         -- 'semantic_scholar' | 'arxiv' | 'manual' | 'zotero' | 'crossref' | 'openalex'
  source_id       TEXT,                         -- ID in the source system
  venue           TEXT,
  year            INTEGER,
  added_at        TEXT NOT NULL,                -- ISO 8601
  updated_at      TEXT NOT NULL,                -- ISO 8601
  read_status     TEXT NOT NULL DEFAULT 'unread'
                    CHECK(read_status IN ('unread', 'reading', 'read', 'reviewed')),
  rating          INTEGER CHECK(rating IS NULL OR (rating BETWEEN 1 AND 5)),
  notes           TEXT,
  bibtex_key      TEXT,
  metadata        TEXT DEFAULT '{}'             -- JSON object for extensible fields
);

-- 3. Tag definitions
CREATE TABLE IF NOT EXISTS rc_tags (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  color      TEXT,                              -- hex color, e.g. '#EF4444'
  created_at TEXT NOT NULL
);

-- 4. Paper-tag junction
CREATE TABLE IF NOT EXISTS rc_paper_tags (
  paper_id TEXT NOT NULL REFERENCES rc_papers(id) ON DELETE CASCADE,
  tag_id   TEXT NOT NULL REFERENCES rc_tags(id)   ON DELETE CASCADE,
  PRIMARY KEY (paper_id, tag_id)
);

-- 5. Named paper collections
CREATE TABLE IF NOT EXISTS rc_collections (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  description TEXT,
  color       TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- 6. Collection-paper junction
CREATE TABLE IF NOT EXISTS rc_collection_papers (
  collection_id TEXT NOT NULL REFERENCES rc_collections(id) ON DELETE CASCADE,
  paper_id      TEXT NOT NULL REFERENCES rc_papers(id)      ON DELETE CASCADE,
  added_at      TEXT    NOT NULL,
  sort_order    INTEGER DEFAULT 0,
  PRIMARY KEY (collection_id, paper_id)
);

-- 7. Dynamic filter groups (saved queries)
CREATE TABLE IF NOT EXISTS rc_smart_groups (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  query_json TEXT NOT NULL,                     -- JSON: { filters, sort, fts_query }
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 8. Reading time tracking
CREATE TABLE IF NOT EXISTS rc_reading_sessions (
  id               TEXT PRIMARY KEY,
  paper_id         TEXT    NOT NULL REFERENCES rc_papers(id) ON DELETE CASCADE,
  started_at       TEXT    NOT NULL,
  ended_at         TEXT,
  duration_minutes INTEGER,                     -- computed on end, or NULL
  notes            TEXT,
  pages_read       INTEGER
);

-- 9. Inter-paper citation links
CREATE TABLE IF NOT EXISTS rc_citations (
  citing_paper_id TEXT NOT NULL REFERENCES rc_papers(id) ON DELETE CASCADE,
  cited_paper_id  TEXT NOT NULL REFERENCES rc_papers(id) ON DELETE CASCADE,
  context         TEXT,                         -- sentence containing the citation
  section         TEXT,                         -- section heading where citation appears
  PRIMARY KEY (citing_paper_id, cited_paper_id)
);

-- 10. Annotation notes on papers
CREATE TABLE IF NOT EXISTS rc_paper_notes (
  id         TEXT PRIMARY KEY,
  paper_id   TEXT NOT NULL REFERENCES rc_papers(id) ON DELETE CASCADE,
  content    TEXT NOT NULL,
  page       INTEGER,
  highlight  TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 11. Task items (deadline-sorted)
CREATE TABLE IF NOT EXISTS rc_tasks (
  id               TEXT PRIMARY KEY,
  title            TEXT NOT NULL,
  description      TEXT,
  task_type        TEXT NOT NULL CHECK(task_type IN ('human', 'agent', 'mixed')),
  status           TEXT NOT NULL DEFAULT 'todo'
                        CHECK(status IN ('todo', 'in_progress', 'blocked', 'done', 'cancelled')),
  priority         TEXT NOT NULL DEFAULT 'medium'
                        CHECK(priority IN ('urgent', 'high', 'medium', 'low')),
  deadline         TEXT,
  completed_at     TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  parent_task_id   TEXT REFERENCES rc_tasks(id)  ON DELETE SET NULL,
  related_paper_id TEXT REFERENCES rc_papers(id) ON DELETE SET NULL,
  agent_session_id TEXT,
  tags             TEXT,                        -- JSON array: '["writing","icml"]'
  notes            TEXT
);

-- 12. Task event tracking / audit log
CREATE TABLE IF NOT EXISTS rc_activity_log (
  id         TEXT PRIMARY KEY,
  task_id    TEXT NOT NULL REFERENCES rc_tasks(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  old_value  TEXT,
  new_value  TEXT,
  actor      TEXT NOT NULL CHECK(actor IN ('human', 'agent')),
  created_at TEXT NOT NULL
);

-- FTS5 virtual table (full-text search on papers)
CREATE VIRTUAL TABLE IF NOT EXISTS rc_papers_fts USING fts5(
  title, authors, abstract, notes,
  content='rc_papers', content_rowid='rowid'
);

-- 3 FTS sync triggers: rc_papers_fts_insert, rc_papers_fts_update, rc_papers_fts_delete
-- 23 indexes (see schema.ts for full list)
```

### 7.4 Migration System

Migrations are versioned integers stored in `rc_schema_version`. Each migration is a function that receives the `Database` instance.

```typescript
interface Migration {
  version: number;
  description: string;
  up(db: Database.Database): void;
}

const migrations: Migration[] = [
  { version: 1, description: 'Initial schema', up: createInitialSchema },
  // Future migrations added here
];

function runMigrations(db: Database.Database): void {
  db.exec('CREATE TABLE IF NOT EXISTS rc_schema_version (version INTEGER NOT NULL, applied_at TEXT NOT NULL)');
  const current = db.prepare('SELECT MAX(version) as v FROM rc_schema_version').get() as { v: number | null };
  const currentVersion = current?.v ?? 0;

  const pending = migrations.filter(m => m.version > currentVersion);
  if (pending.length === 0) return;

  const runAll = db.transaction(() => {
    for (const m of pending) {
      m.up(db);
      db.prepare('INSERT INTO rc_schema_version (version, applied_at) VALUES (?, ?)')
        .run(m.version, new Date().toISOString());
    }
  });

  runAll();
}
```

### 7.5 Backup

The `scripts/backup.sh` script creates timestamped copies of the database using SQLite's `.backup` API (via `VACUUM INTO`):

```bash
# Backup target: .research-claw/backups/library-YYYYMMDD-HHMMSS.db
sqlite3 .research-claw/library.db "VACUUM INTO '.research-claw/backups/library-$(date +%Y%m%d-%H%M%S).db'"
```

The backup is crash-safe even while the gateway is running (WAL mode ensures consistent snapshots).

---

## 8. State Management

The dashboard uses Zustand for all client-side state. Seven stores handle distinct domains, connected to the gateway via RPC and events.

### 8.1 Store Architecture

```
┌──────────────────────────────────────────────────────┐
│                     Dashboard                        │
│                                                      │
│  ┌──────────┐  ┌──────────┐  ┌──────────────────┐  │
│  │ gateway   │  │ chat     │  │ sessions         │  │
│  │ store     │  │ store    │  │ store            │  │
│  │           │  │          │  │                  │  │
│  │ state     │  │ messages │  │ list, active,    │  │
│  │ connId    │  │ runId    │  │ archived         │  │
│  │ hello     │  │ streaming│  │                  │  │
│  └─────┬─────┘  └────┬─────┘  └────────┬─────────┘  │
│        │             │                 │             │
│  ┌─────┴─────────────┴─────────────────┴──────────┐ │
│  │           GatewayClient (singleton)             │ │
│  │      ws://127.0.0.1:28789  WS RPC v3           │ │
│  └─────────────────────────────────────────────────┘ │
│        │             │                 │             │
│  ┌─────┴─────┐  ┌───┴──────┐  ┌──────┴──────────┐  │
│  │ library   │  │ tasks    │  │ config          │  │
│  │ store     │  │ store    │  │ store           │  │
│  │           │  │          │  │                 │  │
│  │ papers    │  │ list     │  │ assistantName   │  │
│  │ tags      │  │ overdue  │  │ theme           │  │
│  │ stats     │  │ upcoming │  │ locale          │  │
│  └───────────┘  └──────────┘  └─────────────────┘  │
│                                                      │
│  ┌───────────────────────────────────────────────┐  │
│  │ ui store                                      │  │
│  │ rightPanel, leftNavCollapsed, modals, toasts  │  │
│  └───────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────┘
```

### 8.2 Store Definitions

#### Gateway Store

```typescript
interface GatewayState {
  /** Current connection state */
  state: ConnectionState;
  /** Connection ID from hello-ok */
  connId: string | null;
  /** Server version from hello-ok */
  serverVersion: string | null;
  /** Available RPC methods */
  methods: string[];
  /** Available event subscriptions */
  events: string[];
  /** Last error message */
  error: string | null;

  // Actions
  connect(): void;
  disconnect(): void;
  setHello(hello: HelloOk): void;
  setState(state: ConnectionState): void;
  setError(error: string | null): void;
}
```

#### Chat Store

```typescript
interface ChatState {
  /** Messages in current session */
  messages: ChatMessage[];
  /** Active run ID (null when idle) */
  runId: string | null;
  /** Whether agent is streaming a response */
  streaming: boolean;
  /** Whether waiting for agent to start */
  loading: boolean;
  /** Accumulated delta text for current stream */
  pendingDelta: string;

  // Actions
  send(text: string, attachments?: ChatAttachment[]): Promise<void>;
  abort(): void;
  retry(): void;
  loadHistory(sessionKey: string): Promise<void>;
  appendDelta(text: string): void;
  finalizeMessage(message: ChatMessage): void;
  clearMessages(): void;
}
```

#### Sessions Store

```typescript
interface SessionsState {
  /** All sessions */
  sessions: SessionSummary[];
  /** Currently active session key */
  activeKey: string | null;
  /** Loading state */
  loading: boolean;

  // Actions
  fetch(): Promise<void>;
  create(name?: string): Promise<string>;
  select(key: string): void;
  rename(key: string, name: string): Promise<void>;
  remove(key: string): Promise<void>;
  archive(key: string): Promise<void>;
  unarchive(key: string): Promise<void>;
}

interface SessionSummary {
  key: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  archived: boolean;
}
```

#### Library Store

```typescript
interface LibraryState {
  /** Papers in current view */
  papers: Paper[];
  /** Total count (for pagination) */
  total: number;
  /** All unique tags */
  tags: string[];
  /** Library statistics */
  stats: LibraryStats | null;
  /** Loading state */
  loading: boolean;
  /** Current search/filter */
  query: string;
  /** Active tag filter */
  tagFilter: string[];
  /** Sort order */
  sort: 'added' | 'title' | 'year' | 'rating';

  // Actions
  fetch(opts?: { q?: string; tags?: string[]; sort?: string; offset?: number; limit?: number }): Promise<void>;
  fetchTags(): Promise<void>;
  fetchStats(): Promise<void>;
  setQuery(q: string): void;
  setTagFilter(tags: string[]): void;
  setSort(sort: string): void;
}
```

#### Tasks Store

```typescript
interface TasksState {
  /** Tasks in current view */
  tasks: Task[];
  /** Total count */
  total: number;
  /** Overdue tasks (for badge/alert) */
  overdue: Task[];
  /** Upcoming tasks within deadline window */
  upcoming: Task[];
  /** Loading state */
  loading: boolean;
  /** Active status filter */
  statusFilter: string | null;
  /** Active type filter */
  typeFilter: string | null;

  // Actions
  fetch(opts?: { status?: string; type?: string; sort?: string; offset?: number; limit?: number }): Promise<void>;
  fetchOverdue(): Promise<void>;
  fetchUpcoming(withinHours?: number): Promise<void>;
  setStatusFilter(status: string | null): void;
  setTypeFilter(type: string | null): void;
}
```

#### Config Store

```typescript
interface ConfigState {
  /** Assistant display name */
  assistantName: string;
  /** Current locale (en | zh-CN) */
  locale: string;
  /** Theme preference */
  theme: 'dark' | 'light' | 'system';
  /** Gateway configuration snapshot */
  gatewayConfig: Record<string, unknown>;

  // Actions
  fetchConfig(): Promise<void>;
  setLocale(locale: string): void;
  setTheme(theme: string): void;
  updateConfig(path: string, value: unknown): Promise<void>;
}
```

#### UI Store

```typescript
interface UiState {
  /** Active right panel tab */
  rightPanel: 'library' | 'tasks' | 'workspace' | 'skills' | 'config' | null;
  /** Whether left nav is collapsed */
  leftNavCollapsed: boolean;
  /** Right panel width (px) */
  rightPanelWidth: number;
  /** Active modal */
  activeModal: string | null;
  /** Toast queue */
  toasts: Toast[];

  // Actions
  setRightPanel(panel: string | null): void;
  toggleLeftNav(): void;
  setRightPanelWidth(width: number): void;
  showModal(id: string): void;
  hideModal(): void;
  addToast(toast: Omit<Toast, 'id'>): void;
  removeToast(id: string): void;
}
```

### 8.3 Store-Gateway Binding Pattern

Stores do not call the gateway directly. They use a shared `rpc` helper that wraps `GatewayClient.request()` with error handling and toast notifications:

```typescript
import { useGatewayStore } from './gateway';

async function rpc<T>(method: string, params?: unknown): Promise<T> {
  const client = useGatewayStore.getState().client;
  if (!client) throw new Error('Not connected');
  return client.request<T>(method, params);
}
```

Event subscriptions are set up in a single `useGatewayEvents()` hook at the App root level. Events are dispatched to the appropriate store via `zustand`'s `setState`:

```typescript
// Simplified pattern
client.onEvent('chat.stream', (payload) => {
  useChatStore.getState().handleStreamEvent(payload as ChatStreamEvent);
});
```

---

## 9. Build Pipeline

### 9.1 Full Build Sequence

```bash
pnpm install
# 1. Install all dependencies (root + workspace members)
# 2. pnpm automatically applies patches/openclaw@2026.3.8.patch
# 3. postinstall runs: pnpm run build

# Build step breakdown:
# pnpm build
#   ├── pnpm build:extensions    # tsc for each extension/*
#   │   ├── extensions/research-claw-core/  → dist/index.js
#   │   └── extensions/wentor-connect/      → dist/index.js
#   └── pnpm build:dashboard     # vite build
#       └── dashboard/           → dashboard/dist/
```

### 9.2 Dependency Graph

```
pnpm install
  └─► patch: openclaw@2026.3.8.patch applied to node_modules/openclaw/
      └─► postinstall: pnpm run build
          ├─► build:extensions (pnpm --filter ./extensions/* build)
          │   ├─► tsc (research-claw-core)
          │   │   Inputs:  extensions/research-claw-core/index.ts + src/**/*.ts
          │   │   Output:  extensions/research-claw-core/dist/
          │   │   Deps:    openclaw (types), better-sqlite3, @sinclair/typebox
          │   │
          │   └─► tsc (wentor-connect)
          │       Inputs:  extensions/wentor-connect/index.ts
          │       Output:  extensions/wentor-connect/dist/
          │       Deps:    openclaw (types)
          │
          └─► build:dashboard (pnpm --filter dashboard build)
              Inputs:  dashboard/src/**/*
              Output:  dashboard/dist/ (index.html + JS/CSS bundles)
              Deps:    react, antd, zustand, etc.
```

### 9.3 pnpm Workspace Configuration

```yaml
# pnpm-workspace.yaml
packages:
  - 'dashboard'
  - 'extensions/*'
```

### 9.4 TypeScript Project References

```jsonc
// tsconfig.json (root)
{
  "references": [
    { "path": "./dashboard" },
    { "path": "./extensions/research-claw-core" }
  ]
}
```

This enables `tsc --build` for incremental compilation across workspace members.

### 9.5 Production Artifact

After `pnpm install` completes, the production-ready artifacts are:

| Artifact | Location | Served by |
|----------|----------|-----------|
| Dashboard SPA | `dashboard/dist/` | Gateway HTTP (via `controlUi.root`) |
| Core plugin | `extensions/research-claw-core/dist/` | Gateway plugin loader (jiti) |
| Connect plugin | `extensions/wentor-connect/dist/` | Gateway plugin loader (jiti) |
| Gateway binary | `node_modules/openclaw/dist/entry.js` | Node.js |
| Research plugins | `node_modules/@wentorai/research-plugins/` | Skill loader |

---

## 10. Dev Workflow

### 10.1 Dual-Process Development

```bash
pnpm dev
# Runs via concurrently:
#   1. pnpm --filter dashboard dev   → Vite dev server on port 5175
#   2. pnpm start                     → OpenClaw gateway on port 28789
```

The Vite dev server on port 5175 proxies WebSocket connections to the gateway on port 28789:

```typescript
// dashboard/vite.config.ts
server: {
  port: 5175,
  proxy: {
    '/ws': {
      target: 'ws://127.0.0.1:28789',
      ws: true,
    },
    '/socket.io': {
      target: 'http://127.0.0.1:28789',
    },
  },
},
```

During development:
- **Dashboard changes**: Vite HMR applies instantly (no restart)
- **Plugin changes**: Requires gateway restart (`pnpm start`)
- **Config changes**: Requires gateway restart
- **Skill changes**: Hot-reloaded by OpenClaw (no restart)

### 10.2 Port Assignments

| Port | Process | Access |
|------|---------|--------|
| 5175 | Vite dev server (dashboard HMR) | `http://localhost:5175` |
| 28789 | OpenClaw gateway (WS RPC + production SPA) | `http://127.0.0.1:28789` |

In production, only port 28789 is used. The Vite dev server is not present.

### 10.3 Extension Development

For iterating on the `research-claw-core` plugin without restarting the gateway each time:

```bash
# Terminal 1: Watch-compile the plugin
cd extensions/research-claw-core
pnpm dev   # tsc --watch

# Terminal 2: Run gateway (auto-loads compiled plugin from dist/)
pnpm start

# After changing plugin code:
# 1. tsc --watch recompiles automatically
# 2. Restart gateway to pick up changes (Ctrl+C, pnpm start)
```

OpenClaw's jiti loader reads the compiled `dist/index.js` at startup. There is no hot-reload for plugins. Future improvement: add a gateway RPC method to reload plugins without full restart.

### 10.4 First-Run Setup

```bash
git clone https://github.com/wentorai/research-claw.git
cd research-claw
pnpm install          # Install deps + apply patch + build
pnpm setup            # Interactive: API provider, key, proxy → .env
pnpm start            # Gateway starts on 127.0.0.1:28789
```

The `pnpm setup` script (`scripts/setup.sh`) prompts for:
1. API provider (Anthropic / OpenAI / Other)
2. API key
3. HTTP proxy (optional, for network-restricted environments)
4. Creates `.env` and ensures `config/openclaw.json` exists

---

## 11. Test Strategy

### 11.1 Test Pyramid

```
    ┌───────────┐
    │   E2E     │  Playwright — 5-10 critical flows
    │  (slow)   │  Dashboard ↔ Gateway integration
    ├───────────┤
    │Integration│  vitest — Plugin ↔ SQLite ↔ RPC
    │  (medium) │  Real better-sqlite3 (in-memory)
    ├───────────┤
    │  Unit     │  vitest — Pure functions, store logic
    │  (fast)   │  Gateway client mock, no I/O
    └───────────┘
```

### 11.2 Unit Tests (vitest)

```bash
pnpm test          # Run all tests once
pnpm test:watch    # Watch mode
```

**Configuration:**

```typescript
// vitest config is inferred from vite.config.ts or root package.json
// Tests use vitest's built-in assertion library (expect)
// No global setup needed for unit tests
```

**Testing patterns:**

| Domain | Strategy | Example |
|--------|----------|---------|
| Gateway client | Mock WebSocket via `vitest.fn()` | Connection state machine, request correlation |
| Zustand stores | Direct store manipulation | `useChatStore.getState().send(...)` |
| RPC types | Type-level tests (compile-time) | Frame parsing, serialization |
| Plugin tools | In-memory SQLite | `new Database(':memory:')` |
| Migrations | Fresh DB per test | Run migrations, verify schema |

**In-memory SQLite for plugin tests:**

```typescript
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach } from 'vitest';

describe('Literature Tools', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
  });

  it('adds a paper to the library', () => {
    // Test tool logic against in-memory DB
  });
});
```

### 11.3 Integration Tests

Integration tests verify the plugin ↔ gateway RPC pipeline. They start a real gateway instance and connect via WebSocket.

```typescript
// test/integration/rpc-pipeline.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

describe('RPC Pipeline', () => {
  let gateway: ChildProcess;
  let client: GatewayClient;

  beforeAll(async () => {
    // Start gateway on a random port
    // Connect client
  });

  afterAll(async () => {
    // Disconnect client
    // Stop gateway
  });

  it('rc.lit.list returns empty library', async () => {
    const result = await client.request('rc.lit.list', {});
    expect(result).toEqual({ papers: [], total: 0 });
  });
});
```

### 11.4 E2E Tests (Playwright)

E2E tests verify critical user flows through the dashboard UI.

**Target flows:**
1. First-run setup wizard → dashboard loads
2. Create session → send message → receive response
3. Library panel → search papers → view detail
4. Task panel → create task → mark complete
5. Exec approval → approve → tool runs
6. Settings → change locale → UI updates
7. Reconnection → kill gateway → restart → dashboard reconnects

**Configuration:**

```typescript
// playwright.config.ts (future)
{
  webServer: [
    { command: 'pnpm start', port: 28789 },
  ],
  use: {
    baseURL: 'http://127.0.0.1:28789',
  },
}
```

### 11.5 Gateway Mock for Dashboard Tests

For testing dashboard components without a real gateway, a mock WebSocket server simulates the RPC protocol:

```typescript
// test/mocks/gateway-mock.ts
export class GatewayMock {
  private handlers = new Map<string, (params: unknown) => unknown>();

  /** Register a mock handler for an RPC method */
  onMethod(method: string, handler: (params: unknown) => unknown): void {
    this.handlers.set(method, handler);
  }

  /** Simulate an event push */
  pushEvent(event: string, payload: unknown): void {
    // Send EventFrame to all connected clients
  }
}
```

### 11.6 Test File Locations

| File | Type | Coverage |
|------|------|----------|
| `test/gateway-client.test.ts` | Unit | WS client connection, correlation, reconnect |
| `test/literature-tools.test.ts` | Unit | Paper CRUD, search, BibTeX export |
| `test/task-tools.test.ts` | Unit | Task CRUD, deadline logic, linking |
| `test/integration/*.test.ts` | Integration | End-to-end RPC pipeline (future) |
| `test/e2e/*.spec.ts` | E2E | Playwright browser tests (future) |

---

## 12. Security

### 12.1 Network Binding

The gateway binds exclusively to the loopback interface (`127.0.0.1:28789`). It is **not** accessible from the network. This is enforced by:

1. OpenClaw config: `"gateway.mode": "local"`
2. Node.js `server.listen('127.0.0.1', 28789)`
3. No reverse proxy, no tunnel, no port forwarding

**There is no authentication required for loopback connections.** The `loopback` auth mode in the handshake only verifies the source IP is `127.0.0.1` or `::1`. This is the same security model as VS Code's Language Server Protocol.

### 12.2 Human-in-Loop Approval

OpenClaw's exec approval system is active by default. When the agent wants to execute a shell command, file write, or external API call, the gateway emits an `exec.request` event. The dashboard shows an approval dialog. The user must explicitly approve or deny.

**Pre-approved tools** (via `config/openclaw.json` `tools.alsoAllow`):

All 18 Research-Claw tools are pre-approved because they operate on local data only:
- `library_add_paper`, `library_search`, `library_update_paper`, `library_get_paper`, `library_export_bibtex`, `library_reading_stats`
- `task_create`, `task_list`, `task_complete`, `task_update`, `task_link`, `task_note`
- `workspace_save`, `workspace_read`, `workspace_list`, `workspace_diff`, `workspace_history`, `workspace_restore`

Shell commands, file system operations, and network requests still require per-invocation approval unless the user adds them to `exec-approvals`.

### 12.3 API Key Management

| Secret | Storage | Access |
|--------|---------|--------|
| `ANTHROPIC_API_KEY` | `.env` (gitignored) | Read by OpenClaw at startup via `dotenv` |
| `OPENAI_API_KEY` | `.env` (gitignored) | Read by OpenClaw at startup via `dotenv` |
| `WENTOR_API_KEY` | `.env` (gitignored) | Future: Wentor platform sync |
| Proxy settings | `.env` (gitignored) | `HTTP_PROXY`, `HTTPS_PROXY` |

The `.env` file is:
- Listed in `.gitignore` (never committed)
- Created by `pnpm setup` with user-provided values
- Read-only by the Node.js process (no network exposure)

### 12.4 Database Security

The SQLite database at `.research-claw/library.db`:
- Is only accessible by the local user (filesystem permissions)
- Has no encryption at rest (acceptable for local-only data)
- Is not exposed via any network endpoint
- The HTTP route `POST /rc/upload` requires `loopback` auth

### 12.5 Dependency Security

- `openclaw` is pinned to exact version `2026.3.8` (no `^` or `~`)
- pnpm's lockfile (`pnpm-lock.yaml`) ensures reproducible installs
- `pnpm audit` should be run before each release
- The pnpm patch is version-locked and fails loudly on version mismatch

### 12.6 Threat Model Summary

| Threat | Mitigation | Residual Risk |
|--------|-----------|---------------|
| Remote access to gateway | Loopback binding only | None (unless user opens tunnel) |
| API key leak | `.env` gitignored, never in config files | User error (committing `.env`) |
| Malicious skill execution | Human-in-Loop approval for shell/network | User approves malicious command |
| SQLite injection | Parameterized queries via better-sqlite3 | None (library uses prepared statements) |
| Supply chain attack | Pinned versions, pnpm lockfile, audit | Zero-day in dependency |
| Stale dependency | `scripts/sync-upstream.sh` + test suite | Patch incompatibility |

---

## 13. Performance Budget

### 13.1 Dashboard

| Metric | Budget | Measurement |
|--------|--------|-------------|
| Initial JS bundle (gzip) | < 500 KB | `vite build` output, `dist/assets/*.js` |
| Initial CSS (gzip) | < 80 KB | `vite build` output, `dist/assets/*.css` |
| First Contentful Paint | < 1.5s | Lighthouse on `127.0.0.1:28789` |
| Time to Interactive | < 2.5s | Lighthouse on `127.0.0.1:28789` |
| WS connection established | < 200ms | Time from page load to `hello-ok` |
| Largest Contentful Paint | < 2.0s | Lighthouse |

**Bundle size strategy:**
- Ant Design tree-shaking (import individual components)
- `shiki` loaded async (not in main bundle)
- Route-based code splitting for right panel tabs
- No moment.js (Ant Design 5 uses dayjs)

### 13.2 WebSocket

| Metric | Budget | Notes |
|--------|--------|-------|
| Loopback round-trip (req → res) | < 50ms | Measured end-to-end including serialization |
| Chat delta delivery | < 30ms | Time from gateway event emission to DOM update |
| Reconnection (after drop) | < 2s | First backoff attempt (800ms) + handshake |
| Frame serialization | < 1ms | JSON.stringify / JSON.parse |
| Maximum concurrent subscriptions | 50 events | Per connection |

### 13.3 SQLite

| Metric | Budget | Notes |
|--------|--------|-------|
| Single-row read | < 1ms | `SELECT ... WHERE id = ?` with index |
| Paginated list (50 rows) | < 10ms | `SELECT ... LIMIT 50 OFFSET ...` |
| Full-text search (1000 papers) | < 50ms | `LIKE '%term%'` on title+abstract |
| Insert single paper | < 5ms | Including index maintenance |
| Migration (fresh schema) | < 100ms | Full `CREATE TABLE` sequence |
| Database size (1000 papers) | < 50 MB | Excluding downloaded PDFs |
| Backup (VACUUM INTO) | < 2s | For 50 MB database |

### 13.4 Monitoring

Performance is measured via:
1. **Build time**: `vite build` reports bundle sizes
2. **Runtime**: Browser DevTools Performance tab (local, manual)
3. **Gateway health**: `pnpm health` / `scripts/health.sh` (CPU, memory, WS connections, uptime)
4. **SQLite stats**: `PRAGMA page_count`, `PRAGMA page_size` for database size monitoring

---

## 14. pnpm Patch Scope

### 14.1 Overview

The pnpm patch modifies string literals in 7 files of the installed `openclaw` package. No logic, no control flow, no API surface is changed. The patch exists purely for branding: ensuring the user sees "Research-Claw" instead of "OpenClaw" in the CLI, process list, system prompt, and system services.

**Patch file:** `patches/openclaw@2026.3.8.patch`

### 14.2 Files Modified

| # | File | Change | Lines |
|---|------|--------|-------|
| 1 | `src/cli/index.ts` | CLI command name: `openclaw` → `research-claw` | 2 |
| 2 | `src/cli/version.ts` | Product name in `--version` output: `OpenClaw` → `Research-Claw` | 2 |
| 3 | `src/runtime.ts` | `process.title` set to `research-claw` instead of `openclaw` | 1 |
| 4 | `src/agents/system.ts` | Product name in default system prompt: `OpenClaw` → `Research-Claw` | 3 |
| 5 | `src/update/check.ts` | Update check URL pointed to Research-Claw release endpoint (or disabled) | 4 |
| 6 | `src/daemon/launchd.ts` | macOS launchd service label: `ai.openclaw.gateway` → `ai.wentor.research-claw` | 3 |
| 7 | `src/daemon/systemd.ts` | Linux systemd unit name: `openclaw-gateway` → `research-claw-gateway` | 3 |
| | **Total** | | **~18** |

### 14.3 Patch Application

pnpm applies the patch automatically during `pnpm install`. The patch is configured in `package.json`:

```json
{
  "pnpm": {
    "patchedDependencies": {
      "openclaw@2026.3.8": "patches/openclaw@2026.3.8.patch"
    }
  }
}
```

If the patch cannot be applied (e.g., after an OpenClaw version bump), `pnpm install` fails with a clear error. This is intentional — it forces the developer to regenerate the patch before proceeding.

### 14.4 Patch Regeneration

When updating OpenClaw to a new version:

```bash
# 1. Update the dependency
pnpm update openclaw

# 2. Create a temporary patching workspace
pnpm patch openclaw
# This opens the package in a temp directory for editing

# 3. Apply the same ~20 line changes to the new version
# (Refer to Section 14.2 for exact locations)

# 4. Commit the patch
pnpm patch-commit <temp-dir> --patch-dir patches
# This generates patches/openclaw@<new-version>.patch

# 5. Update package.json patchedDependencies key

# 6. Run tests
pnpm test

# 7. Commit
git add patches/ package.json
git commit -m "chore: update openclaw to <new-version> and regenerate branding patch"
```

Alternatively, `scripts/apply-branding.sh` automates steps 2-4.

### 14.5 Patch Verification

After installation, verify the patch was applied:

```bash
# Check CLI name
node ./node_modules/openclaw/dist/entry.js --version
# Should output: Research-Claw <version>

# Check process title
node -e "
  require('./node_modules/openclaw/dist/runtime.js');
  console.log(process.title);
"
# Should output: research-claw

# Check system prompt contains Research-Claw
grep -r 'Research-Claw' node_modules/openclaw/dist/agents/
# Should find matches
```

### 14.6 What the Patch Does NOT Change

The patch intentionally avoids:
- Any runtime logic or control flow
- Any API surface (WS RPC methods, Plugin SDK, etc.)
- Any dependency or import paths
- Any test files
- The license file or attribution
- Any configuration schema or defaults

This constraint ensures that Research-Claw remains a true satellite: functionally identical to OpenClaw, with only cosmetic branding differences.

---

## Appendix A: Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | Yes (or OpenAI) | — | Anthropic Claude API key |
| `OPENAI_API_KEY` | Yes (or Anthropic) | — | OpenAI GPT API key |
| `HTTP_PROXY` | No | — | HTTP proxy URL |
| `HTTPS_PROXY` | No | — | HTTPS proxy URL |
| `WENTOR_API_KEY` | No | — | Future: Wentor platform API key |
| `WENTOR_API_URL` | No | `https://wentor.ai/api/v1` | Future: Wentor platform endpoint |
| `NODE_ENV` | No | `development` | Node.js environment |

## Appendix B: Version Compatibility Matrix

| Component | Minimum | Recommended | Maximum |
|-----------|---------|-------------|---------|
| Node.js | 22.12.0 | 22.x LTS | — |
| pnpm | 9.0.0 | 9.15.0 | — |
| OpenClaw | 2026.3.8 | 2026.3.8 | 2026.3.x (patch only) |
| TypeScript | 5.7.0 | 5.7.x | — |
| React | 18.3.0 | 18.3.x | 18.x |
| Ant Design | 5.23.0 | 5.23.x | 5.x |
| Vite | 6.0.0 | 6.x | — |
| better-sqlite3 | 11.7.0 | 11.x | — |
| Zustand | 5.0.0 | 5.x | — |

## Appendix C: Glossary

| Term | Definition |
|------|------------|
| **Gateway** | OpenClaw's Node.js server process; hosts WS RPC, plugin runtime, and HTTP server |
| **Agent** | The LLM-powered assistant that executes tasks, calls tools, and responds to chat |
| **Satellite** | A downstream project that uses OpenClaw as an npm dependency with custom config and plugins |
| **Skill** | A SKILL.md file with YAML frontmatter that provides domain knowledge to the agent |
| **Plugin** | A TypeScript package that extends OpenClaw via the Plugin SDK (tools, RPC, hooks) |
| **Session** | A conversation thread with history, context, and state |
| **Run** | A single agent invocation within a session (user message → agent response) |
| **Exec approval** | User confirmation required before the agent can execute shell commands or external calls |
| **Bootstrap files** | AGENTS.md, SOUL.md, HEARTBEAT.md, etc. — loaded at agent startup to define persona and behavior |
| **Control UI** | The dashboard SPA served by the gateway's HTTP server |
| **pnpm patch** | A diff file applied to an npm dependency at install time, used for branding |

---

*Document C2 — Research-Claw Engineering Architecture*
*Cross-references: [C0 Reference Map](./00-reference-map.md) | [C5 Plugin SDK](./modules/05-plugin-sdk.md) | [C3e Dashboard](./modules/03e-dashboard-ui.md)*

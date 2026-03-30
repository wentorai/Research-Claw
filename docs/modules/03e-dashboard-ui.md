# 03e — Dashboard UI Engineering Spec

> Research-Claw Dashboard — React 18 + Vite + Ant Design 5
> Based on OpenClaw gateway WS RPC v3 protocol (commit 62d5df28d, version 2026.3.8)

---

## Table of Contents

1. [Tech Stack Rationale](#1-tech-stack-rationale)
2. [GatewayClient Class Spec](#2-gatewayclient-class-spec)
3. [React Hooks](#3-react-hooks)
4. [Zustand Stores](#4-zustand-stores)
5. [Component Tree](#5-component-tree)
6. [Data Flow](#6-data-flow)
7. [Streaming Message Handling](#7-streaming-message-handling)
8. [Responsive Layout](#8-responsive-layout)
9. [Theme System](#9-theme-system)
10. [Internationalization](#10-internationalization)
11. [Build & Deployment](#11-build--deployment)
12. [Performance](#12-performance)

---

## 1. Tech Stack Rationale

| Layer | Choice | Why |
|:------|:-------|:----|
| UI Framework | React 18 | Team expertise (Web Platform uses React), ecosystem maturity |
| Build Tool | Vite 6+ | Fast HMR, ESM-native, simple config |
| Component Library | Ant Design 5 | Comprehensive components, dark theme support, antd-style for CSS-in-JS |
| Styling | antd-style + CSS custom properties | Design token sharing with Web Platform, theme switching |
| State Management | Zustand 5 | Lightweight, TypeScript-first, no boilerplate |
| Markdown | react-markdown + remark-gfm | Standard Markdown rendering with GitHub-flavored extensions |
| Syntax Highlighting | Shiki | Accurate highlighting, theme-aware, lazy-loadable |
| i18n | react-i18next + i18next | Industry standard, JSON resources, namespace support |

### Why NOT Lit (OpenClaw's choice)

OpenClaw's built-in UI uses Lit web components. We chose React because:
- Our Web Platform team already uses React — shared knowledge, shared components
- Ant Design 5 provides a complete dark-theme component set out of the box
- Design tokens from `docs/FRONTEND_DESIGN_SYSTEM.md` (HashMind) are CSS custom properties — framework-agnostic
- React's ecosystem for markdown rendering, virtual scrolling, and i18n is more mature

### Why NOT UmiJS (Web Platform's choice)

The Web Platform uses UmiJS Max for its multi-page app with routing, SSR hints, and proxy config. The dashboard is a local SPA with exactly 2 views (Setup Wizard + Workbench) — UmiJS would be overkill. Vite provides everything needed.

---

## 2. GatewayClient Class Spec

Based on OpenClaw's `GatewayBrowserClient` (ui/src/ui/gateway.ts, 470 lines).

### 2.1 Class Interface

```typescript
import type {
  ConnectionState,
  RequestFrame,
  ResponseFrame,
  EventFrame,
  HelloOk,
  GatewayErrorInfo,
  BootstrapConfig,
} from './types';

interface GatewayClientOptions {
  url: string;                              // ws://127.0.0.1:28789
  token?: string;                           // Optional auth token
  clientName?: string;                      // "research-claw-dashboard"
  clientVersion?: string;                   // "0.1.0"
  platform?: string;                        // "browser"
  onHello?: (hello: HelloOk) => void;
  onEvent?: (event: EventFrame) => void;
  onClose?: (code: number, reason: string) => void;
  onStateChange?: (state: ConnectionState) => void;
  onGap?: (expected: number, actual: number) => void;
}

class GatewayClient {
  // --- Lifecycle ---
  constructor(opts: GatewayClientOptions);
  connect(): void;
  disconnect(): void;

  // --- RPC ---
  request<T = unknown>(method: string, params?: unknown): Promise<T>;

  // --- Events ---
  subscribe(event: string, handler: (payload: unknown) => void): () => void;

  // --- State ---
  get connectionState(): ConnectionState;
  get isConnected(): boolean;
}
```

### 2.2 Connection State Machine

```
disconnected ──→ connecting ──→ authenticating ──→ connected
     ▲                                                │
     │                                                ▼
     └─────────────── reconnecting ◄──────────────────┘
                          │                    (on close/error)
                          │
                    (non-recoverable
                     auth error)
                          │
                          ▼
                     disconnected
```

### 2.3 Handshake Sequence

```
Browser                              Gateway
  │                                     │
  │──── WebSocket OPEN ────────────────→│
  │                                     │
  │◄─── event: connect.challenge ───────│
  │     { nonce: "abc123..." }          │
  │                                     │
  │──── req: connect ──────────────────→│
  │     {                               │
  │       minProtocol: 3,               │
  │       maxProtocol: 3,               │
  │       client: {                     │
  │         id: "openclaw-control-ui",  │
  │         version: "0.4.1",           │
  │         platform: "browser",        │
  │         mode: "ui",                 │
  │         displayName: "Research-Claw Dashboard"
  │       },                            │
  │       role: "operator",             │
  │       scopes: ["operator.read",     │
  │         "operator.write",           │
  │         "operator.admin"],          │
  │       auth: { token: "..." },       │
  │       device: { id, publicKey,      │
  │         signature, signedAt, nonce }│
  │     }                               │
  │                                     │
  │◄─── hello-ok ──────────────────────│
  │     {                               │
  │       protocol: 3,                  │
  │       server: { version, connId },  │
  │       features: { methods, events },│
  │       snapshot: { ... }             │
  │     }                               │
  │                                     │
  │  ═══ Connected ═══════════════════  │
```

**Device Identity Authentication:** The dashboard uses Ed25519 device-identity signing
(`device-identity.ts`) to authenticate with the gateway. On first run, a keypair is
generated and persisted locally. During the handshake, the `connect` request payload is
signed with the private key; the gateway verifies the signature against the stored
public key as part of the v3 protocol hello sequence.

### 2.4 Token Resolution (v0.6.0)

```
getGatewayToken():
  URL param ?token=xxx   →  最高优先级（needs_token 页提交后附带）
  localStorage 'rc-gateway-token'  →  远程用户持久化（连接成功时写入）
  DEFAULT_TOKEN 'research-claw'    →  本地部署零配置匹配
```

**连接成功时**: 若 token ≠ DEFAULT_TOKEN → 写入 localStorage（远程用户后续免输入）。
**进入 needs_token 时**: 清除 localStorage（防止过期 token 循环失败）。

### 2.5 onConnectError → needs_token 路由

```typescript
// stores/gateway.ts
if (code === 'NOT_PAIRED' || code === 'UNAUTHORIZED' || code === 'INVALID_REQUEST') {
  useConfigStore.getState().setBootState('needs_token');
}
```

OC gateway connect 握手只返回 `INVALID_REQUEST` 和 `NOT_PAIRED` 作为 auth 失败的 top-level code。
所有 `INVALID_REQUEST` 统一路由到 `needs_token`（有引导），而非 `gateway_unreachable`（仅重试按钮）。

### 2.6 needs_token 页面

| 区域 | 内容 |
|------|------|
| 标题 | "需要网关令牌" + error code/message |
| 输入 | 密码框 + 连接按钮 |
| 快捷 | "使用默认令牌 (research-claw) 连接" 链接 |
| 引导 | 如何找到令牌（3 步文本） |
| 恢复 | 3 套可复制命令：Docker / pnpm serve / WSL2 systemd |

调试入口: 浏览器控制台 `__resetToken()` 可强制显示此页面。

### 2.7 Reconnection Strategy

- **Algorithm:** Exponential backoff
- **Initial delay:** 800ms
- **Max delay:** 15,000ms (15s)
- **Multiplier:** 1.7x
- **Reset:** On successful `hello-ok`
- **Stop conditions:** Non-recoverable auth errors (token mismatch, device identity required)

### 2.5 Request/Response Correlation

```typescript
// Internal pending map
private pending = new Map<string, {
  resolve: (payload: unknown) => void;
  reject: (error: GatewayRequestError) => void;
  timer: ReturnType<typeof setTimeout>;
}>();

// Request timeout: 30 seconds default
private readonly REQUEST_TIMEOUT_MS = 30_000;
```

Each request generates a UUID, stores resolve/reject in the map, and sets a timeout. When a `res` frame arrives, the matching pending entry is resolved or rejected.

### 2.6 Event Sequence Tracking

```typescript
private lastSeq = 0;

private handleEvent(frame: EventFrame): void {
  if (frame.seq !== undefined) {
    if (frame.seq > this.lastSeq + 1) {
      this.opts.onGap?.(this.lastSeq + 1, frame.seq);
    }
    this.lastSeq = frame.seq;
  }
  // Route to subscribers
  this.eventHandlers.get(frame.event)?.forEach(h => h(frame.payload));
  this.opts.onEvent?.(frame);
}
```

### 2.7 Bootstrap Config Fetch

Before connecting WebSocket, fetch server config:

```typescript
async function fetchBootstrapConfig(baseUrl: string): Promise<BootstrapConfig> {
  const res = await fetch(`${baseUrl}/socket.io/config.json`);
  return res.json();
}
```

Returns: `{ basePath, assistantName, assistantAvatar, assistantAgentId, serverVersion }`

---

## 3. React Hooks

### 3.1 useGateway

```typescript
function useGateway(): {
  client: GatewayClient | null;
  state: ConnectionState;
  serverVersion: string | null;
  connect: (url?: string) => void;
  disconnect: () => void;
}
```

- Manages singleton `GatewayClient` instance
- Auto-connects on mount if setup is complete
- Stores connection state in `gatewayStore`

### 3.2 useRpc

```typescript
function useRpc<T>(
  method: string,
  params?: unknown,
  deps?: unknown[],
): {
  data: T | null;
  loading: boolean;
  error: string | null;
  refetch: () => void;
}
```

- Calls `client.request()` on mount and when deps change
- Returns cached data, loading state, and error
- `refetch()` forces a new request

### 3.3 useEvent

```typescript
function useEvent(
  eventName: string,
  handler: (payload: unknown) => void,
): void
```

- Subscribes to gateway event on mount
- Unsubscribes on unmount or handler change
- Uses `useEffect` + `useCallback` for stability

### 3.4 useChat

```typescript
function useChat(): {
  messages: ChatMessage[];
  send: (text: string, attachments?: ChatAttachment[]) => Promise<void>;
  abort: () => void;
  loading: boolean;
  streaming: boolean;
  streamText: string | null;
  error: string | null;
}
```

- Reads from `chatStore`
- `send()` appends user message, calls `chat.send` RPC, tracks `runId`
- `abort()` calls `chat.abort` RPC
- Subscribes to `chat.message` events for streaming updates

---

## 4. Zustand Stores

### 4.1 Gateway Store

```typescript
interface GatewayState {
  client: GatewayClient | null;
  state: ConnectionState;
  serverVersion: string | null;
  assistantName: string;
  connId: string | null;

  // Actions
  connect: (url: string, token?: string) => void;
  disconnect: () => void;
  setServerInfo: (hello: HelloOk) => void;
}
```

### 4.2 Chat Store

```typescript
interface ChatState {
  messages: ChatMessage[];
  sending: boolean;
  streaming: boolean;
  streamText: string | null;
  runId: string | null;
  sessionKey: string;
  thinkingLevel: string | null;
  lastError: string | null;

  // Actions
  send: (text: string, attachments?: ChatAttachment[]) => Promise<void>;
  abort: () => void;
  loadHistory: () => Promise<void>;
  handleChatEvent: (event: ChatStreamEvent) => void;
  setSessionKey: (key: string) => void;
  clearError: () => void;
}
```

**Chat event handling state machine:**

| Current State | Event | Action |
|:---|:---|:---|
| idle | `send()` called | Append user msg, set `sending=true`, call RPC |
| sending | RPC response | Set `runId`, `sending=false` |
| streaming | `delta` (same runId) | Append to `streamText` |
| streaming | `final` (same runId) | Commit msg to `messages`, clear stream state |
| streaming | `aborted` (same runId) | Commit partial, clear stream state |
| streaming | `error` (same runId) | Set `lastError`, clear stream state |
| any | `final` (different runId) | Append to `messages` (sub-agent announcement) |

### 4.3 Sessions Store

OpenClaw session model: keys are colon-delimited (`agent:{agentId}:{rest}`), default is `"main"` → canonicalized to `"agent:main:main"`. Sessions are implicit — created on first `chat.send` with a new `sessionKey`. Main session cannot be deleted.

```typescript
export const MAIN_SESSION_KEY = 'main';

interface SessionsState {
  sessions: Session[];
  activeSessionKey: string;  // persisted in localStorage('rc_active_session')
  loading: boolean;

  loadSessions: () => Promise<void>;     // sessions.list RPC
  switchSession: (key: string) => void;  // sets key + syncs chat store + loadHistory
  createSession: () => Promise<string>;  // generates project-{uuid8}, adds local placeholder
  deleteSession: (key: string) => Promise<void>;  // sessions.delete RPC, main protected
  renameSession: (key: string, label: string) => Promise<void>; // sessions.patch RPC
  isMainSession: (key: string) => boolean;  // checks 'main' and 'agent:main:main'
}

interface Session {
  key: string;
  label?: string;
  displayName?: string;
  derivedTitle?: string;
  updatedAt?: number;
  sessionId?: string;
  kind?: string;
}
```

Key behaviors:
- `switchSession` calls `useChatStore.setSessionKey()` + `loadHistory()` to refresh chat view
- `createSession` adds a local placeholder session so it appears in the dropdown immediately (before first message creates it on the server)
- `loadHistory` includes a stale-response guard: if `sessionKey` changed during the async request, the response is discarded
- `deleteSession` falls back to `MAIN_SESSION_KEY` if the deleted session was active
- Active session key persisted via `localStorage('rc_active_session')`, restored on page load

### 4.4 Library Store

```typescript
interface LibraryState {
  papers: Paper[];
  tags: Tag[];
  loading: boolean;
  total: number;
  searchQuery: string;
  activeTab: 'pending' | 'saved';
  filters: PaperFilter;

  loadPapers: (filter?: PaperFilter) => Promise<void>;
  loadTags: () => Promise<void>;
  setSearchQuery: (q: string) => void;
  setActiveTab: (tab: 'pending' | 'saved') => void;
  updatePaperStatus: (id: string, status: ReadStatus) => Promise<void>;
  ratePaper: (id: string, rating: number) => Promise<void>;
}

interface PaperFilter {
  status?: ReadStatus;
  tags?: string[];
  yearMin?: number;
  yearMax?: number;
  sort?: 'added_at' | 'year' | 'title';
}

type ReadStatus = 'unread' | 'reading' | 'read' | 'reviewed';
```

### 4.5 Tasks Store

```typescript
interface TasksState {
  tasks: Task[];
  loading: boolean;
  total: number;
  perspective: 'all' | 'human' | 'agent';
  showCompleted: boolean;
  sortBy: 'deadline' | 'priority' | 'created_at';

  loadTasks: () => Promise<void>;
  setPerspective: (p: 'all' | 'human' | 'agent') => void;
  toggleCompleted: () => void;
  completeTask: (id: string) => Promise<void>;
  createTask: (input: TaskInput) => Promise<void>;
}
```

### 4.6 Config Store

```typescript
type BootState = 'pending' | 'ready' | 'needs_setup' | 'gateway_unreachable' | 'needs_token';

interface ConfigState {
  theme: 'dark' | 'light';
  locale: 'en' | 'zh-CN';
  systemPromptAppend: string;
  bootState: BootState;

  /** Live config from gateway (via config.get RPC) */
  gatewayConfig: GatewayConfig | null;
  gatewayConfigLoading: boolean;

  setTheme: (t: 'dark' | 'light') => void;
  setLocale: (l: 'en' | 'zh-CN') => void;
  setSystemPromptAppend: (v: string) => void;
  loadConfig: () => void;
  loadGatewayConfig: () => Promise<void>;
  evaluateConfig: () => void;
  setBootState: (s: BootState) => void;
}
```

### 4.7 UI Store

```typescript
interface UiState {
  rightPanelTab: PanelTab;
  rightPanelOpen: boolean;
  rightPanelWidth: number;
  leftNavCollapsed: boolean;
  agentStatus: string;
  notifications: Notification[];
  unreadCount: number;
  workspaceRefreshKey: number;       // Monotonic counter — incremented after each chat turn to trigger WorkspacePanel reload
  pendingPreviewPath: string | null; // FileCard sets this to request file preview in WorkspacePanel

  setRightPanelTab: (tab: PanelTab) => void;
  toggleRightPanel: () => void;
  setRightPanelWidth: (w: number) => void;
  setLeftNavCollapsed: (v: boolean) => void;
  addNotification: (n: Notification) => void;
  markNotificationRead: (id: string) => void;
  markAllNotificationsRead: () => void;
  clearNotifications: () => void;
  triggerWorkspaceRefresh: () => void;           // Increments workspaceRefreshKey
  requestWorkspacePreview: (path: string) => void; // Sets pendingPreviewPath + opens workspace panel
  clearPendingPreview: () => void;               // Resets pendingPreviewPath to null
}

type PanelTab = 'library' | 'workspace' | 'tasks' | 'monitor' | 'settings';

interface Notification {
  id: string;
  type: 'deadline' | 'heartbeat' | 'system' | 'error';
  title: string;
  body?: string;           // May contain markdown (rendered via ReactMarkdown in bell panel + toast)
  timestamp: string;       // Set once at creation (new Date().toISOString()), immutable thereafter
  read: boolean;
  chatMessageId?: string;  // Link to chat message
  dedupKey?: string;       // Stable key for deduplication — same dedupKey won't create a second notification
  targetSessionKey?: string; // Session key to navigate to when clicked (Layer 2, #33)
}

// Notifications are persisted to localStorage ('rc-notifications') and sorted by timestamp descending.
// Read state is separately persisted via 'rc-read-dedup-keys' for cross-refresh dedup.
```

### 4.8 Cron Store

```typescript
interface CronState {
  presets: CronPreset[];
  loading: boolean;

  loadPresets: () => Promise<void>;
  activatePreset: (presetId: string) => Promise<void>;
  deactivatePreset: (presetId: string) => Promise<void>;
}
```

### 4.9 Monitor Store

```typescript
interface MonitorState {
  monitors: Monitor[];
  loading: boolean;

  loadMonitors: () => Promise<void>;
  createMonitor: (config: MonitorConfig) => Promise<void>;
  updateMonitor: (id: string, patch: Partial<MonitorConfig>) => Promise<void>;
  deleteMonitor: (id: string) => Promise<void>;
  runMonitor: (id: string) => Promise<void>;
}
```

---

## 5. Component Tree

```
App
├── ConfigProvider (Ant Design theme: dark/light)
├── I18nextProvider
│
├── [if !setupComplete]
│   └── SetupWizard
│       ├── ProviderSelector { onSelect }
│       ├── ApiKeyInput { provider, onSubmit }
│       └── StartButton { onClick }
│
└── [if setupComplete]
    └── Workbench
        ├── TopBar ─────────────────────── grid-area: topbar
        │   ├── Logo { emoji: 🦞, text: t('app.name') }
        │   ├── Spacer
        │   ├── NotificationBell { count, onClick }
        │   ├── AgentStatusDot { state: ConnectionState }
        │   ├── LangToggle { EN | 中, onClick: setLocale }
        │   └── ThemeToggle { Sun/Moon SVG, onClick: setTheme }
        │
        ├── LeftNav ────────────────────── grid-area: leftnav
        │   ├── ProjectSwitcher
        │   │   └── Dropdown { projects[], active, onSwitch }
        │   └── FunctionRail
        │       ├── RailIcon { icon: Book, tab: 'library', active }
        │       ├── RailIcon { icon: Folder, tab: 'workspace', active }
        │       ├── RailIcon { icon: CheckSquare, tab: 'tasks', active }
        │       ├── RailIcon { icon: Monitor, tab: 'monitor', active }
        │       └── RailIcon { icon: Settings, tab: 'settings', active }
        │
        ├── ChatView ───────────────────── grid-area: chat
        │   ├── MessageList
        │   │   └── MessageBubble { message, isStreaming? }
        │   │       ├── [text content] → react-markdown + remark-gfm
        │   │       ├── [paper_card] → PaperCard component
        │   │       ├── [task_card] → TaskCard component
        │   │       ├── [progress_card] → ProgressCard component
        │   │       ├── [approval_card] → ApprovalCard component
        │   │       ├── [monitor_digest] → MonitorDigest component
        │   │       ├── [file_card] → FileCard component
        │   │       └── [code_block] → Shiki highlighted + copy/save
        │   ├── StreamingIndicator { text, visible } (deferred)
        │   └── MessageInput
        │       ├── TextArea { value, onChange, onKeyDown }
        │       ├── SlashCommandMenu { query, onSelect } (deferred)
        │       ├── AttachButton { onFiles } (deferred)
        │       └── SendButton { onClick, disabled }
        │
        ├── RightPanel ─────────────────── grid-area: rightpanel
        │   ├── PanelHeader { tab, onClose }
        │   ├── [tab === 'library']
        │   │   └── LibraryPanel (React.lazy)
        │   │       ├── TabBar { 'pending' | 'saved' }
        │   │       ├── SearchBar { query, onSearch }
        │   │       ├── TagFilter { tags, selected, onToggle }
        │   │       └── PaperList { papers, onAction }
        │   ├── [tab === 'workspace']
        │   │   └── WorkspacePanel (React.lazy)
        │   │       ├── FileTree { nodes, onSelect }
        │   │       ├── UploadDropzone { onUpload }
        │   │       └── RecentChanges { commits }
        │   ├── [tab === 'tasks']
        │   │   └── TaskPanel (React.lazy)
        │   │       ├── PerspectiveToggle { 'all' | 'human' | 'agent' }
        │   │       ├── TaskList { tasks, sortBy: 'deadline' }
        │   │       │   └── TaskRow { task, onComplete, onEdit }
        │   │       └── CompletedFold { tasks, expanded }
        │   ├── [tab === 'monitor']
        │   │   └── MonitorPanel (React.lazy)
        │   │       ├── MonitorList { monitors, onToggle, onEdit }
        │   │       ├── MonitorCreate { onSubmit }
        │   │       └── MonitorHistory { results }
        │   └── [tab === 'settings']
        │       └── SettingsPanel (React.lazy)
        │           ├── SettingsTabs { 'model' | 'proxy' | 'about' }
        │           ├── ModelSettings { provider, model, temperature }
        │           ├── ProxySettings { proxy config, localStorage-only }
        │           └── AboutSettings { version, connections }
        │
        └── StatusBar ──────────────────── grid-area: statusbar
            ├── ModelName { name: "claude-sonnet-4-5" }
            ├── TokenCount { input, output }  // NO cost display
            ├── HeartbeatTimer { nextAt }
            └── VersionString { version }
```

---

## 6. Data Flow

### 6.1 Store Population

```
Mount / Tab Switch
    │
    ├── gateway.connect()
    │       │
    │       ├── hello-ok → gatewayStore.setServerInfo()
    │       └── subscribe("chat.message") → chatStore.handleChatEvent()
    │
    ├── chat.loadHistory() → chatStore.messages
    │
    ├── [library tab] rc.lit.list → libraryStore.papers
    ├── [tasks tab]   rc.task.list → tasksStore.tasks
    ├── [workspace]   rc.ws.tree → workspaceStore (not defined above, uses local state)
    └── [monitor tab]  rc.monitor.list → monitorStore.monitors
```

### 6.2 CRUD Routing

| Panel | Operation | Route | Rationale |
|:------|:----------|:------|:----------|
| Library | Toggle read status | Direct RPC: `rc.lit.status` | Simple, instant |
| Library | Rate paper | Direct RPC: `rc.lit.rate` | Simple, instant |
| Library | Add/remove tag | Direct RPC: `rc.lit.tag` / `rc.lit.untag` | Simple |
| Library | Add paper (search) | Chat: pre-fill `/search [query]` | Complex: needs AI search |
| Library | Import from Zotero | Chat: pre-fill "Import from Zotero" | Complex: multi-step |
| Library | Delete paper | Chat: approval_card required | Irreversible |
| Tasks | Mark complete | Direct RPC: `rc.task.complete` | Simple |
| Tasks | Create task | Chat: pre-fill `/task [title]` | Needs AI for details |
| Tasks | Update priority | Direct RPC: `rc.task.update` | Simple |
| Tasks | Delete task | Chat: approval_card required | Irreversible |
| Workspace | Upload file | HTTP: `POST /rc/upload` | Binary transfer |
| Workspace | View file | Direct RPC: `rc.ws.read` | Simple |
| Workspace | Restore version | Chat: confirmation needed | Potentially destructive |
| Settings | Change theme | Local: configStore.setTheme | Instant, no RPC |
| Settings | Change language | Local: configStore.setLocale | Instant, no RPC (TopBar toggle) |
| Settings | Change model | Local: localStorage `rc-*` | No RPC — config.set requires full JSON5 raw |
| Settings | Update proxy | Local: localStorage `rc-proxy` | No RPC — same config.set limitation |

---

## 7. Streaming Message Handling

### 7.1 Event Flow

```
Gateway Event: chat.message
    │
    ├── payload.state === "delta"
    │   ├── Same runId? → Append to streamText (take longer of current vs new)
    │   └── Different runId? → Ignore (stale delta)
    │
    ├── payload.state === "final"
    │   ├── Same runId? → Commit message to messages[], clear stream state
    │   └── Different runId? → Append to messages[] (sub-agent announcement)
    │
    ├── payload.state === "aborted"
    │   └── Commit partial (streamText or message obj), mark as aborted
    │
    └── payload.state === "error"
        └── Set lastError, clear runId and streamText
```

### 7.2 Silent Reply Detection

```typescript
const SILENT_REPLY_PATTERN = /^\s*NO_REPLY\s*$/;

function isSilentReply(text: string | undefined): boolean {
  return text !== undefined && SILENT_REPLY_PATTERN.test(text);
}
```

Silent replies are filtered from display — they occur when the agent has nothing to say (e.g., heartbeat with no alerts).

### 7.3 Message Card Parsing

During markdown rendering, intercept fenced code blocks:

```typescript
const CARD_TYPES = new Set([
  'paper_card', 'task_card', 'progress_card',
  'approval_card', 'monitor_digest', 'file_card',
]);

// Custom react-markdown code component
function CodeBlock({ className, children }: CodeProps) {
  const language = className?.replace('language-', '');

  if (language && CARD_TYPES.has(language)) {
    try {
      const data = JSON.parse(String(children));
      return renderCard(language, data);
    } catch {
      // Fallback to plain code block
    }
  }

  // Default: syntax-highlighted code block
  return <ShikiHighlight language={language} code={String(children)} />;
}
```

---

## 8. Responsive Layout

### 8.1 CSS Grid

```css
.workbench {
  display: grid;
  height: 100vh;
  grid-template-columns: 240px 1fr 360px;
  grid-template-rows: 48px 1fr 28px;
  grid-template-areas:
    "topbar    topbar    topbar"
    "leftnav   chat      rightpanel"
    "statusbar statusbar statusbar";
}

.topbar      { grid-area: topbar; }
.leftnav     { grid-area: leftnav; }
.chat        { grid-area: chat; }
.rightpanel  { grid-area: rightpanel; }
.statusbar   { grid-area: statusbar; }
```

### 8.2 Breakpoints

| Breakpoint | Layout | Right Panel | Left Nav |
|:-----------|:-------|:------------|:---------|
| ≥1440px | 3-column | Inline, 320-480px | Inline, 240px |
| 1024-1439px | 2-column | Overlay (slide from right) | Inline, 240px |
| <1024px | 1-column | Modal (full-width sheet) | Collapsed (icons only, 56px) |

```css
@media (max-width: 1439px) {
  .workbench {
    grid-template-columns: 240px 1fr;
    grid-template-areas:
      "topbar    topbar"
      "leftnav   chat"
      "statusbar statusbar";
  }
  .rightpanel {
    position: fixed;
    right: 0;
    top: 48px;
    bottom: 28px;
    width: 400px;
    z-index: 100;
    transform: translateX(100%);
    transition: transform 0.2s ease;
  }
  .rightpanel.open {
    transform: translateX(0);
  }
}

@media (max-width: 1023px) {
  .workbench {
    grid-template-columns: 56px 1fr;
  }
  .leftnav {
    width: 56px;
    /* Show icons only, hide labels */
  }
  .rightpanel {
    width: 100%;
    /* Full-width modal sheet */
  }
}
```

---

## 9. Theme System

### 9.1 CSS Custom Properties

Defined in `dashboard/src/styles/global.css`, aligned with `docs/FRONTEND_DESIGN_SYSTEM.md`:

```css
:root {
  /* Dark theme (default) — HashMind Terminal Aesthetic */
  --bg: #030303;
  --surface: #0A0A0B;
  --surface-hover: #141415;
  --surface-active: #1C1C1E;
  --text-primary: #E4E4E7;
  --text-secondary: #A1A1AA;
  --text-tertiary: #71717A;
  --border: rgba(255,255,255,0.08);
  --border-hover: rgba(255,255,255,0.15);
  --accent-primary: #EF4444;   /* Lobster Red */
  --accent-secondary: #3B82F6; /* Academic Blue */
  --success: #10B981;
  --warning: #F59E0B;
  --error: #F43F5E;
  --code-bg: #161618;
  --glass-bg: rgba(10,10,11,0.7);
  --glass-blur: 16px;
  --glow-red: 0 0 20px rgba(239,68,68,0.3);
  --glow-blue: 0 0 20px rgba(59,130,246,0.3);
  --accent-primary-hover: #DC2626;
  --accent-secondary-hover: #2563EB;
}

[data-theme='light'] {
  --bg: #FFFBF5;               /* Warm paper */
  --surface: #FFF8F0;
  --surface-hover: #FFF3E8;
  --surface-active: #FFEDD5;
  --text-primary: #1C1917;
  --text-secondary: #78716C;
  --text-tertiary: #A8A29E;
  --border: rgba(28,25,23,0.08);
  --border-hover: rgba(28,25,23,0.15);
  --accent-primary: #DC2626;
  --accent-secondary: #2563EB;
  --success: #059669;
  --warning: #D97706;
  --error: #E11D48;
  --code-bg: #F5F0EA;
  --glass-bg: rgba(255,251,245,0.85);
  --glass-blur: 12px;
}
```

### 9.2 Ant Design Integration

```typescript
// In styles/theme.ts — getAntdThemeConfig()
{
  algorithm: mode === 'dark' ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
  token: {
    colorPrimary: tokens.accent.red,
    colorInfo: tokens.accent.blue,
    colorSuccess: tokens.accent.green,
    colorWarning: tokens.accent.amber,
    colorError: tokens.accent.error,
    colorBgContainer: tokens.bg.surface,
    colorBgElevated: tokens.bg.secondary,
    colorBgLayout: tokens.bg.primary,
    colorText: tokens.text.primary,
    colorTextSecondary: tokens.text.secondary,
    colorTextTertiary: tokens.text.muted,
    colorBorder: tokens.border.default,
    colorBorderSecondary: tokens.border.hover,
    borderRadius: 8,
    borderRadiusLG: 12,
    borderRadiusSM: 4,
    fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
    fontFamilyCode: "'Fira Code', 'JetBrains Mono', Consolas, monospace",
  },
  components: {
    Button: { borderRadius: 8 },
    Input: { borderRadius: 8 },
  },
}
```

### 9.3 Theme Switching

```typescript
// In configStore
setTheme: (t: 'dark' | 'light') => {
  document.documentElement.setAttribute('data-theme', t);
  set({ theme: t });
  localStorage.setItem('rc-theme', t);
}
```

---

## 10. Internationalization

### 10.1 Setup

```typescript
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './i18n/en.json';
import zhCN from './i18n/zh-CN.json';

i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    'zh-CN': { translation: zhCN },
  },
  lng: localStorage.getItem('rc-locale') || 'zh-CN',
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
});
```

### 10.2 Usage

```tsx
import { useTranslation } from 'react-i18next';

function LibraryPanel() {
  const { t } = useTranslation();
  return <h2>{t('library.title')}</h2>;
}
```

### 10.3 Language Toggle

In Settings > General, a language dropdown. On change:
```typescript
i18n.changeLanguage(locale);
localStorage.setItem('rc-locale', locale);
configStore.setLocale(locale);
```

---

## 11. Build & Deployment

### 11.1 Vite Config

```typescript
// dashboard/vite.config.ts
export default defineConfig({
  plugins: [react()],
  base: './',                    // Relative paths for gateway serving
  resolve: {
    alias: { '@': resolve(__dirname, 'src') },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks: {
          antd: ['antd', '@ant-design/icons'],
          markdown: ['react-markdown', 'remark-gfm'],
        },
      },
    },
  },
  server: {
    port: 5175,
    proxy: {
      '/ws': { target: 'ws://127.0.0.1:28789', ws: true },
      '/socket.io': { target: 'http://127.0.0.1:28789' },
    },
  },
});
```

### 11.2 Gateway Serving

The built dashboard is served by OpenClaw's control-ui handler:
- Config: `gateway.controlUi.root` → `./dashboard/dist`
- SPA fallback: missing paths → `index.html`
- Security headers: X-Frame-Options DENY, CSP, X-Content-Type-Options nosniff

### 11.3 Dev Workflow

```bash
# Terminal 1: Gateway
pnpm start

# Terminal 2: Dashboard dev server (HMR)
pnpm --filter dashboard dev

# Or both via concurrently:
pnpm dev
```

Dev server at `http://localhost:5175` proxies WS and API requests to gateway at `127.0.0.1:28789`.

---

## 12. Performance

### 12.1 Budget

| Metric | Target |
|:-------|:-------|
| Dashboard JS bundle (gzip) | < 500 KB |
| Initial load (LCP) | < 2s |
| WS round-trip (loopback) | < 50ms |
| SQLite query (via RPC) | < 10ms |
| Chat delta render | < 16ms (60fps) |

### 12.2 Code Splitting

```typescript
// Lazy-load panel components
const LibraryPanel = React.lazy(() => import('./components/panels/LibraryPanel'));
const WorkspacePanel = React.lazy(() => import('./components/panels/WorkspacePanel'));
const TaskPanel = React.lazy(() => import('./components/panels/TaskPanel'));
const RadarPanel = React.lazy(() => import('./components/panels/RadarPanel'));
const SettingsPanel = React.lazy(() => import('./components/panels/SettingsPanel'));
```

### 12.3 Virtual Scrolling

For lists exceeding 100 items (papers, tasks), use virtual scrolling:
- Library paper list: virtualized with `react-window` or Ant Design's virtual Table
- Task list: unlikely to exceed 100, defer virtualization

### 12.4 Debounced Search

```typescript
// 300ms debounce on search input
const debouncedSearch = useMemo(
  () => debounce((q: string) => libraryStore.loadPapers({ query: q }), 300),
  [],
);
```

### 12.5 Shiki Lazy Loading

Shiki grammars are loaded on-demand when a code block with that language first appears. Avoid bundling all languages.

---

## Cross-References

| Topic | Document |
|:------|:---------|
| Visual design, wireframes, color tokens | `01-interaction-design.md` |
| WS protocol, frame format, auth | `02-engineering-architecture.md` Section 4 |
| Message card types and parsing | `03d-message-card-protocol.md` |
| Literature RPC methods (rc.lit.*) | `03a-literature-library.md` Section 4 |
| Task RPC methods (rc.task.*) | `03b-task-system.md` Section 4 |
| Workspace RPC methods (rc.ws.*) | `03c-workspace-git-tracking.md` Section 4 |
| Plugin aggregation (all methods) | `03f-research-claw-core-plugin.md` |
| Theme tokens (HashMind) | `FRONTEND_DESIGN_SYSTEM.md` |

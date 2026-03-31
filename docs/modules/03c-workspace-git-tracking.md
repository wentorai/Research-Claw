# 03c — Workspace & Git Tracking Module

> Structured workspace directory for research files with automatic Git-based
> version tracking. The agent commits on behalf of the researcher; it never
> auto-pushes.

| Field | Value |
|-------|-------|
| **Status** | Draft |
| **Depends on** | `02` (Engineering Architecture — HTTP route registration, RPC protocol) |
| **Consumed by** | `03b` (task-file linking), `03e` (WorkspacePanel component), `03f` (plugin aggregation) |
| **Namespace** | `rc.ws.*` (11 WS RPC methods + 1 HTTP route) |
| **Agent tools** | 7 (`workspace_save`, `workspace_read`, `workspace_list`, `workspace_diff`, `workspace_history`, `workspace_restore`, `workspace_move`) |
| **HTTP routes** | 1 (`POST /rc/upload`) |

---

## Table of Contents

1. [Feature Overview](#1-feature-overview)
2. [Directory Convention](#2-directory-convention)
3. [Agent Tools](#3-agent-tools)
4. [Plugin RPC Methods](#4-plugin-rpc-methods)
5. [HTTP Endpoint](#5-http-endpoint)
6. [Dashboard Timeline](#6-dashboard-timeline)
7. [Git Tracker Implementation](#7-git-tracker-implementation)
8. [TypeScript Types](#8-typescript-types)
9. [Configuration](#9-configuration)
10. [Error Catalogue](#10-error-catalogue)
11. [Cross-References](#11-cross-references)

---

## 1. Feature Overview

Research-Claw provides a structured local workspace that solves three problems
researchers face when working with AI agents:

1. **File sprawl** — agent-generated outputs scatter across the filesystem with
   no naming or location discipline. The workspace enforces a source/output
   split so the researcher always knows where to find things.

2. **Version amnesia** — an agent can overwrite a draft without the researcher
   noticing. Git-based auto-commit captures every meaningful change, giving the
   researcher a timeline they can roll back.

3. **Upload friction** — getting a PDF or dataset into the agent's context
   requires copy-pasting paths. Drag-drop upload from the dashboard places the
   file directly into the workspace and makes it immediately available.

### Design Principles

| Principle | Rule |
|-----------|------|
| **Local-only by default** | Git repo lives in the workspace directory. No remote is configured automatically. The agent NEVER pushes. |
| **Upload/output separation** | Dashboard-uploaded files go under `uploads/`. Agent-generated files go under `outputs/`. This boundary is enforced by convention (tool descriptions), not by hard filesystem locks. |
| **Descriptive commits** | Every auto-commit includes a human-readable message that names the action and, where applicable, the related project or paper. |
| **No data loss** | Overwriting a tracked file always produces a new commit first. The researcher can restore any prior version. |
| **Large-file safety** | Files exceeding 10 MB are listed in `.gitignore` by default to prevent repository bloat. The user can override this. |

---

## 2. Directory Convention

```
workspace/
├── .git/                 # Auto-initialized, local-only
├── .gitignore            # Generated on init (see template below)
├── uploads/              # User uploads, reference materials
│   ├── papers/           # Uploaded PDFs
│   ├── data/             # Uploaded datasets (CSV, JSON, XLSX, etc.)
│   └── references/       # Uploaded BibTeX, notes, annotations
└── outputs/              # Agent-generated files
    ├── drafts/           # Writing drafts (Markdown, LaTeX, DOCX)
    ├── figures/          # Generated charts, plots, diagrams
    ├── exports/          # BibTeX exports, summaries, extracted data
    └── reports/          # Analysis reports, literature reviews
```

### 2.1 Workspace Root Resolution

The workspace root is determined by the following priority chain:

1. `research-claw.workspace.root` in `openclaw.json` (absolute path)
2. `$RESEARCH_CLAW_WORKSPACE` environment variable
3. `<gateway-data-dir>/workspace/` (default)

On first access, if the directory does not exist, the plugin creates it along
with all subdirectories and initializes a Git repository.

### 2.2 Auto-Init Sequence

```
1. mkdir -p workspace/{uploads/{papers,data,references},outputs/{drafts,figures,exports,reports}}
2. cd workspace && git init
3. git config user.name "Research-Claw"
4. git config user.email "research-claw@wentor.ai"
5. Write .gitignore from template
6. git add .gitignore && git commit -m "Init: workspace created"
```

### 2.3 `.gitignore` Template

```gitignore
# Research-Claw workspace — auto-generated
# Large binary files (>10MB managed by size guard)
*.zip
*.tar.gz
*.7z

# Temporary files
*.tmp
*.swp
*~
.DS_Store
Thumbs.db

# Python artifacts
__pycache__/
*.pyc
.ipynb_checkpoints/

# R artifacts
.Rhistory
.RData

# Editor state
.vscode/
.idea/

# Large data (user can remove lines to track specific files)
*.h5
*.hdf5
*.parquet
*.sqlite
*.db
```

### 2.4 Commit Message Conventions

All auto-commits follow a prefix convention:

| Prefix | Trigger | Example |
|--------|---------|---------|
| `Init:` | Workspace creation | `Init: workspace created` |
| `Add:` | New file saved | `Add: literature review draft for [quantum computing]` |
| `Update:` | Existing file modified | `Update: figure 3 — revised color scheme` |
| `Upload:` | File uploaded via dashboard | `Upload: smith2024.pdf to uploads/papers` |
| `Restore:` | File restored from history | `Restore: draft.md to version abc1234` |
| `Delete:` | File removed | `Delete: outdated export results.csv` |

If the agent provides a custom `commit_message` parameter, that message is used
verbatim (no prefix added).

---

## 3. Agent Tools

All tools are registered via the OpenClaw Plugin SDK `registry.registerTool()`.
Schemas use TypeBox (`@sinclair/typebox`).

### 3.1 `workspace_save`

Save or create a file in the workspace. Optionally auto-commits the change.

```typescript
import { Type, type Static } from '@sinclair/typebox';

const WorkspaceSaveParams = Type.Object({
  path: Type.String({
    description: 'File path relative to workspace root (e.g. "outputs/drafts/review.md")',
    minLength: 1,
    maxLength: 512,
  }),
  content: Type.String({
    description: 'File content to write (UTF-8 text)',
  }),
  commit_message: Type.Optional(Type.String({
    description: 'Custom git commit message. If omitted, an auto-generated message is used.',
    maxLength: 200,
  })),
});
type WorkspaceSaveParams = Static<typeof WorkspaceSaveParams>;

const WorkspaceSaveResult = Type.Object({
  path: Type.String(),
  size: Type.Number(),
  committed: Type.Boolean(),
  commit_hash: Type.Optional(Type.String()),
});
type WorkspaceSaveResult = Static<typeof WorkspaceSaveResult>;
```

**Behavior:**

1. Resolve `path` against workspace root. Reject paths containing `..` or
   starting with `/` (see [Error Catalogue](#10-error-catalogue)).
2. Create parent directories as needed (`mkdir -p`).
3. Write content to file (UTF-8, atomic write via temp-file + rename).
4. If `autoTrackGit` is enabled (default: `true`):
   a. `git add <path>`
   b. Determine prefix: `Add:` if new file, `Update:` if modified.
   c. Commit with provided or auto-generated message.
   d. Return `committed: true` and `commit_hash`.
5. If `autoTrackGit` is disabled, return `committed: false`.

### 3.2 `workspace_read`

Read a file from the workspace.

```typescript
const WorkspaceReadParams = Type.Object({
  path: Type.String({
    description: 'File path relative to workspace root',
    minLength: 1,
    maxLength: 512,
  }),
});
type WorkspaceReadParams = Static<typeof WorkspaceReadParams>;

const WorkspaceReadResult = Type.Object({
  content: Type.String(),
  metadata: Type.Object({
    path: Type.String(),
    size: Type.Number(),
    mime_type: Type.String(),
    modified_at: Type.String({ format: 'date-time' }),
    git_status: Type.Optional(Type.Union([
      Type.Literal('new'),
      Type.Literal('modified'),
      Type.Literal('committed'),
      Type.Literal('untracked'),
    ])),
  }),
});
type WorkspaceReadResult = Static<typeof WorkspaceReadResult>;
```

**Behavior:**

1. Validate path (no traversal).
2. Read file contents as UTF-8 string. For binary files, return base64-encoded
   content and set `mime_type` accordingly.
3. Stat the file for `size` and `modified_at`.
4. Run `git status --porcelain <path>` to determine `git_status`:
   - `??` -> `untracked`
   - `A ` or `AM` -> `new`
   - ` M` or `MM` -> `modified`
   - otherwise -> `committed`

### 3.3 `workspace_list`

List files in the workspace.

```typescript
const WorkspaceListParams = Type.Object({
  directory: Type.Optional(Type.String({
    description: 'Subdirectory relative to workspace root. Defaults to root.',
  })),
  recursive: Type.Optional(Type.Boolean({
    description: 'List files recursively. Default: false.',
    default: false,
  })),
  pattern: Type.Optional(Type.String({
    description: 'Glob pattern to filter files (e.g. "*.pdf", "**/*.md").',
  })),
});
type WorkspaceListParams = Static<typeof WorkspaceListParams>;

const WorkspaceListResult = Type.Object({
  files: Type.Array(Type.Ref(FileEntrySchema)),
  total: Type.Number(),
});
type WorkspaceListResult = Static<typeof WorkspaceListResult>;
```

**Behavior:**

1. Resolve `directory` against workspace root (default: workspace root).
2. If `recursive`, walk the directory tree. Otherwise, list immediate children.
3. If `pattern` is provided, filter using micromatch or picomatch.
4. For each entry, stat to populate `size`, `modified_at`, `type`.
5. Return sorted by `modified_at` descending (most recent first).
6. Limit: 500 entries. If more exist, return the first 500 with `total` set to
   the actual count.

### 3.4 `workspace_diff`

Show changes (uncommitted or between commits).

```typescript
const WorkspaceDiffParams = Type.Object({
  path: Type.Optional(Type.String({
    description: 'File path relative to workspace root. If omitted, diff all changes.',
  })),
  commit_range: Type.Optional(Type.String({
    description: 'Git commit range (e.g. "abc1234..def5678", "HEAD~3..HEAD"). If omitted, show uncommitted changes.',
    pattern: '^[a-f0-9A-Z~^.]+$',
  })),
});
type WorkspaceDiffParams = Static<typeof WorkspaceDiffParams>;

const WorkspaceDiffResult = Type.Object({
  diff: Type.String({ description: 'Unified diff output' }),
  files_changed: Type.Number(),
  insertions: Type.Number(),
  deletions: Type.Number(),
});
type WorkspaceDiffResult = Static<typeof WorkspaceDiffResult>;
```

**Behavior:**

1. If `commit_range` is provided: `git diff <commit_range> [-- <path>]`
2. If only `path` is provided: `git diff -- <path>` (working tree vs index)
3. If neither: `git diff` (all uncommitted changes)
4. Parse diff stat line for `files_changed`, `insertions`, `deletions`.
5. Max diff output: 50 KB. Truncate with `[...truncated]` if exceeded.

### 3.5 `workspace_history`

Show git log for the workspace or a specific file.

```typescript
const WorkspaceHistoryParams = Type.Object({
  path: Type.Optional(Type.String({
    description: 'File path to show history for. If omitted, show full workspace history.',
  })),
  limit: Type.Optional(Type.Number({
    description: 'Maximum number of commits to return. Default: 20. Max: 100.',
    default: 20,
    minimum: 1,
    maximum: 100,
  })),
});
type WorkspaceHistoryParams = Static<typeof WorkspaceHistoryParams>;

const WorkspaceHistoryResult = Type.Object({
  commits: Type.Array(Type.Ref(CommitEntrySchema)),
  total: Type.Number(),
});
type WorkspaceHistoryResult = Static<typeof WorkspaceHistoryResult>;
```

**Behavior:**

1. Run `git log --format=<format> -n <limit> [-- <path>]`
2. Format string: `%H|%h|%s|%an|%aI|` followed by `--numstat` for file count.
3. Parse into `CommitEntry[]`.
4. `total` is obtained from `git rev-list --count HEAD [-- <path>]`.

### 3.6 `workspace_restore`

Restore a file to a previous version.

```typescript
const WorkspaceRestoreParams = Type.Object({
  path: Type.String({
    description: 'File path relative to workspace root',
    minLength: 1,
    maxLength: 512,
  }),
  commit_hash: Type.String({
    description: 'Git commit hash (short or full) to restore from',
    minLength: 4,
    maxLength: 40,
    pattern: '^[a-f0-9]+$',
  }),
});
type WorkspaceRestoreParams = Static<typeof WorkspaceRestoreParams>;

const WorkspaceRestoreResult = Type.Object({
  path: Type.String(),
  restored_from: Type.String({ description: 'Full commit hash' }),
  committed: Type.Boolean(),
  commit_hash: Type.Optional(Type.String()),
});
type WorkspaceRestoreResult = Static<typeof WorkspaceRestoreResult>;
```

**Behavior:**

1. Validate that `commit_hash` resolves: `git cat-file -t <hash>`.
2. Validate that `path` exists at that commit: `git show <hash>:<path>`.
3. Restore: `git checkout <hash> -- <path>`.
4. Auto-commit: `Restore: <filename> to version <short_hash>`.
5. Return the new commit hash.

### 3.7 `workspace_move`

Move or rename a file or directory within the workspace. Automatically commits the change.

```typescript
const WorkspaceMoveParams = Type.Object({
  from: Type.String({
    description: 'Source path relative to workspace root (e.g. "outputs/drafts/old-name.md")',
    minLength: 1,
    maxLength: 512,
  }),
  to: Type.String({
    description: 'Destination path relative to workspace root (e.g. "outputs/drafts/new-name.md")',
    minLength: 1,
    maxLength: 512,
  }),
});
type WorkspaceMoveParams = Static<typeof WorkspaceMoveParams>;

const WorkspaceMoveResult = Type.Object({
  from: Type.String(),
  to: Type.String(),
  committed: Type.Boolean(),
});
type WorkspaceMoveResult = Static<typeof WorkspaceMoveResult>;
```

**Behavior:**

1. Validate both paths (no traversal).
2. Move the file or directory from `from` to `to`.
3. Auto-commit with git.
4. Return the paths and commit status.

---

## 4. Plugin RPC Methods

All methods are registered on the gateway WebSocket under the `rc.ws.*`
namespace. They follow the JSON-RPC 2.0 envelope defined in `02`.

### 4.1 `rc.ws.tree`

Returns the workspace file tree for the dashboard sidebar.

```typescript
// --- Request ---
interface RcWsTreeParams {
  root?: string;   // Subdirectory to start from. Default: workspace root.
  depth?: number;  // Max depth. Default: 3. Max: 10.
}

// --- Response ---
interface RcWsTreeResult {
  tree: TreeNode[];
  workspace_root: string;  // Absolute path, for display purposes
}
```

**Implementation notes:**

- Walk the filesystem up to `depth` levels.
- Populate `git_status` for each file via a single `git status --porcelain -z`
  call (batched, not per-file).
- Exclude `.git/` directory from output.
- Directories sort before files. Within each group, sort alphabetically.

### 4.2 `rc.ws.read`

Read a single file for the dashboard preview pane.

```typescript
// --- Request ---
interface RcWsReadParams {
  path: string;  // Relative to workspace root
}

// --- Response ---
interface RcWsReadResult {
  content: string;       // UTF-8 text or base64 for binary
  size: number;          // Bytes
  mime_type: string;     // e.g. "text/markdown", "application/pdf"
  git_status: 'new' | 'modified' | 'committed' | 'untracked';
  encoding: 'utf-8' | 'base64';
}
```

**Implementation notes:**

- For text files (detected by mime type), return raw UTF-8.
- For binary files (PDF, images, etc.), return base64-encoded content.
- Max file size for read: 10 MB. Larger files return error `WS_FILE_TOO_LARGE`.
- MIME detection uses file extension mapping (not content sniffing).

### 4.3 `rc.ws.history`

Returns paginated git log for the dashboard timeline.

```typescript
// --- Request ---
interface RcWsHistoryParams {
  path?: string;    // Filter to specific file. Omit for full history.
  limit?: number;   // Default: 20. Max: 100.
  offset?: number;  // Skip N commits for pagination. Default: 0.
}

// --- Response ---
interface RcWsHistoryResult {
  commits: CommitEntry[];
  total: number;
  has_more: boolean;
}
```

**Implementation notes:**

- Uses `git log --skip=<offset> -n <limit>`.
- `has_more` is `true` when `offset + commits.length < total`.
- The `files_changed` count per commit comes from `--numstat` parsing.

### 4.4 `rc.ws.diff`

Returns a diff for the dashboard diff viewer.

```typescript
// --- Request ---
interface RcWsDiffParams {
  path?: string;   // Specific file, or omit for all changes
  from?: string;   // Start commit hash. Default: parent of `to`.
  to?: string;     // End commit hash. Default: HEAD.
}

// --- Response ---
interface RcWsDiffResult {
  diff: string;           // Unified diff output
  files_changed: number;
  insertions: number;
  deletions: number;
}
```

**Implementation notes:**

- If both `from` and `to` are omitted: `git diff` (uncommitted changes).
- If only `to` is provided: `git diff <to>~1..<to>`.
- If both provided: `git diff <from>..<to>`.
- Max output: 100 KB (RPC responses go over WebSocket; keep them bounded).

### 4.5 `rc.ws.restore`

Restore a file to a historical version.

```typescript
// --- Request ---
interface RcWsRestoreParams {
  path: string;     // File to restore
  commit: string;   // Commit hash to restore from
}

// --- Response ---
interface RcWsRestoreResult {
  ok: true;
  path: string;
  restored_from: string;   // Full commit hash
  new_commit: string;       // New commit hash after restore
}
```

**Implementation notes:**

- Delegates to the same `GitTracker.restore()` used by the agent tool.
- Returns error `WS_COMMIT_NOT_FOUND` if hash is invalid.
- Returns error `WS_FILE_NOT_IN_COMMIT` if file does not exist at that commit.

### 4.6 `rc.ws.save`

Write content to a workspace file with optional auto-commit.

- **Params:** `{ path: string, content: string, message?: string }`
- **Returns:** `{ path: string, size: number, committed: boolean }`

### 4.7 `rc.ws.delete`

Delete a file from the workspace.

- **Params:** `{ path: string }`
- **Returns:** `{ ok: true }`

### 4.8 `rc.ws.saveImage`

Save a base64-encoded image to the workspace. Used by the dashboard to persist
chat image uploads so the agent's image tool can access them by file path.

- **Params:** `{ path: string, base64: string, mimeType?: string }`
- **Returns:** `{ path: string, size: number }`

### 4.9 `rc.ws.openExternal`

Open a file with the system default application (macOS `open`, Windows `start`,
Linux `xdg-open`).

- **Params:** `{ path: string }`
- **Returns:** `{ ok: true }`

Path is validated to stay within the workspace root.

### 4.10 `rc.ws.openFolder`

Open the containing folder of a file in the system file manager.

- **Params:** `{ path: string }`
- **Returns:** `{ ok: true }`

### 4.11 `rc.ws.move`

Move or rename a file or directory within the workspace.

- **Params:** `{ from: string, to: string }`
- **Returns:** `{ from: string, to: string, committed: boolean }`

### 4.12 `rc.ws.upload` (HTTP-only)

> **Note:** `rc.ws.upload` is an HTTP POST endpoint (`POST /rc/upload`), NOT a WS
> RPC method. See [Section 5](#5-http-endpoint) for details.

---

## 5. HTTP Endpoint

### `POST /rc/upload`

Multipart file upload for the dashboard drag-drop feature.

| Property | Value |
|----------|-------|
| **Path** | `/rc/upload` |
| **Method** | `POST` |
| **Match** | Exact |
| **Auth** | Gateway loopback only (requests must originate from 127.0.0.1) |
| **Content-Type** | `multipart/form-data` |
| **Max file size** | 100 MB |
| **Registration** | Via `server.registerHttpRoute()` in the plugin init (see `02`) |

#### Request Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `file` | Binary | Yes | The file to upload |
| `destination` | String | No | Relative path under workspace root. Default: `uploads/` |

#### Response (200 OK)

```json
{
  "ok": true,
  "file": {
    "name": "smith2024.pdf",
    "path": "uploads/smith2024.pdf",
    "type": "file",
    "size": 2458624,
    "mime_type": "application/pdf",
    "modified_at": "2026-03-11T14:30:00.000Z",
    "git_status": "committed"
  }
}
```

#### Error Responses

| Status | Code | Condition |
|--------|------|-----------|
| 400 | `UPLOAD_NO_FILE` | No file field in request |
| 400 | `UPLOAD_INVALID_DESTINATION` | Destination contains `..` or is absolute |
| 413 | `UPLOAD_TOO_LARGE` | File exceeds 100 MB |
| 500 | `UPLOAD_WRITE_FAILED` | Filesystem write error |

#### Implementation Sketch

```typescript
server.registerHttpRoute({
  method: 'POST',
  path: '/rc/upload',
  match: 'exact',
  handler: async (req, res) => {
    // 1. Parse multipart form data (e.g. using busboy or formidable)
    const { file, fields } = await parseMultipart(req, {
      maxFileSize: 100 * 1024 * 1024,  // 100 MB
    });

    if (!file) {
      return res.status(400).json({ error: 'UPLOAD_NO_FILE' });
    }

    const destination = sanitizePath(fields.destination ?? 'uploads/');

    // 2. Write to temp location
    const tmpPath = path.join(os.tmpdir(), `rc-upload-${Date.now()}`);
    await fs.writeFile(tmpPath, file.buffer);

    // 3. Delegate to workspace upload logic
    try {
      const result = await workspaceManager.handleUpload(
        file.originalname,
        tmpPath,
        destination,
      );
      return res.status(200).json({ ok: true, file: result.file });
    } finally {
      await fs.unlink(tmpPath).catch(() => {});
    }
  },
});
```

---

## 6. Dashboard Timeline

The workspace timeline is a core component of the dashboard (see `03e`). It
renders the git history as a vertical timeline grouped by date.

### 6.1 Visual Structure

```
    ┌──────────────────────────────────────────────┐
    │  Workspace Timeline                     ↻    │
    ├──────────────────────────────────────────────┤
    │                                              │
    │  March 11, 2026                              │
    │  ●─── abc1234  14:30                         │
    │  │    Add: literature review draft            │
    │  │    2 files changed                         │
    │  │                                            │
    │  ●─── def5678  11:15                         │
    │  │    Upload: smith2024.pdf to uploads/       │
    │  │    1 file changed                          │
    │  │                                            │
    │  March 10, 2026                              │
    │  ●─── 789abcd  22:45                         │
    │  │    Update: figure 3 — revised color scheme │
    │  │    1 file changed                          │
    │  │                                            │
    │  ●─── ...                                    │
    └──────────────────────────────────────────────┘
```

### 6.2 Entry Composition

Each timeline entry displays:

| Element | Source | Style |
|---------|--------|-------|
| Commit hash (short) | `CommitEntry.short_hash` | Monospace, muted text, clickable |
| Timestamp | `CommitEntry.timestamp` | HH:MM format, muted |
| Commit message | `CommitEntry.message` | Primary text |
| Files changed count | `CommitEntry.files_changed` | Badge or inline text |

### 6.3 Expand-on-Click Behavior

Clicking a timeline entry expands it to show:

1. **Changed files list** — each file with an icon indicating add/modify/delete.
2. **Inline diff preview** — abbreviated unified diff (first 20 lines per file).
3. **Restore button** — for each file, a button to restore that file to this
   version (calls `rc.ws.restore`).

The diff preview is fetched lazily via `rc.ws.diff` with `from=<parent>` and
`to=<hash>` when the entry is expanded. This avoids loading diffs for all
entries upfront.

### 6.4 Data Flow

```
Dashboard mount
  → rc.ws.history({ limit: 20 })
  → Render timeline entries grouped by date
  → User scrolls to bottom
  → rc.ws.history({ limit: 20, offset: 20 })
  → Append entries (infinite scroll)

User clicks entry
  → rc.ws.diff({ from: <parent_hash>, to: <hash> })
  → Expand with file list + diff preview
```

### 6.5 Styling Notes

- Timeline dot: 8px circle, `var(--accent-primary)` fill (`#EF4444`).
- Connecting line: 2px solid `var(--border-subtle)`.
- Date separator: uppercase label, `var(--text-muted)`.
- Expanded diff: `<pre>` block with syntax highlighting for
  additions (green) and deletions (red), using terminal-style colors consistent
  with the HashMind dark theme.

---

## 7. Git Tracker Implementation

The `GitTracker` class encapsulates all Git operations. It uses
`child_process.execFile` to invoke the system `git` binary directly -- no
JavaScript Git libraries.

### 7.1 Class Interface

```typescript
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

interface GitTrackerConfig {
  workspaceRoot: string;
  authorName: string;        // Default: "Research-Claw"
  authorEmail: string;       // Default: "research-claw@wentor.ai"
  commitDebounceMs: number;  // Default: 5000
  maxFileSize: number;       // bytes — files larger than this are .gitignored
  enabled: boolean;
}

class GitTracker {
  private root: string;
  private authorName: string;
  private authorEmail: string;
  private commitDebounceMs: number;
  private maxFileSize: number;
  private pendingPaths: Set<string>;
  private debounceTimer: ReturnType<typeof setTimeout> | null;

  constructor(config: GitTrackerConfig);

  /** Initialize git repo if not already initialized */
  async init(): Promise<void>;

  /** Stage a file */
  async add(filePath: string): Promise<void>;

  /**
   * Commit staged changes.
   * If debounce is active, queues the path and commits after debounceMs.
   */
  async commit(message: string, options?: { immediate?: boolean }): Promise<string | null>;

  /** Get git log */
  async log(options?: {
    path?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ commits: CommitEntry[]; total: number }>;

  /** Get diff output */
  async diff(options?: {
    path?: string;
    from?: string;
    to?: string;
  }): Promise<{ diff: string; files_changed: number; insertions: number; deletions: number }>;

  /** Restore a file from a specific commit */
  async restore(filePath: string, commitHash: string): Promise<string>;

  /** Get status of a specific file or all files */
  async status(filePath?: string): Promise<Map<string, GitFileStatus>>;

  /** Check if workspace is a git repo */
  async isRepo(): Promise<boolean>;

  // --- Private ---

  private async git(args: string[]): Promise<string>;
  private scheduleDebouncedCommit(path: string, message: string): void;
  private async flushDebouncedCommit(): Promise<void>;
}

type GitFileStatus = 'new' | 'modified' | 'committed' | 'untracked' | 'deleted';
```

### 7.2 Core `git()` Helper

All git commands go through a single private method that handles errors
consistently:

```typescript
private async git(args: string[]): Promise<string> {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: this.authorName,
    GIT_AUTHOR_EMAIL: this.authorEmail,
    GIT_COMMITTER_NAME: this.authorName,
    GIT_COMMITTER_EMAIL: this.authorEmail,
    // Prevent git from opening editors or pagers
    GIT_EDITOR: 'true',
    GIT_PAGER: 'cat',
  };

  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd: this.root,
      env,
      maxBuffer: 10 * 1024 * 1024,  // 10 MB
      timeout: 30_000,               // 30s hard timeout
    });
    return stdout;
  } catch (err: unknown) {
    const execErr = err as { stderr?: string; code?: number };
    throw new GitError(
      `git ${args[0]} failed: ${execErr.stderr?.trim() ?? 'unknown error'}`,
      args[0],
      execErr.code ?? 1,
    );
  }
}
```

### 7.3 Debounced Commits

When multiple files are saved in rapid succession (e.g., the agent writes a
draft and its BibTeX export in the same turn), we batch them into a single
commit:

```typescript
private scheduleDebouncedCommit(filePath: string, message: string): void {
  this.pendingPaths.add(filePath);

  if (this.debounceTimer) {
    clearTimeout(this.debounceTimer);
  }

  this.debounceTimer = setTimeout(async () => {
    await this.flushDebouncedCommit();
  }, this.commitDebounceMs);
}

private async flushDebouncedCommit(): Promise<void> {
  if (this.pendingPaths.size === 0) return;

  const paths = [...this.pendingPaths];
  this.pendingPaths.clear();
  this.debounceTimer = null;

  // Stage all pending paths
  for (const p of paths) {
    await this.add(p);
  }

  // Build a combined commit message
  const message = paths.length === 1
    ? `Add: ${path.basename(paths[0])}`
    : `Batch: ${paths.length} files updated`;

  await this.git(['commit', '-m', message]);
}
```

**Important:** When `workspace_save` is called with `options.immediate = true`
(or with an explicit `commit_message`), the debounce is bypassed and the commit
happens synchronously. The debounce only applies to auto-generated commits
without explicit messages.

### 7.4 Size Guard

Before staging a file, the tracker checks its size:

```typescript
async add(filePath: string): Promise<void> {
  const fullPath = path.join(this.root, filePath);
  const stat = await fs.stat(fullPath);

  if (stat.size > 10 * 1024 * 1024) {
    // 10 MB threshold — add to .gitignore instead
    await this.appendGitignore(filePath);
    return;
  }

  await this.git(['add', '--', filePath]);
}
```

Files exceeding 10 MB are automatically appended to `.gitignore` rather than
staged. A warning is logged so the user is aware.

### 7.5 Restore Implementation

```typescript
async restore(filePath: string, commitHash: string): Promise<string> {
  // Validate commit exists
  await this.git(['cat-file', '-t', commitHash]);

  // Validate file exists at that commit
  await this.git(['show', `${commitHash}:${filePath}`]);

  // Checkout the file from that commit
  await this.git(['checkout', commitHash, '--', filePath]);

  // Auto-commit the restoration
  const shortHash = commitHash.slice(0, 7);
  const filename = path.basename(filePath);
  const message = `Restore: ${filename} to version ${shortHash}`;
  await this.git(['add', '--', filePath]);
  const result = await this.git(['commit', '-m', message]);

  // Extract new commit hash
  const match = result.match(/\[[\w-]+ ([a-f0-9]+)\]/);
  return match?.[1] ?? '';
}
```

---

## 8. TypeScript Types

Canonical type definitions used across agent tools, RPC methods, and the
dashboard.

### 8.1 `FileEntry`

```typescript
interface FileEntry {
  /** Filename without directory (e.g. "review.md") */
  name: string;

  /** Path relative to workspace root (e.g. "outputs/drafts/review.md") */
  path: string;

  /** Entry type */
  type: 'file' | 'directory';

  /** File size in bytes. Undefined for directories. */
  size?: number;

  /** MIME type detected from extension. Undefined for directories. */
  mime_type?: string;

  /** ISO 8601 timestamp of last modification */
  modified_at?: string;

  /** Git tracking status */
  git_status?: 'new' | 'modified' | 'committed' | 'untracked';
}
```

TypeBox schema (for agent tool registration):

```typescript
const FileEntrySchema = Type.Object({
  name: Type.String(),
  path: Type.String(),
  type: Type.Union([Type.Literal('file'), Type.Literal('directory')]),
  size: Type.Optional(Type.Number()),
  mime_type: Type.Optional(Type.String()),
  modified_at: Type.Optional(Type.String({ format: 'date-time' })),
  git_status: Type.Optional(Type.Union([
    Type.Literal('new'),
    Type.Literal('modified'),
    Type.Literal('committed'),
    Type.Literal('untracked'),
  ])),
}, { $id: 'FileEntry' });
```

### 8.2 `TreeNode`

```typescript
interface TreeNode extends FileEntry {
  /** Child entries. Only present for directories. */
  children?: TreeNode[];
}
```

TypeBox schema:

```typescript
const TreeNodeSchema = Type.Recursive(
  (Self) => Type.Intersect([
    Type.Ref(FileEntrySchema),
    Type.Object({
      children: Type.Optional(Type.Array(Self)),
    }),
  ]),
  { $id: 'TreeNode' },
);
```

### 8.3 `CommitEntry`

```typescript
interface CommitEntry {
  /** Full 40-character commit hash */
  hash: string;

  /** Short 7-character hash for display */
  short_hash: string;

  /** Commit message */
  message: string;

  /** Author name (typically "Research-Claw") */
  author: string;

  /** ISO 8601 timestamp */
  timestamp: string;

  /** Number of files changed in this commit */
  files_changed: number;
}
```

TypeBox schema:

```typescript
const CommitEntrySchema = Type.Object({
  hash: Type.String({ minLength: 40, maxLength: 40, pattern: '^[a-f0-9]+$' }),
  short_hash: Type.String({ minLength: 7, maxLength: 7 }),
  message: Type.String(),
  author: Type.String(),
  timestamp: Type.String({ format: 'date-time' }),
  files_changed: Type.Number({ minimum: 0 }),
}, { $id: 'CommitEntry' });
```

### 8.4 `GitError`

Custom error class for git operation failures:

```typescript
class GitError extends Error {
  constructor(
    message: string,
    public readonly command: string,
    public readonly exitCode: number,
  ) {
    super(message);
    this.name = 'GitError';
  }
}
```

---

## 9. Configuration

All workspace settings live under the `research-claw.workspace` key in
`openclaw.json`:

```jsonc
{
  "research-claw": {
    "workspace": {
      // Absolute path to workspace root.
      // Default: <gateway-data-dir>/workspace/
      "root": "/home/user/research-workspace",

      // Enable automatic git tracking on workspace_save.
      // Default: true
      "autoTrackGit": true,

      // Debounce window for batching auto-commits (milliseconds).
      // Default: 5000
      "commitDebounceMs": 5000,

      // Maximum file size (bytes) to track in git.
      // Files above this are auto-added to .gitignore.
      // Default: 10485760 (10 MB)
      "maxGitFileSize": 10485760,

      // Maximum upload file size (bytes) for the HTTP endpoint.
      // Default: 104857600 (100 MB)
      "maxUploadSize": 104857600,

      // Git author name for auto-commits.
      // Default: "Research-Claw"
      "gitAuthorName": "Research-Claw",

      // Git author email for auto-commits.
      // Default: "research-claw@wentor.ai"
      "gitAuthorEmail": "research-claw@wentor.ai"
    }
  }
}
```

### 9.1 Environment Variable Overrides

| Variable | Overrides | Example |
|----------|-----------|---------|
| `RESEARCH_CLAW_WORKSPACE` | `workspace.root` | `/home/user/my-workspace` |
| `RESEARCH_CLAW_GIT_AUTHOR` | `workspace.gitAuthorName` | `My Custom Name` |
| `RESEARCH_CLAW_GIT_EMAIL` | `workspace.gitAuthorEmail` | `me@example.com` |

Environment variables take precedence over `openclaw.json` values.

---

## 10. Error Catalogue

All errors follow the JSON-RPC error object format. Codes in the -32000 to
-32099 range (server error space).

| Code | Constant | Condition | Agent-Facing Message |
|------|----------|-----------|---------------------|
| -32001 | `WS_PATH_TRAVERSAL` | Path contains `..` or starts with `/` | "Invalid path: directory traversal is not allowed." |
| -32002 | `WS_FILE_NOT_FOUND` | File does not exist at the specified path | "File not found: {path}" |
| -32003 | `WS_FILE_TOO_LARGE` | File exceeds read size limit (10 MB) | "File too large to read ({size} bytes). Maximum is 10 MB." |
| -32004 | `WS_COMMIT_NOT_FOUND` | Git commit hash does not resolve | "Commit {hash} not found in workspace history." |
| -32005 | `WS_FILE_NOT_IN_COMMIT` | File does not exist at the specified commit | "File {path} does not exist at commit {hash}." |
| -32006 | `WS_GIT_NOT_AVAILABLE` | `git` binary not found in PATH | "Git is not installed or not in PATH. Workspace tracking is disabled." |
| -32007 | `WS_GIT_ERROR` | Generic git command failure | "Git operation failed: {stderr}" |
| -32008 | `WS_WRITE_FAILED` | Filesystem write error | "Failed to write file: {error}" |
| -32009 | `WS_UPLOAD_NO_FILE` | Upload request missing file field | "No file provided in upload request." |
| -32010 | `WS_UPLOAD_TOO_LARGE` | Upload exceeds 100 MB | "Upload exceeds maximum size of 100 MB." |

### Error Response Example

```json
{
  "jsonrpc": "2.0",
  "id": 42,
  "error": {
    "code": -32002,
    "message": "File not found: outputs/drafts/review.md",
    "data": {
      "constant": "WS_FILE_NOT_FOUND",
      "path": "outputs/drafts/review.md"
    }
  }
}
```

---

## 11. Cross-References

| Document | Relationship |
|----------|-------------|
| `02` — Engineering Architecture | Defines HTTP route registration (`server.registerHttpRoute`), RPC protocol envelope, plugin init lifecycle |
| `03b` — Task System | Tasks can link to workspace files via `task_link` tool. The `resource_type: 'file'` + `resource_id: <workspace_path>` pattern connects tasks to outputs. |
| `03e` — Dashboard UI | `WorkspacePanel` component consumes `rc.ws.tree`, `rc.ws.read`, `rc.ws.history`. Timeline component defined in section 6 of this document is rendered inside `WorkspacePanel`. |
| `03d` — Message Card Protocol | The `file_card` message card type renders a workspace file preview in the chat. It uses `FileEntry` fields for display. |
| `03f` — Plugin Aggregation | All 7 agent tools and 11 WS RPC methods (+1 HTTP route) are registered in the `research-claw-core` plugin's `activate()` function. |
| `04` — Prompt Design | `AGENTS.md` instructs the agent to use `workspace_save` for all file outputs and to prefer the `outputs/` subtree for generated content. |

---

*End of document 03c.*

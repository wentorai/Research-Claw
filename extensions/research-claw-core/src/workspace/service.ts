/**
 * WorkspaceService — High-level workspace operations for Research-Claw.
 *
 * Wraps the GitTracker (factory-based) to provide the 8 `rc.ws.*` RPC methods:
 * init, tree, read, save, history, diff, restore, delete. Handles path validation,
 * MIME type detection, atomic writes, and directory scaffolding.
 */

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  type CommitEntry,
  type GitFileStatus,
  type GitTracker,
  type GitTrackerConfig,
  createGitTracker,
} from './git-tracker.js';

// ---------------------------------------------------------------------------
// Error codes (JSON-RPC server error space)
// ---------------------------------------------------------------------------

export class WorkspaceError extends Error {
  override readonly name = 'WorkspaceError';

  constructor(
    message: string,
    public readonly code: number,
    public readonly data?: Record<string, unknown>,
  ) {
    super(message);
  }
}

const WS_PATH_TRAVERSAL = -32001;
const WS_FILE_NOT_FOUND = -32002;
const WS_FILE_TOO_LARGE = -32003;
const WS_COMMIT_NOT_FOUND = -32004;
const WS_FILE_NOT_IN_COMMIT = -32005;
const WS_WRITE_FAILED = -32008;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FileEntry {
  /** Filename without directory */
  name: string;
  /** Path relative to workspace root */
  path: string;
  /** Entry type */
  type: 'file' | 'directory';
  /** File size in bytes */
  size?: number;
  /** MIME type detected from extension */
  mime_type?: string;
  /** ISO 8601 timestamp of last modification */
  modified_at?: string;
  /** Git tracking status */
  git_status?: GitFileStatus;
}

export interface TreeNode extends FileEntry {
  /** Child entries (only for directories) */
  children?: TreeNode[];
}

export interface WorkspaceConfig {
  /** Absolute path to the workspace root directory */
  root: string;
  /** Whether to auto-track changes with git */
  autoTrackGit: boolean;
  /** Debounce window for batching commits (ms) */
  commitDebounceMs: number;
  /** Files larger than this (bytes) are .gitignored instead of committed */
  maxGitFileSize: number;
  /** Maximum upload file size (bytes) */
  maxUploadSize: number;
  /** Git author name */
  gitAuthorName: string;
  /** Git author email */
  gitAuthorEmail: string;
}

// ---------------------------------------------------------------------------
// MIME type mapping (extension-based)
// ---------------------------------------------------------------------------

const MIME_MAP: Record<string, string> = {
  // Text / documents
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.txt': 'text/plain',
  '.tex': 'text/x-latex',
  '.bib': 'application/x-bibtex',
  '.ris': 'application/x-research-info-systems',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.xml': 'application/xml',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.rtf': 'application/rtf',

  // Data / config
  '.json': 'application/json',
  '.jsonl': 'application/x-ndjson',
  '.yaml': 'text/x-yaml',
  '.yml': 'text/x-yaml',
  '.toml': 'text/x-toml',
  '.ini': 'text/x-ini',

  // Code
  '.py': 'text/x-python',
  '.r': 'text/x-r',
  '.R': 'text/x-r',
  '.rmd': 'text/x-r-markdown',
  '.Rmd': 'text/x-r-markdown',
  '.js': 'text/javascript',
  '.ts': 'text/typescript',
  '.sh': 'text/x-shellscript',
  '.bash': 'text/x-shellscript',
  '.m': 'text/x-matlab',
  '.jl': 'text/x-julia',
  '.lua': 'text/x-lua',
  '.c': 'text/x-c',
  '.cpp': 'text/x-c++',
  '.h': 'text/x-c',
  '.java': 'text/x-java',
  '.go': 'text/x-go',
  '.rs': 'text/x-rust',
  '.sql': 'text/x-sql',

  // Notebooks
  '.ipynb': 'application/x-ipynb+json',

  // Documents
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.odt': 'application/vnd.oasis.opendocument.text',
  '.ods': 'application/vnd.oasis.opendocument.spreadsheet',

  // Images
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.tiff': 'image/tiff',
  '.tif': 'image/tiff',
  '.ico': 'image/x-icon',

  // Archives
  '.zip': 'application/zip',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip',
  '.7z': 'application/x-7z-compressed',
  '.rar': 'application/x-rar-compressed',

  // Data formats
  '.hdf5': 'application/x-hdf5',
  '.h5': 'application/x-hdf5',
  '.parquet': 'application/x-parquet',
  '.sqlite': 'application/x-sqlite3',
  '.db': 'application/x-sqlite3',
  '.npy': 'application/x-numpy',
  '.npz': 'application/x-numpy',
};

/** Extensions that are definitely binary (read as base64, not utf-8). */
const BINARY_EXTENSIONS = new Set([
  '.pdf', '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.tiff', '.tif',
  '.ico', '.webp',
  // Note: .svg is excluded — it is XML-based text (image/svg+xml)
  '.docx', '.doc', '.xlsx', '.xls', '.pptx', '.odt', '.ods',
  '.zip', '.tar', '.gz', '.7z', '.rar',
  '.hdf5', '.h5', '.parquet', '.sqlite', '.db',
  '.npy', '.npz',
  '.exe', '.dll', '.so', '.dylib',
  '.mp4', '.avi', '.mov', '.mkv', '.mp3', '.wav', '.flac',
]);

/** Text MIME type prefixes for content encoding decisions. */
const TEXT_MIME_PREFIXES = [
  'text/',
  'application/json',
  'application/xml',
  'application/x-ndjson',
];

const TEXT_MIME_EXACT = new Set([
  'application/x-bibtex',
  'application/x-research-info-systems',
  'application/x-ipynb+json',
  'text/x-yaml',
  'text/x-toml',
  'text/x-ini',
  'image/svg+xml', // SVG is XML-based text
]);

function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_MAP[ext] ?? 'application/octet-stream';
}

function isTextMime(mime: string): boolean {
  if (TEXT_MIME_EXACT.has(mime)) return true;
  return TEXT_MIME_PREFIXES.some((prefix) => mime.startsWith(prefix));
}

function isBinaryExtension(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_READ_SIZE = 10 * 1024 * 1024; // 10 MB
const MAX_DIFF_OUTPUT = 100 * 1024; // 100 KB truncation for diff
const MAX_TREE_DEPTH = 10;
const DEFAULT_TREE_DEPTH = 3;

/** Standard workspace directory scaffold. */
const WORKSPACE_DIRS = [
  '.ResearchClaw',
  'uploads',
  'sources/papers',
  'sources/data',
  'sources/references',
  'outputs/drafts',
  'outputs/figures',
  'outputs/exports',
  'outputs/reports',
  'outputs/notes',
  'outputs/monitor',
] as const;

/**
 * Prompt files that live in .ResearchClaw/ (loaded via agent:bootstrap hook).
 * MEMORY.md + memory/ stay at workspace root (OC memory search scans root).
 */
const RELOCATABLE_PROMPT_FILES = [
  'AGENTS.md', 'SOUL.md', 'TOOLS.md', 'IDENTITY.md',
  'USER.md', 'HEARTBEAT.md', 'BOOTSTRAP.md',
] as const;

/**
 * Root-level entries hidden from rc.ws.tree (system files, like Windows hidden files).
 * Agent tools (workspace_read/save/list) are NOT affected — only the dashboard tree.
 */
const HIDDEN_ROOT_ENTRIES = new Set([
  // System directories
  '.ResearchClaw', '.openclaw', '.research-claw', 'memory',
  // Prompt files that remain at root during migration or as legacy
  'AGENTS.md', 'SOUL.md', 'TOOLS.md', 'IDENTITY.md',
  'USER.md', 'HEARTBEAT.md', 'BOOTSTRAP.md', 'BOOTSTRAP.md.done',
  'MEMORY.md',
  // OS/tool artifacts
  '.DS_Store', 'Thumbs.db', '.gitignore',
]);

const DEFAULT_GITIGNORE = `# Research-Claw workspace — auto-generated
# Large binary files (managed by size guard)
*.zip
*.tar.gz
*.tgz
*.rar
*.7z
*.iso
*.dmg
*.exe
*.dll
*.so
*.dylib
*.o
*.obj

# Temporary files
*.tmp
*.swp
*.swo
*~
*.log
*.pid
*.seed
.DS_Store
Thumbs.db

# Media (large)
*.mp4
*.avi
*.mov
*.mkv
*.mp3
*.wav
*.flac

# Python artifacts
__pycache__/
*.pyc
.venv/
.ipynb_checkpoints/

# R artifacts
.Rhistory
.RData

# Node
node_modules/

# Editor state
.vscode/
.idea/

# Large data (user can remove lines to track specific files)
*.h5
*.hdf5
*.parquet
*.sqlite
*.db

# Environment / secrets
.env
.env.*
`;

// ---------------------------------------------------------------------------
// WorkspaceService
// ---------------------------------------------------------------------------

export class WorkspaceService {
  private readonly root: string;
  private readonly config: WorkspaceConfig;
  private tracker: GitTracker | null = null;

  constructor(config: WorkspaceConfig) {
    this.root = path.resolve(config.root);
    this.config = config;
  }

  // -----------------------------------------------------------------------
  // Path security
  // -----------------------------------------------------------------------

  /**
   * Validate a relative path. Throws WS_PATH_TRAVERSAL (-32001) if the
   * path contains `..`, starts with `/`, or contains null bytes.
   */
  private validatePath(p: string): void {
    if (!p || typeof p !== 'string') {
      throw new WorkspaceError(
        'Invalid path: path must be a non-empty string.',
        WS_PATH_TRAVERSAL,
        { path: p },
      );
    }

    if (p.includes('\0')) {
      throw new WorkspaceError(
        'Invalid path: null bytes are not allowed.',
        WS_PATH_TRAVERSAL,
        { path: p },
      );
    }

    if (path.isAbsolute(p) || p.startsWith('/') || p.startsWith('\\')) {
      throw new WorkspaceError(
        'Invalid path: absolute paths are not allowed.',
        WS_PATH_TRAVERSAL,
        { path: p },
      );
    }

    // Normalize and check for traversal
    const normalized = path.normalize(p);
    if (normalized.startsWith('..') || normalized.includes(`${path.sep}..`)) {
      throw new WorkspaceError(
        'Invalid path: directory traversal is not allowed.',
        WS_PATH_TRAVERSAL,
        { path: p },
      );
    }

    // Also check the raw string for `..` segments (covers mixed separators)
    const segments = p.replace(/\\/g, '/').split('/');
    if (segments.some((s) => s === '..')) {
      throw new WorkspaceError(
        'Invalid path: directory traversal is not allowed.',
        WS_PATH_TRAVERSAL,
        { path: p },
      );
    }
  }

  /**
   * Resolve a relative path to an absolute path within the workspace.
   * Also checks for symlink escapes on existing paths and their parent dirs.
   */
  private resolvePath(relativePath: string): string {
    this.validatePath(relativePath);
    const resolved = path.resolve(this.root, relativePath);

    // Double-check the resolved path is still within workspace root
    if (resolved !== this.root && !resolved.startsWith(this.root + path.sep)) {
      throw new WorkspaceError(
        'Invalid path: resolved path escapes workspace root.',
        WS_PATH_TRAVERSAL,
        { path: relativePath },
      );
    }

    // Symlink escape guard: walk up from resolved path to workspace root,
    // checking the first existing ancestor via fs.realpathSync(). This catches
    // symlinks at any depth (e.g. workspace/a → /tmp/x/, write to a/b/c.txt).
    try {
      const realRoot = fs.realpathSync(this.root);
      let checkPath = resolved;
      while (checkPath !== realRoot && checkPath !== path.dirname(checkPath)) {
        try {
          const real = fs.realpathSync(checkPath);
          if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
            throw new WorkspaceError(
              'Invalid path: resolves outside workspace root via symlink.',
              WS_PATH_TRAVERSAL,
              { path: relativePath },
            );
          }
          break; // Found existing path within bounds — safe
        } catch (e) {
          if (e instanceof WorkspaceError) throw e;
          // ENOENT: path doesn't exist yet, check parent
          checkPath = path.dirname(checkPath);
        }
      }
    } catch (e) {
      if (e instanceof WorkspaceError) throw e;
      // If realpath on root fails, skip symlink check entirely
    }

    return resolved;
  }

  // -----------------------------------------------------------------------
  // init — rc.ws.init
  // -----------------------------------------------------------------------

  /**
   * Initialize the workspace directory structure and optional git tracker.
   *
   * Creates the standard scaffold directories (sources/papers, sources/data,
   * sources/references, outputs/drafts, outputs/figures, outputs/exports,
   * outputs/reports). Initializes the git tracker if autoTrackGit is enabled.
   * Creates a default .gitignore if one does not already exist.
   */
  async init(): Promise<void> {
    // Ensure workspace root exists
    await fsp.mkdir(this.root, { recursive: true });

    // Create standard directory scaffold
    const dirCreations = WORKSPACE_DIRS.map((dir) =>
      fsp.mkdir(path.join(this.root, dir), { recursive: true }),
    );
    await Promise.all(dirCreations);

    // Migrate prompt files from workspace root → .ResearchClaw/ (idempotent)
    await this.migratePromptFiles();

    // Create default .gitignore if it does not exist
    const gitignorePath = path.join(this.root, '.gitignore');
    try {
      await fsp.access(gitignorePath, fs.constants.F_OK);
    } catch {
      await fsp.writeFile(gitignorePath, DEFAULT_GITIGNORE, 'utf-8');
    }

    // Initialize git tracker if auto-tracking is enabled
    if (this.config.autoTrackGit) {
      const trackerConfig: GitTrackerConfig = {
        workspaceRoot: this.root,
        authorName: this.config.gitAuthorName,
        authorEmail: this.config.gitAuthorEmail,
        commitDebounceMs: this.config.commitDebounceMs,
        maxFileSize: this.config.maxGitFileSize,
        enabled: true,
      };

      this.tracker = createGitTracker(trackerConfig);
      await this.tracker.init();
    }
  }

  /**
   * Migrate prompt files from workspace root to .ResearchClaw/ subdirectory.
   *
   * Idempotent: skips files that already exist in .ResearchClaw/.
   * Only moves files that physically exist at root AND are not yet in the subdirectory.
   */
  private async migratePromptFiles(): Promise<void> {
    const rcDir = path.join(this.root, '.ResearchClaw');

    for (const filename of RELOCATABLE_PROMPT_FILES) {
      const rootPath = path.join(this.root, filename);
      const destPath = path.join(rcDir, filename);

      try {
        // Skip if destination already exists (already migrated)
        await fsp.access(destPath, fs.constants.F_OK);
        continue;
      } catch {
        // destPath does not exist — check if source exists at root
      }

      try {
        await fsp.access(rootPath, fs.constants.F_OK);
        // Source exists at root, destination missing → move
        await fsp.rename(rootPath, destPath);
      } catch {
        // Source doesn't exist at root either — nothing to migrate
      }
    }

    // Also handle BOOTSTRAP.md.done (renamed after first-run onboarding)
    const doneSrc = path.join(this.root, 'BOOTSTRAP.md.done');
    const doneDest = path.join(rcDir, 'BOOTSTRAP.md.done');
    try {
      await fsp.access(doneDest, fs.constants.F_OK);
    } catch {
      try {
        await fsp.access(doneSrc, fs.constants.F_OK);
        await fsp.rename(doneSrc, doneDest);
      } catch {
        // Neither exists
      }
    }
  }

  // -----------------------------------------------------------------------
  // tree — rc.ws.tree
  // -----------------------------------------------------------------------

  /**
   * Recursive directory listing for the workspace.
   *
   * Excludes `.git/` and system files at root level (.ResearchClaw/, AGENTS.md,
   * MEMORY.md, .openclaw/, .DS_Store, etc.). Directories sort before files.
   * Each file gets metadata (size, modified_at, mime_type) and an optional git_status.
   *
   * @param root  - Relative path within workspace to start from (default: workspace root)
   * @param depth - Maximum recursion depth (default 3, max 10)
   * @param includeHidden - If true, include system files at root level (default: false)
   */
  async tree(
    root?: string,
    depth?: number,
    includeHidden?: boolean,
  ): Promise<{ tree: TreeNode[]; workspace_root: string; hidden_count: number }> {
    const maxDepth = Math.min(
      Math.max(depth ?? DEFAULT_TREE_DEPTH, 1),
      MAX_TREE_DEPTH,
    );

    let startDir: string;
    if (root) {
      startDir = this.resolvePath(root);
    } else {
      startDir = this.root;
    }

    // Verify start directory exists and is a directory
    try {
      const startStat = await fsp.stat(startDir);
      if (!startStat.isDirectory()) {
        throw new WorkspaceError(
          `Not a directory: ${root ?? '.'}`,
          WS_FILE_NOT_FOUND,
          { path: root ?? '.' },
        );
      }
    } catch (err) {
      if (err instanceof WorkspaceError) throw err;
      throw new WorkspaceError(
        `Directory not found: ${root ?? '.'}`,
        WS_FILE_NOT_FOUND,
        { path: root ?? '.' },
      );
    }

    const hideSystem = !includeHidden;
    const counter = { hidden: 0 };
    const nodes = await this.walkDirectory(startDir, maxDepth, 0, hideSystem, counter);

    return {
      tree: nodes,
      workspace_root: this.root,
      hidden_count: counter.hidden,
    };
  }

  /**
   * Recursively walk a directory, building TreeNode structures.
   */
  private async walkDirectory(
    dir: string,
    maxDepth: number,
    currentDepth: number,
    hideSystem: boolean = true,
    counter: { hidden: number } = { hidden: 0 },
  ): Promise<TreeNode[]> {
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }

    // Separate directories and files, then sort alphabetically within each group
    const dirEntries: fs.Dirent[] = [];
    const fileEntries: fs.Dirent[] = [];

    const isRootLevel = dir === this.root;

    for (const entry of entries) {
      // Always skip .git directory
      if (entry.name === '.git') continue;

      // At root level, hide system files (like Windows hidden system files).
      // Agent tools (workspace_read/save/list) bypass this — only the dashboard
      // tree is affected, keeping the user-facing workspace clean.
      if (isRootLevel && hideSystem && HIDDEN_ROOT_ENTRIES.has(entry.name)) {
        counter.hidden++;
        continue;
      }

      if (entry.isDirectory()) {
        dirEntries.push(entry);
      } else if (entry.isFile()) {
        fileEntries.push(entry);
      }
    }

    dirEntries.sort((a, b) => a.name.localeCompare(b.name));
    fileEntries.sort((a, b) => a.name.localeCompare(b.name));

    const nodes: TreeNode[] = [];

    // Process directories first
    for (const entry of dirEntries) {
      const fullPath = path.join(dir, entry.name);
      const relativePath = path.relative(this.root, fullPath).replace(/\\/g, '/');

      const node: TreeNode = {
        name: entry.name,
        path: relativePath,
        type: 'directory',
      };

      if (currentDepth < maxDepth - 1) {
        node.children = await this.walkDirectory(
          fullPath,
          maxDepth,
          currentDepth + 1,
          hideSystem,
          counter,
        );
      }

      nodes.push(node);
    }

    // Process files
    for (const entry of fileEntries) {
      const fullPath = path.join(dir, entry.name);
      const relativePath = path.relative(this.root, fullPath).replace(/\\/g, '/');

      let fileStat: fs.Stats | null = null;
      try {
        fileStat = await fsp.stat(fullPath);
      } catch {
        // Skip files we cannot stat
        continue;
      }

      const mime = getMimeType(entry.name);

      // Get git status if tracker is available
      let gitStatus: GitFileStatus | undefined;
      if (this.tracker) {
        try {
          gitStatus = await this.tracker.getFileStatus(relativePath);
        } catch {
          // Git status unavailable for this file
        }
      }

      const node: TreeNode = {
        name: entry.name,
        path: relativePath,
        type: 'file',
        size: fileStat.size,
        mime_type: mime,
        modified_at: fileStat.mtime.toISOString(),
        git_status: gitStatus,
      };

      nodes.push(node);
    }

    return nodes;
  }

  // -----------------------------------------------------------------------
  // read — rc.ws.read
  // -----------------------------------------------------------------------

  /**
   * Read a file from the workspace.
   *
   * For text files, returns UTF-8 string content. For binary files, returns
   * base64-encoded content. Maximum file size for reading is 10 MB.
   *
   * @param filePath - Relative path within workspace
   */
  async read(filePath: string): Promise<{
    content: string;
    size: number;
    mime_type: string;
    git_status: GitFileStatus;
    encoding: 'utf-8' | 'base64';
    modified_at: string;
  }> {
    const fullPath = this.resolvePath(filePath);

    // Check file exists and is a regular file
    let fileStat: fs.Stats;
    try {
      fileStat = await fsp.stat(fullPath);
    } catch {
      throw new WorkspaceError(
        `File not found: ${filePath}`,
        WS_FILE_NOT_FOUND,
        { path: filePath },
      );
    }

    if (!fileStat.isFile()) {
      throw new WorkspaceError(
        `Not a file: ${filePath}`,
        WS_FILE_NOT_FOUND,
        { path: filePath },
      );
    }

    // Size check
    if (fileStat.size > MAX_READ_SIZE) {
      throw new WorkspaceError(
        `File too large to read (${fileStat.size} bytes). Maximum is ${MAX_READ_SIZE} bytes.`,
        WS_FILE_TOO_LARGE,
        { path: filePath, size: fileStat.size, max: MAX_READ_SIZE },
      );
    }

    const mime = getMimeType(filePath);
    const binary = isBinaryExtension(filePath) || !isTextMime(mime);

    let content: string;
    let encoding: 'utf-8' | 'base64';

    if (binary) {
      const buffer = await fsp.readFile(fullPath);
      content = buffer.toString('base64');
      encoding = 'base64';
    } else {
      content = await fsp.readFile(fullPath, 'utf-8');
      encoding = 'utf-8';
    }

    // Git status
    let gitStatus: GitFileStatus = 'untracked';
    if (this.tracker) {
      try {
        gitStatus = await this.tracker.getFileStatus(filePath);
      } catch {
        // Git not available — leave as untracked
      }
    }

    return {
      content,
      size: fileStat.size,
      mime_type: mime,
      git_status: gitStatus,
      encoding,
      modified_at: fileStat.mtime.toISOString(),
    };
  }

  // -----------------------------------------------------------------------
  // save — rc.ws.save
  // -----------------------------------------------------------------------

  /**
   * Write content to a workspace file with optional auto-commit.
   *
   * Uses atomic write (temp file + rename) to prevent corruption on crash.
   * Creates parent directories automatically. If autoTrackGit is enabled,
   * the file is committed with a message (default: "Add: <filename>" for
   * new files, "Update: <filename>" for existing files).
   *
   * @param filePath       - Relative path within workspace
   * @param content        - File content (UTF-8 string)
   * @param commitMessage  - Optional custom commit message
   */
  async save(
    filePath: string,
    content: string | Buffer,
    commitMessage?: string,
  ): Promise<{
    path: string;
    size: number;
    committed: boolean;
    commit_hash?: string;
  }> {
    const fullPath = this.resolvePath(filePath);

    // Create parent directories if needed
    const parentDir = path.dirname(fullPath);
    await fsp.mkdir(parentDir, { recursive: true });

    // Check if file already exists (for commit message prefix)
    let isNew = true;
    try {
      await fsp.access(fullPath, fs.constants.F_OK);
      isNew = false;
    } catch {
      // File does not exist — it is new
    }

    // Atomic write: write to temp file, then rename into place
    const tmpPath = path.join(parentDir, `.${randomUUID()}.tmp`);
    try {
      await fsp.writeFile(tmpPath, content, typeof content === 'string' ? 'utf-8' : undefined);
      await fsp.rename(tmpPath, fullPath);
    } catch (err) {
      // Clean up temp file on failure
      try {
        await fsp.unlink(tmpPath);
      } catch {
        // Ignore cleanup errors
      }
      throw new WorkspaceError(
        `Failed to write file: ${(err as Error).message}`,
        WS_WRITE_FAILED,
        { path: filePath },
      );
    }

    const fileStat = await fsp.stat(fullPath);

    // Auto-commit if git tracking is enabled
    let committed = false;
    let commitHash: string | undefined;

    if (this.tracker) {
      try {
        const prefix = isNew ? 'Add' : 'Update';
        const filename = path.basename(filePath);
        const message = commitMessage ?? `${prefix}: ${filename}`;

        const result = await this.tracker.commitFile(filePath, message);
        committed = result.committed;
        commitHash = result.hash;
      } catch {
        // Git failure is non-fatal for save operations
      }
    }

    return {
      path: filePath,
      size: fileStat.size,
      committed,
      commit_hash: commitHash,
    };
  }

  // -----------------------------------------------------------------------
  // history — rc.ws.history
  // -----------------------------------------------------------------------

  /**
   * Git log for the workspace or a specific file.
   *
   * @param filePath - Optional relative path to filter history for a single file
   * @param limit    - Number of commits to return (default 20, max 100)
   * @param offset   - Number of commits to skip (default 0)
   */
  async history(
    filePath?: string,
    limit?: number,
    offset?: number,
  ): Promise<{
    commits: CommitEntry[];
    total: number;
    has_more: boolean;
  }> {
    if (filePath) {
      this.validatePath(filePath);
    }

    if (!this.tracker) {
      return { commits: [], total: 0, has_more: false };
    }

    const effectiveLimit = Math.min(Math.max(limit ?? 20, 1), 100);
    const effectiveOffset = Math.max(offset ?? 0, 0);

    return this.tracker.getLog(filePath, effectiveLimit, effectiveOffset);
  }

  // -----------------------------------------------------------------------
  // diff — rc.ws.diff
  // -----------------------------------------------------------------------

  /**
   * Git diff for the workspace or a specific file.
   *
   * If both `fromCommit` and `toCommit` are omitted, shows uncommitted
   * changes vs HEAD. Output is truncated at 100 KB with a `[...truncated]`
   * marker.
   *
   * @param filePath   - Optional relative path to restrict diff to a single file
   * @param fromCommit - Start commit hash
   * @param toCommit   - End commit hash
   */
  async diff(
    filePath?: string,
    fromCommit?: string,
    toCommit?: string,
  ): Promise<{
    diff: string;
    files_changed: number;
    insertions: number;
    deletions: number;
  }> {
    if (filePath) {
      this.validatePath(filePath);
    }

    if (!this.tracker) {
      return { diff: '', files_changed: 0, insertions: 0, deletions: 0 };
    }

    const result = await this.tracker.getDiff(filePath, fromCommit, toCommit);

    // Truncate diff output if it exceeds the maximum
    let diffOutput = result.diff;
    if (Buffer.byteLength(diffOutput, 'utf-8') > MAX_DIFF_OUTPUT) {
      const truncated = Buffer.from(diffOutput, 'utf-8').subarray(0, MAX_DIFF_OUTPUT);
      diffOutput = truncated.toString('utf-8') + '\n[...truncated]';
    }

    return {
      diff: diffOutput,
      files_changed: result.files_changed,
      insertions: result.insertions,
      deletions: result.deletions,
    };
  }

  // -----------------------------------------------------------------------
  // restore — rc.ws.restore
  // -----------------------------------------------------------------------

  /**
   * Restore a file to its state at a previous commit.
   *
   * The restored content is written to the file and auto-committed with
   * a message like "Restore: <filename> to version <short_hash>".
   *
   * @param filePath   - Relative path of the file to restore
   * @param commitHash - Full or abbreviated commit hash to restore from
   */
  async restore(
    filePath: string,
    commitHash: string,
  ): Promise<{
    ok: boolean;
    path: string;
    restored_from: string;
    new_commit?: string;
  }> {
    this.validatePath(filePath);

    if (!this.tracker) {
      throw new WorkspaceError(
        'Git tracking is not enabled — cannot restore files.',
        WS_COMMIT_NOT_FOUND,
        { path: filePath, hash: commitHash },
      );
    }

    try {
      const result = await this.tracker.restoreFile(filePath, commitHash);

      return {
        ok: true,
        path: filePath,
        restored_from: result.restored_from,
        new_commit: result.commit_hash,
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);

      if (errMsg.includes('not found') || errMsg.includes('NOT_A_COMMIT')) {
        throw new WorkspaceError(
          `Commit ${commitHash} not found in workspace history.`,
          WS_COMMIT_NOT_FOUND,
          { hash: commitHash },
        );
      }

      if (errMsg.includes('does not exist at commit') || errMsg.includes('FILE_NOT_IN_COMMIT')) {
        throw new WorkspaceError(
          `File ${filePath} does not exist at commit ${commitHash}.`,
          WS_FILE_NOT_IN_COMMIT,
          { path: filePath, hash: commitHash },
        );
      }

      throw err;
    }
  }

  // -----------------------------------------------------------------------
  // delete — rc.ws.delete
  // -----------------------------------------------------------------------

  /**
   * Delete a file from the workspace and commit the removal.
   *
   * @param filePath - Relative path within workspace
   */
  async delete(filePath: string): Promise<{ ok: boolean; path: string; committed: boolean }> {
    const fullPath = this.resolvePath(filePath);

    // Check file exists
    try {
      const stat = await fsp.stat(fullPath);
      if (!stat.isFile()) {
        throw new WorkspaceError(
          `Not a file: ${filePath}`,
          WS_FILE_NOT_FOUND,
          { path: filePath },
        );
      }
    } catch (err) {
      if (err instanceof WorkspaceError) throw err;
      throw new WorkspaceError(
        `File not found: ${filePath}`,
        WS_FILE_NOT_FOUND,
        { path: filePath },
      );
    }

    // Delete the file
    await fsp.unlink(fullPath);

    // Auto-commit the deletion if git tracking is enabled
    let committed = false;
    if (this.tracker) {
      try {
        const filename = path.basename(filePath);
        const result = await this.tracker.commitFile(filePath, `Delete: ${filename}`);
        committed = result.committed;
      } catch {
        // Git failure is non-fatal
      }
    }

    return { ok: true, path: filePath, committed };
  }

  // -----------------------------------------------------------------------
  // move — rc.ws.move
  // -----------------------------------------------------------------------

  /**
   * Move or rename a file/directory within the workspace.
   *
   * @param srcPath  - Source relative path within workspace
   * @param destPath - Destination relative path within workspace
   */
  async move(
    srcPath: string,
    destPath: string,
  ): Promise<{ ok: boolean; from: string; to: string; committed: boolean }> {
    const fullSrc = this.resolvePath(srcPath);
    const fullDest = this.resolvePath(destPath);

    // Verify source exists
    try {
      await fsp.stat(fullSrc);
    } catch {
      throw new WorkspaceError(
        `Source not found: ${srcPath}`,
        WS_FILE_NOT_FOUND,
        { path: srcPath },
      );
    }

    // Create destination parent directory if needed
    const destDir = path.dirname(fullDest);
    await fsp.mkdir(destDir, { recursive: true });

    // Move
    await fsp.rename(fullSrc, fullDest);

    // Auto-commit if git tracking is enabled
    let committed = false;
    if (this.tracker) {
      try {
        // Stage both old (deleted) and new (added) paths
        const result = await this.tracker.commitFile(
          destPath,
          `Move: ${path.basename(srcPath)} → ${destPath}`,
        );
        committed = result.committed;
      } catch {
        // Git failure is non-fatal
      }
    }

    return { ok: true, from: srcPath, to: destPath, committed };
  }

  // -----------------------------------------------------------------------
  // destroy
  // -----------------------------------------------------------------------

  /**
   * Clean up resources held by the workspace service.
   *
   * Tears down the git tracker (cancels any pending debounced commits).
   */
  destroy(): void {
    if (this.tracker) {
      this.tracker.destroy();
      this.tracker = null;
    }
  }
}

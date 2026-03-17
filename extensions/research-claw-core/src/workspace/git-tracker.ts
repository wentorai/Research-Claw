/**
 * workspace/git-tracker — Git auto-tracking for workspace files.
 *
 * Uses the system `git` binary via `child_process.execFile` (no JS git libs).
 * All operations are scoped to a workspace root directory. Debounce batching
 * accumulates file paths during a configurable window and flushes them in a
 * single commit.
 */

import { execFile as execFileCb } from 'node:child_process';
import { access, appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFileCb);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Normalized git status values used across the workspace layer. */
export type GitFileStatus = 'new' | 'modified' | 'committed' | 'untracked' | 'deleted';

export interface GitTrackerConfig {
  workspaceRoot: string;
  authorName: string;
  authorEmail: string;
  commitDebounceMs: number;
  maxFileSize: number; // bytes — files larger than this are .gitignored
  enabled: boolean;
}

export interface CommitEntry {
  /** Full 40-character commit hash */
  hash: string;
  /** Short 7-character hash for display */
  short_hash: string;
  /** Commit message */
  message: string;
  /** Author name */
  author: string;
  /** ISO 8601 timestamp */
  timestamp: string;
  /** Number of files changed in this commit */
  files_changed: number;
}

export interface CommitResult {
  committed: boolean;
  hash?: string;
}

export interface LogResult {
  commits: CommitEntry[];
  total: number;
  has_more: boolean;
}

export interface DiffResult {
  diff: string;
  files_changed: number;
  insertions: number;
  deletions: number;
}

export interface RestoreResult {
  restored_from: string;
  committed: boolean;
  commit_hash?: string;
}

export interface GitTracker {
  init(): Promise<void>;
  isAvailable(): Promise<boolean>;
  commitFile(path: string, message: string): Promise<CommitResult>;
  getLog(filePath?: string, limit?: number, offset?: number): Promise<LogResult>;
  getDiff(path?: string, fromCommit?: string, toCommit?: string): Promise<DiffResult>;
  restoreFile(path: string, commitHash: string): Promise<RestoreResult>;
  getFileStatus(path: string): Promise<GitFileStatus>;
  destroy(): void;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class GitTrackerError extends Error {
  override readonly name = 'GitTrackerError';

  constructor(
    message: string,
    public readonly code: string,
    public readonly cause?: unknown,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GIT_EXEC_TIMEOUT_MS = 30_000;
const LOG_MAX_LIMIT = 100;
const LOG_DEFAULT_LIMIT = 20;
/**
 * Pattern that accepts:
 *   - Hex commit hashes (4-40 chars): e.g., "abc1234", "abc1234def5678..."
 *   - HEAD with optional ~N or ^N suffixes: e.g., "HEAD", "HEAD~3", "HEAD^2"
 *   - Branch/tag names with optional ~N or ^N: e.g., "main~1", "v1.0^2"
 *
 * Rejects dangerous characters (spaces, semicolons, backticks, etc.) for security.
 */
const COMMIT_REF_PATTERN = /^[0-9a-fA-F]{4,40}(~\d+|\^\d*)*$|^HEAD(~\d+|\^\d*)*$|^[a-zA-Z_][a-zA-Z0-9_.\-]*(~\d+|\^\d*)*$/;

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
// Path safety
// ---------------------------------------------------------------------------

/**
 * Resolve a user-supplied path against the workspace root and ensure it does
 * not escape the workspace via `..` traversal or absolute-path tricks.
 */
function safePath(workspaceRoot: string, rawPath: string): string {
  const normalizedRoot = resolve(workspaceRoot);
  const resolved = isAbsolute(rawPath)
    ? normalize(rawPath)
    : resolve(normalizedRoot, rawPath);

  if (resolved !== normalizedRoot && !resolved.startsWith(normalizedRoot + sep)) {
    throw new GitTrackerError(
      `Path "${rawPath}" resolves outside workspace root`,
      'PATH_TRAVERSAL',
    );
  }
  return resolved;
}

/**
 * Return the path relative to workspace root (for git commands).
 */
function relPath(workspaceRoot: string, absPath: string): string {
  return relative(resolve(workspaceRoot), absPath);
}

/**
 * Validate a commit ref string to prevent argument injection.
 * Accepts hex hashes, HEAD with suffixes, and branch/tag names with suffixes.
 */
function validateCommitRef(ref: string): void {
  if (!COMMIT_REF_PATTERN.test(ref)) {
    throw new GitTrackerError(
      `Invalid commit ref: ${ref}`,
      'INVALID_COMMIT_REF',
    );
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createGitTracker(config: GitTrackerConfig): GitTracker {
  const {
    workspaceRoot,
    authorName,
    authorEmail,
    commitDebounceMs,
    maxFileSize,
    enabled,
  } = config;

  const root = resolve(workspaceRoot);

  // -- Debounce state -------------------------------------------------------
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  /** Accumulated files to commit in the next debounce flush. Map<relPath, message> */
  const pendingFiles: Map<string, string> = new Map();
  /** Resolvers for all callers waiting on the current debounce window. */
  let debounceResolvers: Array<(result: CommitResult) => void> = [];
  let destroyed = false;

  // -----------------------------------------------------------------------
  // Core helper: run a git command
  // -----------------------------------------------------------------------

  async function execGit(args: string[]): Promise<string> {
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      GIT_AUTHOR_NAME: authorName,
      GIT_AUTHOR_EMAIL: authorEmail,
      GIT_COMMITTER_NAME: authorName,
      GIT_COMMITTER_EMAIL: authorEmail,
      GIT_TERMINAL_PROMPT: '0',
      GIT_EDITOR: 'true',
      GIT_PAGER: 'cat',
    };

    try {
      const { stdout } = await execFileAsync('git', args, {
        cwd: root,
        timeout: GIT_EXEC_TIMEOUT_MS,
        maxBuffer: 10 * 1024 * 1024,
        env,
      });
      return stdout ?? '';
    } catch (err: unknown) {
      const execErr = err as {
        code?: string | number;
        stderr?: string;
        message?: string;
      };
      throw new GitTrackerError(
        `git ${args[0]} failed: ${execErr.stderr?.trim() ?? execErr.message ?? 'unknown error'}`,
        'GIT_EXEC_FAILED',
        err,
      );
    }
  }

  // -----------------------------------------------------------------------
  // .gitignore helpers
  // -----------------------------------------------------------------------

  async function readGitignore(): Promise<string[]> {
    try {
      const content = await readFile(join(root, '.gitignore'), 'utf-8');
      return content.split('\n');
    } catch {
      return [];
    }
  }

  async function writeGitignoreContent(content: string): Promise<void> {
    await writeFile(join(root, '.gitignore'), content, 'utf-8');
  }

  async function ensureGitignored(fileRelPath: string): Promise<void> {
    const lines = await readGitignore();
    const normalized = fileRelPath.replace(/\\/g, '/');
    if (lines.some((l) => l.trim() === normalized)) {
      return;
    }
    const entry = `\n# Auto-added: file exceeds size limit\n${normalized}\n`;
    await appendFile(join(root, '.gitignore'), entry, 'utf-8');
  }

  // -----------------------------------------------------------------------
  // Commit helpers
  // -----------------------------------------------------------------------

  async function hasCommits(): Promise<boolean> {
    try {
      await execGit(['rev-parse', 'HEAD']);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Check whether there are staged changes (returns true if there are).
   */
  async function hasStagedChanges(): Promise<boolean> {
    try {
      await execGit(['diff', '--cached', '--quiet']);
      return false; // exit code 0 = nothing staged
    } catch {
      return true; // exit code 1 = staged changes exist
    }
  }

  /**
   * Perform an immediate commit of everything currently staged.
   * Returns the new commit hash, or null if nothing was committed.
   */
  async function doCommit(message: string): Promise<string | null> {
    const staged = await hasStagedChanges();
    if (!staged) {
      return null;
    }

    await execGit(['commit', '-m', message]);
    const headOut = await execGit(['rev-parse', 'HEAD']);
    return headOut.trim();
  }

  // -----------------------------------------------------------------------
  // Debounce flush: commits all pending files in one batch
  // -----------------------------------------------------------------------

  async function flushPending(): Promise<CommitResult> {
    if (pendingFiles.size === 0) {
      const resolvers = debounceResolvers;
      debounceResolvers = [];
      const result: CommitResult = { committed: false };
      for (const r of resolvers) r(result);
      return result;
    }

    // Snapshot and clear BOTH pending state and resolvers atomically
    // to prevent interleaved commitFile() calls from getting their
    // resolvers resolved by this flush
    const batch = new Map(pendingFiles);
    pendingFiles.clear();
    const resolvers = debounceResolvers;
    debounceResolvers = [];

    try {
      // Stage all pending files in one git add
      const filePaths = [...batch.keys()];
      await execGit(['add', '--', ...filePaths]);

      // Build commit message
      let message: string;
      if (batch.size === 1) {
        const [, msg] = [...batch.entries()][0]!;
        message = msg;
      } else {
        const lines = [...batch.entries()].map(([f, m]) => `  - ${f}: ${m}`);
        message = `Auto-track ${batch.size} files\n\n${lines.join('\n')}`;
      }

      const hash = await doCommit(message);
      const result: CommitResult = hash
        ? { committed: true, hash }
        : { committed: false };

      // Resolve all callers that were waiting on this debounce window
      for (const r of resolvers) r(result);

      return result;
    } catch {
      // On error, resolve the snapshotted resolvers so callers don't hang forever
      const failResult: CommitResult = { committed: false };
      for (const r of resolvers) r(failResult);
      return failResult;
    }
  }

  // -----------------------------------------------------------------------
  // Log parser
  // -----------------------------------------------------------------------

  /**
   * Parse git log output that uses a custom delimiter format:
   *   <delim>%H<delim>%h<delim>%s<delim>%an<delim>%aI
   * followed by --numstat lines.
   */
  function parseLogOutput(output: string, delim: string): CommitEntry[] {
    if (!output.trim()) return [];

    const commits: CommitEntry[] = [];
    const parts = output.split(delim).filter((p) => p.length > 0);

    // Parts come in groups of 5: hash, short_hash, message, author, timestamp+numstat
    let i = 0;
    while (i + 4 < parts.length) {
      const hash = parts[i]!.trim();
      const short_hash = parts[i + 1]!.trim();
      const message = parts[i + 2]!.trim();
      const author = parts[i + 3]!.trim();

      // Last field = ISO timestamp, possibly followed by numstat lines
      const lastField = parts[i + 4]!;
      const fieldLines = lastField.split('\n');
      const timestamp = fieldLines[0]!.trim();

      let filesChanged = 0;
      for (let j = 1; j < fieldLines.length; j++) {
        const line = fieldLines[j]!.trim();
        if (line && (/^\d+\t\d+\t/.test(line) || /^-\t-\t/.test(line))) {
          filesChanged++;
        }
      }

      commits.push({
        hash,
        short_hash,
        message,
        author,
        timestamp,
        files_changed: filesChanged,
      });
      i += 5;
    }

    return commits;
  }

  // -----------------------------------------------------------------------
  // Diff stat parser
  // -----------------------------------------------------------------------

  /**
   * Parse the summary line from `git diff --stat` output.
   * Example: " 3 files changed, 12 insertions(+), 5 deletions(-)"
   */
  function parseDiffStat(statOutput: string): {
    filesChanged: number;
    insertions: number;
    deletions: number;
  } {
    const lines = statOutput.trim().split('\n');
    const summaryLine = lines[lines.length - 1] ?? '';

    const filesMatch = /(\d+)\s+files?\s+changed/.exec(summaryLine);
    const insertMatch = /(\d+)\s+insertions?\(\+\)/.exec(summaryLine);
    const deleteMatch = /(\d+)\s+deletions?\(-\)/.exec(summaryLine);

    return {
      filesChanged: filesMatch ? parseInt(filesMatch[1]!, 10) : 0,
      insertions: insertMatch ? parseInt(insertMatch[1]!, 10) : 0,
      deletions: deleteMatch ? parseInt(deleteMatch[1]!, 10) : 0,
    };
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  const tracker: GitTracker = {
    // -------------------------------------------------------------------
    // init()
    // -------------------------------------------------------------------
    async init(): Promise<void> {
      if (!enabled) return;

      const available = await tracker.isAvailable();
      if (!available) {
        throw new GitTrackerError('git binary not found in PATH', 'GIT_NOT_FOUND');
      }

      // Ensure workspace root directory exists
      await mkdir(root, { recursive: true });

      // Init repo if .git does not exist
      try {
        await access(join(root, '.git'));
      } catch {
        await execGit(['init']);
      }

      // Set local config for author
      await execGit(['config', 'user.name', authorName]);
      await execGit(['config', 'user.email', authorEmail]);

      // Create default .gitignore if missing
      const ignorePath = join(root, '.gitignore');
      let createdIgnore = false;
      try {
        await access(ignorePath);
      } catch {
        await writeGitignoreContent(DEFAULT_GITIGNORE);
        createdIgnore = true;
      }

      // Initial commit if empty repo
      const repoHasCommits = await hasCommits();
      if (!repoHasCommits) {
        await execGit(['add', '.gitignore']);
        await execGit(['commit', '-m', 'Init: workspace tracking enabled']);
      } else if (createdIgnore) {
        // Existing repo but we just created .gitignore
        await execGit(['add', '.gitignore']);
        await execGit(['commit', '-m', 'Add default .gitignore']);
      }
    },

    // -------------------------------------------------------------------
    // isAvailable()
    // -------------------------------------------------------------------
    async isAvailable(): Promise<boolean> {
      try {
        await execFileAsync('git', ['--version'], { timeout: 5_000 });
        return true;
      } catch {
        return false;
      }
    },

    // -------------------------------------------------------------------
    // commitFile(path, message)
    // -------------------------------------------------------------------
    async commitFile(filePath: string, message: string): Promise<CommitResult> {
      if (!enabled || destroyed) return { committed: false };

      const absPath = safePath(root, filePath);
      const rel = relPath(root, absPath);

      // Check file size — if too large, add to .gitignore instead
      try {
        const fileStat = await stat(absPath);
        if (fileStat.size > maxFileSize) {
          await ensureGitignored(rel);
          await execGit(['add', '.gitignore']);
          try {
            await doCommit(
              `Auto-ignore large file: ${rel} (${fileStat.size} bytes)`,
            );
          } catch {
            // .gitignore may already be committed with this entry
          }
          return { committed: false };
        }
      } catch (err: unknown) {
        const fsErr = err as { code?: string };
        // File may have been deleted — git can still track the deletion
        if (fsErr.code !== 'ENOENT') {
          throw new GitTrackerError(
            `Cannot stat file: ${rel}`,
            'FILE_STAT_FAILED',
            err,
          );
        }
      }

      // Add to pending batch
      pendingFiles.set(rel, message);

      // No debounce — commit immediately
      if (commitDebounceMs <= 0) {
        return flushPending();
      }

      // Debounced: reset timer, return a promise resolved on flush
      if (debounceTimer !== null) {
        clearTimeout(debounceTimer);
      }

      return new Promise<CommitResult>((resolvePromise) => {
        debounceResolvers.push(resolvePromise);

        debounceTimer = setTimeout(() => {
          debounceTimer = null;
          // flushPending() internally resolves snapshotted resolvers on both
          // success and error, so .catch() is only needed to suppress
          // unhandled rejection warnings
          flushPending().catch(() => {});
        }, commitDebounceMs);
      });
    },

    // -------------------------------------------------------------------
    // getLog(filePath?, limit?, offset?)
    // -------------------------------------------------------------------
    async getLog(
      filePath?: string,
      limit?: number,
      offset?: number,
    ): Promise<LogResult> {
      const repoHasCommits = await hasCommits();
      if (!repoHasCommits) {
        return { commits: [], total: 0, has_more: false };
      }

      const effectiveLimit = Math.min(
        Math.max(limit ?? LOG_DEFAULT_LIMIT, 1),
        LOG_MAX_LIMIT,
      );
      const effectiveOffset = Math.max(offset ?? 0, 0);

      // Use a delimiter unlikely to appear in commit messages
      const delim = '<<<RC_DELIM>>>';
      const format = `${delim}%H${delim}%h${delim}%s${delim}%an${delim}%aI`;

      const logArgs: string[] = [
        'log',
        `--format=${format}`,
        '--numstat',
        `-n`,
        String(effectiveLimit),
      ];

      if (effectiveOffset > 0) {
        logArgs.push('--skip', String(effectiveOffset));
      }

      // Validate and add file filter
      let validatedRelPath: string | undefined;
      if (filePath !== undefined) {
        const absPath = safePath(root, filePath);
        validatedRelPath = relPath(root, absPath);
        logArgs.push('--', validatedRelPath);
      }

      let logOutput: string;
      try {
        logOutput = await execGit(logArgs);
      } catch {
        return { commits: [], total: 0, has_more: false };
      }

      const commits = parseLogOutput(logOutput, delim);

      // Get total commit count
      const countArgs: string[] = ['rev-list', '--count', 'HEAD'];
      if (validatedRelPath !== undefined) {
        countArgs.push('--', validatedRelPath);
      }

      let total = commits.length;
      try {
        const countOutput = await execGit(countArgs);
        total = parseInt(countOutput.trim(), 10) || commits.length;
      } catch {
        // Fall back to commits.length
      }

      return {
        commits,
        total,
        has_more: effectiveOffset + commits.length < total,
      };
    },

    // -------------------------------------------------------------------
    // getDiff(path?, fromCommit?, toCommit?)
    // -------------------------------------------------------------------
    async getDiff(
      diffPath?: string,
      fromCommit?: string,
      toCommit?: string,
    ): Promise<DiffResult> {
      // Validate path if provided
      let validatedRelPath: string | undefined;
      if (diffPath !== undefined) {
        const absPath = safePath(root, diffPath);
        validatedRelPath = relPath(root, absPath);
      }

      // Validate commit hashes
      if (fromCommit !== undefined) validateCommitRef(fromCommit);
      if (toCommit !== undefined) validateCommitRef(toCommit);

      // Build diff args
      const diffArgs: string[] = ['diff'];
      const statArgs: string[] = ['diff', '--stat', '--stat-width=200'];

      if (fromCommit !== undefined && toCommit !== undefined) {
        // Explicit range: from..to
        const range = `${fromCommit}..${toCommit}`;
        diffArgs.push(range);
        statArgs.push(range);
      } else if (toCommit !== undefined) {
        // Single commit: diff against its parent (toCommit~1..toCommit)
        const range = `${toCommit}~1..${toCommit}`;
        diffArgs.push(range);
        statArgs.push(range);
      } else if (fromCommit !== undefined) {
        // From a commit to working tree
        diffArgs.push(fromCommit);
        statArgs.push(fromCommit);
      } else {
        // Working tree vs HEAD (or empty if no commits yet).
        // Intentionally uses `git diff HEAD` (not `git diff` or `git diff --cached`)
        // to show ALL uncommitted changes (both staged and unstaged) in one view.
        // This is the correct behavior for the dashboard use case.
        const repoHasCommits = await hasCommits();
        if (!repoHasCommits) {
          return { diff: '', files_changed: 0, insertions: 0, deletions: 0 };
        }
        diffArgs.push('HEAD');
        statArgs.push('HEAD');
      }

      if (validatedRelPath !== undefined) {
        diffArgs.push('--', validatedRelPath);
        statArgs.push('--', validatedRelPath);
      }

      // Raw diff text
      let diffText: string;
      try {
        diffText = await execGit(diffArgs);
      } catch {
        diffText = '';
      }

      // Stat summary
      let filesChanged = 0;
      let insertions = 0;
      let deletions = 0;
      try {
        const statOutput = await execGit(statArgs);
        const parsed = parseDiffStat(statOutput);
        filesChanged = parsed.filesChanged;
        insertions = parsed.insertions;
        deletions = parsed.deletions;
      } catch {
        // Leave counts at 0
      }

      return {
        diff: diffText,
        files_changed: filesChanged,
        insertions,
        deletions,
      };
    },

    // -------------------------------------------------------------------
    // restoreFile(path, commitHash)
    // -------------------------------------------------------------------
    async restoreFile(
      filePath: string,
      commitHash: string,
    ): Promise<RestoreResult> {
      const absPath = safePath(root, filePath);
      const rel = relPath(root, absPath);

      validateCommitRef(commitHash);

      // Verify the commit exists and is a commit object
      try {
        const typeOut = await execGit(['cat-file', '-t', commitHash]);
        if (typeOut.trim() !== 'commit') {
          throw new GitTrackerError(
            `${commitHash} is not a commit object`,
            'NOT_A_COMMIT',
          );
        }
      } catch (err: unknown) {
        if (err instanceof GitTrackerError && err.code === 'NOT_A_COMMIT') {
          throw err;
        }
        throw new GitTrackerError(
          `Commit ${commitHash} not found`,
          'COMMIT_NOT_FOUND',
          err,
        );
      }

      // Verify the file exists at that commit
      try {
        await execGit(['show', `${commitHash}:${rel}`]);
      } catch {
        throw new GitTrackerError(
          `File ${rel} does not exist at commit ${commitHash}`,
          'FILE_NOT_IN_COMMIT',
        );
      }

      // Get short hash for the restore message
      const shortHashOut = await execGit(['rev-parse', '--short', commitHash]);
      const shortHash = shortHashOut.trim();

      // Checkout the file from that commit
      await execGit(['checkout', commitHash, '--', rel]);

      // Auto-commit the restored file
      const restoreMsg = `Restore: ${basename(rel)} to version ${shortHash}`;
      await execGit(['add', '--', rel]);

      const staged = await hasStagedChanges();
      if (!staged) {
        // File was already at that version — nothing to commit
        return { restored_from: shortHash, committed: false };
      }

      await execGit(['commit', '-m', restoreMsg]);
      const newHashOut = await execGit(['rev-parse', 'HEAD']);

      return {
        restored_from: shortHash,
        committed: true,
        commit_hash: newHashOut.trim(),
      };
    },

    // -------------------------------------------------------------------
    // getFileStatus(path)
    // -------------------------------------------------------------------
    async getFileStatus(filePath: string): Promise<GitFileStatus> {
      const absPath = safePath(root, filePath);
      const rel = relPath(root, absPath);

      let statusOutput: string;
      try {
        statusOutput = (await execGit(['status', '--porcelain', '--', rel])).trim();
      } catch {
        // Git unavailable — treat as untracked
        return 'untracked';
      }

      if (statusOutput === '') {
        // File is either tracked+clean or does not exist in git at all.
        try {
          await execGit(['ls-files', '--error-unmatch', '--', rel]);
          return 'committed';
        } catch {
          return 'untracked';
        }
      }

      // Porcelain format: XY filename
      const indexCode = statusOutput.charAt(0);
      const worktreeCode = statusOutput.charAt(1);

      // Map raw git statuses to the normalized GitFileStatus union.
      // 'renamed' and 'staged' map to 'modified'; 'copied' maps to 'new'.
      if (indexCode === '?' && worktreeCode === '?') return 'untracked';
      if (indexCode === 'A' || worktreeCode === 'A') return 'new';
      if (indexCode === 'D' || worktreeCode === 'D') return 'deleted';
      if (indexCode === 'R' || worktreeCode === 'R') return 'modified'; // renamed → modified
      if (indexCode === 'C' || worktreeCode === 'C') return 'new';      // copied → new
      if (indexCode === 'M' && worktreeCode === ' ') return 'modified';  // staged → modified
      if (worktreeCode === 'M') return 'modified';
      if (indexCode !== ' ' && indexCode !== '?' && worktreeCode === ' ') return 'modified'; // staged → modified

      return 'modified';
    },

    // -------------------------------------------------------------------
    // destroy()
    // -------------------------------------------------------------------
    destroy(): void {
      destroyed = true;
      if (debounceTimer !== null) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      // Resolve any pending waiters so they don't hang forever
      const resolvers = debounceResolvers;
      debounceResolvers = [];
      for (const r of resolvers) r({ committed: false });
      pendingFiles.clear();
    },
  };

  // Suppress unused-read for `destroyed` (used only in commitFile guard)
  void destroyed;
  // Suppress unused-read for `readGitignore` (used by ensureGitignored via readGitignore)
  void readGitignore;

  return tracker;
}

/**
 * GitHub release / tag discovery + local update runners.
 * Used by rc.app.check_updates, rc.app.apply_update.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import process from 'node:process';

export interface UpdateLogger {
  info: (message: string) => void;
  warn: (message: string) => void;
}

const DEFAULT_REPO = 'wentorai/Research-Claw';

// ── Server-side update-in-progress state ──────────────────────────
// Module-level singleton — survives across RPC calls, reset on process restart.
let _updateInProgress = false;

export function isUpdateRunning(): boolean {
  return _updateInProgress;
}

/**
 * Walk up from `startDir` to find the nearest directory containing `.git`.
 * Returns the git repo root, or `startDir` if no `.git` is found.
 */
export function findGitRoot(startDir: string): string {
  let dir = path.resolve(startDir);
  while (true) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return startDir; // reached filesystem root
    dir = parent;
  }
}

const GH_HEADERS: Record<string, string> = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'Research-Claw-UpdateCheck/1',
};

/** Strip leading "v" from tag names. */
export function stripVersionPrefix(tag: string): string {
  return String(tag).trim().replace(/^v/i, '');
}

/** Parse leading X.Y.Z from a version string. */
export function parseSemver(s: string): [number, number, number] | null {
  const m = stripVersionPrefix(s).match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** >0 if a > b, <0 if a < b, 0 if equal or incomparable. */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return stripVersionPrefix(a).localeCompare(stripVersionPrefix(b));
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

function readLocalVersion(repoRoot: string): string {
  try {
    const pkgPath = path.join(repoRoot, 'package.json');
    const raw = fs.readFileSync(pkgPath, 'utf8');
    const pkg = JSON.parse(raw) as { version?: string };
    if (typeof pkg.version === 'string' && pkg.version.trim()) {
      return pkg.version.trim();
    }
  } catch {
    /* ignore */
  }
  return '0.0.0';
}

function authHeaders(): Record<string, string> {
  const token = process.env.GITHUB_TOKEN?.trim();
  if (!token) return GH_HEADERS;
  return { ...GH_HEADERS, Authorization: `Bearer ${token}` };
}

async function fetchLatestFromGitHub(repo: string): Promise<{
  version: string;
  latestTag: string;
  releaseUrl: string | null;
  publishedAt: string | null;
}> {
  const headers = authHeaders();
  const releaseRes = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, { headers });
  if (releaseRes.ok) {
    const j = (await releaseRes.json()) as {
      tag_name?: string;
      html_url?: string;
      published_at?: string;
    };
    const tag = typeof j.tag_name === 'string' ? j.tag_name : '';
    if (!tag) throw new Error('GitHub release missing tag_name');
    return {
      version: stripVersionPrefix(tag),
      latestTag: tag,
      releaseUrl: typeof j.html_url === 'string' ? j.html_url : null,
      publishedAt: typeof j.published_at === 'string' ? j.published_at : null,
    };
  }

  const tagsRes = await fetch(`https://api.github.com/repos/${repo}/tags?per_page=30`, { headers });
  if (!tagsRes.ok) {
    throw new Error(`GitHub API: releases ${releaseRes.status}, tags ${tagsRes.status}`);
  }
  const tags = (await tagsRes.json()) as Array<{ name?: string }>;
  for (const t of tags) {
    const name = typeof t.name === 'string' ? t.name : '';
    if (name && parseSemver(stripVersionPrefix(name))) {
      return {
        version: stripVersionPrefix(name),
        latestTag: name,
        releaseUrl: `https://github.com/${repo}/releases/tag/${encodeURIComponent(name)}`,
        publishedAt: null,
      };
    }
  }
  throw new Error('No semver tag found on GitHub');
}

export interface CheckUpdatesResult {
  current: string;
  latest: string | null;
  latestTag: string | null;
  upToDate: boolean;
  releaseUrl: string | null;
  publishedAt: string | null;
  repoRoot: string;
  shellUpdateHint: string;
  error?: string;
}

export async function checkUpdates(repoRoot: string, repoFullName = DEFAULT_REPO): Promise<CheckUpdatesResult> {
  const current = readLocalVersion(repoRoot);
  const isWindows = process.platform === 'win32';
  const shellUpdateHint = isWindows
    ? `cd "${repoRoot.replace(/"/g, '`"')}"; git pull --ff-only; pnpm install; pnpm build`
    : `cd '${repoRoot.replace(/'/g, "'\\''")}' && git pull --ff-only && pnpm install && pnpm build`;

  try {
    const remote = await fetchLatestFromGitHub(repoFullName);
    const cmp = compareSemver(current, remote.version);
    const upToDate = cmp >= 0;
    return {
      current,
      latest: remote.version,
      latestTag: remote.latestTag,
      upToDate,
      releaseUrl: remote.releaseUrl,
      publishedAt: remote.publishedAt,
      repoRoot,
      shellUpdateHint,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      current,
      latest: null,
      latestTag: null,
      upToDate: true,
      releaseUrl: `https://github.com/${repoFullName}/releases`,
      publishedAt: null,
      repoRoot,
      shellUpdateHint,
      error: message,
    };
  }
}

function runCmd(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env },
      shell: false,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`Timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (c: string) => {
      stdout += c;
    });
    child.stderr?.on('data', (c: string) => {
      stderr += c;
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

/**
 * Run update script (git pull --ff-only, pnpm install, pnpm build).
 * - macOS / Linux: scripts/update-research-claw.sh (bash)
 * - Windows: scripts/update-research-claw.ps1 (PowerShell)
 */
export async function applyUpdate(repoRoot: string, logger: UpdateLogger): Promise<{ ok: boolean; log: string }> {
  if (_updateInProgress) {
    throw new Error('An update is already in progress.');
  }

  const isWindows = process.platform === 'win32';
  const gitDir = path.join(repoRoot, '.git');
  if (!fs.existsSync(gitDir)) {
    throw new Error('Not a git clone — download releases from GitHub or clone the repository to enable updates.');
  }

  let script: string;
  let command: string;
  let args: string[];

  if (isWindows) {
    script = path.join(repoRoot, 'scripts', 'update-research-claw.ps1');
    if (!fs.existsSync(script)) {
      throw new Error('update-research-claw.ps1 not found — sync your checkout or update manually.');
    }
    command = 'powershell';
    args = ['-ExecutionPolicy', 'Bypass', '-File', script];
  } else {
    script = path.join(repoRoot, 'scripts', 'update-research-claw.sh');
    if (!fs.existsSync(script)) {
      throw new Error('update-research-claw.sh not found — sync your checkout or update manually.');
    }
    command = 'bash';
    args = [script];
  }

  _updateInProgress = true;
  logger.info('[rc.app.apply_update] starting update script');
  try {
    const r = await runCmd(command, args, repoRoot, 30 * 60 * 1000);
    const log = `${r.stdout}\n${r.stderr}`.trim();
    if (r.code !== 0) {
      logger.warn(`[rc.app.apply_update] failed exit=${r.code}`);
      throw new Error(log || `Update script exited with code ${r.code}`);
    }
    logger.info('[rc.app.apply_update] finished OK');
    return { ok: true, log: log || '(no output)' };
  } finally {
    _updateInProgress = false;
  }
}

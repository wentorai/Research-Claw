/**
 * path-guard — single source of truth for workspace path containment.
 *
 * Every user-controlled path surface (WorkspaceService, rc.ws.openExternal /
 * openFolder, POST /rc/upload, GET /rc/download) funnels through
 * resolveWithinRoot: relative-path validation, prefix containment, and a
 * symlink-escape walk. Call sites map PathEscapeError onto their own error
 * shape (WorkspaceError / RPC code -32001 / HTTP JSON codes).
 *
 * GitTracker's internal safePath prefix check intentionally stays separate:
 * it is defense-in-depth behind service-validated inputs and accepts
 * absolute-inside-root paths, which this guard (by design) does not.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export class PathEscapeError extends Error {
  override readonly name = 'PathEscapeError';
  constructor(
    message: string,
    public readonly path: string,
  ) {
    super(message);
  }
}

/** Reject empty, null-byte, absolute, and `..`-traversal relative paths.
 *  Accepts '.' (the root itself). */
export function validateRelPath(p: string): void {
  if (!p || typeof p !== 'string') {
    throw new PathEscapeError('Invalid path: path must be a non-empty string.', p);
  }
  if (p.includes('\0')) {
    throw new PathEscapeError('Invalid path: null bytes are not allowed.', p);
  }
  if (path.isAbsolute(p) || p.startsWith('/') || p.startsWith('\\')) {
    throw new PathEscapeError('Invalid path: absolute paths are not allowed.', p);
  }
  // Normalize and check for traversal
  const normalized = path.normalize(p);
  if (normalized.startsWith('..') || normalized.includes(`${path.sep}..`)) {
    throw new PathEscapeError('Invalid path: directory traversal is not allowed.', p);
  }
  // Also check the raw string for `..` segments (covers mixed separators)
  const segments = p.replace(/\\/g, '/').split('/');
  if (segments.some((s) => s === '..')) {
    throw new PathEscapeError('Invalid path: directory traversal is not allowed.', p);
  }
}

/**
 * Resolve `relativePath` against `root`, guaranteeing the result stays within
 * the root — including through symlinks: walks up from the resolved path to
 * the first existing ancestor and realpath-checks it, so a link at any depth
 * (e.g. workspace/a → /tmp/x) cannot smuggle reads or writes outside.
 */
export function resolveWithinRoot(root: string, relativePath: string): string {
  validateRelPath(relativePath);
  const resolved = path.resolve(root, relativePath);

  // Double-check the resolved path is still within the root
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new PathEscapeError('Invalid path: resolved path escapes workspace root.', relativePath);
  }

  try {
    const realRoot = fs.realpathSync(root);
    let checkPath = resolved;
    while (checkPath !== realRoot && checkPath !== path.dirname(checkPath)) {
      try {
        const real = fs.realpathSync(checkPath);
        if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
          throw new PathEscapeError(
            'Invalid path: resolves outside workspace root via symlink.',
            relativePath,
          );
        }
        break; // Found existing path within bounds — safe
      } catch (e) {
        if (e instanceof PathEscapeError) throw e;
        // ENOENT: path doesn't exist yet, check parent
        checkPath = path.dirname(checkPath);
      }
    }
  } catch (e) {
    if (e instanceof PathEscapeError) throw e;
    // If realpath on root fails, skip symlink check entirely
  }

  return resolved;
}

/**
 * workspace/rpc — 11 Gateway WS RPC Handlers
 *
 * Registers rc.ws.tree, rc.ws.read, rc.ws.save, rc.ws.history, rc.ws.diff,
 * rc.ws.restore, rc.ws.delete, rc.ws.saveImage, rc.ws.openExternal,
 * rc.ws.openFolder, and rc.ws.move as gateway WebSocket RPC methods.
 *
 * rc.ws.upload is HTTP-only (POST /rc/upload) and is NOT registered here.
 * It should be registered as an HTTP route in the plugin entry point (index.ts).
 *
 * All handlers delegate to WorkspaceService. Errors thrown by WorkspaceService
 * are caught and re-thrown for the gateway framework to handle.
 */

import { exec } from 'node:child_process';
import * as path from 'node:path';
import type { WorkspaceService } from './service.js';
import type { RegisterMethod } from '../types.js';

// ---------------------------------------------------------------------------
// Parameter validation helpers
// ---------------------------------------------------------------------------

function requireString(
  params: Record<string, unknown>,
  name: string,
): string {
  const value = params[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw Object.assign(
      new Error(`Missing required parameter: ${name}`),
      { code: -32602, data: { parameter: name } },
    );
  }
  return value;
}

function optionalString(
  params: Record<string, unknown>,
  name: string,
): string | undefined {
  const value = params[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw Object.assign(
      new Error(`Parameter ${name} must be a string.`),
      { code: -32602, data: { parameter: name } },
    );
  }
  return value;
}

function optionalNumber(
  params: Record<string, unknown>,
  name: string,
): number | undefined {
  const value = params[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw Object.assign(
      new Error(`Parameter ${name} must be a finite number.`),
      { code: -32602, data: { parameter: name } },
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

function mapError(err: unknown): never {
  if (err instanceof Error) throw err;
  throw new Error(String(err));
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Register the 7 workspace WS RPC methods with the gateway.
 *
 * @param registerMethod - Function to register a gateway RPC method
 * @param service        - WorkspaceService instance to delegate operations to
 * @param wsRoot         - Absolute path to workspace root (for openExternal/openFolder)
 *
 * Methods registered:
 * - rc.ws.tree         — Directory tree listing
 * - rc.ws.read         — Read a single file
 * - rc.ws.save         — Write content to a file with optional auto-commit
 * - rc.ws.history      — Paginated git log
 * - rc.ws.diff         — Git diff (uncommitted or between commits)
 * - rc.ws.restore      — Restore a file to a historical version
 * - rc.ws.delete       — Delete a file from the workspace
 * - rc.ws.openExternal — Open a file with the system default application
 * - rc.ws.openFolder   — Open the containing folder in the system file manager
 *
 * Note: rc.ws.upload is HTTP-only (POST /rc/upload) and must be registered
 * as an HTTP route in index.ts, not here.
 */
export function registerWorkspaceRpc(
  registerMethod: RegisterMethod,
  service: WorkspaceService,
  wsRoot?: string,
): void {
  // -----------------------------------------------------------------------
  // 1. rc.ws.tree — Directory tree for the dashboard sidebar
  //    params: { root?: string, depth?: number, includeHidden?: boolean }
  // -----------------------------------------------------------------------
  registerMethod('rc.ws.tree', async (params: Record<string, unknown>) => {
    try {
      const root = optionalString(params, 'root');
      const depth = optionalNumber(params, 'depth');
      const includeHidden = params.includeHidden === true;

      return service.tree(root, depth, includeHidden);
    } catch (err) {
      mapError(err);
    }
  });

  // -----------------------------------------------------------------------
  // 2. rc.ws.read — Read a single file for the dashboard preview pane
  //    params: { path: string }
  // -----------------------------------------------------------------------
  registerMethod('rc.ws.read', async (params: Record<string, unknown>) => {
    try {
      const filePath = requireString(params, 'path');

      return service.read(filePath);
    } catch (err) {
      mapError(err);
    }
  });

  // -----------------------------------------------------------------------
  // 3. rc.ws.save — Write content to a workspace file with optional commit
  //    params: { path: string, content?: string, message?: string }
  //    content defaults to '' (empty) to support creating new empty files.
  // -----------------------------------------------------------------------
  registerMethod('rc.ws.save', async (params: Record<string, unknown>) => {
    try {
      const filePath = requireString(params, 'path');
      const content = typeof params.content === 'string' ? params.content : (optionalString(params, 'content') ?? '');
      const message = optionalString(params, 'message');

      return service.save(filePath, content, message);
    } catch (err) {
      mapError(err);
    }
  });

  // -----------------------------------------------------------------------
  // 4. rc.ws.history — Paginated git log for the dashboard timeline
  //    params: { path?: string, limit?: number, offset?: number }
  // -----------------------------------------------------------------------
  registerMethod('rc.ws.history', async (params: Record<string, unknown>) => {
    try {
      const filePath = optionalString(params, 'path');
      const limit = optionalNumber(params, 'limit');
      const offset = optionalNumber(params, 'offset');

      return service.history(filePath, limit, offset);
    } catch (err) {
      mapError(err);
    }
  });

  // -----------------------------------------------------------------------
  // 5. rc.ws.diff — Git diff for the dashboard diff viewer
  //    params: { path?: string, from?: string, to?: string }
  // -----------------------------------------------------------------------
  registerMethod('rc.ws.diff', async (params: Record<string, unknown>) => {
    try {
      const filePath = optionalString(params, 'path');
      const from = optionalString(params, 'from');
      const to = optionalString(params, 'to');

      return service.diff(filePath, from, to);
    } catch (err) {
      mapError(err);
    }
  });

  // -----------------------------------------------------------------------
  // 6. rc.ws.restore — Restore a file to a historical version
  //    params: { path: string, commit: string }
  // -----------------------------------------------------------------------
  registerMethod('rc.ws.restore', async (params: Record<string, unknown>) => {
    try {
      const filePath = requireString(params, 'path');
      const commit = requireString(params, 'commit');

      return service.restore(filePath, commit);
    } catch (err) {
      mapError(err);
    }
  });

  // -----------------------------------------------------------------------
  // 7. rc.ws.delete — Delete a file from the workspace
  //    params: { path: string }
  // -----------------------------------------------------------------------
  registerMethod('rc.ws.delete', async (params: Record<string, unknown>) => {
    try {
      const filePath = requireString(params, 'path');
      return service.delete(filePath);
    } catch (err) {
      mapError(err);
    }
  });

  // -----------------------------------------------------------------------
  // 8. rc.ws.saveImage — Save a base64-encoded image to workspace
  //    params: { path: string, base64: string, mimeType?: string }
  //    Used by the dashboard to persist chat image uploads so that the
  //    agent's /image tool (imageModel) can access them by file path.
  // -----------------------------------------------------------------------
  registerMethod('rc.ws.saveImage', async (params: Record<string, unknown>) => {
    try {
      const filePath = requireString(params, 'path');
      const base64 = requireString(params, 'base64');
      const buffer = Buffer.from(base64, 'base64');
      const result = await service.save(filePath, buffer, 'Upload chat image');
      return { path: result.path, size: result.size };
    } catch (err) {
      mapError(err);
    }
  });

  // -----------------------------------------------------------------------
  // 9. rc.ws.openExternal — Open a file with the system default application
  //    params: { path: string }
  //    On macOS, falls back to `open -t` (default text editor) if the
  //    default `open` fails — handles .tex, .bib, .r, etc. that may not
  //    have an associated app.
  // -----------------------------------------------------------------------
  registerMethod('rc.ws.openExternal', async (params: Record<string, unknown>) => {
    const filePath = requireString(params, 'path');
    if (!wsRoot) throw new Error('Workspace root not configured');

    // Resolve and validate path stays within workspace
    const resolved = path.resolve(wsRoot, filePath);
    if (!resolved.startsWith(path.resolve(wsRoot) + path.sep) && resolved !== path.resolve(wsRoot)) {
      throw Object.assign(new Error('Path escapes workspace root'), { code: -32001 });
    }

    const quoted = JSON.stringify(resolved);
    const run = (cmd: string) =>
      new Promise<void>((res, rej) => exec(cmd, (err) => (err ? rej(err) : res())));

    if (process.platform === 'darwin') {
      try {
        await run(`open ${quoted}`);
      } catch (firstErr) {
        // Fallback: open with default text editor (handles .tex, .bib, .r, etc.)
        // Only for files — `open -t` doesn't work on directories.
        const ext = path.extname(resolved);
        if (ext) {
          await run(`open -t ${quoted}`).catch(() => {
            throw new Error(`Failed to open file: ${(firstErr as Error).message}`);
          });
        } else {
          throw new Error(`Failed to open file: ${(firstErr as Error).message}`);
        }
      }
    } else if (process.platform === 'win32') {
      await run(`start "" ${quoted}`).catch((err) => {
        throw new Error(`Failed to open file: ${err.message}`);
      });
    } else {
      await run(`xdg-open ${quoted}`).catch((err) => {
        throw new Error(`Failed to open file: ${err.message}`);
      });
    }

    return { ok: true };
  });

  // -----------------------------------------------------------------------
  // 9. rc.ws.openFolder — Open the containing folder in the system file manager
  //    params: { path: string }
  // -----------------------------------------------------------------------
  registerMethod('rc.ws.openFolder', async (params: Record<string, unknown>) => {
    const filePath = requireString(params, 'path');
    if (!wsRoot) throw new Error('Workspace root not configured');

    // Resolve and validate path stays within workspace
    const resolved = path.resolve(wsRoot, filePath);
    if (!resolved.startsWith(path.resolve(wsRoot) + path.sep) && resolved !== path.resolve(wsRoot)) {
      throw Object.assign(new Error('Path escapes workspace root'), { code: -32001 });
    }

    const dir = path.dirname(resolved);
    const cmd = process.platform === 'darwin'
      ? `open ${JSON.stringify(dir)}`
      : process.platform === 'win32'
        ? `explorer ${JSON.stringify(dir)}`
        : `xdg-open ${JSON.stringify(dir)}`;

    return new Promise<{ ok: boolean }>((resolve, reject) => {
      exec(cmd, (err) => {
        if (err) reject(new Error(`Failed to open folder: ${err.message}`));
        else resolve({ ok: true });
      });
    });
  });

  // -----------------------------------------------------------------------
  // 10. rc.ws.mkdir — Create an empty directory in the workspace
  //     params: { path: string }
  //     Creates the directory (recursive) and adds a .gitkeep for git tracking.
  // -----------------------------------------------------------------------
  registerMethod('rc.ws.mkdir', async (params: Record<string, unknown>) => {
    try {
      const dirPath = requireString(params, 'path');
      // Create directory, then save a .gitkeep to ensure git tracks it
      const gitkeepPath = dirPath.replace(/\/$/, '') + '/.gitkeep';
      const result = await service.save(gitkeepPath, '', `Add: ${dirPath.split('/').pop()}/`);
      return { ok: true, path: dirPath, committed: result.committed };
    } catch (err) {
      mapError(err);
    }
  });

  // -----------------------------------------------------------------------
  // 11. rc.ws.move — Move or rename a file/directory within the workspace
  //     params: { from: string, to: string }
  // -----------------------------------------------------------------------
  registerMethod('rc.ws.move', async (params: Record<string, unknown>) => {
    try {
      const from = requireString(params, 'from');
      const to = requireString(params, 'to');

      return service.move(from, to);
    } catch (err) {
      mapError(err);
    }
  });
}

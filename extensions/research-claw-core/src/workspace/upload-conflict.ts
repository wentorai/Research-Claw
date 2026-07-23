/**
 * Upload conflict resolution for POST /rc/upload.
 *
 * The conflict policy lives at the HTTP handler level ONLY: WorkspaceService.save()
 * keeps its overwrite-as-Update semantics because editor saves (rc.ws.save),
 * chat image saves (rc.ws.saveImage), mkdir's .gitkeep and the agent tools all
 * depend on it. Uploads default to 'fail' so a duplicate name returns
 * 409 UPLOAD_FILE_EXISTS instead of silently replacing the existing file.
 */

import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

export type UploadConflictMode = 'fail' | 'overwrite' | 'rename';

/** Coerce the client-supplied onConflict field; unknown/absent values fail closed. */
export function normalizeConflictMode(raw: string | undefined): UploadConflictMode {
  return raw === 'overwrite' || raw === 'rename' ? raw : 'fail';
}

/** Finder-style "name (2).ext" candidate for the nth attempt (n >= 2). */
export function finderStyleName(fileName: string, n: number | string): string {
  const dot = fileName.lastIndexOf('.');
  // Treat dotfiles (".env") and extension-less names as having no extension.
  if (dot <= 0) return `${fileName} (${n})`;
  return `${fileName.slice(0, dot)} (${n})${fileName.slice(dot)}`;
}

export type UploadConflictResolution =
  | { action: 'proceed'; fileName: string; renamed: boolean }
  | { action: 'conflict'; existing: 'file' | 'directory' };

/**
 * Decide what to do about a potential name collision in `absDir`.
 *
 * - 'fail': anything already at the target → conflict (409).
 * - 'overwrite': proceed with the original name; a DIRECTORY at the target is
 *   still a conflict (a file can never overwrite a directory).
 * - 'rename': walk "name (2).ext", "name (3).ext", … until a free slot.
 *
 * The check is adjacent to the write but not atomic with it (same accepted
 * TOCTOU tradeoff as WorkspaceService.move()).
 */
export async function resolveUploadConflict(
  absDir: string,
  fileName: string,
  mode: UploadConflictMode,
): Promise<UploadConflictResolution> {
  const existing = await statType(path.join(absDir, fileName));
  if (existing === null) {
    return { action: 'proceed', fileName, renamed: false };
  }
  if (mode === 'fail') {
    return { action: 'conflict', existing };
  }
  if (mode === 'overwrite') {
    if (existing === 'directory') return { action: 'conflict', existing };
    return { action: 'proceed', fileName, renamed: false };
  }
  // mode === 'rename': find the first free Finder-style candidate.
  for (let n = 2; n < 1000; n++) {
    const candidate = finderStyleName(fileName, n);
    if ((await statType(path.join(absDir, candidate))) === null) {
      return { action: 'proceed', fileName: candidate, renamed: true };
    }
  }
  // Pathological directory with 998 taken slots — fall back to a random
  // suffix (collision-safe even for concurrent uploads in the same instant).
  const fallback = finderStyleName(fileName, randomUUID().slice(0, 8));
  return { action: 'proceed', fileName: fallback, renamed: true };
}

async function statType(absPath: string): Promise<'file' | 'directory' | null> {
  try {
    const stat = await fsp.stat(absPath);
    return stat.isDirectory() ? 'directory' : 'file';
  } catch {
    return null;
  }
}

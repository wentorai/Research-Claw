/**
 * File-reference helpers shared by the composer drag/drop, the `@` mention
 * menu, and the chat send pipeline.
 *
 * A "reference" is always a WORKSPACE-RELATIVE path (e.g. "sources/chat/data.csv").
 * Agent file tools are workspace-scoped (application-layer path enforcement;
 * deployment-level isolation comes from running the whole product in Docker),
 * so only relative paths reachable via workspace_read are injected into prompts.
 */

/** Client-side soft cap for ingesting external files. The gateway streams
 *  uploads to disk (O(1) memory) with its own 2GB default cap
 *  (workspace.maxUploadSize) — this front gate just keeps accidental
 *  huge drops from tying up the UI. */
export const MAX_REFERENCE_SIZE = 1024 * 1024 * 1024; // 1GB

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|tiff?|heic|heif|svg|avif)$/i;

/** Chat-composer inbox: raw non-image drops land here (timestamped), keeping
 *  the sources/ root curated. Folder drops nest under a timestamped root. */
export const CHAT_DROP_DIR = 'sources/chat';

/** Chat-originated images (drop / paste / attach button / vision attachments).
 *  Separate subdir so screenshots don't mix with document drops. Only NEW
 *  ingests land here — existing files are never moved. */
export const CHAT_IMAGE_DIR = 'sources/chat/images';

/** Destination for a loose file dropped into the chat composer: images go to
 *  the chat image dir (they also ride inline as vision attachments); everything
 *  else lands in the chat inbox. */
export function composerDropDestination(
  name: string,
  isImageMime: boolean,
): typeof CHAT_IMAGE_DIR | typeof CHAT_DROP_DIR {
  return isImagePath(name) || isImageMime ? CHAT_IMAGE_DIR : CHAT_DROP_DIR;
}

/** True when a path/filename looks like an image by extension. */
export function isImagePath(pathOrName: string): boolean {
  return IMAGE_EXT_RE.test(pathOrName);
}

/** Last path segment of a relative/absolute path (handles / and \). */
export function basenameOf(path: string): string {
  const norm = path.replace(/[\\/]+$/, '');
  const idx = Math.max(norm.lastIndexOf('/'), norm.lastIndexOf('\\'));
  return idx >= 0 ? norm.slice(idx + 1) : norm;
}

/** Sanitize a filename for workspace upload (mirrors gateway's filename rules). */
export function safeUploadName(name: string): string {
  return name
    .replace(/\0/g, '')
    .replace(/[\\/]/g, '_')
    .replace(/[\x00-\x1f]/g, '')
    .trim() || 'file';
}

/** Timestamp-prefixed name that makes composer ingests collision-free up
 *  front (uploads default to onConflict:'fail', so a duplicate name would 409
 *  rather than overwrite). Mirrors the existing image naming `${ts}-${safeName}`. */
export function timestampedUploadName(name: string, now: number): string {
  return `${now}-${safeUploadName(name)}`;
}

/** Stable de-dupe of paths, preserving first-seen order. */
export function dedupePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of paths) {
    if (!seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
  }
  return out;
}

export const REFERENCE_BLOCK_HEADER = '[引用文件 / Referenced files]';

/**
 * Build the structured reference block appended to an outgoing message.
 * Returns '' when there are no valid paths.
 */
export function buildReferenceBlock(paths: string[]): string {
  const unique = dedupePaths(paths.map((p) => p?.trim()).filter((p): p is string => !!p));
  if (unique.length === 0) return '';
  return `${REFERENCE_BLOCK_HEADER}\n${unique.map((p) => `- @${p}`).join('\n')}`;
}

/** Append the reference block to a message body (with a blank-line separator). */
export function appendReferenceBlock(message: string, paths: string[]): string {
  const block = buildReferenceBlock(paths);
  if (!block) return message;
  return message ? `${message}\n\n${block}` : block;
}

/**
 * Drag-and-drop ingestion helpers shared by the composer (chat references) and
 * the Workspace panel (explicit upload).
 *
 * Browsers expose dropped *directories* only through the non-standard
 * `DataTransferItem.webkitGetAsEntry()` filesystem API — `dataTransfer.files`
 * contains loose files but silently omits directory contents. This module
 * walks the entry tree and flattens it into a list of files, each tagged with
 * its path relative to the drop, so callers can recreate the directory
 * structure on upload.
 *
 * No content filtering happens here: every file under a dropped folder is
 * returned (including dotfiles / nested folders). Callers decide what to skip.
 */

export interface DroppedFile {
  file: File;
  /**
   * Path relative to the drop root. For a dropped folder this includes the top
   * folder name, e.g. "myfolder/sub/a.txt". For a loose top-level file it is
   * just the filename.
   */
  relPath: string;
  /** Top-level dropped directory name, or null for a loose (non-folder) file. */
  rootDir: string | null;
}

export interface CollectedDrop {
  files: DroppedFile[];
  /** True when at least one dropped item was a directory (entries API was used). */
  hadDirectory: boolean;
}

/** Bulk-confirmation thresholds (shared so composer and panel behave alike). */
export const MAX_DROP_FILES = 200;
export const MAX_DROP_TOTAL_BYTES = 200 * 1024 * 1024; // 200MB
/** Parallel upload fan-out — kept modest to avoid saturating the local gateway. */
export const UPLOAD_CONCURRENCY = 5;

interface EntryReader {
  readEntries: (onSuccess: (entries: EntryLike[]) => void, onError?: (e: unknown) => void) => void;
}

interface EntryLike {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file?: (onSuccess: (f: File) => void, onError?: (e: unknown) => void) => void;
  createReader?: () => EntryReader;
}

function fileFromEntry(entry: EntryLike): Promise<File | null> {
  return new Promise((resolve) => {
    if (typeof entry.file !== 'function') {
      resolve(null);
      return;
    }
    entry.file(
      (f) => resolve(f),
      () => resolve(null),
    );
  });
}

function readEntriesBatch(reader: EntryReader): Promise<EntryLike[]> {
  return new Promise((resolve) => {
    reader.readEntries(
      (entries) => resolve(entries),
      () => resolve([]),
    );
  });
}

async function walkDirectory(
  dir: EntryLike,
  prefix: string,
  rootDir: string,
  out: DroppedFile[],
): Promise<void> {
  if (typeof dir.createReader !== 'function') return;
  const reader = dir.createReader();
  // readEntries() returns at most ~100 entries per call and signals completion
  // with an empty batch — loop until drained.
  let batch: EntryLike[];
  do {
    batch = await readEntriesBatch(reader);
    for (const child of batch) {
      const childPath = `${prefix}/${child.name}`;
      if (child.isDirectory) {
        await walkDirectory(child, childPath, rootDir, out);
      } else {
        const file = await fileFromEntry(child);
        if (file) out.push({ file, relPath: childPath, rootDir });
      }
    }
  } while (batch.length > 0);
}

/**
 * Flatten a drop into a list of files, expanding any dropped directories.
 *
 * IMPORTANT: the synchronous portion (capturing entries from `dataTransfer.items`)
 * runs before the first await, so this MUST be called directly inside the drop
 * event handler — the DataTransferItemList is only valid during event dispatch.
 */
export async function collectDroppedEntries(dt: DataTransfer): Promise<CollectedDrop> {
  const items = dt.items;
  // Capture entries synchronously — the item list is invalidated after the
  // first await, so we cannot read webkitGetAsEntry() lazily.
  const entries: EntryLike[] = [];
  let supportsEntries = false;
  if (items && items.length > 0) {
    for (let i = 0; i < items.length; i++) {
      const getAsEntry = (items[i] as unknown as {
        webkitGetAsEntry?: () => EntryLike | null;
      }).webkitGetAsEntry;
      if (typeof getAsEntry === 'function') {
        supportsEntries = true;
        const entry = getAsEntry.call(items[i]);
        if (entry) entries.push(entry);
      }
    }
  }

  if (!supportsEntries) {
    // Fallback: directory expansion unavailable — loose files only.
    const files = dt.files ? Array.from(dt.files) : [];
    return {
      files: files.map((file) => ({ file, relPath: file.name, rootDir: null })),
      hadDirectory: false,
    };
  }

  const out: DroppedFile[] = [];
  let hadDirectory = false;
  for (const entry of entries) {
    if (entry.isDirectory) {
      hadDirectory = true;
      await walkDirectory(entry, entry.name, entry.name, out);
    } else {
      const file = await fileFromEntry(entry);
      if (file) out.push({ file, relPath: file.name, rootDir: null });
    }
  }
  return { files: out, hadDirectory };
}

export interface DropPolicyOptions {
  /** Per-file size cap in bytes; larger files are skipped with one combined warning. */
  maxFileSize: number;
  warnOversize: (count: number, limitMb: number) => void;
  /** Asked once when the batch exceeds MAX_DROP_FILES / MAX_DROP_TOTAL_BYTES. */
  confirmBulk: (count: number, totalMb: number) => Promise<boolean>;
}

/**
 * Shared drop policy for the composer and the Workspace panel: skip oversized
 * files and gate very large batches behind a confirmation. Returns the files
 * to upload ([] when nothing survives), or null when the user cancels.
 */
export async function applyDropPolicy(
  collected: CollectedDrop,
  opts: DropPolicyOptions,
): Promise<DroppedFile[] | null> {
  const all = collected.files;
  if (all.length === 0) return [];
  const oversized = all.filter((d) => d.file.size > opts.maxFileSize);
  const kept = all.filter((d) => d.file.size <= opts.maxFileSize);
  if (oversized.length > 0) {
    opts.warnOversize(oversized.length, Math.round(opts.maxFileSize / (1024 * 1024)));
  }
  if (kept.length === 0) return kept;
  const totalBytes = kept.reduce((sum, d) => sum + d.file.size, 0);
  if (kept.length > MAX_DROP_FILES || totalBytes > MAX_DROP_TOTAL_BYTES) {
    const ok = await opts.confirmBulk(kept.length, Math.round(totalBytes / (1024 * 1024)));
    if (!ok) return null;
  }
  return kept;
}

/**
 * Split a relative path into a (subdirectory, filename) pair, dropping a known
 * root-folder prefix and sanitizing each directory segment with `sanitizeSeg`.
 * The filename is returned raw (callers sanitize it for the upload separately).
 */
export function splitRelPath(
  relPath: string,
  rootDir: string | null,
  sanitizeSeg: (s: string) => string,
): { subDir: string; fileName: string } {
  let rel = relPath;
  if (rootDir && rel.startsWith(`${rootDir}/`)) {
    rel = rel.slice(rootDir.length + 1);
  }
  const segs = rel.split('/').filter(Boolean);
  const fileName = segs.pop() ?? relPath;
  const subDir = segs.map(sanitizeSeg).filter(Boolean).join('/');
  return { subDir, fileName };
}

/**
 * Run `fn` over `items` with at most `limit` concurrent in-flight calls.
 * Resolves to results in input order. Individual rejections propagate, so wrap
 * `fn` in try/catch if partial failures should be tolerated.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  };
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, () => worker());
  await Promise.all(workers);
  return results;
}

/**
 * EndNote Bridge — Read-only import from local EndNote .enl SQLite database.
 *
 * The .enl file is a SQLite database with a 64-column `refs` table (wide/flat format).
 * Schema versions vary by EndNote version — columns are detected dynamically.
 *
 * When EndNote is running, the DB is WAL-locked. Fallback: copy to temp then read.
 */
import BetterSqlite3 from 'better-sqlite3';
import { existsSync, copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname, basename, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import type { PaperInput } from './service.js';

// ── Public interfaces ───────────────────────────────────────────────────

export interface EndNoteDetectResult {
  available: boolean;
  library_path: string | null;
  data_path: string | null;
  record_count: number;
  schema_version: number | null;
}

export interface EndNoteImportResult {
  imported: number;
  duplicates: number;
  errors: number;
  items: string[];
}

// ── Constants ───────────────────────────────────────────────────────────

/** reference_type integer -> paper_type mapping */
const REF_TYPE_MAP: Record<number, string> = {
  0: 'journal_article',
  1: 'book',
  5: 'book_chapter',
  10: 'conference_paper',
  13: 'report',
  32: 'thesis',
  47: 'preprint',
};

/**
 * Tier 1 columns — present since EndNote X7 (54 columns).
 * These are always safe to query.
 */
const TIER1_COLUMNS = [
  'id', 'reference_type', 'author', 'year', 'title', 'secondary_title',
  'volume', 'number', 'pages', 'section', 'abstract', 'notes',
  'electronic_resource_number', 'url', 'author_address', 'label',
  'keywords', 'custom1', 'custom2', 'custom3', 'custom4', 'custom5',
  'custom6', 'custom7', 'accession_number', 'call_number', 'isbn_issn',
  'short_title', 'alternate_title', 'tertiary_title', 'subsidiary_author',
  'tertiary_author', 'translated_author', 'translated_title',
  'publisher', 'place_published', 'edition', 'date', 'type_of_work',
  'reprint_edition', 'reviewed_item', 'original_publication',
  'caption', 'access_date', 'language', 'name_of_database',
  'database_provider', 'research_notes', 'link_to_pdf', 'rec_number',
] as const;

/**
 * Tier 2 columns — added in EndNote X9 (3 columns).
 */
const TIER2_COLUMNS = [
  'doi', 'pmid', 'pmcid',
] as const;

/**
 * Tier 3 columns — added in EndNote 20+ (7 columns, includes timestamps).
 */
const TIER3_COLUMNS = [
  'added_to_library', 'record_last_updated',
  'rating', 'read_status', 'custom8', 'custom9', 'custom10',
] as const;

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * Parse CR-delimited, LF-delimited, or CRLF-delimited author string.
 * EndNote stores authors as a carriage-return-separated string.
 */
function parseEndNoteAuthors(authorField: string | null | undefined): string[] {
  if (!authorField || typeof authorField !== 'string') return [];
  return authorField
    .split(/\r\n|\r|\n/)
    .map(a => a.trim())
    .filter(a => a.length > 0);
}

/**
 * Parse keywords from newline, semicolon, or CR-delimited string.
 */
function parseEndNoteKeywords(kwField: string | null | undefined): string[] {
  if (!kwField || typeof kwField !== 'string') return [];
  return kwField
    .split(/\r\n|\r|\n|;/)
    .map(k => k.trim())
    .filter(k => k.length > 0);
}

/**
 * Convert Unix epoch seconds to ISO 8601 string.
 * Returns undefined if the value is null, undefined, or not a valid number.
 */
function epochSecondsToISO(epoch: unknown): string | undefined {
  if (epoch == null) return undefined;
  const n = typeof epoch === 'number' ? epoch : Number(epoch);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return new Date(n * 1000).toISOString();
}

/**
 * Derive the .Data directory path from the .enl file path.
 * Convention: for `My EndNote Library.enl` the data dir is
 * `My EndNote Library.Data/` in the same parent directory.
 */
function deriveDataPath(enlPath: string): string {
  const dir = dirname(enlPath);
  const base = basename(enlPath, '.enl');
  return join(dir, `${base}.Data`);
}

/**
 * Get the default .enl search paths for the current platform.
 */
function getDefaultSearchPaths(): string[] {
  const home = homedir();
  const platform = process.platform;

  if (platform === 'darwin') {
    return [
      join(home, 'Documents', 'My EndNote Library.enl'),
      join(home, 'Documents', 'EndNote', 'My EndNote Library.enl'),
    ];
  }

  if (platform === 'win32') {
    // %USERPROFILE%\Documents is the standard location
    const docs = join(home, 'Documents');
    return [
      join(docs, 'My EndNote Library.enl'),
      join(docs, 'EndNote', 'My EndNote Library.enl'),
    ];
  }

  // Linux — unlikely for EndNote, but try anyway
  return [
    join(home, 'Documents', 'My EndNote Library.enl'),
  ];
}

// ── EndNoteBridge ───────────────────────────────────────────────────────

export class EndNoteBridge {
  // All static methods, no instance state

  /**
   * Detect whether an EndNote library is available on this machine.
   *
   * Searches default paths for .enl files, attempts to open the database,
   * and returns metadata about the library.
   */
  static detect(enlPath?: string): EndNoteDetectResult {
    const NOT_FOUND: EndNoteDetectResult = {
      available: false,
      library_path: null,
      data_path: null,
      record_count: 0,
      schema_version: null,
    };

    // Resolve library path
    let resolvedPath: string | null = enlPath ?? null;
    if (!resolvedPath) {
      const candidates = getDefaultSearchPaths();
      for (const candidate of candidates) {
        if (existsSync(candidate)) {
          resolvedPath = candidate;
          break;
        }
      }
    }

    if (!resolvedPath || !existsSync(resolvedPath)) {
      return NOT_FOUND;
    }

    let handle: { db: BetterSqlite3.Database; tempDir: string | null } | null = null;
    try {
      handle = EndNoteBridge.openReadonly(resolvedPath);
      const { db } = handle;

      // Verify it has a refs table
      const tableCheck = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='refs'"
      ).get() as { name: string } | undefined;

      if (!tableCheck) {
        return NOT_FOUND;
      }

      // Count records
      const countRow = db.prepare('SELECT COUNT(*) AS cnt FROM refs').get() as
        | { cnt: number }
        | undefined;
      const recordCount = countRow?.cnt ?? 0;

      // Read schema version from misc table (code=1 → schema version)
      let schemaVersion: number | null = null;
      const miscCheck = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='misc'"
      ).get() as { name: string } | undefined;

      if (miscCheck) {
        const versionRow = db.prepare(
          "SELECT value FROM misc WHERE code = 1"
        ).get() as { value: number | string } | undefined;

        if (versionRow != null) {
          schemaVersion = Number(versionRow.value) || null;
        }
      }

      const dataPath = deriveDataPath(resolvedPath);

      return {
        available: true,
        library_path: resolvedPath,
        data_path: existsSync(dataPath) ? dataPath : null,
        record_count: recordCount,
        schema_version: schemaVersion,
      };
    } catch {
      // DB might be corrupted or incompatible
      return NOT_FOUND;
    } finally {
      if (handle) {
        try { handle.db.close(); } catch { /* ignore */ }
        if (handle.tempDir) {
          try { rmSync(handle.tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
        }
      }
    }
  }

  /**
   * Open an .enl database in read-only mode.
   *
   * If the database is locked (SQLITE_BUSY / SQLITE_LOCKED — typically because
   * EndNote is running with a WAL lock), falls back to copying the .enl file
   * (plus any -wal and -shm sidecar files) to a temporary directory and opening
   * the copy.
   *
   * Callers MUST close the returned db and clean up tempDir when done.
   */
  static openReadonly(enlPath: string): { db: BetterSqlite3.Database; tempDir: string | null } {
    // First attempt: direct read-only open
    try {
      const db = new BetterSqlite3(enlPath, { readonly: true });
      // Probe the database to ensure it's actually readable (WAL lock may
      // only manifest on the first query, not on open).
      db.prepare("SELECT 1").get();
      return { db, tempDir: null };
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      const msg = (err as { message?: string })?.message ?? '';
      const isLock =
        code === 'SQLITE_BUSY' ||
        code === 'SQLITE_LOCKED' ||
        msg.includes('database is locked') ||
        msg.includes('SQLITE_BUSY') ||
        msg.includes('SQLITE_LOCKED');

      if (!isLock) {
        throw err;
      }
    }

    // Fallback: copy database files to temp directory
    const tempDir = mkdtempSync(join(tmpdir(), 'endnote-bridge-'));
    const tempEnl = join(tempDir, basename(enlPath));

    try {
      copyFileSync(enlPath, tempEnl);

      // Copy WAL and SHM sidecar files if they exist
      const walPath = enlPath + '-wal';
      const shmPath = enlPath + '-shm';
      if (existsSync(walPath)) {
        copyFileSync(walPath, tempEnl + '-wal');
      }
      if (existsSync(shmPath)) {
        copyFileSync(shmPath, tempEnl + '-shm');
      }

      const db = new BetterSqlite3(tempEnl, { readonly: true });
      // Probe to ensure readability
      db.prepare("SELECT 1").get();
      return { db, tempDir };
    } catch (copyErr) {
      // Clean up temp dir on failure
      try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
      throw copyErr;
    }
  }

  /**
   * Discover which columns are present in the `refs` table.
   *
   * This handles version differences automatically — Tier 1 (X7+, ~54 cols),
   * Tier 2 (X9+, +3 cols), Tier 3 (EN20+, +7 cols). Only columns that actually
   * exist in the database will be queried.
   */
  static getAvailableColumns(db: BetterSqlite3.Database): Set<string> {
    const rows = db.pragma('table_info(refs)') as Array<{ name: string }>;
    return new Set(rows.map(r => r.name));
  }

  /**
   * List items from an EndNote library, mapped to PaperInput.
   *
   * @param enlPath  Path to the .enl file
   * @param opts     Optional limit/offset for pagination
   */
  static listItems(
    enlPath: string,
    opts?: { limit?: number; offset?: number },
  ): PaperInput[] {
    let handle: { db: BetterSqlite3.Database; tempDir: string | null } | null = null;
    try {
      handle = EndNoteBridge.openReadonly(enlPath);
      const { db } = handle;
      const columns = EndNoteBridge.getAvailableColumns(db);

      // Derive .Data path for PDF resolution
      const rawDataPath = deriveDataPath(enlPath);
      const dataPath = existsSync(rawDataPath) ? rawDataPath : null;

      // Build SELECT clause — only include columns that actually exist
      const allDesired = [
        ...TIER1_COLUMNS,
        ...TIER2_COLUMNS,
        ...TIER3_COLUMNS,
      ];
      const selectCols = allDesired.filter(c => columns.has(c));

      if (selectCols.length === 0) {
        // Fallback: select everything
        return [];
      }

      // Ensure `id` is always included for source_id
      if (!selectCols.includes('id') && columns.has('id')) {
        selectCols.unshift('id');
      }

      let sql = `SELECT ${selectCols.map(c => `"${c}"`).join(', ')} FROM refs`;

      const params: unknown[] = [];
      const limit = opts?.limit;
      const offset = opts?.offset;

      if (limit != null && limit > 0) {
        sql += ' LIMIT ?';
        params.push(limit);
      }
      if (offset != null && offset > 0) {
        if (limit == null) {
          sql += ' LIMIT -1'; // SQLite requires LIMIT before OFFSET
        }
        sql += ' OFFSET ?';
        params.push(offset);
      }

      const stmt = db.prepare(sql);
      const rows = (params.length > 0 ? stmt.all(...params) : stmt.all()) as Array<Record<string, unknown>>;

      return rows
        .map(row => EndNoteBridge.toPaperInput(row, columns, dataPath, db))
        .filter((p): p is PaperInput => p !== null);
    } finally {
      if (handle) {
        try { handle.db.close(); } catch { /* ignore */ }
        if (handle.tempDir) {
          try { rmSync(handle.tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
        }
      }
    }
  }

  /**
   * Map a single refs row to a PaperInput object.
   *
   * Returns null if the row has no usable title (skip junk records).
   */
  static toPaperInput(
    row: Record<string, unknown>,
    columns: Set<string>,
    dataPath: string | null,
    db: BetterSqlite3.Database,
  ): PaperInput | null {
    const str = (key: string): string | undefined => {
      if (!columns.has(key)) return undefined;
      const v = row[key];
      if (v == null) return undefined;
      const s = String(v).trim();
      return s.length > 0 ? s : undefined;
    };

    const num = (key: string): number | undefined => {
      if (!columns.has(key)) return undefined;
      const v = row[key];
      if (v == null) return undefined;
      const n = Number(v);
      return Number.isFinite(n) ? n : undefined;
    };

    // Title is required
    const title = str('title');
    if (!title) return null;

    // Authors — CR-delimited
    const authors = parseEndNoteAuthors(str('author'));

    // DOI: prefer dedicated `doi` column (Tier 2), fall back to electronic_resource_number
    let doi = str('doi') ?? str('electronic_resource_number');
    if (doi) {
      // Normalize: strip URI prefix if present
      doi = doi.replace(/^https?:\/\/doi\.org\//, '').trim();
      // Basic DOI format check: should start with 10.
      if (!doi.startsWith('10.')) {
        // electronic_resource_number might contain non-DOI data; skip
        if (!str('doi')) doi = undefined;
      }
    }

    // Year — might be a string like "2024" or "2024/01/15"
    let year: number | undefined;
    const yearRaw = str('year');
    if (yearRaw) {
      const match = yearRaw.match(/(\d{4})/);
      if (match) {
        year = Number(match[1]);
        if (year < 1000 || year > 2100) year = undefined;
      }
    }

    // Journal → venue (stored in secondary_title)
    const venue = str('secondary_title');

    // Issue → stored in `number` column (not "issue")
    const issue = str('number');

    // Reference type → paper_type
    const refType = num('reference_type');
    const paperType = refType != null ? (REF_TYPE_MAP[refType] ?? 'other') : undefined;

    // Keywords
    const keywords = parseEndNoteKeywords(str('keywords'));

    // ISBN/ISSN — stored in isbn_issn, disambiguate by ref type
    const isbnIssn = str('isbn_issn');
    let issn: string | undefined;
    let isbn: string | undefined;
    if (isbnIssn) {
      // ISBNs are 10 or 13 digits (possibly with hyphens), ISSNs are 8 digits with a dash
      if (/^\d{4}-?\d{3}[\dXx]$/.test(isbnIssn.replace(/\s/g, ''))) {
        issn = isbnIssn.trim();
      } else if (/^\d[\d-]{8,16}\d$/.test(isbnIssn.replace(/\s/g, ''))) {
        isbn = isbnIssn.trim();
      } else {
        // Ambiguous — assign based on reference type
        if (refType === 0) {
          issn = isbnIssn.trim();
        } else if (refType === 1 || refType === 5) {
          isbn = isbnIssn.trim();
        }
      }
    }

    // Timestamps (Tier 3: EN20+, Unix epoch seconds)
    const addedEpoch = num('added_to_library');
    const addedAt = epochSecondsToISO(addedEpoch);
    const updatedEpoch = num('record_last_updated');
    const updatedAt = epochSecondsToISO(updatedEpoch);

    // PDF resolution from file_res table
    let pdfPath: string | undefined;
    const refId = row['id'];
    if (refId != null && dataPath) {
      pdfPath = EndNoteBridge.resolvePdf(db, refId, dataPath);
    }

    // URL — prefer explicit url column, fall back to access url patterns
    const url = str('url');

    // Build metadata with fields that don't map directly to PaperInput
    const metadata: Record<string, unknown> = {};
    if (addedAt) metadata.endnote_added_at = addedAt;
    if (updatedAt) metadata.endnote_updated_at = updatedAt;
    if (str('accession_number')) metadata.accession_number = str('accession_number');
    if (str('call_number')) metadata.call_number = str('call_number');
    if (str('label')) metadata.label = str('label');
    if (str('rec_number')) metadata.rec_number = str('rec_number');
    if (str('pmid')) metadata.pmid = str('pmid');
    if (str('pmcid')) metadata.pmcid = str('pmcid');
    if (str('date')) metadata.endnote_date = str('date');

    const paper: PaperInput = {
      title,
      authors: authors.length > 0 ? authors : undefined,
      abstract: str('abstract'),
      doi,
      url,
      pdf_path: pdfPath,
      source: 'endnote',
      source_id: refId != null ? String(refId) : undefined,
      venue,
      year,
      notes: str('notes'),
      keywords: keywords.length > 0 ? keywords : undefined,
      language: str('language'),
      paper_type: paperType,
      volume: str('volume'),
      issue,
      pages: str('pages'),
      publisher: str('publisher'),
      issn,
      isbn,
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    };

    return paper;
  }

  /**
   * Resolve PDF attachment path from the `file_res` table.
   *
   * The file_res table contains: refs_id, file_path (relative), file_type.
   * Actual path: {enl_dir}/{enl_name}.Data/PDF/{file_path}
   *
   * Returns the first existing PDF path, or undefined.
   */
  private static resolvePdf(
    db: BetterSqlite3.Database,
    refsId: unknown,
    dataPath: string,
  ): string | undefined {
    try {
      // Check if file_res table exists
      const tableCheck = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='file_res'"
      ).get() as { name: string } | undefined;

      if (!tableCheck) return undefined;

      const rows = db.prepare(
        'SELECT file_path FROM file_res WHERE refs_id = ?'
      ).all(refsId) as Array<{ file_path: string }>;

      const normalizedDataPath = resolve(dataPath);

      for (const row of rows) {
        if (!row.file_path) continue;

        // Try PDF subdirectory first (most common)
        const pdfInDataPdf = join(dataPath, 'PDF', row.file_path);
        if (!resolve(pdfInDataPdf).startsWith(normalizedDataPath)) continue; // path traversal attempt
        if (existsSync(pdfInDataPdf)) return pdfInDataPdf;

        // Try directly in .Data directory
        const pdfInData = join(dataPath, row.file_path);
        if (!resolve(pdfInData).startsWith(normalizedDataPath)) continue; // path traversal attempt
        if (existsSync(pdfInData)) return pdfInData;

        // Note: we no longer try the path as-is (absolute or relative to cwd)
        // to prevent path traversal outside the data directory.
      }

      return undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Import all (or limited) items from an EndNote library into the RC literature service.
   *
   * Performs duplicate checking via DOI or title before inserting.
   *
   * @param enlPath  Path to the .enl file
   * @param service  Object with `add()` and `duplicateCheck()` methods
   * @param opts     Optional limit
   */
  static importAll(
    enlPath: string,
    service: {
      add: (input: PaperInput) => unknown;
      duplicateCheck: (opts: { doi?: string; title?: string }) => Array<{ match_type: string; confidence: number }>;
    },
    opts?: { limit?: number },
  ): EndNoteImportResult {
    const result: EndNoteImportResult = {
      imported: 0,
      duplicates: 0,
      errors: 0,
      items: [],
    };

    let papers: PaperInput[];
    try {
      papers = EndNoteBridge.listItems(enlPath, { limit: opts?.limit });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors = 1;
      result.items.push(`Failed to read EndNote library: ${msg}`);
      return result;
    }

    for (const paper of papers) {
      try {
        // Duplicate check
        const dupCheck = service.duplicateCheck({
          doi: paper.doi,
          title: paper.title,
        });

        if (dupCheck.some(m => m.confidence >= 0.9)) {
          result.duplicates++;
          continue;
        }

        service.add(paper);
        result.imported++;
        result.items.push(paper.title);
      } catch (err: unknown) {
        result.errors++;
        const msg = err instanceof Error ? err.message : String(err);
        result.items.push(`Error importing "${paper.title}": ${msg}`);
      }
    }

    return result;
  }
}

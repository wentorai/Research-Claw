/**
 * Zotero Bridge — Read-only import from local Zotero SQLite database.
 *
 * This module provides one-way import from the user's local Zotero database
 * into the Research-Claw library. It is strictly read-only and never modifies
 * the Zotero database.
 *
 * Database layout (EAV model):
 *   items → itemData → itemDataValues → fields  (4-table JOIN per field)
 *   items → itemCreators → creators              (authors)
 *   items → itemAttachments                      (PDFs)
 *   items → itemTags → tags                      (tags)
 *   items → collectionItems → collections        (collections)
 *
 * Zotero stores its DB at:
 *   macOS / Linux:  ~/Zotero/zotero.sqlite
 *   Windows:        %USERPROFILE%\Zotero\zotero.sqlite
 */

import BetterSqlite3 from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { PaperInput } from './service.js';

// ── Types ──────────────────────────────────────────────────────────────

export interface ZoteroItem {
  zotero_key: string;
  item_type: string;
  title: string;
  authors: string[];
  abstract: string | null;
  doi: string | null;
  url: string | null;
  year: number | null;
  venue: string | null;
  volume: string | null;
  issue: string | null;
  pages: string | null;
  publisher: string | null;
  issn: string | null;
  isbn: string | null;
  language: string | null;
  tags: string[];
  collections: string[];
  pdf_path: string | null;
  bibtex_key: string | null;
  arxiv_id: string | null;
}

export interface ZoteroDetectResult {
  available: boolean;
  db_path: string | null;
  storage_path: string | null;
  stats: {
    total_items: number;
    total_collections: number;
    total_tags: number;
  } | null;
}

export interface ZoteroImportResult {
  imported: number;
  duplicates: number;
  errors: number;
  items: string[]; // IDs of imported papers
}

// ── Item type mapping ──────────────────────────────────────────────────

const ZOTERO_TYPE_MAP: Record<string, string> = {
  journalArticle: 'journal_article',
  conferencePaper: 'conference_paper',
  preprint: 'preprint',
  book: 'book',
  bookSection: 'book_chapter',
  thesis: 'thesis',
  report: 'report',
};

const VALID_ITEM_TYPES = new Set(Object.keys(ZOTERO_TYPE_MAP));

// ── Venue field per type ───────────────────────────────────────────────

const VENUE_FIELDS: Record<string, string> = {
  journalArticle: 'publicationTitle',
  conferencePaper: 'proceedingsTitle',
  bookSection: 'bookTitle',
  preprint: 'repository',
};

// ── Internal row types (Zotero schema) ─────────────────────────────────

interface ZoteroItemRow {
  itemID: number;
  key: string;
  typeName: string;
}

interface ZoteroFieldRow {
  fieldName: string;
  value: string;
}

interface ZoteroCreatorRow {
  firstName: string | null;
  lastName: string | null;
  orderIndex: number;
}

interface ZoteroTagRow {
  name: string;
}

interface ZoteroCollectionRow {
  collectionName: string;
}

interface ZoteroAttachmentRow {
  key: string;
  path: string | null;
  linkMode: number;
  contentType: string | null;
}

interface ZoteroCollectionStatRow {
  name: string;
  count: number;
}

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * Resolve the default Zotero data directory for the current platform.
 */
function defaultZoteroDir(): string {
  return join(homedir(), 'Zotero');
}

/**
 * Resolve a PDF attachment path to an absolute filesystem path.
 *
 * Zotero stores attachment paths in two formats:
 *   - "storage:<filename>" for stored files (linkMode 0)
 *     → resolved as <storagePath>/<attachmentKey>/<filename>
 *   - Absolute path for linked files (linkMode 2)
 */
function resolvePdfPath(
  attachmentPath: string | null,
  attachmentKey: string,
  storagePath: string,
): string | null {
  if (!attachmentPath) return null;

  if (attachmentPath.startsWith('storage:')) {
    const filename = attachmentPath.slice('storage:'.length);
    const resolved = join(storagePath, attachmentKey, filename);
    return existsSync(resolved) ? resolved : null;
  }

  // Linked file — absolute path stored directly
  return existsSync(attachmentPath) ? attachmentPath : null;
}

/**
 * Extract an ArXiv ID from Zotero item fields.
 *
 * Checks two locations:
 *   1. `archiveID` field: "arXiv:2312.02010" → "2312.02010"
 *   2. `extra` field: freeform text containing "arXiv: 2312.02010"
 */
function extractArxivId(fields: Map<string, string>): string | null {
  const archiveID = fields.get('archiveID');
  if (archiveID?.startsWith('arXiv:')) return archiveID.slice(6);

  const extra = fields.get('extra');
  if (extra) {
    const match = extra.match(/arXiv[:\s]+(\d+\.\d+(?:v\d+)?)/i);
    if (match) return match[1];
  }

  return null;
}

/**
 * Format a creator name. Handles cases where firstName or lastName may be null.
 */
function formatAuthorName(firstName: string | null, lastName: string | null): string {
  const first = firstName?.trim() ?? '';
  const last = lastName?.trim() ?? '';
  if (first && last) return `${first} ${last}`;
  return last || first;
}

/**
 * Parse a year from a Zotero date string.
 * Zotero dates can be: "2023", "2023-01-15", "January 15, 2023", etc.
 */
function parseYear(dateStr: string | undefined): number | null {
  if (!dateStr) return null;
  const match = dateStr.match(/\b((?:19|20)\d{2})\b/);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * Generate a BibTeX key from author/year/title.
 * Format: LastName + Year + FirstSignificantWord, e.g. "Smith2023Attention"
 */
function generateBibtexKey(
  authors: string[],
  year: number | null,
  title: string,
): string | null {
  const lastName = authors[0]?.split(/\s+/).pop()?.replace(/[^a-zA-Z]/g, '') ?? '';
  if (!lastName) return null;

  const yearStr = year?.toString() ?? '';
  const stopWords = new Set([
    'a', 'an', 'the', 'of', 'in', 'on', 'at', 'to', 'for', 'and', 'or',
    'is', 'are', 'was', 'were', 'with', 'from', 'by', 'as',
  ]);
  const firstWord = title
    .split(/\s+/)
    .map((w) => w.replace(/[^a-zA-Z]/g, ''))
    .find((w) => w.length > 0 && !stopWords.has(w.toLowerCase()));

  return `${lastName}${yearStr}${firstWord ?? ''}`;
}

// ── Prepared statement cache key constants ──────────────────────────────

const SQL_VALID_ITEMS = `
  SELECT i.itemID, i.key, it.typeName
  FROM items i
  JOIN itemTypes it ON i.itemTypeID = it.itemTypeID
  WHERE it.typeName IN (${Array.from(VALID_ITEM_TYPES).map((t) => `'${t}'`).join(', ')})
    AND i.itemID NOT IN (SELECT itemID FROM deletedItems)
  ORDER BY i.dateModified DESC
`;

const SQL_VALID_ITEMS_SINCE = `
  SELECT i.itemID, i.key, it.typeName
  FROM items i
  JOIN itemTypes it ON i.itemTypeID = it.itemTypeID
  WHERE it.typeName IN (${Array.from(VALID_ITEM_TYPES).map((t) => `'${t}'`).join(', ')})
    AND i.itemID NOT IN (SELECT itemID FROM deletedItems)
    AND i.dateModified > ?
  ORDER BY i.dateModified DESC
`;

const SQL_VALID_ITEMS_COLLECTION = `
  SELECT i.itemID, i.key, it.typeName
  FROM items i
  JOIN itemTypes it ON i.itemTypeID = it.itemTypeID
  JOIN collectionItems ci ON ci.itemID = i.itemID
  JOIN collections c ON c.collectionID = ci.collectionID
  WHERE it.typeName IN (${Array.from(VALID_ITEM_TYPES).map((t) => `'${t}'`).join(', ')})
    AND i.itemID NOT IN (SELECT itemID FROM deletedItems)
    AND c.collectionName = ?
  ORDER BY i.dateModified DESC
`;

const SQL_VALID_ITEMS_COLLECTION_SINCE = `
  SELECT i.itemID, i.key, it.typeName
  FROM items i
  JOIN itemTypes it ON i.itemTypeID = it.itemTypeID
  JOIN collectionItems ci ON ci.itemID = i.itemID
  JOIN collections c ON c.collectionID = ci.collectionID
  WHERE it.typeName IN (${Array.from(VALID_ITEM_TYPES).map((t) => `'${t}'`).join(', ')})
    AND i.itemID NOT IN (SELECT itemID FROM deletedItems)
    AND c.collectionName = ?
    AND i.dateModified > ?
  ORDER BY i.dateModified DESC
`;

const SQL_ITEM_FIELDS = `
  SELECT f.fieldName, idv.value
  FROM itemData id
  JOIN fieldsCombined f ON id.fieldID = f.fieldID
  JOIN itemDataValues idv ON id.valueID = idv.valueID
  WHERE id.itemID = ?
`;

const SQL_ITEM_CREATORS = `
  SELECT c.firstName, c.lastName, ic.orderIndex
  FROM itemCreators ic
  JOIN creators c ON ic.creatorID = c.creatorID
  WHERE ic.itemID = ?
  ORDER BY ic.orderIndex
`;

const SQL_ITEM_TAGS = `
  SELECT t.name
  FROM itemTags it
  JOIN tags t ON it.tagID = t.tagID
  WHERE it.itemID = ?
`;

const SQL_ITEM_COLLECTIONS = `
  SELECT c.collectionName
  FROM collectionItems ci
  JOIN collections c ON ci.collectionID = c.collectionID
  WHERE ci.itemID = ?
`;

const SQL_ITEM_ATTACHMENTS = `
  SELECT i.key, ia.path, ia.linkMode, ia.contentType
  FROM itemAttachments ia
  JOIN items i ON ia.itemID = i.itemID
  WHERE ia.parentItemID = ?
    AND (ia.contentType = 'application/pdf' OR ia.path LIKE '%.pdf')
  ORDER BY ia.linkMode ASC
`;

const SQL_COUNT_ITEMS = `
  SELECT COUNT(*) as cnt
  FROM items i
  JOIN itemTypes it ON i.itemTypeID = it.itemTypeID
  WHERE it.typeName IN (${Array.from(VALID_ITEM_TYPES).map((t) => `'${t}'`).join(', ')})
    AND i.itemID NOT IN (SELECT itemID FROM deletedItems)
`;

const SQL_COUNT_COLLECTIONS = `
  SELECT COUNT(*) as cnt FROM collections
`;

const SQL_COUNT_TAGS = `
  SELECT COUNT(DISTINCT t.tagID) as cnt
  FROM itemTags it
  JOIN tags t ON it.tagID = t.tagID
`;

const SQL_STATS_BY_TYPE = `
  SELECT it.typeName, COUNT(*) as cnt
  FROM items i
  JOIN itemTypes it ON i.itemTypeID = it.itemTypeID
  WHERE it.typeName IN (${Array.from(VALID_ITEM_TYPES).map((t) => `'${t}'`).join(', ')})
    AND i.itemID NOT IN (SELECT itemID FROM deletedItems)
  GROUP BY it.typeName
  ORDER BY cnt DESC
`;

const SQL_COLLECTION_STATS = `
  SELECT c.collectionName as name, COUNT(ci.itemID) as count
  FROM collections c
  LEFT JOIN collectionItems ci ON c.collectionID = ci.collectionID
  GROUP BY c.collectionID
  ORDER BY count DESC
`;

// ── Bridge class ───────────────────────────────────────────────────────

export class ZoteroBridge {
  /**
   * Detect whether a local Zotero installation exists and is accessible.
   * Returns database path, storage path, and basic stats if available.
   */
  static detect(): ZoteroDetectResult {
    const zoteroDir = defaultZoteroDir();
    const dbPath = join(zoteroDir, 'zotero.sqlite');
    const storagePath = join(zoteroDir, 'storage');

    if (!existsSync(dbPath)) {
      return { available: false, db_path: null, storage_path: null, stats: null };
    }

    let db: BetterSqlite3.Database | null = null;
    try {
      db = ZoteroBridge.openReadonly(dbPath);

      const totalItems = (db.prepare(SQL_COUNT_ITEMS).get() as { cnt: number }).cnt;
      const totalCollections = (db.prepare(SQL_COUNT_COLLECTIONS).get() as { cnt: number }).cnt;
      const totalTags = (db.prepare(SQL_COUNT_TAGS).get() as { cnt: number }).cnt;

      return {
        available: true,
        db_path: dbPath,
        storage_path: existsSync(storagePath) ? storagePath : null,
        stats: {
          total_items: totalItems,
          total_collections: totalCollections,
          total_tags: totalTags,
        },
      };
    } catch {
      return { available: false, db_path: dbPath, storage_path: null, stats: null };
    } finally {
      db?.close();
    }
  }

  /**
   * Open the Zotero database in strict read-only mode.
   *
   * Uses `PRAGMA query_only = ON` as an additional safety layer to guarantee
   * no writes can occur even if a bug constructs a write statement.
   *
   * @throws Error with a user-friendly message if the database is locked
   *         (typically because Zotero is running with an exclusive lock).
   */
  static openReadonly(dbPath: string): BetterSqlite3.Database {
    try {
      const db = new BetterSqlite3(dbPath, {
        readonly: true,
        fileMustExist: true,
      });

      db.pragma('query_only = ON');

      return db;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);

      if (message.includes('SQLITE_BUSY') || message.includes('database is locked')) {
        throw new Error(
          'Zotero database is locked. Close Zotero and retry. ' +
            '(Zotero holds an exclusive lock on its database while running.)',
        );
      }

      throw new Error(`Failed to open Zotero database at ${dbPath}: ${message}`);
    }
  }

  /**
   * List items from the Zotero database, fully hydrated with authors,
   * tags, collections, PDF paths, and all metadata fields.
   *
   * @param dbPath   - Absolute path to zotero.sqlite
   * @param opts     - Optional filters:
   *   - collection: filter by Zotero collection name
   *   - limit:      max items to return (default: no limit)
   *   - offset:     skip N items (default: 0)
   *   - since:      only items modified after this ISO date string
   */
  static listItems(
    dbPath: string,
    opts?: {
      collection?: string;
      limit?: number;
      offset?: number;
      since?: string;
    },
  ): ZoteroItem[] {
    const db = ZoteroBridge.openReadonly(dbPath);
    const storagePath = join(dbPath, '..', 'storage');

    try {
      // ── Select base items ──
      let itemRows: ZoteroItemRow[];

      if (opts?.collection && opts?.since) {
        itemRows = db.prepare(SQL_VALID_ITEMS_COLLECTION_SINCE).all(
          opts.collection,
          opts.since,
        ) as ZoteroItemRow[];
      } else if (opts?.collection) {
        itemRows = db.prepare(SQL_VALID_ITEMS_COLLECTION).all(
          opts.collection,
        ) as ZoteroItemRow[];
      } else if (opts?.since) {
        itemRows = db.prepare(SQL_VALID_ITEMS_SINCE).all(
          opts.since,
        ) as ZoteroItemRow[];
      } else {
        itemRows = db.prepare(SQL_VALID_ITEMS).all() as ZoteroItemRow[];
      }

      // ── Apply offset / limit ──
      const offset = opts?.offset ?? 0;
      if (offset > 0) {
        itemRows = itemRows.slice(offset);
      }
      if (opts?.limit != null && opts.limit > 0) {
        itemRows = itemRows.slice(0, opts.limit);
      }

      // ── Prepare per-item statements (reuse across loop) ──
      const stmtFields = db.prepare(SQL_ITEM_FIELDS);
      const stmtCreators = db.prepare(SQL_ITEM_CREATORS);
      const stmtTags = db.prepare(SQL_ITEM_TAGS);
      const stmtCollections = db.prepare(SQL_ITEM_COLLECTIONS);
      const stmtAttachments = db.prepare(SQL_ITEM_ATTACHMENTS);

      // ── Hydrate each item ──
      const results: ZoteroItem[] = [];

      for (const row of itemRows) {
        try {
          const item = ZoteroBridge.hydrateItem(
            row,
            storagePath,
            stmtFields,
            stmtCreators,
            stmtTags,
            stmtCollections,
            stmtAttachments,
          );
          if (item) results.push(item);
        } catch {
          // Skip items that fail to hydrate (corrupt data, missing fields, etc.)
          continue;
        }
      }

      return results;
    } finally {
      db.close();
    }
  }

  /**
   * Get aggregate statistics from the Zotero database.
   */
  static getStats(dbPath: string): {
    by_type: Record<string, number>;
    collections: Array<{ name: string; count: number }>;
    total_tags: number;
  } {
    const db = ZoteroBridge.openReadonly(dbPath);

    try {
      // Items grouped by type
      const typeRows = db.prepare(SQL_STATS_BY_TYPE).all() as Array<{
        typeName: string;
        cnt: number;
      }>;
      const byType: Record<string, number> = {};
      for (const row of typeRows) {
        byType[row.typeName] = row.cnt;
      }

      // Collection stats
      const collectionRows = db.prepare(SQL_COLLECTION_STATS).all() as ZoteroCollectionStatRow[];
      const collections = collectionRows.map((r) => ({
        name: r.name,
        count: r.count,
      }));

      // Total tags
      const totalTags = (db.prepare(SQL_COUNT_TAGS).get() as { cnt: number }).cnt;

      return { by_type: byType, collections, total_tags: totalTags };
    } finally {
      db.close();
    }
  }

  /**
   * Convert a ZoteroItem to a PaperInput suitable for LiteratureService.add().
   */
  static toPaperInput(item: ZoteroItem): PaperInput {
    return {
      title: item.title,
      authors: item.authors.length > 0 ? item.authors : undefined,
      abstract: item.abstract ?? undefined,
      doi: item.doi ?? undefined,
      url: item.url ?? undefined,
      arxiv_id: item.arxiv_id ?? undefined,
      pdf_path: item.pdf_path ?? undefined,
      source: 'zotero',
      source_id: item.zotero_key,
      venue: item.venue ?? undefined,
      year: item.year ?? undefined,
      bibtex_key: item.bibtex_key ?? undefined,
      tags: item.tags.length > 0 ? item.tags : undefined,
      language: item.language ?? undefined,
      paper_type: ZOTERO_TYPE_MAP[item.item_type] ?? undefined,
      volume: item.volume ?? undefined,
      issue: item.issue ?? undefined,
      pages: item.pages ?? undefined,
      publisher: item.publisher ?? undefined,
      issn: item.issn ?? undefined,
      isbn: item.isbn ?? undefined,
      metadata: {
        zotero_collections: item.collections,
        zotero_item_type: item.item_type,
      },
    };
  }

  /**
   * Import items from Zotero into the Research-Claw library.
   *
   * Performs duplicate detection before adding each item. The `service` parameter
   * must provide `add()` and `duplicateCheck()` methods matching LiteratureService.
   *
   * @returns Summary with counts and IDs of successfully imported papers.
   */
  static importAll(
    dbPath: string,
    service: {
      add: (input: PaperInput) => { id: string; duplicate?: boolean };
      duplicateCheck: (opts: {
        doi?: string;
        title?: string;
        arxiv_id?: string;
      }) => Array<{ match_type: string; confidence: number }>;
    },
    opts?: { collection?: string; limit?: number; since?: string },
  ): ZoteroImportResult {
    const items = ZoteroBridge.listItems(dbPath, {
      collection: opts?.collection,
      limit: opts?.limit,
      since: opts?.since,
    });

    let imported = 0;
    let duplicates = 0;
    let errors = 0;
    const importedIds: string[] = [];

    for (const item of items) {
      try {
        // Pre-check for duplicates using the strongest available identifier
        const dupeMatches = service.duplicateCheck({
          doi: item.doi ?? undefined,
          title: item.title,
          arxiv_id: item.arxiv_id ?? undefined,
        });

        // Consider it a duplicate if any match has high confidence
        const isDuplicate = dupeMatches.some((m) => m.confidence >= 0.9);

        if (isDuplicate) {
          duplicates++;
          continue;
        }

        const paperInput = ZoteroBridge.toPaperInput(item);
        const result = service.add(paperInput);

        if ('duplicate' in result && result.duplicate) {
          duplicates++;
        } else {
          imported++;
          importedIds.push(result.id);
        }
      } catch {
        errors++;
      }
    }

    return {
      imported,
      duplicates,
      errors,
      items: importedIds,
    };
  }

  // ── Private helpers ──────────────────────────────────────────────────

  /**
   * Hydrate a single Zotero item row into a full ZoteroItem.
   * Returns null if the item has no title (unusable).
   */
  private static hydrateItem(
    row: ZoteroItemRow,
    storagePath: string,
    stmtFields: BetterSqlite3.Statement,
    stmtCreators: BetterSqlite3.Statement,
    stmtTags: BetterSqlite3.Statement,
    stmtCollections: BetterSqlite3.Statement,
    stmtAttachments: BetterSqlite3.Statement,
  ): ZoteroItem | null {
    // ── Load all EAV fields into a map ──
    const fieldRows = stmtFields.all(row.itemID) as ZoteroFieldRow[];
    const fields = new Map<string, string>();
    for (const f of fieldRows) {
      fields.set(f.fieldName, f.value);
    }

    // Title is mandatory — skip items without one
    const title = fields.get('title');
    if (!title?.trim()) return null;

    // ── Authors ──
    const creatorRows = stmtCreators.all(row.itemID) as ZoteroCreatorRow[];
    const authors = creatorRows.map((c) => formatAuthorName(c.firstName, c.lastName)).filter(Boolean);

    // ── Tags ──
    const tagRows = stmtTags.all(row.itemID) as ZoteroTagRow[];
    const tags = tagRows.map((t) => t.name);

    // ── Collections ──
    const collectionRows = stmtCollections.all(row.itemID) as ZoteroCollectionRow[];
    const collections = collectionRows.map((c) => c.collectionName);

    // ── PDF attachment ──
    const attachmentRows = stmtAttachments.all(row.itemID) as ZoteroAttachmentRow[];
    let pdfPath: string | null = null;
    for (const att of attachmentRows) {
      const resolved = resolvePdfPath(att.path, att.key, storagePath);
      if (resolved) {
        pdfPath = resolved;
        break; // Use the first valid PDF found
      }
    }

    // ── Scalar fields ──
    const year = parseYear(fields.get('date'));
    const venueField = VENUE_FIELDS[row.typeName];
    const venue = (venueField ? fields.get(venueField) : null) ?? null;
    const arxivId = extractArxivId(fields);

    const item: ZoteroItem = {
      zotero_key: row.key,
      item_type: row.typeName,
      title: title.trim(),
      authors,
      abstract: fields.get('abstractNote')?.trim() || null,
      doi: fields.get('DOI')?.trim() || null,
      url: fields.get('url')?.trim() || null,
      year,
      venue,
      volume: fields.get('volume')?.trim() || null,
      issue: fields.get('issue')?.trim() || null,
      pages: fields.get('pages')?.trim() || null,
      publisher: fields.get('publisher')?.trim() || null,
      issn: fields.get('ISSN')?.trim() || null,
      isbn: fields.get('ISBN')?.trim() || null,
      language: fields.get('language')?.trim() || null,
      tags,
      collections,
      pdf_path: pdfPath,
      bibtex_key: generateBibtexKey(authors, year, title),
      arxiv_id: arxivId,
    };

    return item;
  }
}

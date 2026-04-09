/**
 * Research-Claw Core — Literature Service
 *
 * Implements 33 RPC methods in the `rc.lit.*` namespace.
 * Uses better-sqlite3 synchronous API against the rc_papers schema.
 */

import type BetterSqlite3 from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

// ── Validation constants ────────────────────────────────────────────────

const VALID_PAPER_TYPES = new Set([
  'journal_article', 'conference_paper', 'preprint', 'thesis',
  'book', 'book_chapter', 'report', 'patent', 'dataset', 'other',
]);

// ── Interfaces ──────────────────────────────────────────────────────────

export interface PaperInput {
  title: string;
  authors?: string[];
  abstract?: string;
  doi?: string;
  url?: string;
  arxiv_id?: string;
  pdf_path?: string;
  source?: string;
  source_id?: string;
  venue?: string;
  year?: number;
  notes?: string;
  bibtex_key?: string;
  metadata?: Record<string, unknown>;
  tags?: string[];
  keywords?: string[];
  language?: string;
  paper_type?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  publisher?: string;
  issn?: string;
  isbn?: string;
  discipline?: string;
  citation_count?: number;
}

export interface PaperPatch {
  title?: string;
  authors?: string[];
  abstract?: string;
  doi?: string;
  url?: string;
  arxiv_id?: string;
  pdf_path?: string;
  source?: string;
  source_id?: string;
  venue?: string;
  year?: number;
  read_status?: string;
  rating?: number;
  notes?: string;
  bibtex_key?: string;
  metadata?: Record<string, unknown>;
  keywords?: string[];
  language?: string;
  paper_type?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  publisher?: string;
  issn?: string;
  isbn?: string;
  discipline?: string;
  citation_count?: number;
}

export interface Paper {
  id: string;
  title: string;
  authors: string[];
  abstract: string | null;
  doi: string | null;
  url: string | null;
  arxiv_id: string | null;
  pdf_path: string | null;
  source: string | null;
  source_id: string | null;
  venue: string | null;
  year: number | null;
  added_at: string;
  updated_at: string;
  read_status: string;
  rating: number | null;
  notes: string | null;
  bibtex_key: string | null;
  metadata: Record<string, unknown>;
  keywords: string[];
  language: string | null;
  paper_type: string | null;
  volume: string | null;
  issue: string | null;
  pages: string | null;
  publisher: string | null;
  issn: string | null;
  isbn: string | null;
  discipline: string | null;
  citation_count: number | null;
  tags?: string[];
}

export interface PaperFilter {
  read_status?: string | string[];
  year?: number;
  source?: string;
  tag?: string;
  tags?: string[];
  collection_id?: string;
  has_pdf?: boolean;
}

export interface Tag {
  id: string;
  name: string;
  color: string | null;
  created_at: string;
  paper_count?: number;
}

export interface Collection {
  id: string;
  name: string;
  description: string | null;
  color: string | null;
  created_at: string;
  updated_at: string;
  paper_count?: number;
}

export interface ReadingSession {
  id: string;
  paper_id: string;
  started_at: string;
  ended_at: string | null;
  duration_minutes: number | null;
  notes: string | null;
  pages_read: number | null;
}

export interface Citation {
  citing_paper_id: string;
  cited_paper_id: string;
  context: string | null;
  section: string | null;
}

export interface PaperNote {
  id: string;
  paper_id: string;
  content: string;
  page: number | null;
  highlight: string | null;
  created_at: string;
}

export interface LibraryStats {
  total: number;
  by_status: Record<string, number>;
  by_year: Record<string, number>;
  by_source: Record<string, number>;
  total_tags: number;
  total_reading_minutes: number;
  papers_with_pdf: number;
  starred_count: number;
  average_rating: number | null;
}

export interface DuplicateMatch {
  paper: Paper;
  match_type: string;
  confidence: number;
}

export interface ReadingStats {
  total_sessions: number;
  total_minutes: number;
  papers_read: number;
  average_session_minutes: number;
  by_day: Record<string, number>;
}

// ── Internal row types ──────────────────────────────────────────────────

interface PaperRow {
  id: string;
  title: string;
  authors: string;
  abstract: string | null;
  doi: string | null;
  url: string | null;
  arxiv_id: string | null;
  pdf_path: string | null;
  source: string | null;
  source_id: string | null;
  venue: string | null;
  year: number | null;
  added_at: string;
  updated_at: string;
  read_status: string;
  rating: number | null;
  notes: string | null;
  bibtex_key: string | null;
  metadata: string | null;
  keywords: string | null;
  language: string | null;
  paper_type: string | null;
  volume: string | null;
  issue: string | null;
  pages: string | null;
  publisher: string | null;
  issn: string | null;
  isbn: string | null;
  discipline: string | null;
  citation_count: number | null;
}

interface ReadingSessionRow {
  id: string;
  paper_id: string;
  started_at: string;
  ended_at: string | null;
  duration_minutes: number | null;
  notes: string | null;
  pages_read: number | null;
}

interface CitationRow {
  citing_paper_id: string;
  cited_paper_id: string;
  context: string | null;
  section: string | null;
}

interface TagRow {
  id: string;
  name: string;
  color: string | null;
  created_at: string;
  paper_count: number;
}

interface CollectionRow {
  id: string;
  name: string;
  description: string | null;
  color: string | null;
  created_at: string;
  updated_at: string;
  paper_count: number;
}

interface NoteRow {
  id: string;
  paper_id: string;
  content: string;
  page: number | null;
  highlight: string | null;
  created_at: string;
}

interface BibtexEntry {
  type: string;
  citation_key: string;
  fields: Record<string, string>;
}

// ── Constants ───────────────────────────────────────────────────────────

const VALID_READ_STATUSES = new Set(['unread', 'reading', 'read', 'reviewed']);
const NOT_DELETED = `(metadata IS NULL OR json_extract(metadata, '$.deleted_at') IS NULL)`;
const MAX_SESSION_MINUTES = 480;
const MAX_BATCH_SIZE = 100;

// ── Helpers ─────────────────────────────────────────────────────────────

function now(): string {
  return new Date().toISOString();
}

function generateSortableId(): string {
  const timestampHex = Date.now().toString(16).padStart(12, '0');
  const randomHex = Array.from(crypto.getRandomValues(new Uint8Array(10)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return timestampHex + randomHex;
}

function rowToPaper(row: PaperRow, tags?: string[]): Paper {
  let authors: string[];
  try {
    authors = JSON.parse(row.authors) as string[];
  } catch {
    authors = [];
  }

  let metadata: Record<string, unknown>;
  try {
    metadata = row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : {};
  } catch {
    metadata = {};
  }

  let keywords: string[];
  try {
    keywords = row.keywords ? (JSON.parse(row.keywords) as string[]) : [];
  } catch {
    keywords = [];
  }

  return {
    id: row.id,
    title: row.title,
    authors,
    abstract: row.abstract,
    doi: row.doi,
    url: row.url,
    arxiv_id: row.arxiv_id,
    pdf_path: row.pdf_path,
    source: row.source,
    source_id: row.source_id,
    venue: row.venue,
    year: row.year,
    added_at: row.added_at,
    updated_at: row.updated_at,
    read_status: row.read_status,
    rating: row.rating,
    notes: row.notes,
    bibtex_key: row.bibtex_key,
    metadata,
    keywords,
    language: row.language,
    paper_type: row.paper_type,
    volume: row.volume,
    issue: row.issue,
    pages: row.pages,
    publisher: row.publisher,
    issn: row.issn,
    isbn: row.isbn,
    discipline: row.discipline,
    citation_count: row.citation_count,
    tags: tags ?? [],
  };
}

function getTagsForPaper(db: BetterSqlite3.Database, paperId: string): string[] {
  const rows = db
    .prepare(
      `SELECT t.name FROM rc_tags t
       JOIN rc_paper_tags pt ON pt.tag_id = t.id
       WHERE pt.paper_id = ?
       ORDER BY t.name`,
    )
    .all(paperId) as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

function getTagsForPapers(db: BetterSqlite3.Database, paperIds: string[]): Map<string, string[]> {
  const result = new Map<string, string[]>();
  if (paperIds.length === 0) return result;

  const placeholders = paperIds.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT pt.paper_id, t.name FROM rc_paper_tags pt
       JOIN rc_tags t ON t.id = pt.tag_id
       WHERE pt.paper_id IN (${placeholders})
       ORDER BY t.name`,
    )
    .all(...paperIds) as Array<{ paper_id: string; name: string }>;

  for (const row of rows) {
    let tags = result.get(row.paper_id);
    if (!tags) {
      tags = [];
      result.set(row.paper_id, tags);
    }
    tags.push(row.name);
  }

  return result;
}

function ensureTag(db: BetterSqlite3.Database, tagName: string, color?: string): string {
  const normalized = tagName.trim().toLowerCase();
  const existing = db
    .prepare('SELECT id FROM rc_tags WHERE name = ?')
    .get(normalized) as { id: string } | undefined;

  if (existing) return existing.id;

  const id = randomUUID();
  db.prepare('INSERT INTO rc_tags (id, name, color, created_at) VALUES (?, ?, ?, ?)').run(
    id,
    normalized,
    color ?? null,
    now(),
  );
  return id;
}

function attachTags(db: BetterSqlite3.Database, paperId: string, tagNames: string[]): void {
  const insertStmt = db.prepare(
    'INSERT OR IGNORE INTO rc_paper_tags (paper_id, tag_id) VALUES (?, ?)',
  );
  for (const name of tagNames) {
    const tagId = ensureTag(db, name);
    insertStmt.run(paperId, tagId);
  }
}

function generateBibtexKey(authors: string[], year?: number | null, title?: string | null): string {
  let lastname = 'unknown';
  if (authors.length > 0) {
    const first = authors[0].trim();
    if (first.includes(',')) {
      lastname = first.split(',')[0].trim();
    } else {
      const parts = first.split(/\s+/);
      lastname = parts[parts.length - 1];
    }
  }

  const yearStr = year ? String(year) : '';

  let firstWord = '';
  if (title) {
    const skip = new Set(['a', 'an', 'the', 'on', 'in', 'of', 'for', 'to', 'and']);
    const words = title.split(/\s+/);
    for (const w of words) {
      const clean = w.replace(/[^a-zA-Z]/g, '');
      if (clean && !skip.has(clean.toLowerCase())) {
        firstWord = clean;
        break;
      }
    }
    if (!firstWord && words.length > 0) {
      firstWord = words[0].replace(/[^a-zA-Z]/g, '');
    }
  }

  return `${lastname}${yearStr}${firstWord}`.toLowerCase();
}

/**
 * Extract content within balanced braces starting at `start` (which must be '{').
 * Returns the content between the outermost braces and the index after the closing '}'.
 * Returns null if braces are unbalanced.
 */
function extractBraced(text: string, start: number): { content: string; end: number } | null {
  if (text[start] !== '{') return null;
  let depth = 1;
  let i = start + 1;
  while (i < text.length && depth > 0) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') depth--;
    i++;
  }
  if (depth !== 0) return null;
  return { content: text.substring(start + 1, i - 1), end: i };
}

function parseBibtex(content: string): BibtexEntry[] {
  const entries: BibtexEntry[] = [];
  // Find each @type{ entry start
  const entryStartRegex = /@(\w+)\s*\{/g;
  let startMatch: RegExpExecArray | null;

  while ((startMatch = entryStartRegex.exec(content)) !== null) {
    const type = startMatch[1].toLowerCase();

    if (['string', 'preamble', 'comment'].includes(type)) continue;

    // Extract the entire entry body using balanced brace matching
    const braceStart = startMatch.index + startMatch[0].length - 1; // position of '{'
    const extracted = extractBraced(content, braceStart);
    if (!extracted) continue;

    // Move regex past this entry to avoid re-matching inside it
    entryStartRegex.lastIndex = extracted.end;

    const entryBody = extracted.content;

    // First token before comma is the citation key
    const commaIdx = entryBody.indexOf(',');
    if (commaIdx === -1) continue;
    const citation_key = entryBody.substring(0, commaIdx).trim();
    const fieldsBody = entryBody.substring(commaIdx + 1);

    // Parse fields with balanced-brace awareness
    const fields: Record<string, string> = {};
    const fieldNameRegex = /(\w+)\s*=\s*/g;
    let fieldStart: RegExpExecArray | null;

    while ((fieldStart = fieldNameRegex.exec(fieldsBody)) !== null) {
      const key = fieldStart[1].toLowerCase();
      const valueStart = fieldStart.index + fieldStart[0].length;
      const ch = fieldsBody[valueStart];
      let value: string;

      if (ch === '{') {
        // Balanced brace extraction
        const braceResult = extractBraced(fieldsBody, valueStart);
        if (!braceResult) continue;
        value = braceResult.content;
        fieldNameRegex.lastIndex = braceResult.end;
      } else if (ch === '"') {
        // Quoted string (no nested braces support needed)
        const closeQuote = fieldsBody.indexOf('"', valueStart + 1);
        if (closeQuote === -1) continue;
        value = fieldsBody.substring(valueStart + 1, closeQuote);
        fieldNameRegex.lastIndex = closeQuote + 1;
      } else {
        // Bare number or macro
        const bareMatch = /^(\d+|[a-zA-Z]\w*)/.exec(fieldsBody.substring(valueStart));
        if (!bareMatch) continue;
        value = bareMatch[1];
        fieldNameRegex.lastIndex = valueStart + bareMatch[0].length;
      }

      fields[key] = value.trim();
    }

    entries.push({ type, citation_key, fields });
  }

  return entries;
}

function escapeBibtex(s: string): string {
  return s
    .replace(/\\/g, '\\textbackslash{}')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/&/g, '\\&')
    .replace(/#/g, '\\#')
    .replace(/%/g, '\\%')
    .replace(/_/g, '\\_')
    .replace(/\$/g, '\\$')
    .replace(/~/g, '{\\textasciitilde}')
    .replace(/\^/g, '{\\textasciicircum}');
}

function paperToBibtex(paper: Paper): string {
  const key = paper.bibtex_key || generateBibtexKey(paper.authors, paper.year, paper.title);

  // Map paper_type to correct BibTeX entry type
  let type: string;
  let venueKey: string;
  switch (paper.paper_type) {
    case 'journal_article':
      type = 'article';
      venueKey = 'journal';
      break;
    case 'conference_paper':
      type = 'inproceedings';
      venueKey = 'booktitle';
      break;
    case 'thesis':
    case 'phd_thesis':
      type = 'phdthesis';
      venueKey = 'school';
      break;
    case 'masters_thesis':
      type = 'mastersthesis';
      venueKey = 'school';
      break;
    case 'book':
      type = 'book';
      venueKey = 'publisher';
      break;
    case 'book_chapter':
      type = 'incollection';
      venueKey = 'booktitle';
      break;
    default:
      // Fallback: infer from venue presence
      if (paper.venue) {
        type = 'article';
        venueKey = 'journal';
      } else {
        type = 'misc';
        venueKey = 'howpublished';
      }
      break;
  }

  const fields: string[] = [];
  fields.push(`  title = {${escapeBibtex(paper.title)}}`);

  if (paper.authors.length > 0) {
    fields.push(`  author = {${paper.authors.map(escapeBibtex).join(' and ')}}`);
  }
  if (paper.year != null) {
    fields.push(`  year = {${paper.year}}`);
  }
  if (paper.doi) {
    fields.push(`  doi = {${paper.doi}}`);
  }
  if (paper.url) {
    fields.push(`  url = {${paper.url}}`);
  }
  if (paper.venue) {
    fields.push(`  ${venueKey} = {${escapeBibtex(paper.venue)}}`);
  }
  if (paper.volume) {
    fields.push(`  volume = {${escapeBibtex(paper.volume)}}`);
  }
  if (paper.issue) {
    fields.push(`  number = {${escapeBibtex(paper.issue)}}`);
  }
  if (paper.pages) {
    fields.push(`  pages = {${escapeBibtex(paper.pages)}}`);
  }
  if (paper.publisher) {
    fields.push(`  publisher = {${escapeBibtex(paper.publisher)}}`);
  }
  if (paper.issn) {
    fields.push(`  issn = {${paper.issn}}`);
  }
  if (paper.isbn) {
    fields.push(`  isbn = {${paper.isbn}}`);
  }
  if (paper.arxiv_id) {
    fields.push(`  eprint = {${paper.arxiv_id}}`);
  }
  if (paper.abstract) {
    fields.push(`  abstract = {${escapeBibtex(paper.abstract)}}`);
  }
  if (paper.keywords && paper.keywords.length > 0) {
    fields.push(`  keywords = {${paper.keywords.map(escapeBibtex).join(', ')}}`);
  }

  return `@${type}{${key},\n${fields.join(',\n')}\n}`;
}

function paperToRIS(paper: Paper): string {
  // Map paper_type to RIS TY tag
  let ty: string;
  switch (paper.paper_type) {
    case 'journal_article':
      ty = 'JOUR';
      break;
    case 'conference_paper':
      ty = 'CONF';
      break;
    case 'book':
      ty = 'BOOK';
      break;
    case 'book_chapter':
      ty = 'CHAP';
      break;
    case 'thesis':
    case 'phd_thesis':
    case 'masters_thesis':
      ty = 'THES';
      break;
    case 'preprint':
      ty = 'UNPB';
      break;
    case 'report':
      ty = 'RPRT';
      break;
    case 'patent':
      ty = 'PAT';
      break;
    default:
      ty = paper.venue ? 'JOUR' : 'GEN';
      break;
  }

  const lines: string[] = [];
  lines.push(`TY  - ${ty}`);

  // Authors — one AU tag per author
  for (const author of paper.authors) {
    lines.push(`AU  - ${author}`);
  }

  lines.push(`TI  - ${paper.title}`);

  // Venue: JO for journals, BT for books/conference proceedings
  if (paper.venue) {
    if (ty === 'JOUR') {
      lines.push(`JO  - ${paper.venue}`);
    } else {
      lines.push(`BT  - ${paper.venue}`);
    }
  }

  if (paper.volume) {
    lines.push(`VL  - ${paper.volume}`);
  }
  if (paper.issue) {
    lines.push(`IS  - ${paper.issue}`);
  }

  // Pages: split on dash for SP/EP
  if (paper.pages) {
    const pageParts = paper.pages.split(/[-–—]/);
    if (pageParts.length >= 2) {
      lines.push(`SP  - ${pageParts[0].trim()}`);
      lines.push(`EP  - ${pageParts[1].trim()}`);
    } else {
      lines.push(`SP  - ${paper.pages.trim()}`);
    }
  }

  if (paper.year != null) {
    lines.push(`PY  - ${paper.year}`);
  }
  if (paper.doi) {
    lines.push(`DO  - ${paper.doi}`);
  }
  if (paper.abstract) {
    lines.push(`AB  - ${paper.abstract}`);
  }

  // Keywords — one KW tag per keyword
  if (paper.keywords && paper.keywords.length > 0) {
    for (const kw of paper.keywords) {
      lines.push(`KW  - ${kw}`);
    }
  }

  if (paper.url) {
    lines.push(`UR  - ${paper.url}`);
  }
  if (paper.publisher) {
    lines.push(`PB  - ${paper.publisher}`);
  }

  // SN for ISSN or ISBN
  if (paper.issn) {
    lines.push(`SN  - ${paper.issn}`);
  } else if (paper.isbn) {
    lines.push(`SN  - ${paper.isbn}`);
  }

  if (paper.language) {
    lines.push(`LA  - ${paper.language}`);
  }

  lines.push('ER  - ');
  lines.push('');

  return lines.join('\n');
}

function normalizeTitleForComparison(title: string): string {
  return title
    .toLowerCase()
    // Keep CJK characters (Unicode ranges: CJK Unified Ideographs + extensions),
    // Latin a-z, digits, and whitespace. Without this, Chinese/Japanese/Korean
    // titles are stripped to empty strings, causing all CJK papers to be
    // treated as duplicates of each other.
    .replace(/[^a-z0-9\s\u4e00-\u9fff\u3400-\u4dbf\uac00-\ud7af\u3040-\u309f\u30a0-\u30ff]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function titleSimilarity(a: string, b: string): number {
  const na = normalizeTitleForComparison(a);
  const nb = normalizeTitleForComparison(b);

  if (na === nb) return 1.0;

  const wordsA = new Set(na.split(' '));
  const wordsB = new Set(nb.split(' '));

  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  let intersection = 0;
  for (const word of wordsA) {
    if (wordsB.has(word)) intersection++;
  }

  const union = new Set([...wordsA, ...wordsB]).size;
  return union > 0 ? intersection / union : 0;
}

// ── LiteratureService ───────────────────────────────────────────────────

export class LiteratureService {
  private db: BetterSqlite3.Database;

  constructor(db: BetterSqlite3.Database) {
    this.db = db;
    this.ensureFtsIntegrity();
  }

  ensureFtsIntegrity(): void {
    const row = this.db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='rc_papers_fts'`)
      .get() as { name: string } | undefined;

    if (!row) {
      this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS rc_papers_fts USING fts5(
  title,
  authors,
  abstract,
  notes,
  keywords,
  content='rc_papers',
  content_rowid='rowid'
)`);

      this.db.exec(`CREATE TRIGGER IF NOT EXISTS rc_papers_fts_insert
  AFTER INSERT ON rc_papers
BEGIN
  INSERT INTO rc_papers_fts(rowid, title, authors, abstract, notes, keywords)
    VALUES (new.rowid, new.title, new.authors, new.abstract, new.notes, new.keywords);
END`);

      this.db.exec(`CREATE TRIGGER IF NOT EXISTS rc_papers_fts_update
  AFTER UPDATE ON rc_papers
BEGIN
  INSERT INTO rc_papers_fts(rc_papers_fts, rowid, title, authors, abstract, notes, keywords)
    VALUES ('delete', old.rowid, old.title, old.authors, old.abstract, old.notes, old.keywords);
  INSERT INTO rc_papers_fts(rowid, title, authors, abstract, notes, keywords)
    VALUES (new.rowid, new.title, new.authors, new.abstract, new.notes, new.keywords);
END`);

      this.db.exec(`CREATE TRIGGER IF NOT EXISTS rc_papers_fts_delete
  BEFORE DELETE ON rc_papers
BEGIN
  INSERT INTO rc_papers_fts(rc_papers_fts, rowid, title, authors, abstract, notes, keywords)
    VALUES ('delete', old.rowid, old.title, old.authors, old.abstract, old.notes, old.keywords);
END`);

      this.db.exec(`INSERT INTO rc_papers_fts(rc_papers_fts) VALUES('rebuild')`);
    }
  }

  // ── 1. add ──────────────────────────────────────────────────────────

  add(input: PaperInput): Paper & { duplicate?: boolean } {
    // Duplicate check on DOI — return existing paper instead of throwing
    if (input.doi) {
      const existing = this.db
        .prepare(`SELECT * FROM rc_papers WHERE doi = ? AND ${NOT_DELETED}`)
        .get(input.doi) as PaperRow | undefined;
      if (existing) {
        const tags = getTagsForPaper(this.db, existing.id);
        return { ...rowToPaper(existing, tags), duplicate: true };
      }
    }

    // Duplicate check on arxiv_id — return existing paper instead of throwing
    if (input.arxiv_id) {
      const existing = this.db
        .prepare(`SELECT * FROM rc_papers WHERE arxiv_id = ? AND ${NOT_DELETED}`)
        .get(input.arxiv_id) as PaperRow | undefined;
      if (existing) {
        const tags = getTagsForPaper(this.db, existing.id);
        return { ...rowToPaper(existing, tags), duplicate: true };
      }
    }

    // Duplicate check on normalized title — prevent title-only duplicates
    {
      const normalizedInput = normalizeTitleForComparison(input.title);
      const firstWord = normalizedInput.split(' ')[0] ?? '';
      // Skip title dedup if the normalized title is empty or the first token
      // is too short to be a meaningful LIKE prefix (prevents LIKE '%%' matching everything)
      if (normalizedInput.length > 0 && firstWord.length > 1) {
        const candidates = this.db
          .prepare(
            `SELECT * FROM rc_papers WHERE LOWER(TRIM(title)) LIKE ? AND ${NOT_DELETED}`,
          )
          .all(`%${firstWord}%`) as PaperRow[];

        for (const row of candidates) {
          if (normalizeTitleForComparison(row.title) === normalizedInput) {
            const tags = getTagsForPaper(this.db, row.id);
            return { ...rowToPaper(row, tags), duplicate: true };
          }
        }
      }
    }

    // Validate paper_type if provided
    if (input.paper_type != null && !VALID_PAPER_TYPES.has(input.paper_type)) {
      throw new Error(`Invalid paper_type: "${input.paper_type}". Must be one of: ${[...VALID_PAPER_TYPES].join(', ')}`);
    }

    const id = crypto.randomUUID();
    const timestamp = now();
    const authors = input.authors ?? [];
    const bibtexKey = input.bibtex_key || generateBibtexKey(authors, input.year, input.title);
    const metadata = input.metadata ? JSON.stringify(input.metadata) : '{}';

    const txn = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO rc_papers
           (id, title, authors, abstract, doi, url, arxiv_id, pdf_path, source, source_id,
            venue, year, added_at, updated_at, read_status, rating, notes, bibtex_key, metadata,
            keywords, language, paper_type, volume, issue, pages, publisher, issn, isbn, discipline, citation_count)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unread', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.title,
          JSON.stringify(authors),
          input.abstract ?? null,
          input.doi ?? null,
          input.url ?? null,
          input.arxiv_id ?? null,
          input.pdf_path ?? null,
          input.source ?? null,
          input.source_id ?? null,
          input.venue ?? null,
          input.year ?? null,
          timestamp,
          timestamp,
          input.notes ?? null,
          bibtexKey,
          metadata,
          JSON.stringify(input.keywords ?? []),
          input.language ?? null,
          input.paper_type ?? null,
          input.volume ?? null,
          input.issue ?? null,
          input.pages ?? null,
          input.publisher ?? null,
          input.issn ?? null,
          input.isbn ?? null,
          input.discipline ?? null,
          input.citation_count ?? null,
        );

      if (input.tags && input.tags.length > 0) {
        attachTags(this.db, id, input.tags);
      }

      const tags = getTagsForPaper(this.db, id);
      const inserted = this.db.prepare('SELECT * FROM rc_papers WHERE id = ?').get(id) as PaperRow;
      return rowToPaper(inserted, tags);
    });

    return txn();
  }

  // ── 2. get ──────────────────────────────────────────────────────────

  get(id: string): Paper | null {
    const row = this.db
      .prepare(`SELECT * FROM rc_papers WHERE id = ? AND ${NOT_DELETED}`)
      .get(id) as PaperRow | undefined;

    if (!row) return null;

    const tags = getTagsForPaper(this.db, id);
    return rowToPaper(row, tags);
  }

  // ── 3. list ─────────────────────────────────────────────────────────

  list(
    opts: {
      offset?: number;
      limit?: number;
      sort?: string;
      filter?: PaperFilter;
    } = {},
  ): { items: Paper[]; total: number } {
    const offset = opts.offset ?? 0;
    const limit = Math.min(opts.limit ?? 50, 500);
    const sort = opts.sort ?? 'added_at';
    const filter = opts.filter;

    const allowedSorts = new Set(['added_at', 'updated_at', 'year', 'title', 'rating']);
    let safeSort = allowedSorts.has(sort) ? sort : 'added_at';

    // Support sort direction via prefix: "-field" for DESC, "+field" or "field" for ASC
    let sortDirection = 'DESC';
    if (sort.startsWith('-')) {
      sortDirection = 'DESC';
      const field = sort.slice(1);
      safeSort = allowedSorts.has(field) ? field : 'added_at';
    } else if (sort.startsWith('+')) {
      sortDirection = 'ASC';
      const field = sort.slice(1);
      safeSort = allowedSorts.has(field) ? field : 'added_at';
    }

    const conditions: string[] = [NOT_DELETED];
    const bindValues: unknown[] = [];
    let fromClause = 'FROM rc_papers p';

    if (filter) {
      if (filter.read_status) {
        if (Array.isArray(filter.read_status)) {
          const placeholders = filter.read_status.map(() => '?').join(', ');
          conditions.push(`p.read_status IN (${placeholders})`);
          for (const s of filter.read_status) bindValues.push(s);
        } else {
          conditions.push('p.read_status = ?');
          bindValues.push(filter.read_status);
        }
      }
      if (filter.year != null) {
        conditions.push('p.year = ?');
        bindValues.push(filter.year);
      }
      if (filter.source) {
        conditions.push('p.source = ?');
        bindValues.push(filter.source);
      }
      if (filter.has_pdf === true) {
        conditions.push('p.pdf_path IS NOT NULL');
      } else if (filter.has_pdf === false) {
        conditions.push('p.pdf_path IS NULL');
      }
      // Multi-tag AND filter: paper must have ALL specified tags
      const effectiveTags: string[] = filter.tags?.length
        ? filter.tags
        : filter.tag
          ? [filter.tag]
          : [];
      if (effectiveTags.length > 0) {
        const placeholders = effectiveTags.map(() => '?').join(', ');
        conditions.push(`p.id IN (
          SELECT pt_inner.paper_id
          FROM rc_paper_tags pt_inner
          JOIN rc_tags t_inner ON t_inner.id = pt_inner.tag_id
          WHERE LOWER(t_inner.name) IN (${placeholders})
          GROUP BY pt_inner.paper_id
          HAVING COUNT(DISTINCT t_inner.id) = ?
        )`);
        for (const t of effectiveTags) {
          bindValues.push(t.trim().toLowerCase());
        }
        bindValues.push(effectiveTags.length);
      }
      if (filter.collection_id) {
        fromClause += `
          JOIN rc_collection_papers cp ON cp.paper_id = p.id AND cp.collection_id = ?`;
        bindValues.push(filter.collection_id);
      }
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    const countSql = `SELECT COUNT(*) as cnt ${fromClause} ${whereClause}`;
    const countRow = this.db.prepare(countSql).get(...bindValues) as { cnt: number };
    const total = countRow.cnt;

    const selectSql = `SELECT p.* ${fromClause} ${whereClause} ORDER BY p.${safeSort} ${sortDirection} LIMIT ? OFFSET ?`;
    const rows = this.db.prepare(selectSql).all(...bindValues, limit, offset) as PaperRow[];

    const tagsMap = getTagsForPapers(this.db, rows.map((r) => r.id));
    const items = rows.map((row) => rowToPaper(row, tagsMap.get(row.id) ?? []));

    return { items, total };
  }

  // ── 4. update ───────────────────────────────────────────────────────

  update(id: string, patch: PaperPatch): Paper {
    const existing = this.db
      .prepare(`SELECT id FROM rc_papers WHERE id = ? AND ${NOT_DELETED}`)
      .get(id) as { id: string } | undefined;
    if (!existing) {
      throw new Error(`Paper not found: ${id}`);
    }

    // Validate paper_type if provided
    if (patch.paper_type != null && !VALID_PAPER_TYPES.has(patch.paper_type)) {
      throw new Error(`Invalid paper_type: "${patch.paper_type}". Must be one of: ${[...VALID_PAPER_TYPES].join(', ')}`);
    }

    const setClauses: string[] = [];
    const values: unknown[] = [];

    const simpleFields: Array<[keyof PaperPatch, string]> = [
      ['title', 'title'],
      ['abstract', 'abstract'],
      ['doi', 'doi'],
      ['url', 'url'],
      ['arxiv_id', 'arxiv_id'],
      ['pdf_path', 'pdf_path'],
      ['source', 'source'],
      ['source_id', 'source_id'],
      ['venue', 'venue'],
      ['year', 'year'],
      ['read_status', 'read_status'],
      ['rating', 'rating'],
      ['notes', 'notes'],
      ['bibtex_key', 'bibtex_key'],
      ['language', 'language'],
      ['paper_type', 'paper_type'],
      ['volume', 'volume'],
      ['issue', 'issue'],
      ['pages', 'pages'],
      ['publisher', 'publisher'],
      ['issn', 'issn'],
      ['isbn', 'isbn'],
      ['discipline', 'discipline'],
      ['citation_count', 'citation_count'],
    ];

    for (const [key, column] of simpleFields) {
      if (key in patch) {
        setClauses.push(`${column} = ?`);
        values.push(patch[key] ?? null);
      }
    }

    if ('authors' in patch) {
      setClauses.push('authors = ?');
      values.push(JSON.stringify(patch.authors ?? []));
    }

    if ('metadata' in patch) {
      setClauses.push('metadata = ?');
      values.push(patch.metadata ? JSON.stringify(patch.metadata) : '{}');
    }

    if ('keywords' in patch) {
      setClauses.push('keywords = ?');
      values.push(JSON.stringify(patch.keywords ?? []));
    }

    setClauses.push('updated_at = ?');
    values.push(now());

    values.push(id);
    this.db
      .prepare(`UPDATE rc_papers SET ${setClauses.join(', ')} WHERE id = ?`)
      .run(...values);

    const row = this.db.prepare('SELECT * FROM rc_papers WHERE id = ?').get(id) as PaperRow;
    const tags = getTagsForPaper(this.db, id);
    return rowToPaper(row, tags);
  }

  // ── 5. delete ───────────────────────────────────────────────────────

  delete(id: string): void {
    const existing = this.db
      .prepare(`SELECT id FROM rc_papers WHERE id = ? AND ${NOT_DELETED}`)
      .get(id) as { id: string } | undefined;
    if (!existing) {
      throw new Error(`Paper not found: ${id}`);
    }

    this.db
      .prepare(
        `UPDATE rc_papers SET metadata = json_set(COALESCE(metadata, '{}'), '$.deleted_at', ?) WHERE id = ?`,
      )
      .run(now(), id);

    // Clean up orphaned tags after soft-deleting a paper
    this.cleanupOrphanedTags();
  }

  // ── 5b. restore ─────────────────────────────────────────────────────

  restore(id: string): Paper {
    const row = this.db
      .prepare(
        `SELECT * FROM rc_papers WHERE id = ? AND metadata IS NOT NULL AND json_extract(metadata, '$.deleted_at') IS NOT NULL`,
      )
      .get(id) as PaperRow | undefined;
    if (!row) {
      throw new Error(`Paper not found or not deleted: ${id}`);
    }

    this.db
      .prepare(
        `UPDATE rc_papers SET metadata = json_remove(metadata, '$.deleted_at'), updated_at = ? WHERE id = ?`,
      )
      .run(now(), id);

    const restored = this.db.prepare('SELECT * FROM rc_papers WHERE id = ?').get(id) as PaperRow;
    const tags = getTagsForPaper(this.db, id);
    return rowToPaper(restored, tags);
  }

  // ── 5c. purge ───────────────────────────────────────────────────────

  purge(id: string): void {
    const row = this.db
      .prepare(
        `SELECT id FROM rc_papers WHERE id = ? AND metadata IS NOT NULL AND json_extract(metadata, '$.deleted_at') IS NOT NULL`,
      )
      .get(id) as { id: string } | undefined;
    if (!row) {
      throw new Error(`Paper not found or not deleted: ${id}`);
    }

    this.db.prepare('DELETE FROM rc_papers WHERE id = ?').run(id);
    this.cleanupOrphanedTags();
  }

  /**
   * Remove tags that have no associated non-deleted papers.
   * Called after paper deletion and untag to prevent tag list pollution.
   */
  cleanupOrphanedTags(): void {
    this.db
      .prepare(
        `DELETE FROM rc_tags WHERE id NOT IN (
          SELECT DISTINCT pt.tag_id
          FROM rc_paper_tags pt
          JOIN rc_papers p ON p.id = pt.paper_id AND ${NOT_DELETED}
        )`,
      )
      .run();
  }

  // ── 6. search ───────────────────────────────────────────────────────

  search(
    query: string,
    limit: number = 50,
    offset: number = 0,
    collectionId?: string,
  ): { items: Paper[]; total: number } {
    const safeLimit = Math.min(limit, 500);
    const collJoin = collectionId
      ? `JOIN rc_collection_papers cp ON cp.paper_id = p.id AND cp.collection_id = ?`
      : '';

    // Try FTS5 first
    try {
      const countSql = collectionId
        ? `SELECT COUNT(*) as cnt FROM rc_papers_fts
           JOIN rc_papers p ON p.rowid = rc_papers_fts.rowid
           ${collJoin}
           WHERE rc_papers_fts MATCH ? AND ${NOT_DELETED}`
        : `SELECT COUNT(*) as cnt FROM rc_papers_fts
           JOIN rc_papers p ON p.rowid = rc_papers_fts.rowid
           WHERE rc_papers_fts MATCH ? AND ${NOT_DELETED}`;

      const countStmt = this.db.prepare(countSql);
      const countRow = (
        collectionId ? countStmt.get(collectionId, query) : countStmt.get(query)
      ) as { cnt: number };

      const selectSql = collectionId
        ? `SELECT p.* FROM rc_papers_fts
           JOIN rc_papers p ON p.rowid = rc_papers_fts.rowid
           ${collJoin}
           WHERE rc_papers_fts MATCH ? AND ${NOT_DELETED}
           ORDER BY rank
           LIMIT ? OFFSET ?`
        : `SELECT p.* FROM rc_papers_fts
           JOIN rc_papers p ON p.rowid = rc_papers_fts.rowid
           WHERE rc_papers_fts MATCH ? AND ${NOT_DELETED}
           ORDER BY rank
           LIMIT ? OFFSET ?`;

      const selectStmt = this.db.prepare(selectSql);
      const rows = (
        collectionId
          ? selectStmt.all(collectionId, query, safeLimit, offset)
          : selectStmt.all(query, safeLimit, offset)
      ) as PaperRow[];

      const tagsMap = getTagsForPapers(this.db, rows.map((r) => r.id));
      const items = rows.map((r) => rowToPaper(r, tagsMap.get(r.id) ?? []));
      return { items, total: countRow.cnt };
    } catch {
      // FTS5 parse error — fall back to LIKE
      const likeQuery = `%${query}%`;

      const likeCountSql = collectionId
        ? `SELECT COUNT(*) as cnt FROM rc_papers p
           ${collJoin}
           WHERE ${NOT_DELETED}
           AND (p.title LIKE ? OR p.abstract LIKE ? OR p.authors LIKE ? OR p.notes LIKE ?)`
        : `SELECT COUNT(*) as cnt FROM rc_papers p
           WHERE ${NOT_DELETED}
           AND (p.title LIKE ? OR p.abstract LIKE ? OR p.authors LIKE ? OR p.notes LIKE ?)`;

      const likeCountStmt = this.db.prepare(likeCountSql);
      const countRow = (
        collectionId
          ? likeCountStmt.get(collectionId, likeQuery, likeQuery, likeQuery, likeQuery)
          : likeCountStmt.get(likeQuery, likeQuery, likeQuery, likeQuery)
      ) as { cnt: number };

      const likeSelectSql = collectionId
        ? `SELECT p.* FROM rc_papers p
           ${collJoin}
           WHERE ${NOT_DELETED}
           AND (p.title LIKE ? OR p.abstract LIKE ? OR p.authors LIKE ? OR p.notes LIKE ?)
           ORDER BY p.added_at DESC
           LIMIT ? OFFSET ?`
        : `SELECT p.* FROM rc_papers p
           WHERE ${NOT_DELETED}
           AND (p.title LIKE ? OR p.abstract LIKE ? OR p.authors LIKE ? OR p.notes LIKE ?)
           ORDER BY p.added_at DESC
           LIMIT ? OFFSET ?`;

      const likeSelectStmt = this.db.prepare(likeSelectSql);
      const rows = (
        collectionId
          ? likeSelectStmt.all(
              collectionId,
              likeQuery,
              likeQuery,
              likeQuery,
              likeQuery,
              safeLimit,
              offset,
            )
          : likeSelectStmt.all(likeQuery, likeQuery, likeQuery, likeQuery, safeLimit, offset)
      ) as PaperRow[];

      const tagsMap = getTagsForPapers(this.db, rows.map((r) => r.id));
      const items = rows.map((r) => rowToPaper(r, tagsMap.get(r.id) ?? []));
      return { items, total: countRow.cnt };
    }
  }

  // ── 7. duplicateCheck ───────────────────────────────────────────────

  duplicateCheck(opts: {
    doi?: string;
    title?: string;
    arxiv_id?: string;
  }): DuplicateMatch[] {
    const matches: DuplicateMatch[] = [];
    const seenIds = new Set<string>();

    // 1. DOI exact match — highest confidence
    if (opts.doi) {
      const rows = this.db
        .prepare(`SELECT * FROM rc_papers WHERE doi = ? AND ${NOT_DELETED}`)
        .all(opts.doi) as PaperRow[];
      for (const row of rows) {
        if (!seenIds.has(row.id)) {
          seenIds.add(row.id);
          matches.push({
            paper: rowToPaper(row, getTagsForPaper(this.db, row.id)),
            match_type: 'doi_exact',
            confidence: 1.0,
          });
        }
      }
    }

    // 2. arxiv_id exact match
    if (opts.arxiv_id) {
      const rows = this.db
        .prepare(`SELECT * FROM rc_papers WHERE arxiv_id = ? AND ${NOT_DELETED}`)
        .all(opts.arxiv_id) as PaperRow[];
      for (const row of rows) {
        if (!seenIds.has(row.id)) {
          seenIds.add(row.id);
          matches.push({
            paper: rowToPaper(row, getTagsForPaper(this.db, row.id)),
            match_type: 'arxiv_exact',
            confidence: 1.0,
          });
        }
      }
    }

    // 3. Title exact match (case-insensitive via SQL LOWER)
    if (opts.title) {
      const normalizedInput = normalizeTitleForComparison(opts.title);

      // Use SQL LOWER for case-insensitive exact match (avoids full table scan into JS)
      const exactRows = this.db
        .prepare(`SELECT * FROM rc_papers WHERE LOWER(title) LIKE ? AND ${NOT_DELETED}`)
        .all(`%${normalizedInput.split(' ')[0] ?? ''}%`) as PaperRow[];

      for (const row of exactRows) {
        if (seenIds.has(row.id)) continue;

        const normalizedRow = normalizeTitleForComparison(row.title);
        if (normalizedRow === normalizedInput) {
          seenIds.add(row.id);
          matches.push({
            paper: rowToPaper(row, getTagsForPaper(this.db, row.id)),
            match_type: 'title_exact',
            confidence: 0.95,
          });
        }
      }

      // 4. Title fuzzy match — use FTS5 to get candidates, then Jaccard in JS
      const inputWords = normalizedInput.split(/\s+/).filter((w) => w.length > 2);
      if (inputWords.length > 0) {
        const ftsQuery = inputWords.slice(0, 5).join(' OR ');
        let candidateRows: PaperRow[] = [];
        try {
          candidateRows = this.db
            .prepare(
              `SELECT p.* FROM rc_papers_fts
               JOIN rc_papers p ON p.rowid = rc_papers_fts.rowid
               WHERE rc_papers_fts MATCH ? AND ${NOT_DELETED}
               LIMIT 200`,
            )
            .all(ftsQuery) as PaperRow[];
        } catch {
          // FTS parse error — fall back to LIKE with first significant word
          candidateRows = this.db
            .prepare(`SELECT * FROM rc_papers WHERE LOWER(title) LIKE ? AND ${NOT_DELETED} LIMIT 200`)
            .all(`%${inputWords[0]}%`) as PaperRow[];
        }

        for (const row of candidateRows) {
          if (seenIds.has(row.id)) continue;

          const similarity = titleSimilarity(opts.title, row.title);
          if (similarity >= 0.7) {
            seenIds.add(row.id);
            matches.push({
              paper: rowToPaper(row, getTagsForPaper(this.db, row.id)),
              match_type: 'title_fuzzy',
              confidence: Math.round(similarity * 100) / 100,
            });
          }
        }
      }
    }

    // Sort by confidence descending
    matches.sort((a, b) => b.confidence - a.confidence);
    return matches;
  }

  // ── 8. setStatus ────────────────────────────────────────────────────

  setStatus(id: string, status: string): Paper {
    if (!VALID_READ_STATUSES.has(status)) {
      throw new Error(
        `Invalid status: ${status}. Must be one of: ${[...VALID_READ_STATUSES].join(', ')}`,
      );
    }

    const existing = this.db
      .prepare(`SELECT * FROM rc_papers WHERE id = ? AND ${NOT_DELETED}`)
      .get(id) as PaperRow | undefined;
    if (!existing) {
      throw new Error(`Paper not found: ${id}`);
    }

    const timestamp = now();

    this.db
      .prepare('UPDATE rc_papers SET read_status = ?, updated_at = ? WHERE id = ?')
      .run(status, timestamp, id);

    // Auto-start reading session when transitioning to 'reading'
    if (status === 'reading') {
      const activeSession = this.db
        .prepare(
          'SELECT id FROM rc_reading_sessions WHERE paper_id = ? AND ended_at IS NULL',
        )
        .get(id) as { id: string } | undefined;

      if (!activeSession) {
        this.db
          .prepare(
            'INSERT INTO rc_reading_sessions (id, paper_id, started_at) VALUES (?, ?, ?)',
          )
          .run(crypto.randomUUID(), id, timestamp);
      }
    }

    const row = this.db.prepare('SELECT * FROM rc_papers WHERE id = ?').get(id) as PaperRow;
    const tags = getTagsForPaper(this.db, id);
    return rowToPaper(row, tags);
  }

  // ── 9. rate ─────────────────────────────────────────────────────────

  rate(id: string, rating: number): Paper {
    // rating=0 means "unrate" (clear rating → NULL)
    if (!Number.isInteger(rating) || rating < 0 || rating > 5) {
      throw new Error(
        `Invalid rating: ${rating}. Must be an integer between 0 and 5 (0 to clear).`,
      );
    }

    const existing = this.db
      .prepare(`SELECT id FROM rc_papers WHERE id = ? AND ${NOT_DELETED}`)
      .get(id) as { id: string } | undefined;
    if (!existing) {
      throw new Error(`Paper not found: ${id}`);
    }

    const dbRating = rating === 0 ? null : rating;
    this.db
      .prepare('UPDATE rc_papers SET rating = ?, updated_at = ? WHERE id = ?')
      .run(dbRating, now(), id);

    const row = this.db.prepare('SELECT * FROM rc_papers WHERE id = ?').get(id) as PaperRow;
    const tags = getTagsForPaper(this.db, id);
    return rowToPaper(row, tags);
  }

  // ── 10. getTags ─────────────────────────────────────────────────────

  getTags(): Tag[] {
    const rows = this.db
      .prepare(
        `SELECT t.id, t.name, t.color, t.created_at, COUNT(p.id) AS paper_count
         FROM rc_tags t
         LEFT JOIN rc_paper_tags pt ON pt.tag_id = t.id
         LEFT JOIN rc_papers p ON p.id = pt.paper_id AND ${NOT_DELETED}
         GROUP BY t.id
         ORDER BY paper_count DESC, t.name ASC`,
      )
      .all() as TagRow[];

    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      color: r.color,
      created_at: r.created_at,
      paper_count: r.paper_count,
    }));
  }

  // ── 11. tag ─────────────────────────────────────────────────────────

  tag(paperId: string, tagName: string, color?: string): string[] {
    const existing = this.db
      .prepare(`SELECT id FROM rc_papers WHERE id = ? AND ${NOT_DELETED}`)
      .get(paperId) as { id: string } | undefined;
    if (!existing) {
      throw new Error(`Paper not found: ${paperId}`);
    }

    const tagId = ensureTag(this.db, tagName, color);
    this.db
      .prepare('INSERT OR IGNORE INTO rc_paper_tags (paper_id, tag_id) VALUES (?, ?)')
      .run(paperId, tagId);

    return getTagsForPaper(this.db, paperId);
  }

  // ── 12. untag ───────────────────────────────────────────────────────

  untag(paperId: string, tagName: string): string[] {
    const normalized = tagName.trim().toLowerCase();
    const tagRow = this.db
      .prepare('SELECT id FROM rc_tags WHERE name = ?')
      .get(normalized) as { id: string } | undefined;

    if (tagRow) {
      this.db
        .prepare('DELETE FROM rc_paper_tags WHERE paper_id = ? AND tag_id = ?')
        .run(paperId, tagRow.id);

      // Clean up orphaned tags after removing a tag from a paper
      this.cleanupOrphanedTags();
    }

    return getTagsForPaper(this.db, paperId);
  }

  // ── 13. startReading ────────────────────────────────────────────────

  startReading(paperId: string): ReadingSession {
    const existing = this.db
      .prepare(`SELECT * FROM rc_papers WHERE id = ? AND ${NOT_DELETED}`)
      .get(paperId) as PaperRow | undefined;
    if (!existing) {
      throw new Error(`Paper not found: ${paperId}`);
    }

    const timestamp = now();

    // Close any existing active sessions for this paper
    const activeSessions = this.db
      .prepare(
        'SELECT * FROM rc_reading_sessions WHERE paper_id = ? AND ended_at IS NULL',
      )
      .all(paperId) as ReadingSessionRow[];

    for (const session of activeSessions) {
      const startedMs = new Date(session.started_at).getTime();
      const endedMs = new Date(timestamp).getTime();
      const duration = Math.min(Math.round((endedMs - startedMs) / 60000), MAX_SESSION_MINUTES);
      this.db
        .prepare(
          'UPDATE rc_reading_sessions SET ended_at = ?, duration_minutes = ? WHERE id = ?',
        )
        .run(timestamp, duration, session.id);
    }

    // Only update paper status to 'reading' if currently 'unread'
    this.db
      .prepare('UPDATE rc_papers SET read_status = ?, updated_at = ? WHERE id = ? AND read_status = ?')
      .run('reading', timestamp, paperId, 'unread');

    // Start new session
    const sessionId = crypto.randomUUID();
    this.db
      .prepare(
        'INSERT INTO rc_reading_sessions (id, paper_id, started_at) VALUES (?, ?, ?)',
      )
      .run(sessionId, paperId, timestamp);

    return {
      id: sessionId,
      paper_id: paperId,
      started_at: timestamp,
      ended_at: null,
      duration_minutes: null,
      notes: null,
      pages_read: null,
    };
  }

  // ── 14. endReading ──────────────────────────────────────────────────

  endReading(
    sessionId: string,
    notes?: string,
    pagesRead?: number,
  ): ReadingSession {
    const session = this.db
      .prepare('SELECT * FROM rc_reading_sessions WHERE id = ?')
      .get(sessionId) as ReadingSessionRow | undefined;

    if (!session) {
      throw new Error(`Reading session not found: ${sessionId}`);
    }
    if (session.ended_at) {
      throw new Error(`Reading session already ended: ${sessionId}`);
    }

    const endedAt = now();
    const startedMs = new Date(session.started_at).getTime();
    const endedMs = new Date(endedAt).getTime();
    const durationMinutes = Math.min(
      Math.round((endedMs - startedMs) / 60000),
      MAX_SESSION_MINUTES,
    );

    this.db
      .prepare(
        `UPDATE rc_reading_sessions
         SET ended_at = ?, duration_minutes = ?, notes = ?, pages_read = ?
         WHERE id = ?`,
      )
      .run(endedAt, durationMinutes, notes ?? null, pagesRead ?? null, sessionId);

    // Only update paper status to 'read' if currently 'reading'
    this.db
      .prepare('UPDATE rc_papers SET read_status = ?, updated_at = ? WHERE id = ? AND read_status = ?')
      .run('read', endedAt, session.paper_id, 'reading');

    return {
      id: sessionId,
      paper_id: session.paper_id,
      started_at: session.started_at,
      ended_at: endedAt,
      duration_minutes: durationMinutes,
      notes: notes ?? null,
      pages_read: pagesRead ?? null,
    };
  }

  // ── 15. listReadingSessions ─────────────────────────────────────────

  listReadingSessions(paperId: string): ReadingSession[] {
    // Verify the paper exists and is not soft-deleted before returning sessions
    const paper = this.db
      .prepare(`SELECT id FROM rc_papers WHERE id = ? AND ${NOT_DELETED}`)
      .get(paperId) as { id: string } | undefined;
    if (!paper) {
      throw new Error(`Paper not found: ${paperId}`);
    }

    return this.db
      .prepare(
        'SELECT * FROM rc_reading_sessions WHERE paper_id = ? ORDER BY started_at DESC',
      )
      .all(paperId) as ReadingSession[];
  }

  // ── 16. addCitation ─────────────────────────────────────────────────

  addCitation(
    citingId: string,
    citedId: string,
    context?: string,
    section?: string,
  ): Citation {
    if (citingId === citedId) {
      throw new Error('A paper cannot cite itself.');
    }

    const citing = this.db
      .prepare(`SELECT id FROM rc_papers WHERE id = ? AND ${NOT_DELETED}`)
      .get(citingId) as { id: string } | undefined;
    if (!citing) {
      throw new Error(`Citing paper not found: ${citingId}`);
    }

    const cited = this.db
      .prepare(`SELECT id FROM rc_papers WHERE id = ? AND ${NOT_DELETED}`)
      .get(citedId) as { id: string } | undefined;
    if (!cited) {
      throw new Error(`Cited paper not found: ${citedId}`);
    }

    this.db
      .prepare(
        `INSERT OR REPLACE INTO rc_citations (citing_paper_id, cited_paper_id, context, section)
         VALUES (?, ?, ?, ?)`,
      )
      .run(citingId, citedId, context ?? null, section ?? null);

    return {
      citing_paper_id: citingId,
      cited_paper_id: citedId,
      context: context ?? null,
      section: section ?? null,
    };
  }

  // ── 17. getCitations ────────────────────────────────────────────────

  getCitations(
    paperId: string,
    direction: string,
  ): { citing: Citation[]; cited_by: Citation[] } {
    const result: { citing: Citation[]; cited_by: Citation[] } = {
      citing: [],
      cited_by: [],
    };

    if (direction === 'citing' || direction === 'both') {
      result.citing = this.db
        .prepare(
          `SELECT c.* FROM rc_citations c
           JOIN rc_papers p ON p.id = c.cited_paper_id AND ${NOT_DELETED}
           WHERE c.citing_paper_id = ?`,
        )
        .all(paperId) as CitationRow[];
    }

    if (direction === 'cited_by' || direction === 'both') {
      result.cited_by = this.db
        .prepare(
          `SELECT c.* FROM rc_citations c
           JOIN rc_papers p ON p.id = c.citing_paper_id AND ${NOT_DELETED}
           WHERE c.cited_paper_id = ?`,
        )
        .all(paperId) as CitationRow[];
    }

    return result;
  }

  // ── 18. getStats ────────────────────────────────────────────────────

  getStats(): LibraryStats {
    const totalRow = this.db
      .prepare(`SELECT COUNT(*) as cnt FROM rc_papers WHERE ${NOT_DELETED}`)
      .get() as { cnt: number };

    // By status
    const statusRows = this.db
      .prepare(
        `SELECT read_status, COUNT(*) as cnt FROM rc_papers
         WHERE ${NOT_DELETED}
         GROUP BY read_status`,
      )
      .all() as Array<{ read_status: string; cnt: number }>;
    const by_status: Record<string, number> = {};
    for (const r of statusRows) by_status[r.read_status] = r.cnt;

    // By year
    const yearRows = this.db
      .prepare(
        `SELECT year, COUNT(*) as cnt FROM rc_papers
         WHERE ${NOT_DELETED} AND year IS NOT NULL
         GROUP BY year ORDER BY year`,
      )
      .all() as Array<{ year: number; cnt: number }>;
    const by_year: Record<string, number> = {};
    for (const r of yearRows) by_year[String(r.year)] = r.cnt;

    // By source
    const sourceRows = this.db
      .prepare(
        `SELECT COALESCE(source, 'unknown') as src, COUNT(*) as cnt FROM rc_papers
         WHERE ${NOT_DELETED}
         GROUP BY src`,
      )
      .all() as Array<{ src: string; cnt: number }>;
    const by_source: Record<string, number> = {};
    for (const r of sourceRows) by_source[r.src] = r.cnt;

    // Total tags
    const tagsRow = this.db
      .prepare('SELECT COUNT(*) as cnt FROM rc_tags')
      .get() as { cnt: number };

    // Total reading minutes
    const readingRow = this.db
      .prepare(
        'SELECT COALESCE(SUM(duration_minutes), 0) as total FROM rc_reading_sessions WHERE duration_minutes IS NOT NULL',
      )
      .get() as { total: number };

    // Papers with PDF
    const pdfRow = this.db
      .prepare(
        `SELECT COUNT(*) as cnt FROM rc_papers WHERE ${NOT_DELETED} AND pdf_path IS NOT NULL`,
      )
      .get() as { cnt: number };

    // Average rating
    const ratingRow = this.db
      .prepare(
        `SELECT AVG(rating) as avg_rating FROM rc_papers
         WHERE ${NOT_DELETED} AND rating IS NOT NULL`,
      )
      .get() as { avg_rating: number | null };

    // Starred count (papers with rating > 0)
    const starredRow = this.db
      .prepare(
        `SELECT COUNT(*) as cnt FROM rc_papers WHERE ${NOT_DELETED} AND rating IS NOT NULL AND rating > 0`,
      )
      .get() as { cnt: number };

    return {
      total: totalRow.cnt,
      by_status,
      by_year,
      by_source,
      total_tags: tagsRow.cnt,
      total_reading_minutes: readingRow.total,
      papers_with_pdf: pdfRow.cnt,
      starred_count: starredRow.cnt,
      average_rating:
        ratingRow.avg_rating != null
          ? Math.round(ratingRow.avg_rating * 100) / 100
          : null,
    };
  }

  // ── 19. batchAdd ────────────────────────────────────────────────────

  batchAdd(
    papers: PaperInput[],
  ): { added: Paper[]; duplicates: Paper[]; errors: Array<{ index: number; error: string }> } {
    if (papers.length > MAX_BATCH_SIZE) {
      throw new Error(
        `Batch size exceeds limit of ${MAX_BATCH_SIZE}. Received ${papers.length}.`,
      );
    }

    const added: Paper[] = [];
    const duplicates: Paper[] = [];
    const errors: Array<{ index: number; error: string }> = [];

    const txn = this.db.transaction(() => {
      for (let i = 0; i < papers.length; i++) {
        try {
          const result = this.add(papers[i]);
          if ('duplicate' in result && result.duplicate) {
            duplicates.push(result);
          } else {
            added.push(result);
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          errors.push({ index: i, error: message });
        }
      }
    });

    txn();

    return { added, duplicates, errors };
  }

  // ── 20. importBibtex ────────────────────────────────────────────────

  importBibtex(bibtex: string): { imported: number; skipped: number } {
    const entries = parseBibtex(bibtex);
    let imported = 0;
    let skipped = 0;

    const txn = this.db.transaction(() => {
      for (const entry of entries) {
        try {
          const f = entry.fields;

          const authors = f.author
            ? f.author
                .split(/\s+and\s+/i)
                .map((a) => a.trim())
                .filter(Boolean)
            : [];

          const year = f.year ? parseInt(f.year, 10) : undefined;
          const arxivId = f.eprint ?? f.arxivid ?? undefined;
          const venue = f.journal ?? f.booktitle ?? undefined;

          const bibtexTypeMap: Record<string, string> = {
            article: 'journal_article',
            inproceedings: 'conference_paper',
            conference: 'conference_paper',
            phdthesis: 'thesis',
            mastersthesis: 'thesis',
            book: 'book',
            incollection: 'book_chapter',
            techreport: 'report',
            misc: 'other',
          };

          const knownFields = new Set([
            'author',
            'title',
            'doi',
            'url',
            'eprint',
            'arxivid',
            'journal',
            'booktitle',
            'year',
            'abstract',
            'note',
            'notes',
            'volume',
            'number',
            'pages',
            'publisher',
            'issn',
            'isbn',
            'keywords',
            'language',
          ]);
          const extraMetadata: Record<string, string> = {};
          for (const [k, v] of Object.entries(f)) {
            if (!knownFields.has(k)) {
              extraMetadata[k] = v;
            }
          }

          const title = f.title ?? entry.citation_key;
          const doi = f.doi;

          const paperInput: PaperInput = {
            title,
            authors,
            abstract: f.abstract,
            doi,
            url: f.url,
            arxiv_id: arxivId,
            venue,
            year: year != null && !isNaN(year) ? year : undefined,
            bibtex_key: entry.citation_key || undefined,
            source: 'manual',
            notes: f.note ?? f.notes,
            volume: f.volume || undefined,
            issue: f.number || undefined,
            pages: f.pages || undefined,
            publisher: f.publisher || undefined,
            issn: f.issn || undefined,
            isbn: f.isbn || undefined,
            keywords: f.keywords ? f.keywords.split(',').map((k: string) => k.trim()).filter(Boolean) : undefined,
            language: f.language || undefined,
            paper_type: bibtexTypeMap[entry.type.toLowerCase()] || undefined,
            metadata:
              Object.keys(extraMetadata).length > 0 ? extraMetadata : undefined,
          };

          // The add() method only deduplicates by DOI and arxiv_id.
          // For entries without either identifier, perform a title-based
          // duplicate check so that re-importing the same BibTeX file
          // does not create duplicate rows.
          if (!doi && !arxivId && title) {
            const titleDupes = this.duplicateCheck({ title });
            if (titleDupes.some((m) => m.match_type === 'title_exact')) {
              skipped++;
              continue;
            }
          }

          const result = this.add(paperInput);
          if ('duplicate' in result && result.duplicate) {
            skipped++;
          } else {
            imported++;
          }
        } catch {
          // Non-duplicate errors count as skipped for this API
          skipped++;
        }
      }
    });

    txn();
    return { imported, skipped };
  }

  // ── 21. exportBibtex ────────────────────────────────────────────────

  exportBibtex(opts: {
    paperIds?: string[];
    tag?: string;
    collection?: string;
    all?: boolean;
  }): { bibtex: string; count: number } {
    let papers: Paper[] = [];

    if (opts.paperIds && opts.paperIds.length > 0) {
      for (const id of opts.paperIds) {
        const row = this.db
          .prepare(`SELECT * FROM rc_papers WHERE id = ? AND ${NOT_DELETED}`)
          .get(id) as PaperRow | undefined;
        if (row) {
          papers.push(rowToPaper(row, getTagsForPaper(this.db, row.id)));
        }
      }
    } else if (opts.tag) {
      const normalized = opts.tag.trim().toLowerCase();
      const rows = this.db
        .prepare(
          `SELECT p.* FROM rc_papers p
           JOIN rc_paper_tags pt ON pt.paper_id = p.id
           JOIN rc_tags t ON t.id = pt.tag_id AND t.name = ?
           WHERE ${NOT_DELETED}
           ORDER BY p.added_at DESC`,
        )
        .all(normalized) as PaperRow[];
      papers = rows.map((r) => rowToPaper(r, getTagsForPaper(this.db, r.id)));
    } else if (opts.collection) {
      const rows = this.db
        .prepare(
          `SELECT p.* FROM rc_papers p
           JOIN rc_collection_papers cp ON cp.paper_id = p.id AND cp.collection_id = ?
           WHERE ${NOT_DELETED}
           ORDER BY cp.sort_order, cp.added_at`,
        )
        .all(opts.collection) as PaperRow[];
      papers = rows.map((r) => rowToPaper(r, getTagsForPaper(this.db, r.id)));
    } else if (opts.all) {
      const rows = this.db
        .prepare(`SELECT * FROM rc_papers WHERE ${NOT_DELETED} ORDER BY added_at DESC`)
        .all() as PaperRow[];
      papers = rows.map((r) => rowToPaper(r, getTagsForPaper(this.db, r.id)));
    }

    const bibtex = papers.map((p) => paperToBibtex(p)).join('\n\n');
    return { bibtex, count: papers.length };
  }

  // ── 21b. exportRIS ─────────────────────────────────────────────────

  exportRIS(opts: {
    paperIds?: string[];
    tag?: string;
    collection?: string;
    all?: boolean;
  }): { ris: string; count: number } {
    let papers: Paper[] = [];

    if (opts.paperIds && opts.paperIds.length > 0) {
      for (const id of opts.paperIds) {
        const row = this.db
          .prepare(`SELECT * FROM rc_papers WHERE id = ? AND ${NOT_DELETED}`)
          .get(id) as PaperRow | undefined;
        if (row) {
          papers.push(rowToPaper(row, getTagsForPaper(this.db, row.id)));
        }
      }
    } else if (opts.tag) {
      const normalized = opts.tag.trim().toLowerCase();
      const rows = this.db
        .prepare(
          `SELECT p.* FROM rc_papers p
           JOIN rc_paper_tags pt ON pt.paper_id = p.id
           JOIN rc_tags t ON t.id = pt.tag_id AND t.name = ?
           WHERE ${NOT_DELETED}
           ORDER BY p.added_at DESC`,
        )
        .all(normalized) as PaperRow[];
      papers = rows.map((r) => rowToPaper(r, getTagsForPaper(this.db, r.id)));
    } else if (opts.collection) {
      const rows = this.db
        .prepare(
          `SELECT p.* FROM rc_papers p
           JOIN rc_collection_papers cp ON cp.paper_id = p.id AND cp.collection_id = ?
           WHERE ${NOT_DELETED}
           ORDER BY cp.sort_order, cp.added_at`,
        )
        .all(opts.collection) as PaperRow[];
      papers = rows.map((r) => rowToPaper(r, getTagsForPaper(this.db, r.id)));
    } else if (opts.all) {
      const rows = this.db
        .prepare(`SELECT * FROM rc_papers WHERE ${NOT_DELETED} ORDER BY added_at DESC`)
        .all() as PaperRow[];
      papers = rows.map((r) => rowToPaper(r, getTagsForPaper(this.db, r.id)));
    }

    const risEntries = papers.map((p) => paperToRIS(p));
    const ris = risEntries.join('\n');
    return { ris, count: papers.length };
  }

  // ── 22. listCollections ─────────────────────────────────────────────

  listCollections(): Collection[] {
    const rows = this.db
      .prepare(
        `SELECT c.id, c.name, c.description, c.color, c.created_at, c.updated_at,
                COUNT(p.id) AS paper_count
         FROM rc_collections c
         LEFT JOIN rc_collection_papers cp ON cp.collection_id = c.id
         LEFT JOIN rc_papers p ON p.id = cp.paper_id AND ${NOT_DELETED}
         GROUP BY c.id
         ORDER BY c.name ASC`,
      )
      .all() as CollectionRow[];

    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      color: r.color,
      created_at: r.created_at,
      updated_at: r.updated_at,
      paper_count: r.paper_count,
    }));
  }

  // ── 23. manageCollection ────────────────────────────────────────────

  manageCollection(
    action: string,
    opts: {
      id?: string;
      name?: string;
      description?: string;
      color?: string;
      paper_ids?: string[];
    },
  ): { id: string; action: string } {
    switch (action) {
      case 'create': {
        if (!opts.name) {
          throw new Error('Collection name is required for create action.');
        }
        const id = crypto.randomUUID();
        const timestamp = now();
        this.db
          .prepare(
            `INSERT INTO rc_collections (id, name, description, color, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(id, opts.name, opts.description ?? null, opts.color ?? null, timestamp, timestamp);
        return { id, action: 'create' };
      }

      case 'update': {
        if (!opts.id) {
          throw new Error('Collection id is required for update action.');
        }
        const existing = this.db
          .prepare('SELECT id FROM rc_collections WHERE id = ?')
          .get(opts.id) as { id: string } | undefined;
        if (!existing) {
          throw new Error(`Collection not found: ${opts.id}`);
        }

        const setClauses: string[] = [];
        const values: unknown[] = [];

        if (opts.name !== undefined) {
          setClauses.push('name = ?');
          values.push(opts.name);
        }
        if (opts.description !== undefined) {
          setClauses.push('description = ?');
          values.push(opts.description);
        }
        if (opts.color !== undefined) {
          setClauses.push('color = ?');
          values.push(opts.color);
        }

        setClauses.push('updated_at = ?');
        values.push(now());
        values.push(opts.id);

        this.db
          .prepare(`UPDATE rc_collections SET ${setClauses.join(', ')} WHERE id = ?`)
          .run(...values);

        return { id: opts.id, action: 'update' };
      }

      case 'delete': {
        if (!opts.id) {
          throw new Error('Collection id is required for delete action.');
        }
        this.db.prepare('DELETE FROM rc_collections WHERE id = ?').run(opts.id);
        return { id: opts.id, action: 'delete' };
      }

      case 'add_paper': {
        if (!opts.id) {
          throw new Error('Collection id is required for add_paper action.');
        }
        if (!opts.paper_ids || opts.paper_ids.length === 0) {
          throw new Error('paper_ids is required for add_paper action.');
        }

        const timestamp = now();
        const stmt = this.db.prepare(
          'INSERT OR IGNORE INTO rc_collection_papers (collection_id, paper_id, added_at) VALUES (?, ?, ?)',
        );

        const txn = this.db.transaction(() => {
          for (const pid of opts.paper_ids!) {
            stmt.run(opts.id, pid, timestamp);
          }
        });
        txn();

        return { id: opts.id, action: 'add_paper' };
      }

      case 'remove_paper': {
        if (!opts.id) {
          throw new Error('Collection id is required for remove_paper action.');
        }
        if (!opts.paper_ids || opts.paper_ids.length === 0) {
          throw new Error('paper_ids is required for remove_paper action.');
        }

        const stmt = this.db.prepare(
          'DELETE FROM rc_collection_papers WHERE collection_id = ? AND paper_id = ?',
        );

        const txn = this.db.transaction(() => {
          for (const pid of opts.paper_ids!) {
            stmt.run(opts.id, pid);
          }
        });
        txn();

        return { id: opts.id, action: 'remove_paper' };
      }

      default:
        throw new Error(`Unknown collection action: ${action}`);
    }
  }

  // ── 24. listNotes ───────────────────────────────────────────────────

  listNotes(paperId: string): PaperNote[] {
    // Verify the paper exists and is not soft-deleted before returning notes
    const paper = this.db
      .prepare(`SELECT id FROM rc_papers WHERE id = ? AND ${NOT_DELETED}`)
      .get(paperId) as { id: string } | undefined;
    if (!paper) {
      throw new Error(`Paper not found: ${paperId}`);
    }

    return this.db
      .prepare(
        'SELECT * FROM rc_paper_notes WHERE paper_id = ? ORDER BY created_at DESC',
      )
      .all(paperId) as NoteRow[];
  }

  // ── 25. addNote ─────────────────────────────────────────────────────

  addNote(
    paperId: string,
    content: string,
    page?: number,
    highlight?: string,
  ): PaperNote {
    const existing = this.db
      .prepare(`SELECT id FROM rc_papers WHERE id = ? AND ${NOT_DELETED}`)
      .get(paperId) as { id: string } | undefined;
    if (!existing) {
      throw new Error(`Paper not found: ${paperId}`);
    }

    const id = generateSortableId();
    const timestamp = now();

    this.db
      .prepare(
        `INSERT INTO rc_paper_notes (id, paper_id, content, page, highlight, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, paperId, content, page ?? null, highlight ?? null, timestamp);

    return {
      id,
      paper_id: paperId,
      content,
      page: page ?? null,
      highlight: highlight ?? null,
      created_at: timestamp,
    };
  }

  // ── 26. deleteNote ──────────────────────────────────────────────────

  deleteNote(noteId: string): void {
    const existing = this.db
      .prepare('SELECT id FROM rc_paper_notes WHERE id = ?')
      .get(noteId) as { id: string } | undefined;
    if (!existing) {
      throw new Error(`Note not found: ${noteId}`);
    }

    this.db.prepare('DELETE FROM rc_paper_notes WHERE id = ?').run(noteId);
  }
}

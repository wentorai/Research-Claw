/**
 * RIS Format Parser — Universal academic reference import/export.
 *
 * Parses RIS (Research Information Systems) format into PaperInput objects.
 * Works with exports from EndNote, Mendeley, Zotero, ReadCube, Web of Science, etc.
 *
 * No external dependencies — pure TypeScript implementation.
 */
import type { PaperInput } from './service.js';

// ── Constants ───────────────────────────────────────────────────────────

/** RIS TY (type) tag -> paper_type mapping */
const RIS_TYPE_MAP: Record<string, string> = {
  JOUR: 'journal_article',
  JFULL: 'journal_article',
  CONF: 'conference_paper',
  CPAPER: 'conference_paper',
  BOOK: 'book',
  CHAP: 'book_chapter',
  THES: 'thesis',
  RPRT: 'report',
  UNPB: 'preprint',
  PAT: 'patent',
  DATA: 'dataset',
  GEN: 'other',
  ELEC: 'other',
  MGZN: 'journal_article',
  NEWS: 'other',
  ABST: 'other',
  ADVS: 'other',
  AGGR: 'other',
  ANCIENT: 'other',
  ART: 'other',
  BILL: 'other',
  BLOG: 'other',
  CASE: 'other',
  CLSWK: 'other',
  COMP: 'other',
  CTLG: 'other',
  DBASE: 'dataset',
  DICT: 'book',
  EBOOK: 'book',
  EDBOOK: 'book',
  EJOUR: 'journal_article',
  ENCYC: 'book',
  GOVDOC: 'report',
  GRANT: 'other',
  HEAR: 'other',
  ICOMM: 'other',
  INPR: 'preprint',
  LEGAL: 'other',
  MANSCPT: 'other',
  MAP: 'other',
  MPCT: 'other',
  MULTI: 'other',
  MUSIC: 'other',
  PAMP: 'other',
  PCOMM: 'other',
  SLIDE: 'other',
  SOUND: 'other',
  STAND: 'other',
  STAT: 'other',
  STD: 'other',
  UNBILL: 'other',
  VIDEO: 'other',
  WEB: 'other',
};

/** Reverse mapping: paper_type -> RIS TY tag (for export) */
const PAPER_TYPE_TO_RIS: Record<string, string> = {
  journal_article: 'JOUR',
  conference_paper: 'CONF',
  book: 'BOOK',
  book_chapter: 'CHAP',
  thesis: 'THES',
  report: 'RPRT',
  preprint: 'UNPB',
  patent: 'PAT',
  dataset: 'DATA',
  other: 'GEN',
};

/**
 * RIS tag line regex.
 * Matches: TAG  - VALUE  (2-4 uppercase chars, two spaces, dash, space, then value)
 * Also handles tags with no value: TAG  -
 */
const TAG_LINE_RE = /^([A-Z][A-Z0-9]{0,3})\s{2}-\s?(.*)$/;

// ── Types ───────────────────────────────────────────────────────────────

interface RISEntry {
  /** Tag -> array of values (multi-value tags produce multiple entries) */
  tags: Map<string, string[]>;
}

// ── Parser ──────────────────────────────────────────────────────────────

/**
 * Parse a complete RIS file/string into PaperInput objects.
 *
 * Handles:
 * - Multiple entries separated by ER tags
 * - Multi-value tags (AU, KW, A1, A2, etc.)
 * - Continuation lines (lines without a tag prefix are appended to the previous tag)
 * - Mixed line endings (CRLF, LF, CR)
 * - Blank lines and whitespace
 * - BOM (byte order mark) at start of file
 */
export function parseRIS(content: string): PaperInput[] {
  if (!content || typeof content !== 'string') return [];

  // Strip BOM if present
  const cleaned = content.charCodeAt(0) === 0xFEFF ? content.slice(1) : content;

  const lines = cleaned.split(/\r\n|\r|\n/);
  const entries: RISEntry[] = [];
  let current: RISEntry | null = null;
  let lastTag: string | null = null;

  for (const line of lines) {
    const match = line.match(TAG_LINE_RE);

    if (match) {
      const [, tag, value] = match;
      const trimmedValue = value.trim();

      if (tag === 'TY') {
        // Start of a new entry
        current = { tags: new Map() };
        current.tags.set('TY', [trimmedValue]);
        lastTag = 'TY';
      } else if (tag === 'ER') {
        // End of current entry
        if (current) {
          entries.push(current);
          current = null;
          lastTag = null;
        }
      } else if (current) {
        // Regular tag within an entry
        const existing = current.tags.get(tag);
        if (existing) {
          existing.push(trimmedValue);
        } else {
          current.tags.set(tag, [trimmedValue]);
        }
        lastTag = tag;
      }
    } else if (current && lastTag && line.trim().length > 0) {
      // Continuation line — append to the last tag's most recent value
      const existing = current.tags.get(lastTag);
      if (existing && existing.length > 0) {
        existing[existing.length - 1] += '\n' + line.trim();
      }
    }
  }

  // Handle entries without a closing ER tag (some exporters omit it)
  if (current && current.tags.size > 0) {
    entries.push(current);
  }

  return entries
    .map(entryToPaperInput)
    .filter((p): p is PaperInput => p !== null);
}

/**
 * Convert a parsed RIS entry to a PaperInput.
 * Returns null if the entry has no usable title.
 */
function entryToPaperInput(entry: RISEntry): PaperInput | null {
  const first = (tag: string): string | undefined => {
    const vals = entry.tags.get(tag);
    return vals?.[0]?.trim() || undefined;
  };

  const all = (tag: string): string[] => {
    return (entry.tags.get(tag) ?? []).map(v => v.trim()).filter(v => v.length > 0);
  };

  // Title: T1 (primary), TI (alternative), CT (caption title)
  const title = first('T1') ?? first('TI') ?? first('CT');
  if (!title) return null;

  // Authors: AU, A1 (primary authors), A2 (secondary/editors), A3 (tertiary)
  const authors = [...all('AU'), ...all('A1')];
  // Deduplicate (some exporters emit both AU and A1)
  const uniqueAuthors = [...new Set(authors)];

  // Type
  const tyTag = first('TY') ?? 'GEN';
  const paperType = RIS_TYPE_MAP[tyTag] ?? 'other';

  // DOI: DO tag, or sometimes embedded in M3, N1, or UR
  let doi = first('DO');
  if (!doi) {
    // Check M3 for DOI
    const m3 = first('M3');
    if (m3 && m3.startsWith('10.')) doi = m3;
  }
  if (!doi) {
    // Check UR for DOI URL
    const urls = all('UR');
    for (const u of urls) {
      const doiMatch = u.match(/doi\.org\/(.+)/i);
      if (doiMatch) {
        doi = doiMatch[1].trim();
        break;
      }
    }
  }
  if (doi) {
    // Normalize: strip URI prefix
    doi = doi.replace(/^https?:\/\/doi\.org\//, '').trim();
  }

  // Year: PY (publication year) or Y1 (primary date) or DA (date)
  let year: number | undefined;
  const yearStr = first('PY') ?? first('Y1') ?? first('DA');
  if (yearStr) {
    const match = yearStr.match(/(\d{4})/);
    if (match) {
      const y = Number(match[1]);
      if (y >= 1000 && y <= 2100) year = y;
    }
  }

  // Journal/venue: JO, JF (journal full), JA (abbreviated), T2 (secondary title)
  const venue = first('JO') ?? first('JF') ?? first('JA') ?? first('T2');

  // Volume, Issue
  const volume = first('VL');
  const issue = first('IS');

  // Pages: SP (start page) + EP (end page) combined, or SP alone if range
  let pages: string | undefined;
  const sp = first('SP');
  const ep = first('EP');
  if (sp && ep) {
    pages = sp === ep ? sp : `${sp}-${ep}`;
  } else if (sp) {
    pages = sp;
  }

  // URL: UR tag (may have multiple — take first non-DOI one, fall back to first)
  let url: string | undefined;
  const urls = all('UR');
  if (urls.length > 0) {
    // Prefer a non-DOI URL
    url = urls.find(u => !u.includes('doi.org')) ?? urls[0];
  }
  // Also check L1 (link to PDF — usually URL), L2 (link to full text)
  if (!url) url = first('L2') ?? first('L1');

  // Abstract: AB or N2
  const abstract_ = first('AB') ?? first('N2');

  // Keywords: KW tag (one per line in RIS)
  const keywords = all('KW');
  // Some exporters put semicolon-delimited keywords in a single KW line
  const expandedKeywords: string[] = [];
  for (const kw of keywords) {
    if (kw.includes(';')) {
      expandedKeywords.push(...kw.split(';').map(k => k.trim()).filter(k => k.length > 0));
    } else {
      expandedKeywords.push(kw);
    }
  }
  const uniqueKeywords = [...new Set(expandedKeywords)];

  // Publisher: PB
  const publisher = first('PB');

  // ISBN/ISSN: SN tag — disambiguate by type
  const sn = first('SN');
  let issn: string | undefined;
  let isbn: string | undefined;
  if (sn) {
    if (
      paperType === 'journal_article' ||
      paperType === 'conference_paper' ||
      tyTag === 'MGZN'
    ) {
      issn = sn;
    } else if (paperType === 'book' || paperType === 'book_chapter') {
      isbn = sn;
    } else {
      // Heuristic: ISSN is 4-4 pattern, ISBN is longer
      if (/^\d{4}-?\d{3}[\dXx]$/.test(sn.replace(/\s/g, ''))) {
        issn = sn;
      } else {
        isbn = sn;
      }
    }
  }

  // Language: LA
  const language = first('LA');

  // Notes: N1 (notes), RN (research notes)
  const notes = first('N1') ?? first('RN');

  // PDF path: L1 (link to PDF — local file path)
  let pdfPath: string | undefined;
  const l1 = first('L1');
  if (l1) {
    // L1 might be a file:// URI or local path
    if (l1.startsWith('file://')) {
      try {
        pdfPath = decodeURIComponent(l1.replace(/^file:\/\//, ''));
      } catch {
        pdfPath = l1.replace(/^file:\/\//, '');
      }
    } else if (l1.startsWith('/') || /^[A-Z]:\\/.test(l1)) {
      pdfPath = l1;
    }
    // Otherwise it's probably a URL, which we handled above
  }

  // Build metadata for RIS-specific fields
  const metadata: Record<string, unknown> = {};
  const id = first('ID');
  if (id) metadata.ris_id = id;
  const accession = first('AN');
  if (accession) metadata.accession_number = accession;
  const callNumber = first('CN');
  if (callNumber) metadata.call_number = callNumber;
  const edition = first('ET');
  if (edition) metadata.edition = edition;
  // Secondary (editor) authors
  const editors = all('A2');
  if (editors.length > 0) metadata.editors = editors;
  // Series editor / tertiary authors
  const a3 = all('A3');
  if (a3.length > 0) metadata.tertiary_authors = a3;
  // Reprint status
  const rp = first('RP');
  if (rp) metadata.reprint_status = rp;
  // Database name / provider
  const dp = first('DP');
  if (dp) metadata.database_provider = dp;
  // Custom fields
  const c1 = first('C1');
  if (c1) metadata.custom1 = c1;
  const c2 = first('C2');
  if (c2) metadata.custom2 = c2;
  const c3 = first('C3');
  if (c3) metadata.custom3 = c3;

  const paper: PaperInput = {
    title,
    authors: uniqueAuthors.length > 0 ? uniqueAuthors : undefined,
    abstract: abstract_,
    doi,
    url,
    pdf_path: pdfPath,
    source: 'ris_import',
    venue,
    year,
    notes,
    keywords: uniqueKeywords.length > 0 ? uniqueKeywords : undefined,
    language,
    paper_type: paperType,
    volume,
    issue,
    pages,
    publisher,
    issn,
    isbn,
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
  };

  return paper;
}

// ── Exporter ────────────────────────────────────────────────────────────

/**
 * Export a single paper record as an RIS-formatted string.
 *
 * Generates a valid RIS entry with TY/ER delimiters. Multi-value fields
 * (authors, keywords) emit one tag per value, per the RIS specification.
 */
export function exportRISEntry(paper: {
  title: string;
  authors: string[];
  abstract?: string | null;
  doi?: string | null;
  url?: string | null;
  year?: number | null;
  venue?: string | null;
  volume?: string | null;
  issue?: string | null;
  pages?: string | null;
  publisher?: string | null;
  issn?: string | null;
  isbn?: string | null;
  language?: string | null;
  keywords?: string[];
  paper_type?: string | null;
}): string {
  const lines: string[] = [];

  const tag = (t: string, v: string | null | undefined) => {
    if (v != null && v.trim().length > 0) {
      lines.push(`${t}  - ${v.trim()}`);
    }
  };

  // Type
  const risType = (paper.paper_type && PAPER_TYPE_TO_RIS[paper.paper_type]) ?? 'GEN';
  tag('TY', risType);

  // Title
  tag('TI', paper.title);

  // Authors — one AU line per author
  if (paper.authors) {
    for (const author of paper.authors) {
      tag('AU', author);
    }
  }

  // Year
  if (paper.year != null) {
    tag('PY', String(paper.year));
  }

  // Journal / venue
  tag('JO', paper.venue ?? undefined);

  // Volume, Issue
  tag('VL', paper.volume ?? undefined);
  tag('IS', paper.issue ?? undefined);

  // Pages — split into SP/EP if range format
  if (paper.pages) {
    const pageMatch = paper.pages.match(/^(\d+)\s*[-–]\s*(\d+)$/);
    if (pageMatch) {
      tag('SP', pageMatch[1]);
      tag('EP', pageMatch[2]);
    } else {
      tag('SP', paper.pages);
    }
  }

  // Abstract
  tag('AB', paper.abstract ?? undefined);

  // DOI
  tag('DO', paper.doi ?? undefined);

  // URL
  tag('UR', paper.url ?? undefined);

  // Publisher
  tag('PB', paper.publisher ?? undefined);

  // ISSN / ISBN → SN
  if (paper.issn) {
    tag('SN', paper.issn);
  } else if (paper.isbn) {
    tag('SN', paper.isbn);
  }

  // Language
  tag('LA', paper.language ?? undefined);

  // Keywords — one KW line per keyword
  if (paper.keywords) {
    for (const kw of paper.keywords) {
      tag('KW', kw);
    }
  }

  // End record
  tag('ER', '');

  return lines.join('\n');
}

/**
 * Export multiple papers as a complete RIS file string.
 *
 * Entries are separated by blank lines per convention.
 */
export function exportRIS(papers: Parameters<typeof exportRISEntry>[0][]): string {
  return papers.map(p => exportRISEntry(p)).join('\n\n') + '\n';
}

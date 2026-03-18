/**
 * Academic paper scanner — arXiv
 *
 * Queries external paper databases for new papers matching the provided options.
 * Deduplicates against the local library (rc_papers) by DOI and arXiv ID.
 */

import type { Database } from 'better-sqlite3';

// ── Types ────────────────────────────────────────────────────────────────

export interface ScannedPaper {
  title: string;
  authors: string[];
  abstract: string;
  url: string;
  source: string;
  arxiv_id?: string;
  doi?: string;
  year?: number;
  venue?: string;
}

export interface ScanResult {
  source: string;
  query: string;
  papers: ScannedPaper[];
  total_found: number;
  papers_added: number;
  papers_skipped: number;
  errors: string[];
}

export interface ScanOptions {
  keywords?: string[];
  authors?: string[];
  sources?: string[];
  max_results?: number;
}

interface ScanConfig {
  keywords: string[];
  authors: string[];
  sources: string[];
}

// ── Helpers ──────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ── arXiv Scanner ────────────────────────────────────────────────────────

function buildArxivQuery(keywords: string[], authors: string[]): string {
  const parts: string[] = [];
  if (keywords.length > 0) {
    parts.push(`all:(${keywords.join(' OR ')})`);
  }
  if (authors.length > 0) {
    parts.push(`au:(${authors.join(' OR ')})`);
  }
  return parts.join(' AND ');
}

function parseArxivAtom(xml: string): ScannedPaper[] {
  const papers: ScannedPaper[] = [];
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
  let match: RegExpExecArray | null;

  while ((match = entryRegex.exec(xml)) !== null) {
    const entry = match[1];

    const titleMatch = entry.match(/<title>([\s\S]*?)<\/title>/);
    const title = titleMatch?.[1]?.replace(/\s+/g, ' ').trim() ?? '';

    const authors: string[] = [];
    const authorRegex = /<author>\s*<name>([\s\S]*?)<\/name>/g;
    let authorMatch: RegExpExecArray | null;
    while ((authorMatch = authorRegex.exec(entry)) !== null) {
      authors.push(authorMatch[1].trim());
    }

    const summaryMatch = entry.match(/<summary>([\s\S]*?)<\/summary>/);
    const abstract = summaryMatch?.[1]?.replace(/\s+/g, ' ').trim() ?? '';

    const idMatch = entry.match(/<id>([\s\S]*?)<\/id>/);
    const rawId = idMatch?.[1]?.trim() ?? '';
    const arxivId = rawId.replace(/https?:\/\/arxiv\.org\/abs\//, '').replace(/v\d+$/, '');

    const publishedMatch = entry.match(/<published>([\s\S]*?)<\/published>/);
    const year = publishedMatch?.[1] ? new Date(publishedMatch[1]).getFullYear() : undefined;

    const doiMatch = entry.match(/<arxiv:doi[^>]*>([\s\S]*?)<\/arxiv:doi>/);
    const doi = doiMatch?.[1]?.trim();

    if (title) {
      papers.push({
        title,
        authors,
        abstract,
        url: `https://arxiv.org/abs/${arxivId}`,
        source: 'arxiv',
        arxiv_id: arxivId || undefined,
        doi,
        year,
      });
    }
  }

  return papers;
}

async function scanArxiv(keywords: string[], authors: string[], maxResults: number): Promise<ScanResult> {
  const query = buildArxivQuery(keywords, authors);
  if (!query) {
    return { source: 'arxiv', query: '', papers: [], total_found: 0, papers_added: 0, papers_skipped: 0, errors: ['No search terms'] };
  }

  const url = `http://export.arxiv.org/api/query?search_query=${encodeURIComponent(query)}&max_results=${maxResults}&sortBy=submittedDate&sortOrder=descending`;

  try {
    const res = await fetchWithTimeout(url, 10_000);
    if (!res.ok) {
      return { source: 'arxiv', query, papers: [], total_found: 0, papers_added: 0, papers_skipped: 0, errors: [`HTTP ${res.status}`] };
    }

    // Rate limit: arXiv asks for delays between requests
    await sleep(400);

    const xml = await res.text();
    const papers = parseArxivAtom(xml);

    const totalMatch = xml.match(/<opensearch:totalResults[^>]*>(\d+)<\/opensearch:totalResults>/);
    const totalFound = totalMatch ? parseInt(totalMatch[1], 10) : papers.length;

    return {
      source: 'arxiv',
      query,
      papers,
      total_found: totalFound,
      papers_added: 0,
      papers_skipped: 0,
      errors: [],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { source: 'arxiv', query, papers: [], total_found: 0, papers_added: 0, papers_skipped: 0, errors: [message] };
  }
}

// ── Deduplication ────────────────────────────────────────────────────────

function deduplicateAgainstLibrary(db: Database, papers: ScannedPaper[]): { unique: ScannedPaper[]; skipped: number } {
  if (papers.length === 0) return { unique: papers, skipped: 0 };

  // Collect all DOIs and arXiv IDs from scanned papers
  const dois = papers.map((p) => p.doi).filter(Boolean) as string[];
  const arxivIds = papers.map((p) => p.arxiv_id).filter(Boolean) as string[];

  const existingDois = new Set<string>();
  const existingArxivIds = new Set<string>();

  // Check existing DOIs
  if (dois.length > 0) {
    const placeholders = dois.map(() => '?').join(',');
    const rows = db.prepare(`SELECT doi FROM rc_papers WHERE doi IN (${placeholders})`).all(...dois) as Array<{ doi: string }>;
    for (const row of rows) existingDois.add(row.doi);
  }

  // Check existing arXiv IDs
  if (arxivIds.length > 0) {
    const placeholders = arxivIds.map(() => '?').join(',');
    const rows = db.prepare(`SELECT arxiv_id FROM rc_papers WHERE arxiv_id IN (${placeholders})`).all(...arxivIds) as Array<{ arxiv_id: string }>;
    for (const row of rows) existingArxivIds.add(row.arxiv_id);
  }

  const unique: ScannedPaper[] = [];
  let skipped = 0;

  for (const paper of papers) {
    const isDupe = (paper.doi && existingDois.has(paper.doi)) ||
                   (paper.arxiv_id && existingArxivIds.has(paper.arxiv_id));
    if (isDupe) {
      skipped++;
    } else {
      unique.push(paper);
    }
  }

  return { unique, skipped };
}

// ── Main Scanner ─────────────────────────────────────────────────────────

export async function scanSources(db: Database, options: ScanOptions = {}): Promise<ScanResult[]> {
  const keywords = options.keywords ?? [];
  const authors = options.authors ?? [];
  const sources = options.sources ?? ['arxiv'];
  const maxResults = options.max_results ?? 20;

  if (keywords.length === 0 && authors.length === 0) {
    return [{
      source: 'none',
      query: '',
      papers: [],
      total_found: 0,
      papers_added: 0,
      papers_skipped: 0,
      errors: ['No keywords or authors to search for.'],
    }];
  }

  const results: ScanResult[] = [];

  // Run each source independently — failures don't block others
  for (const source of sources) {
    let result: ScanResult;

    switch (source) {
      case 'arxiv':
        result = await scanArxiv(keywords, authors, maxResults);
        break;
      default:
        result = {
          source,
          query: '',
          papers: [],
          total_found: 0,
          papers_added: 0,
          papers_skipped: 0,
          errors: [`Unknown source: ${source}`],
        };
    }

    // Deduplicate against local library
    const { unique, skipped } = deduplicateAgainstLibrary(db, result.papers);
    result.papers = unique;
    result.papers_skipped = skipped;

    results.push(result);
  }

  return results;
}

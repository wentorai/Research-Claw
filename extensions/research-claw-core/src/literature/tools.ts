/**
 * Research-Claw Core — Literature Tools
 *
 * 17 agent tools in the `library_*` namespace.
 * Each tool is registered via api.registerTool() with JSON Schema parameters
 * and an execute callback matching the OpenClaw ToolDefinition interface.
 */

// Note: Tool parameters use raw JSON Schema objects for simplicity.
// The spec suggests TypeBox (@sinclair/typebox) but raw schemas are
// functionally equivalent and avoid an additional abstraction layer.

import { existsSync } from 'node:fs';
import { LiteratureService, type Paper, type PaperInput, type PaperPatch } from './service.js';
import type { ToolDefinition } from '../types.js';
import { ZoteroBridge } from './zotero.js';
import { EndNoteBridge } from './endnote.js';
import { parseRIS } from './ris-parser.js';

// ── Helpers ─────────────────────────────────────────────────────────────

function ok(text: string, details: unknown): unknown {
  return { content: [{ type: 'text', text }], details };
}

function fail(message: string): unknown {
  return { content: [{ type: 'text', text: `Error: ${message}` }], details: { error: message } };
}

// ── Registration ────────────────────────────────────────────────────────

export function createLiteratureTools(service: LiteratureService): ToolDefinition[] {
  const tools: ToolDefinition[] = [];

  // ── 1. library_add_paper ──────────────────────────────────────────────

  tools.push({
    name: 'library_add_paper',
    description:
      'Add a paper to the local research library. Returns the saved paper object. ' +
      'If a paper with the same DOI or arXiv ID already exists, an error is returned.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Paper title' },
        authors: { type: 'array', items: { type: 'string' }, description: 'List of author names' },
        doi: { type: 'string', description: 'Digital Object Identifier' },
        arxiv_id: { type: 'string', description: 'arXiv identifier (e.g. 2301.12345)' },
        venue: { type: 'string', description: 'Publication venue (journal or conference)' },
        year: { type: 'number', description: 'Publication year' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags to attach' },
        notes: { type: 'string', description: 'Personal notes' },
        pdf_path: { type: 'string', description: 'Local path to the PDF file' },
        bibtex_key: { type: 'string', description: 'BibTeX citation key' },
        metadata: { type: 'object', description: 'Additional metadata' },
        abstract: { type: 'string', description: 'Paper abstract' },
        url: { type: 'string', description: 'URL to the paper' },
        source: { type: 'string', description: 'Discovery source (e.g. arxiv, openalex, crossref)' },
        source_id: { type: 'string', description: 'Source-specific identifier' },
        keywords: { type: 'array', items: { type: 'string' }, description: 'Paper keywords' },
        language: { type: 'string', description: 'Paper language (e.g. en, zh, ja)' },
        paper_type: { type: 'string', enum: ['journal_article', 'conference_paper', 'preprint', 'thesis', 'book', 'book_chapter', 'report', 'patent', 'dataset', 'other'], description: 'Paper type' },
        volume: { type: 'string', description: 'Journal volume' },
        issue: { type: 'string', description: 'Journal issue number' },
        pages: { type: 'string', description: 'Page range (e.g. "1-15")' },
        publisher: { type: 'string', description: 'Publisher name' },
        issn: { type: 'string', description: 'Journal ISSN' },
        isbn: { type: 'string', description: 'Book ISBN' },
        discipline: { type: 'string', description: 'Academic discipline' },
        citation_count: { type: 'number', description: 'Citation count' },
      },
      required: ['title'],
    },
    execute: async (_toolCallId: string, params: Record<string, unknown>) => {
      try {
        // Defensive validation: LLM may omit or null-out required fields
        if (typeof params.title !== 'string' || !params.title.trim()) {
          return fail('title is required and must be a non-empty string');
        }

        const input: PaperInput = {
          title: params.title.trim(),
          authors: Array.isArray(params.authors) ? params.authors.filter((a): a is string => typeof a === 'string') : undefined,
          doi: typeof params.doi === 'string' ? params.doi : undefined,
          arxiv_id: typeof params.arxiv_id === 'string' ? params.arxiv_id : undefined,
          venue: typeof params.venue === 'string' ? params.venue : undefined,
          year: typeof params.year === 'number' ? params.year : undefined,
          tags: Array.isArray(params.tags) ? params.tags.filter((t): t is string => typeof t === 'string') : undefined,
          notes: typeof params.notes === 'string' ? params.notes : undefined,
          pdf_path: typeof params.pdf_path === 'string' ? params.pdf_path : undefined,
          bibtex_key: typeof params.bibtex_key === 'string' ? params.bibtex_key : undefined,
          metadata: (typeof params.metadata === 'object' && params.metadata !== null) ? params.metadata as Record<string, unknown> : undefined,
          abstract: typeof params.abstract === 'string' ? params.abstract : undefined,
          url: typeof params.url === 'string' ? params.url : undefined,
          source: typeof params.source === 'string' ? params.source : undefined,
          source_id: typeof params.source_id === 'string' ? params.source_id : undefined,
          keywords: Array.isArray(params.keywords) ? params.keywords.filter((k): k is string => typeof k === 'string') : undefined,
          language: typeof params.language === 'string' ? params.language : undefined,
          paper_type: typeof params.paper_type === 'string' ? params.paper_type : undefined,
          volume: typeof params.volume === 'string' ? params.volume : undefined,
          issue: typeof params.issue === 'string' ? params.issue : undefined,
          pages: typeof params.pages === 'string' ? params.pages : undefined,
          publisher: typeof params.publisher === 'string' ? params.publisher : undefined,
          issn: typeof params.issn === 'string' ? params.issn : undefined,
          isbn: typeof params.isbn === 'string' ? params.isbn : undefined,
          discipline: typeof params.discipline === 'string' ? params.discipline : undefined,
          citation_count: typeof params.citation_count === 'number' ? params.citation_count : undefined,
        };
        const paper = service.add(input);

        // Build paper_card JSON block so the LLM includes it in its response
        const cardData: Record<string, unknown> = {
          type: 'paper_card',
          title: paper.title,
          authors: paper.authors ?? [],
          read_status: paper.read_status ?? 'unread',
          library_id: paper.id,
        };
        if (paper.venue) cardData.venue = paper.venue;
        if (paper.year) cardData.year = paper.year;
        if (paper.doi) cardData.doi = paper.doi;
        if (paper.url) cardData.url = paper.url;
        if (paper.arxiv_id) cardData.arxiv_id = paper.arxiv_id;
        const cardJson = JSON.stringify(cardData);

        return ok(
          `Added paper "${paper.title}" (id: ${paper.id})` +
            (paper.tags && paper.tags.length > 0 ? ` with tags: ${paper.tags.join(', ')}` : '') +
            `\n\nInclude this card in your response:\n\`\`\`paper_card\n${cardJson}\n\`\`\``,
          paper,
        );
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  });

  // ── 2. library_search ─────────────────────────────────────────────────

  tools.push({
    name: 'library_search',
    description:
      'Search the local research library by query string. ' +
      'Supports full-text search across title, abstract, and authors.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query (full-text search across title, abstract, authors)' },
        limit: { type: 'number', description: 'Maximum results to return (default 50, max 500)' },
        offset: { type: 'number', description: 'Pagination offset' },
      },
      required: ['query'],
    },
    execute: async (_toolCallId: string, params: Record<string, unknown>) => {
      try {
        if (typeof params.query !== 'string' || !params.query.trim()) {
          return fail('query is required and must be a non-empty string');
        }
        const query = params.query.trim();
        const limit = typeof params.limit === 'number' ? params.limit : 50;
        const offset = typeof params.offset === 'number' ? params.offset : 0;
        const result = service.search(query, limit, offset);
        return ok(
          `Found ${result.total} paper(s) matching "${query}" (showing ${result.items.length})`,
          result,
        );
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  });

  // ── 3. library_update_paper ───────────────────────────────────────────

  tools.push({
    name: 'library_update_paper',
    description:
      'Update one or more fields of an existing paper in the library. ' +
      'Only provide the fields you want to change.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Paper ID' },
        title: { type: 'string', description: 'Paper title' },
        authors: { type: 'array', items: { type: 'string' }, description: 'Updated author list' },
        abstract: { type: 'string', description: 'Paper abstract' },
        doi: { type: 'string', description: 'Digital Object Identifier' },
        url: { type: 'string', description: 'URL to the paper' },
        arxiv_id: { type: 'string', description: 'arXiv identifier' },
        pdf_path: { type: 'string', description: 'Local PDF path' },
        source: { type: 'string', description: 'Discovery source' },
        source_id: { type: 'string', description: 'Source-specific identifier' },
        venue: { type: 'string', description: 'Publication venue' },
        year: { type: 'number', description: 'Publication year' },
        read_status: { type: 'string', description: 'Reading status (unread, reading, read, reviewed)' },
        rating: { type: 'number', description: 'Rating (1-5)' },
        notes: { type: 'string', description: 'Personal notes' },
        bibtex_key: { type: 'string', description: 'BibTeX citation key' },
        metadata: { type: 'object', description: 'Additional metadata' },
        keywords: { type: 'array', items: { type: 'string' }, description: 'Paper keywords' },
        language: { type: 'string', description: 'Paper language (e.g. en, zh, ja)' },
        paper_type: { type: 'string', enum: ['journal_article', 'conference_paper', 'preprint', 'thesis', 'book', 'book_chapter', 'report', 'patent', 'dataset', 'other'], description: 'Paper type' },
        volume: { type: 'string', description: 'Journal volume' },
        issue: { type: 'string', description: 'Journal issue number' },
        pages: { type: 'string', description: 'Page range (e.g. "1-15")' },
        publisher: { type: 'string', description: 'Publisher name' },
        issn: { type: 'string', description: 'Journal ISSN' },
        isbn: { type: 'string', description: 'Book ISBN' },
        discipline: { type: 'string', description: 'Academic discipline' },
        citation_count: { type: 'number', description: 'Citation count' },
      },
      required: ['id'],
    },
    execute: async (_toolCallId: string, params: Record<string, unknown>) => {
      try {
        if (typeof params.id !== 'string' || !params.id.trim()) {
          return fail('id is required and must be a non-empty string');
        }
        const id = params.id.trim();
        const patch: PaperPatch = {};
        if (params.title !== undefined && typeof params.title === 'string') patch.title = params.title;
        if (params.authors !== undefined && Array.isArray(params.authors)) patch.authors = params.authors.filter((a): a is string => typeof a === 'string');
        if (params.abstract !== undefined && typeof params.abstract === 'string') patch.abstract = params.abstract;
        if (params.doi !== undefined && typeof params.doi === 'string') patch.doi = params.doi;
        if (params.url !== undefined && typeof params.url === 'string') patch.url = params.url;
        if (params.arxiv_id !== undefined && typeof params.arxiv_id === 'string') patch.arxiv_id = params.arxiv_id;
        if (params.pdf_path !== undefined && typeof params.pdf_path === 'string') patch.pdf_path = params.pdf_path;
        if (params.source !== undefined && typeof params.source === 'string') patch.source = params.source;
        if (params.source_id !== undefined && typeof params.source_id === 'string') patch.source_id = params.source_id;
        if (params.venue !== undefined && typeof params.venue === 'string') patch.venue = params.venue;
        if (params.year !== undefined && typeof params.year === 'number') patch.year = params.year;
        if (params.read_status !== undefined && typeof params.read_status === 'string') patch.read_status = params.read_status;
        if (params.rating !== undefined && typeof params.rating === 'number') patch.rating = params.rating;
        if (params.notes !== undefined && typeof params.notes === 'string') patch.notes = params.notes;
        if (params.bibtex_key !== undefined && typeof params.bibtex_key === 'string') patch.bibtex_key = params.bibtex_key;
        if (params.metadata !== undefined && typeof params.metadata === 'object' && params.metadata !== null) patch.metadata = params.metadata as Record<string, unknown>;
        if (params.keywords !== undefined && Array.isArray(params.keywords)) patch.keywords = params.keywords.filter((k): k is string => typeof k === 'string');
        if (params.language !== undefined && typeof params.language === 'string') patch.language = params.language;
        if (params.paper_type !== undefined && typeof params.paper_type === 'string') patch.paper_type = params.paper_type;
        if (params.volume !== undefined && typeof params.volume === 'string') patch.volume = params.volume;
        if (params.issue !== undefined && typeof params.issue === 'string') patch.issue = params.issue;
        if (params.pages !== undefined && typeof params.pages === 'string') patch.pages = params.pages;
        if (params.publisher !== undefined && typeof params.publisher === 'string') patch.publisher = params.publisher;
        if (params.issn !== undefined && typeof params.issn === 'string') patch.issn = params.issn;
        if (params.isbn !== undefined && typeof params.isbn === 'string') patch.isbn = params.isbn;
        if (params.discipline !== undefined && typeof params.discipline === 'string') patch.discipline = params.discipline;
        if (params.citation_count !== undefined && typeof params.citation_count === 'number') patch.citation_count = params.citation_count;

        const paper = service.update(id, patch);
        return ok(`Updated paper "${paper.title}" (id: ${paper.id})`, paper);
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  });

  // ── 4. library_get_paper ──────────────────────────────────────────────

  tools.push({
    name: 'library_get_paper',
    description:
      'Get detailed information about a specific paper by ID, including tags and metadata.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Paper ID' },
      },
      required: ['id'],
    },
    execute: async (_toolCallId: string, params: Record<string, unknown>) => {
      try {
        if (typeof params.id !== 'string' || !params.id.trim()) {
          return fail('id is required and must be a non-empty string');
        }
        const id = params.id.trim();
        const paper = service.get(id);
        if (!paper) {
          return fail(`Paper not found: ${id}`);
        }
        return ok(`Paper: "${paper.title}" by ${paper.authors.join(', ') || 'unknown'}`, paper);
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  });

  // ── 5. library_export_bibtex ──────────────────────────────────────────

  tools.push({
    name: 'library_export_bibtex',
    description:
      'Export papers as BibTeX or RIS entries. Select by paper IDs, tag, collection, or export all.',
    parameters: {
      type: 'object',
      properties: {
        paper_ids: { type: 'array', items: { type: 'string' }, description: 'List of paper IDs to export' },
        tag: { type: 'string', description: 'Export all papers with this tag' },
        collection: { type: 'string', description: 'Export all papers in this collection ID' },
        all: { type: 'boolean', description: 'Export entire library' },
        format: { type: 'string', enum: ['bibtex', 'ris'], description: 'Export format (default: bibtex)' },
      },
    },
    execute: async (_toolCallId: string, params: Record<string, unknown>) => {
      try {
        const exportOpts = {
          paperIds: Array.isArray(params.paper_ids) ? params.paper_ids.filter((id): id is string => typeof id === 'string') : undefined,
          tag: typeof params.tag === 'string' ? params.tag : undefined,
          collection: typeof params.collection === 'string' ? params.collection : undefined,
          all: typeof params.all === 'boolean' ? params.all : undefined,
        };
        const format = typeof params.format === 'string' ? params.format : 'bibtex';
        const result = format === 'ris' ? service.exportRIS(exportOpts) : service.exportBibtex(exportOpts);
        return ok(`Exported ${result.count} paper(s) as ${format === 'ris' ? 'RIS' : 'BibTeX'}`, result);
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  });

  // ── 6. library_reading_stats ──────────────────────────────────────────

  tools.push({
    name: 'library_reading_stats',
    description:
      'Get library statistics including total papers, breakdown by status/year/source, ' +
      'reading time, PDF coverage, and average rating.',
    parameters: {
      type: 'object',
      properties: {
        period: { type: 'string', description: 'Time period filter (reserved for future use)' },
      },
    },
    execute: async (_toolCallId: string) => {
      try {
        const stats = service.getStats();
        return ok(
          `Library: ${stats.total} papers, ${stats.total_reading_minutes} min reading time, ` +
            `${stats.papers_with_pdf} with PDF` +
            (stats.average_rating != null ? `, avg rating ${stats.average_rating}` : ''),
          stats,
        );
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  });

  // ── 7. library_batch_add ──────────────────────────────────────────────

  tools.push({
    name: 'library_batch_add',
    description:
      'Add multiple papers to the library in a single batch (max 100). ' +
      'Returns counts of added papers, duplicates, and errors.',
    parameters: {
      type: 'object',
      properties: {
        papers: {
          type: 'array',
          maxItems: 100,
          description: 'Array of paper objects to add (max 100)',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'Paper title' },
              authors: { type: 'array', items: { type: 'string' } },
              abstract: { type: 'string' },
              doi: { type: 'string' },
              url: { type: 'string' },
              arxiv_id: { type: 'string' },
              pdf_path: { type: 'string' },
              source: { type: 'string' },
              source_id: { type: 'string' },
              venue: { type: 'string' },
              year: { type: 'number' },
              notes: { type: 'string' },
              bibtex_key: { type: 'string' },
              metadata: { type: 'object' },
              tags: { type: 'array', items: { type: 'string' } },
              keywords: { type: 'array', items: { type: 'string' } },
              language: { type: 'string' },
              paper_type: { type: 'string', enum: ['journal_article', 'conference_paper', 'preprint', 'thesis', 'book', 'book_chapter', 'report', 'patent', 'dataset', 'other'] },
              volume: { type: 'string' },
              issue: { type: 'string' },
              pages: { type: 'string' },
              publisher: { type: 'string' },
              issn: { type: 'string' },
              isbn: { type: 'string' },
              discipline: { type: 'string' },
              citation_count: { type: 'number' },
            },
            required: ['title'],
          },
        },
      },
      required: ['papers'],
    },
    execute: async (_toolCallId: string, params: Record<string, unknown>) => {
      try {
        if (!Array.isArray(params.papers) || params.papers.length === 0) {
          return fail('papers is required and must be a non-empty array');
        }
        // Validate each paper has at least a title string
        const papers: PaperInput[] = params.papers
          .filter((p): p is Record<string, unknown> => typeof p === 'object' && p !== null && typeof (p as Record<string, unknown>).title === 'string')
          .map((p) => ({
            title: (p.title as string).trim(),
            authors: Array.isArray(p.authors) ? p.authors.filter((a): a is string => typeof a === 'string') : undefined,
            doi: typeof p.doi === 'string' ? p.doi : undefined,
            arxiv_id: typeof p.arxiv_id === 'string' ? p.arxiv_id : undefined,
            venue: typeof p.venue === 'string' ? p.venue : undefined,
            year: typeof p.year === 'number' ? p.year : undefined,
            tags: Array.isArray(p.tags) ? p.tags.filter((t): t is string => typeof t === 'string') : undefined,
            notes: typeof p.notes === 'string' ? p.notes : undefined,
            pdf_path: typeof p.pdf_path === 'string' ? p.pdf_path : undefined,
            bibtex_key: typeof p.bibtex_key === 'string' ? p.bibtex_key : undefined,
            abstract: typeof p.abstract === 'string' ? p.abstract : undefined,
            url: typeof p.url === 'string' ? p.url : undefined,
            source: typeof p.source === 'string' ? p.source : undefined,
            source_id: typeof p.source_id === 'string' ? p.source_id : undefined,
            metadata: typeof p.metadata === 'object' && p.metadata !== null ? p.metadata as Record<string, unknown> : undefined,
            keywords: Array.isArray(p.keywords) ? p.keywords.filter((k): k is string => typeof k === 'string') : undefined,
            language: typeof p.language === 'string' ? p.language : undefined,
            paper_type: typeof p.paper_type === 'string' ? p.paper_type : undefined,
            volume: typeof p.volume === 'string' ? p.volume : undefined,
            issue: typeof p.issue === 'string' ? p.issue : undefined,
            pages: typeof p.pages === 'string' ? p.pages : undefined,
            publisher: typeof p.publisher === 'string' ? p.publisher : undefined,
            issn: typeof p.issn === 'string' ? p.issn : undefined,
            isbn: typeof p.isbn === 'string' ? p.isbn : undefined,
            discipline: typeof p.discipline === 'string' ? p.discipline : undefined,
            citation_count: typeof p.citation_count === 'number' ? p.citation_count : undefined,
          }));
        if (papers.length === 0) {
          return fail('no valid papers found — each paper must have a title string');
        }
        const result = service.batchAdd(papers);
        const parts: string[] = [`Added ${result.added.length} paper(s)`];
        if (result.duplicates.length > 0) parts.push(`${result.duplicates.length} duplicate(s) skipped`);
        if (result.errors.length > 0) parts.push(`${result.errors.length} error(s)`);
        // Build paper_card blocks for each added paper
        if (result.added.length > 0) {
          const cards = result.added.map((p: Paper) => {
            const cd: Record<string, unknown> = {
              type: 'paper_card',
              title: p.title,
              authors: p.authors ?? [],
              read_status: p.read_status ?? 'unread',
              library_id: p.id,
            };
            if (p.venue) cd.venue = p.venue;
            if (p.year) cd.year = p.year;
            if (p.doi) cd.doi = p.doi;
            if (p.url) cd.url = p.url;
            if (p.arxiv_id) cd.arxiv_id = p.arxiv_id;
            return '```paper_card\n' + JSON.stringify(cd) + '\n```';
          });
          return ok(
            parts.join(', ') + '\n\nInclude these cards in your response:\n' + cards.join('\n'),
            result,
          );
        }
        return ok(parts.join(', '), result);
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  });

  // ── 8. library_manage_collection ──────────────────────────────────────

  tools.push({
    name: 'library_manage_collection',
    description:
      'Manage paper collections: create, update, delete a collection, ' +
      'or add/remove papers from a collection.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'Action: create, update, delete, add_paper, remove_paper' },
        id: { type: 'string', description: 'Collection ID (required for update/delete/add_paper/remove_paper)' },
        name: { type: 'string', description: 'Collection name (for create/update)' },
        description: { type: 'string', description: 'Collection description (for create/update)' },
        color: { type: 'string', description: 'Collection color hex code (for create/update)' },
        paper_ids: { type: 'array', items: { type: 'string' }, description: 'Paper IDs (for add_paper/remove_paper)' },
      },
      required: ['action'],
    },
    execute: async (_toolCallId: string, params: Record<string, unknown>) => {
      try {
        if (typeof params.action !== 'string' || !params.action.trim()) {
          return fail('action is required and must be a non-empty string');
        }
        const action = params.action.trim();
        const result = service.manageCollection(action, {
          id: typeof params.id === 'string' ? params.id : undefined,
          name: typeof params.name === 'string' ? params.name : undefined,
          description: typeof params.description === 'string' ? params.description : undefined,
          color: typeof params.color === 'string' ? params.color : undefined,
          paper_ids: Array.isArray(params.paper_ids) ? params.paper_ids.filter((id): id is string => typeof id === 'string') : undefined,
        });
        return ok(`Collection ${result.action}: ${result.id}`, result);
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  });

  // ── 9. library_tag_paper ──────────────────────────────────────────────

  tools.push({
    name: 'library_tag_paper',
    description: 'Add or remove a tag on a paper.',
    parameters: {
      type: 'object',
      properties: {
        paper_id: { type: 'string', description: 'Paper ID' },
        tag_name: { type: 'string', description: 'Tag name' },
        action: {
          type: 'string',
          enum: ['add', 'remove'],
          description: 'Whether to add or remove the tag (default: add)',
        },
        color: { type: 'string', description: 'Tag color hex code (only used when adding)' },
      },
      required: ['paper_id', 'tag_name'],
    },
    execute: async (_toolCallId: string, params: Record<string, unknown>) => {
      try {
        if (typeof params.paper_id !== 'string' || !params.paper_id.trim()) {
          return fail('paper_id is required and must be a non-empty string');
        }
        if (typeof params.tag_name !== 'string' || !params.tag_name.trim()) {
          return fail('tag_name is required and must be a non-empty string');
        }
        const paperId = params.paper_id.trim();
        const tagName = params.tag_name.trim();
        const action = typeof params.action === 'string' ? params.action : 'add';
        const color = typeof params.color === 'string' ? params.color : undefined;

        let tags: string[];
        if (action === 'remove') {
          tags = service.untag(paperId, tagName);
          return ok(`Removed tag "${tagName}" from paper ${paperId}`, { action: 'removed', paper_id: paperId, tag: tagName, tags });
        }
        tags = service.tag(paperId, tagName, color);
        return ok(`Added tag "${tagName}" to paper ${paperId}`, { action: 'added', paper_id: paperId, tag: tagName, tags });
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  });

  // ── 10. library_add_note ──────────────────────────────────────────────

  tools.push({
    name: 'library_add_note',
    description: 'Add a note or annotation to a paper, optionally tied to a specific page or highlight.',
    parameters: {
      type: 'object',
      properties: {
        paper_id: { type: 'string', description: 'Paper ID' },
        note_text: { type: 'string', description: 'Note content (Markdown supported)' },
        page: { type: 'number', description: 'Page number the note refers to' },
        highlight: { type: 'string', description: 'Highlighted text the note refers to' },
      },
      required: ['paper_id', 'note_text'],
    },
    execute: async (_toolCallId: string, params: Record<string, unknown>) => {
      try {
        if (typeof params.paper_id !== 'string' || !params.paper_id.trim()) {
          return fail('paper_id is required and must be a non-empty string');
        }
        if (typeof params.note_text !== 'string' || !params.note_text.trim()) {
          return fail('note_text is required and must be a non-empty string');
        }
        const paperId = params.paper_id.trim();
        const noteText = params.note_text.trim();
        const page = typeof params.page === 'number' ? params.page : undefined;
        const highlight = typeof params.highlight === 'string' ? params.highlight : undefined;
        const note = service.addNote(paperId, noteText, page, highlight);
        return ok(
          `Added note to paper ${paperId}` +
            (page != null ? ` (page ${page})` : ''),
          note,
        );
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  });

  // ── 11. library_import_bibtex ─────────────────────────────────────────

  tools.push({
    name: 'library_import_bibtex',
    description:
      'Import papers from BibTeX content. Parses the BibTeX and adds each entry to the library.',
    parameters: {
      type: 'object',
      properties: {
        bibtex_content: { type: 'string', description: 'BibTeX content to import (one or more @entries)' },
      },
      required: ['bibtex_content'],
    },
    execute: async (_toolCallId: string, params: Record<string, unknown>) => {
      try {
        if (typeof params.bibtex_content !== 'string' || !params.bibtex_content.trim()) {
          return fail('bibtex_content is required and must be a non-empty string');
        }
        const bibtexContent = params.bibtex_content.trim();
        const result = service.importBibtex(bibtexContent);
        return ok(
          `Imported ${result.imported} paper(s), skipped ${result.skipped}`,
          result,
        );
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  });

  // ── 12. library_citation_graph ────────────────────────────────────────

  tools.push({
    name: 'library_citation_graph',
    description:
      'Get the citation graph for a paper. Returns papers that this paper cites ' +
      'and/or papers that cite it. Supports multi-hop traversal up to depth 3.',
    parameters: {
      type: 'object',
      properties: {
        paper_id: { type: 'string', description: 'Paper ID to get citations for' },
        direction: {
          type: 'string',
          enum: ['citing', 'cited_by', 'both'],
          description: 'Direction: citing, cited_by, or both (default: both)',
        },
        depth: {
          type: 'number',
          minimum: 1,
          maximum: 3,
          description: 'Traversal depth for the citation graph (1-3, default: 1). ' +
            'Depth 1 returns direct citations only. Deeper traversal follows citation ' +
            'chains via BFS.',
        },
      },
      required: ['paper_id'],
    },
    execute: async (_toolCallId: string, params: Record<string, unknown>) => {
      try {
        if (typeof params.paper_id !== 'string' || !params.paper_id.trim()) {
          return fail('paper_id is required and must be a non-empty string');
        }
        const paperId = params.paper_id.trim();
        const direction = typeof params.direction === 'string' ? params.direction : 'both';
        const depth = Math.min(Math.max(typeof params.depth === 'number' ? params.depth : 1, 1), 3);

        // Depth-1: current behavior (direct citations)
        const result = service.getCitations(paperId, direction);

        if (depth === 1) {
          const citingCount = result.citing.length;
          const citedByCount = result.cited_by.length;

          return ok(
            `Paper ${paperId}: cites ${citingCount} paper(s), cited by ${citedByCount} paper(s)`,
            { center: paperId, depth, ...result, direction },
          );
        }

        // Depth 2-3: BFS traversal
        // Collect all nodes and edges across hops
        interface GraphNode { paper_id: string; depth: number }
        interface GraphEdge { from: string; to: string }
        const nodes: GraphNode[] = [{ paper_id: paperId, depth: 0 }];
        const edges: GraphEdge[] = [];
        const visited = new Set<string>([paperId]);

        // Add depth-1 results
        for (const c of result.citing) {
          edges.push({ from: paperId, to: c.cited_paper_id });
          if (!visited.has(c.cited_paper_id)) {
            visited.add(c.cited_paper_id);
            nodes.push({ paper_id: c.cited_paper_id, depth: 1 });
          }
        }
        for (const c of result.cited_by) {
          edges.push({ from: c.citing_paper_id, to: paperId });
          if (!visited.has(c.citing_paper_id)) {
            visited.add(c.citing_paper_id);
            nodes.push({ paper_id: c.citing_paper_id, depth: 1 });
          }
        }

        // BFS for depths 2..depth
        for (let d = 2; d <= depth; d++) {
          const frontier = nodes.filter((n) => n.depth === d - 1);
          for (const node of frontier) {
            try {
              const hopResult = service.getCitations(node.paper_id, direction);
              for (const c of hopResult.citing) {
                edges.push({ from: node.paper_id, to: c.cited_paper_id });
                if (!visited.has(c.cited_paper_id)) {
                  visited.add(c.cited_paper_id);
                  nodes.push({ paper_id: c.cited_paper_id, depth: d });
                }
              }
              for (const c of hopResult.cited_by) {
                edges.push({ from: c.citing_paper_id, to: node.paper_id });
                if (!visited.has(c.citing_paper_id)) {
                  visited.add(c.citing_paper_id);
                  nodes.push({ paper_id: c.citing_paper_id, depth: d });
                }
              }
            } catch {
              // Skip papers that can't be found (may be external)
            }
          }
        }

        return ok(
          `Citation graph for ${paperId}: ${nodes.length} node(s), ${edges.length} edge(s), depth ${depth}`,
          { center: paperId, depth, nodes, edges, direction },
        );
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  });

  // ── 13. library_zotero_detect ──────────────────────────────────────────
  tools.push({
    name: 'library_zotero_detect',
    description: 'Detect if Zotero is installed locally. Returns library stats (paper count, collections, tags) and database path.',
    parameters: {
      type: 'object',
      properties: {
        db_path: { type: 'string', description: 'Custom path to zotero.sqlite' },
      },
    },
    execute: async (_toolCallId: string, params: Record<string, unknown>) => {
      try {
        const customDbPath = typeof params.db_path === 'string' ? params.db_path : undefined;
        const result = ZoteroBridge.detect(customDbPath);
        if (!result.available) {
          if (result.environment === 'docker') {
            return ok(
              'Zotero database not accessible — Docker container filesystem is isolated from host. ' +
              'Alternatives: (1) Mount ~/Zotero as a Docker volume, (2) Export BibTeX/RIS from Zotero ' +
              'and use library_import_bibtex or library_import_ris.',
              result,
            );
          }
          return ok(
            'Zotero not installed or database not at default path (~/Zotero/zotero.sqlite). ' +
            'You can specify a custom path via the db_path parameter.',
            result,
          );
        }
        return ok(
          `Zotero found: ${result.stats?.total_items ?? 0} items, ${result.stats?.total_collections ?? 0} collections`,
          result,
        );
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  });

  // ── 14. library_zotero_import ──────────────────────────────────────────
  tools.push({
    name: 'library_zotero_import',
    description:
      'Import papers from the local Zotero library into Research-Claw. ' +
      'Automatically deduplicates by DOI/arXiv ID. Optionally filter by collection name.',
    parameters: {
      type: 'object',
      properties: {
        collection: { type: 'string', description: 'Only import from this Zotero collection' },
        limit: { type: 'number', description: 'Maximum papers to import (default: all)' },
        db_path: { type: 'string', description: 'Custom path to zotero.sqlite' },
      },
    },
    execute: async (_toolCallId: string, params: Record<string, unknown>) => {
      try {
        const customDbPath = typeof params.db_path === 'string' ? params.db_path : undefined;
        const detect = ZoteroBridge.detect(customDbPath);
        if (!detect.available || !detect.db_path) {
          return fail('Zotero not found on this machine');
        }
        const result = ZoteroBridge.importAll(detect.db_path, service, {
          collection: typeof params.collection === 'string' ? params.collection : undefined,
          limit: typeof params.limit === 'number' ? params.limit : undefined,
        });
        return ok(
          `Imported ${result.imported} paper(s) from Zotero (${result.duplicates} duplicates skipped)`,
          result,
        );
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  });

  // ── 15. library_endnote_detect ─────────────────────────────────────────
  tools.push({
    name: 'library_endnote_detect',
    description: 'Detect if an EndNote library (.enl file) exists locally. Returns library path, record count, and schema version.',
    parameters: {
      type: 'object',
      properties: {
        enl_path: { type: 'string', description: 'Custom path to .enl file' },
      },
    },
    execute: async (_toolCallId: string, params: Record<string, unknown>) => {
      try {
        const customEnlPath = typeof params.enl_path === 'string' ? params.enl_path : undefined;
        const result = EndNoteBridge.detect(customEnlPath);
        if (!result.available) {
          if (existsSync('/.dockerenv')) {
            return ok(
              'EndNote library not accessible — Docker container filesystem is isolated from host. ' +
              'Alternatives: (1) Mount the EndNote library directory as a Docker volume, ' +
              '(2) Export BibTeX/RIS from EndNote and use library_import_bibtex or library_import_ris.',
              result,
            );
          }
          return ok(
            'No EndNote library found on this machine. ' +
            'You can specify a custom path to your .enl file via the enl_path parameter.',
            result,
          );
        }
        return ok(
          `EndNote library found: ${result.record_count} records (schema v${result.schema_version})`,
          result,
        );
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  });

  // ── 16. library_endnote_import ─────────────────────────────────────────
  tools.push({
    name: 'library_endnote_import',
    description:
      'Import papers from the local EndNote library (.enl file) into Research-Claw. ' +
      'Automatically deduplicates by DOI.',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Maximum papers to import (default: all)' },
        enl_path: { type: 'string', description: 'Custom path to .enl file' },
      },
    },
    execute: async (_toolCallId: string, params: Record<string, unknown>) => {
      try {
        const customEnlPath = typeof params.enl_path === 'string' ? params.enl_path : undefined;
        const detect = EndNoteBridge.detect(customEnlPath);
        if (!detect.available || !detect.library_path) {
          return fail('No EndNote library found on this machine');
        }
        const result = EndNoteBridge.importAll(detect.library_path, service, {
          limit: typeof params.limit === 'number' ? params.limit : undefined,
        });
        return ok(
          `Imported ${result.imported} paper(s) from EndNote (${result.duplicates} duplicates skipped)`,
          result,
        );
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  });

  // ── 17. library_import_ris ──────────────────────────────────────────────
  tools.push({
    name: 'library_import_ris',
    description:
      'Import papers from RIS format content into the local library. ' +
      'RIS is a universal format supported by EndNote, Mendeley, Zotero, and most reference managers.',
    parameters: {
      type: 'object',
      properties: {
        ris_content: { type: 'string', description: 'RIS format content (one or more entries)' },
      },
      required: ['ris_content'],
    },
    execute: async (_toolCallId: string, params: Record<string, unknown>) => {
      try {
        if (typeof params.ris_content !== 'string' || !params.ris_content.trim()) {
          return fail('ris_content is required and must be a non-empty string');
        }
        const papers = parseRIS(params.ris_content.trim());
        if (papers.length === 0) {
          return fail('No valid RIS entries found in the provided content');
        }
        const result = service.batchAdd(papers);
        return ok(
          `Imported ${result.added.length} paper(s) from RIS (${result.duplicates.length} duplicates skipped)`,
          result,
        );
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  });

  // ── 18. library_zotero_local_detect ──────────────────────────────────
  tools.push({
    name: 'library_zotero_local_detect',
    description:
      'Detect if Zotero Local API is reachable (localhost:23119). ' +
      'Requires Zotero desktop running with "Allow other applications" enabled in Advanced settings.',
    parameters: { type: 'object', properties: {} },
    execute: async () => {
      try {
        const { ZoteroLocalAPI } = await import('./zotero-local-api.js');
        const result = await ZoteroLocalAPI.detect();
        if (!result.available) {
          return ok(
            'Zotero Local API not reachable. Ensure Zotero is running and ' +
            '"Allow other applications on this computer to communicate with Zotero" ' +
            'is enabled in Zotero Settings → Advanced.',
            result,
          );
        }
        return ok(`Zotero Local API available: ${result.itemCount ?? 'unknown'} items`, result);
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  });

  // ── 19. library_zotero_local_import ─────────────────────────────────
  tools.push({
    name: 'library_zotero_local_import',
    description:
      'Import papers from Zotero via its Local API (localhost:23119). ' +
      'Read-only, auto-dedup. Zotero must be running.',
    parameters: {
      type: 'object',
      properties: {
        collection: { type: 'string', description: 'Only import from this Zotero collection key' },
        limit: { type: 'number', description: 'Maximum papers to import (default: 25)' },
        query: { type: 'string', description: 'Search query to filter items' },
      },
    },
    execute: async (_toolCallId: string, params: Record<string, unknown>) => {
      try {
        const { ZoteroLocalAPI } = await import('./zotero-local-api.js');
        const { ZoteroWebAPI } = await import('./zotero-web-api.js');

        const detect = await ZoteroLocalAPI.detect();
        if (!detect.available) {
          return fail(
            'Zotero Local API not reachable. Ensure Zotero is running with Local API enabled.',
          );
        }

        const query = typeof params.query === 'string' ? params.query : undefined;
        const limit = typeof params.limit === 'number' ? params.limit : 25;
        const collection = typeof params.collection === 'string' ? params.collection : undefined;

        const items = query
          ? await ZoteroLocalAPI.searchItems(query, { limit })
          : await ZoteroLocalAPI.listItems({ limit, collection });

        let imported = 0;
        let duplicates = 0;
        const ids: string[] = [];

        for (const item of items) {
          if (!item.title || item.itemType === 'attachment' || item.itemType === 'note') continue;
          const paperInput = ZoteroWebAPI.toPaperInput(item);
          const dupMatches = service.duplicateCheck({ doi: paperInput.doi, title: paperInput.title, arxiv_id: paperInput.arxiv_id });
          if (dupMatches.length > 0) { duplicates++; continue; }
          const added = service.add(paperInput);
          ids.push(added.id);
          imported++;
        }

        return ok(
          `Imported ${imported} paper(s) via Zotero Local API (${duplicates} duplicates skipped)`,
          { imported, duplicates, items: ids },
        );
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  });

  // ── 20. library_zotero_web_detect ───────────────────────────────────
  tools.push({
    name: 'library_zotero_web_detect',
    description:
      'Validate Zotero Web API credentials (API Key + User ID). ' +
      'Configure via ZOTERO_API_KEY and ZOTERO_USER_ID environment variables.',
    parameters: { type: 'object', properties: {} },
    execute: async () => {
      try {
        const { ZoteroWebAPI } = await import('./zotero-web-api.js');
        const config = ZoteroWebAPI.getConfig();
        if (!config) {
          return ok(
            'Zotero Web API not configured. To set up:\n' +
            '1. Go to https://www.zotero.org/settings/keys\n' +
            '2. Your User ID is shown at the top of the page\n' +
            '3. Click "Create new private key" → enable Library Read+Write access → Save\n' +
            '4. Add to openclaw.json: env.vars.ZOTERO_API_KEY and env.vars.ZOTERO_USER_ID\n' +
            '5. Restart the gateway to apply.',
            { configured: false },
          );
        }
        const result = await ZoteroWebAPI.validateCredentials(config);
        if (!result.configured) {
          return ok('Zotero Web API credentials invalid. Check API Key and User ID.', result);
        }
        return ok(
          `Zotero Web API connected: ${result.totalItems ?? 'unknown'} items, ` +
          `rate limit remaining: ${result.rateLimitRemaining ?? 'unknown'}`,
          result,
        );
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  });

  // ── 21. library_zotero_web_import ───────────────────────────────────
  tools.push({
    name: 'library_zotero_web_import',
    description:
      'Import papers from Zotero cloud library via Web API v3. Read-only, auto-dedup.',
    parameters: {
      type: 'object',
      properties: {
        collection: { type: 'string', description: 'Zotero collection key to filter' },
        limit: { type: 'number', description: 'Max papers (default: 25)' },
        query: { type: 'string', description: 'Search query' },
      },
    },
    execute: async (_toolCallId: string, params: Record<string, unknown>) => {
      try {
        const { ZoteroWebAPI } = await import('./zotero-web-api.js');
        const config = ZoteroWebAPI.getConfig();
        if (!config) return fail('Zotero Web API not configured. Set ZOTERO_API_KEY + ZOTERO_USER_ID.');

        const query = typeof params.query === 'string' ? params.query : undefined;
        const limit = typeof params.limit === 'number' ? params.limit : 25;
        const collection = typeof params.collection === 'string' ? params.collection : undefined;

        const items = query
          ? await ZoteroWebAPI.searchItems(config, query, { limit })
          : await ZoteroWebAPI.listItems(config, { limit, collection });

        let imported = 0;
        let duplicates = 0;
        const ids: string[] = [];

        for (const item of items) {
          if (!item.title || item.itemType === 'attachment' || item.itemType === 'note') continue;
          const paperInput = ZoteroWebAPI.toPaperInput(item);
          const dupMatches = service.duplicateCheck({ doi: paperInput.doi, title: paperInput.title, arxiv_id: paperInput.arxiv_id });
          if (dupMatches.length > 0) { duplicates++; continue; }
          const added = service.add(paperInput);
          ids.push(added.id);
          imported++;
        }

        return ok(
          `Imported ${imported} paper(s) via Zotero Web API (${duplicates} duplicates skipped)`,
          { imported, duplicates, items: ids },
        );
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  });

  // ── 22. library_zotero_web_search ───────────────────────────────────
  tools.push({
    name: 'library_zotero_web_search',
    description: 'Search papers in Zotero cloud library via Web API v3.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        limit: { type: 'number', description: 'Max results (default: 25)' },
      },
      required: ['query'],
    },
    execute: async (_toolCallId: string, params: Record<string, unknown>) => {
      try {
        const { ZoteroWebAPI } = await import('./zotero-web-api.js');
        const config = ZoteroWebAPI.getConfig();
        if (!config) return fail('Zotero Web API not configured.');
        if (typeof params.query !== 'string') return fail('query is required');

        const items = await ZoteroWebAPI.searchItems(config, params.query, {
          limit: typeof params.limit === 'number' ? params.limit : 25,
        });

        return ok(`Found ${items.length} item(s) in Zotero cloud library`, { items });
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  });

  // ── 23. library_zotero_web_create ───────────────────────────────────
  tools.push({
    name: 'library_zotero_web_create',
    description:
      'Create a new item in Zotero cloud library via Web API v3. ' +
      'REQUIRES user approval (approval_card, risk_level: medium).',
    parameters: {
      type: 'object',
      properties: {
        paper_id: { type: 'string', description: 'RC library paper ID to sync to Zotero' },
      },
      required: ['paper_id'],
    },
    execute: async (_toolCallId: string, params: Record<string, unknown>) => {
      try {
        const { ZoteroWebAPI } = await import('./zotero-web-api.js');
        const config = ZoteroWebAPI.getConfig();
        if (!config) return fail('Zotero Web API not configured.');
        if (typeof params.paper_id !== 'string') return fail('paper_id is required');

        const paper = service.get(params.paper_id);
        if (!paper) return fail(`Paper ${params.paper_id} not found in RC library`);

        const result = await ZoteroWebAPI.createItem(config, {
          itemType: paper.paper_type === 'journal_article' ? 'journalArticle' :
                    paper.paper_type === 'conference_paper' ? 'conferencePaper' :
                    paper.paper_type === 'preprint' ? 'preprint' :
                    paper.paper_type === 'book' ? 'book' :
                    paper.paper_type === 'thesis' ? 'thesis' : 'document',
          title: paper.title,
          creators: (paper.authors as string[])?.map((name: string) => ({
            creatorType: 'author',
            name,
          })) ?? [],
          DOI: paper.doi ?? '',
          url: paper.url ?? '',
          abstractNote: paper.abstract ?? '',
          date: paper.year ? String(paper.year) : '',
        });

        if (!result) return fail('Failed to create item in Zotero');
        return ok(`Created item in Zotero cloud: key=${result.key}`, result);
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  });

  // ── 24. library_zotero_web_update ───────────────────────────────────
  tools.push({
    name: 'library_zotero_web_update',
    description:
      'Update an existing item in Zotero cloud library via Web API v3. ' +
      'REQUIRES user approval (approval_card, risk_level: medium).',
    parameters: {
      type: 'object',
      properties: {
        zotero_key: { type: 'string', description: 'Zotero item key to update' },
        version: { type: 'number', description: 'Current item version (for optimistic locking)' },
        fields: {
          type: 'object',
          description: 'Fields to update (e.g. { title, DOI, abstractNote })',
        },
      },
      required: ['zotero_key', 'version', 'fields'],
    },
    execute: async (_toolCallId: string, params: Record<string, unknown>) => {
      try {
        const { ZoteroWebAPI } = await import('./zotero-web-api.js');
        const config = ZoteroWebAPI.getConfig();
        if (!config) return fail('Zotero Web API not configured.');
        if (typeof params.zotero_key !== 'string') return fail('zotero_key is required');
        if (typeof params.version !== 'number') return fail('version is required');

        const success = await ZoteroWebAPI.updateItem(
          config,
          params.zotero_key,
          params.version,
          params.fields as Record<string, unknown> ?? {},
        );

        return success
          ? ok(`Updated Zotero item: ${params.zotero_key}`, { key: params.zotero_key })
          : fail('Failed to update item in Zotero. Check key, version, and permissions.');
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  });

  // ── 25. library_zotero_web_delete ───────────────────────────────────
  tools.push({
    name: 'library_zotero_web_delete',
    description:
      'Delete an item from Zotero cloud library via Web API v3. ' +
      'REQUIRES user approval (approval_card, risk_level: high). Irreversible.',
    parameters: {
      type: 'object',
      properties: {
        zotero_key: { type: 'string', description: 'Zotero item key to delete' },
        version: { type: 'number', description: 'Current item version (for optimistic locking)' },
      },
      required: ['zotero_key', 'version'],
    },
    execute: async (_toolCallId: string, params: Record<string, unknown>) => {
      try {
        const { ZoteroWebAPI } = await import('./zotero-web-api.js');
        const config = ZoteroWebAPI.getConfig();
        if (!config) return fail('Zotero Web API not configured.');
        if (typeof params.zotero_key !== 'string') return fail('zotero_key is required');
        if (typeof params.version !== 'number') return fail('version is required');

        const success = await ZoteroWebAPI.deleteItem(config, params.zotero_key, params.version);

        return success
          ? ok(`Deleted Zotero item: ${params.zotero_key}`, { key: params.zotero_key })
          : fail('Failed to delete item from Zotero. Check key, version, and permissions.');
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  });

  return tools;
}

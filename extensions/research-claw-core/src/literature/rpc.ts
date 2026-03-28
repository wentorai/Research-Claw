/**
 * Research-Claw Core — Literature RPC Handlers
 *
 * 33 gateway RPC methods in the `rc.lit.*` namespace.
 * Each handler extracts params, calls the LiteratureService,
 * and responds via the gateway method callback.
 *
 * Error codes: rc.lit.* uses -32001 to -32012
 *   -32001 PAPER_NOT_FOUND, -32002 DUPLICATE_PAPER, -32003 TAG_NOT_FOUND,
 *   -32004 COLLECTION_NOT_FOUND, -32005 SESSION_NOT_FOUND,
 *   -32006 SESSION_ALREADY_ENDED, -32007 SELF_CITATION,
 *   -32010 BIBTEX_PARSE_ERROR, -32011 VALIDATION_ERROR, -32012 FTS_QUERY_ERROR
 */

import { type LiteratureService, type PaperInput, type PaperPatch, type PaperFilter } from './service.js';
import type { RegisterMethod } from '../types.js';
import { ZoteroBridge } from './zotero.js';
import { EndNoteBridge } from './endnote.js';
import { parseRIS } from './ris-parser.js';

// ── Error codes ─────────────────────────────────────────────────────────

const ErrorCode = {
  PAPER_NOT_FOUND: -32001,
  DUPLICATE_PAPER: -32002,
  TAG_NOT_FOUND: -32003,
  COLLECTION_NOT_FOUND: -32004,
  SESSION_NOT_FOUND: -32005,
  SESSION_ALREADY_ENDED: -32006,
  SELF_CITATION: -32007,
  BIBTEX_PARSE_ERROR: -32010,
  VALIDATION_ERROR: -32011,
  FTS_QUERY_ERROR: -32012,
} as const;

// ── Helpers ─────────────────────────────────────────────────────────────

interface ErrorShape {
  code: number;
  message: string;
  details?: unknown;
}

function classifyError(err: unknown): ErrorShape {
  const message = err instanceof Error ? err.message : String(err);

  if (message.includes('Paper not found')) {
    return { code: ErrorCode.PAPER_NOT_FOUND, message };
  }
  if (message.includes('Duplicate paper found')) {
    return { code: ErrorCode.DUPLICATE_PAPER, message };
  }
  if (message.includes('Tag not found')) {
    return { code: ErrorCode.TAG_NOT_FOUND, message };
  }
  if (message.includes('Collection not found')) {
    return { code: ErrorCode.COLLECTION_NOT_FOUND, message };
  }
  if (message.includes('Reading session not found')) {
    return { code: ErrorCode.SESSION_NOT_FOUND, message };
  }
  if (message.includes('Reading session already ended')) {
    return { code: ErrorCode.SESSION_ALREADY_ENDED, message };
  }
  if (message.includes('cannot cite itself')) {
    return { code: ErrorCode.SELF_CITATION, message };
  }
  if (message.includes('BibTeX') || message.includes('bibtex') || message.includes('parse')) {
    return { code: ErrorCode.BIBTEX_PARSE_ERROR, message };
  }
  if (message.includes('Invalid') || message.includes('required') || message.includes('exceeds limit')) {
    return { code: ErrorCode.VALIDATION_ERROR, message };
  }
  if (message.includes('FTS') || message.includes('fts')) {
    return { code: ErrorCode.FTS_QUERY_ERROR, message };
  }

  return { code: ErrorCode.VALIDATION_ERROR, message };
}

function requireString(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${key} is required and must be a non-empty string`);
  }
  return value;
}

function optionalString(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  if (value === undefined || value === null) return undefined;
  return String(value);
}

function optionalNumber(params: Record<string, unknown>, key: string): number | undefined {
  const value = params[key];
  if (value === undefined || value === null) return undefined;
  return Number(value);
}

function optionalBoolean(params: Record<string, unknown>, key: string): boolean | undefined {
  const value = params[key];
  if (value === undefined || value === null) return undefined;
  return Boolean(value);
}

function optionalStringArray(params: Record<string, unknown>, key: string): string[] | undefined {
  const value = params[key];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) return undefined;
  return value.map(String);
}

// ── Registration ────────────────────────────────────────────────────────

export function registerLiteratureRpc(registerMethod: RegisterMethod, service: LiteratureService): void {

  // ── 1. rc.lit.list ──────────────────────────────────────────────────

  registerMethod('rc.lit.list', async (params: Record<string, unknown>) => {
    try {
      const filter: PaperFilter = {};
      if (params.read_status !== undefined) {
        filter.read_status = Array.isArray(params.read_status)
          ? params.read_status.map(String)
          : String(params.read_status);
      }
      if (params.year !== undefined) filter.year = Number(params.year);
      if (params.source !== undefined) filter.source = String(params.source);
      // Support both singular 'tag' and plural 'tags' parameters
      if (params.tags !== undefined) {
        const tagsParam = params.tags;
        filter.tags = Array.isArray(tagsParam) ? tagsParam.map(String) : [String(tagsParam)];
      } else if (params.tag !== undefined) {
        // Backward compatibility: single tag → array
        filter.tags = [String(params.tag)];
      }
      if (params.collection_id !== undefined) filter.collection_id = String(params.collection_id);
      if (params.has_pdf !== undefined) filter.has_pdf = Boolean(params.has_pdf);

      const offset = optionalNumber(params, 'offset') ?? 0;
      const limit = optionalNumber(params, 'limit') ?? 50;

      const result = service.list({
        offset,
        limit,
        sort: optionalString(params, 'sort'),
        filter: Object.keys(filter).length > 0 ? filter : undefined,
      });

      return { ...result, offset, limit };
    } catch (err) {
      throw classifyError(err);
    }
  });

  // ── 2. rc.lit.get ───────────────────────────────────────────────────

  registerMethod('rc.lit.get', async (params: Record<string, unknown>) => {
    try {
      const id = requireString(params, 'id');
      const paper = service.get(id);
      if (!paper) {
        throw new Error(`Paper not found: ${id}`);
      }

      // Enrich with reading sessions and citation counts
      const reading_sessions = service.listReadingSessions(id);
      const citations = service.getCitations(id, 'both');
      const citing_count = citations.citing.length;
      const cited_by_count = citations.cited_by.length;

      return { ...paper, reading_sessions, citing_count, cited_by_count };
    } catch (err) {
      throw classifyError(err);
    }
  });

  // ── 3. rc.lit.add ───────────────────────────────────────────────────

  registerMethod('rc.lit.add', async (params: Record<string, unknown>) => {
    try {
      // Accept either { paper: {...} } or flat params
      const raw = (params.paper as Record<string, unknown>) ?? params;
      const input: PaperInput = {
        title: requireString(raw, 'title'),
        authors: optionalStringArray(raw, 'authors'),
        abstract: optionalString(raw, 'abstract'),
        doi: optionalString(raw, 'doi'),
        url: optionalString(raw, 'url'),
        arxiv_id: optionalString(raw, 'arxiv_id'),
        pdf_path: optionalString(raw, 'pdf_path'),
        source: optionalString(raw, 'source'),
        source_id: optionalString(raw, 'source_id'),
        venue: optionalString(raw, 'venue'),
        year: optionalNumber(raw, 'year'),
        notes: optionalString(raw, 'notes'),
        bibtex_key: optionalString(raw, 'bibtex_key'),
        metadata: raw.metadata as Record<string, unknown> | undefined,
        tags: optionalStringArray(raw, 'tags'),
        keywords: optionalStringArray(raw, 'keywords'),
        language: optionalString(raw, 'language'),
        paper_type: optionalString(raw, 'paper_type'),
        volume: optionalString(raw, 'volume'),
        issue: optionalString(raw, 'issue'),
        pages: optionalString(raw, 'pages'),
        publisher: optionalString(raw, 'publisher'),
        issn: optionalString(raw, 'issn'),
        isbn: optionalString(raw, 'isbn'),
        discipline: optionalString(raw, 'discipline'),
        citation_count: optionalNumber(raw, 'citation_count'),
      };
      return service.add(input);
    } catch (err) {
      throw classifyError(err);
    }
  });

  // ── 4. rc.lit.update ────────────────────────────────────────────────

  registerMethod('rc.lit.update', async (params: Record<string, unknown>) => {
    try {
      const id = requireString(params, 'id');
      const raw = (params.patch as Record<string, unknown>) ?? params;
      const patch: PaperPatch = {};

      if (raw.title !== undefined) patch.title = String(raw.title);
      if (raw.authors !== undefined) patch.authors = optionalStringArray(raw, 'authors');
      if (raw.abstract !== undefined) patch.abstract = String(raw.abstract);
      if (raw.doi !== undefined) patch.doi = String(raw.doi);
      if (raw.url !== undefined) patch.url = String(raw.url);
      if (raw.arxiv_id !== undefined) patch.arxiv_id = String(raw.arxiv_id);
      if (raw.pdf_path !== undefined) patch.pdf_path = String(raw.pdf_path);
      if (raw.source !== undefined) patch.source = String(raw.source);
      if (raw.source_id !== undefined) patch.source_id = String(raw.source_id);
      if (raw.venue !== undefined) patch.venue = String(raw.venue);
      if (raw.year !== undefined) patch.year = Number(raw.year);
      if (raw.read_status !== undefined) patch.read_status = String(raw.read_status);
      if (raw.rating !== undefined) patch.rating = Number(raw.rating);
      if (raw.notes !== undefined) patch.notes = String(raw.notes);
      if (raw.bibtex_key !== undefined) patch.bibtex_key = String(raw.bibtex_key);
      if (raw.metadata !== undefined) patch.metadata = raw.metadata as Record<string, unknown>;
      if (raw.keywords !== undefined) patch.keywords = optionalStringArray(raw, 'keywords');
      if (raw.language !== undefined) patch.language = String(raw.language);
      if (raw.paper_type !== undefined) patch.paper_type = String(raw.paper_type);
      if (raw.volume !== undefined) patch.volume = String(raw.volume);
      if (raw.issue !== undefined) patch.issue = String(raw.issue);
      if (raw.pages !== undefined) patch.pages = String(raw.pages);
      if (raw.publisher !== undefined) patch.publisher = String(raw.publisher);
      if (raw.issn !== undefined) patch.issn = String(raw.issn);
      if (raw.isbn !== undefined) patch.isbn = String(raw.isbn);
      if (raw.discipline !== undefined) patch.discipline = String(raw.discipline);
      if (raw.citation_count !== undefined) patch.citation_count = Number(raw.citation_count);

      return service.update(id, patch);
    } catch (err) {
      throw classifyError(err);
    }
  });

  // ── 5. rc.lit.delete ────────────────────────────────────────────────

  registerMethod('rc.lit.delete', async (params: Record<string, unknown>) => {
    try {
      const id = requireString(params, 'id');
      service.delete(id);
      return { ok: true };
    } catch (err) {
      throw classifyError(err);
    }
  });

  // ── 6. rc.lit.status ────────────────────────────────────────────────

  registerMethod('rc.lit.status', async (params: Record<string, unknown>) => {
    try {
      const id = requireString(params, 'id');
      const status = requireString(params, 'status');
      return service.setStatus(id, status);
    } catch (err) {
      throw classifyError(err);
    }
  });

  // ── 7. rc.lit.rate ──────────────────────────────────────────────────

  registerMethod('rc.lit.rate', async (params: Record<string, unknown>) => {
    try {
      const id = requireString(params, 'id');
      const rating = Number(params.rating);
      if (isNaN(rating)) {
        throw new Error('Invalid rating: must be a number between 0 and 5 (0 to clear)');
      }
      return service.rate(id, rating);
    } catch (err) {
      throw classifyError(err);
    }
  });

  // ── 8. rc.lit.tags ──────────────────────────────────────────────────

  registerMethod('rc.lit.tags', async () => {
    try {
      return service.getTags();
    } catch (err) {
      throw classifyError(err);
    }
  });

  // ── 9. rc.lit.tag ───────────────────────────────────────────────────

  registerMethod('rc.lit.tag', async (params: Record<string, unknown>) => {
    try {
      const paperId = requireString(params, 'paper_id');
      const tagName = requireString(params, 'tag_name');
      const color = optionalString(params, 'color');
      const tags = service.tag(paperId, tagName, color);
      return { paper_id: paperId, tags };
    } catch (err) {
      throw classifyError(err);
    }
  });

  // ── 10. rc.lit.untag ────────────────────────────────────────────────

  registerMethod('rc.lit.untag', async (params: Record<string, unknown>) => {
    try {
      const paperId = requireString(params, 'paper_id');
      const tagName = requireString(params, 'tag_name');
      const tags = service.untag(paperId, tagName);
      return { paper_id: paperId, tags };
    } catch (err) {
      throw classifyError(err);
    }
  });

  // ── 11. rc.lit.reading.start ────────────────────────────────────────

  registerMethod('rc.lit.reading.start', async (params: Record<string, unknown>) => {
    try {
      const paperId = requireString(params, 'paper_id');
      return service.startReading(paperId);
    } catch (err) {
      throw classifyError(err);
    }
  });

  // ── 12. rc.lit.reading.end ──────────────────────────────────────────

  registerMethod('rc.lit.reading.end', async (params: Record<string, unknown>) => {
    try {
      const sessionId = requireString(params, 'session_id');
      const notes = optionalString(params, 'notes');
      const pagesRead = optionalNumber(params, 'pages_read');
      return service.endReading(sessionId, notes, pagesRead);
    } catch (err) {
      throw classifyError(err);
    }
  });

  // ── 13. rc.lit.reading.list ─────────────────────────────────────────

  registerMethod('rc.lit.reading.list', async (params: Record<string, unknown>) => {
    try {
      const paperId = requireString(params, 'paper_id');
      return service.listReadingSessions(paperId);
    } catch (err) {
      throw classifyError(err);
    }
  });

  // ── 14. rc.lit.cite ─────────────────────────────────────────────────
  // Note: "cite" here means "record a citation relationship between two papers",
  // NOT "format a citation string". For BibTeX formatting, use rc.lit.export_bibtex.

  registerMethod('rc.lit.cite', async (params: Record<string, unknown>) => {
    try {
      const citingId = requireString(params, 'citing_id');
      const citedId = requireString(params, 'cited_id');
      const context = optionalString(params, 'context');
      const section = optionalString(params, 'section');
      return service.addCitation(citingId, citedId, context, section);
    } catch (err) {
      throw classifyError(err);
    }
  });

  // ── 15. rc.lit.citations ────────────────────────────────────────────

  registerMethod('rc.lit.citations', async (params: Record<string, unknown>) => {
    try {
      const paperId = requireString(params, 'paper_id');
      const direction = optionalString(params, 'direction') ?? 'both';
      return service.getCitations(paperId, direction);
    } catch (err) {
      throw classifyError(err);
    }
  });

  // ── 16. rc.lit.search ───────────────────────────────────────────────

  registerMethod('rc.lit.search', async (params: Record<string, unknown>) => {
    try {
      const query = requireString(params, 'query');
      const limit = optionalNumber(params, 'limit');
      const offset = optionalNumber(params, 'offset');
      const collection_id = optionalString(params, 'collection_id');
      return service.search(query, limit, offset, collection_id);
    } catch (err) {
      throw classifyError(err);
    }
  });

  // ── 17. rc.lit.duplicate_check ──────────────────────────────────────

  registerMethod('rc.lit.duplicate_check', async (params: Record<string, unknown>) => {
    try {
      const raw = (params.paper as Record<string, unknown>) ?? params;
      return service.duplicateCheck({
        doi: optionalString(raw, 'doi'),
        title: optionalString(raw, 'title'),
        arxiv_id: optionalString(raw, 'arxiv_id'),
      });
    } catch (err) {
      throw classifyError(err);
    }
  });

  // ── 18. rc.lit.stats ────────────────────────────────────────────────

  registerMethod('rc.lit.stats', async () => {
    try {
      return service.getStats();
    } catch (err) {
      throw classifyError(err);
    }
  });

  // ── 19. rc.lit.batch_add ────────────────────────────────────────────

  registerMethod('rc.lit.batch_add', async (params: Record<string, unknown>) => {
    try {
      const papers = params.papers as PaperInput[];
      if (!Array.isArray(papers)) {
        throw new Error('papers is required and must be an array');
      }
      return service.batchAdd(papers);
    } catch (err) {
      throw classifyError(err);
    }
  });

  // ── 20. rc.lit.import_bibtex ────────────────────────────────────────

  registerMethod('rc.lit.import_bibtex', async (params: Record<string, unknown>) => {
    try {
      const bibtex = requireString(params, 'bibtex');
      return service.importBibtex(bibtex);
    } catch (err) {
      throw classifyError(err);
    }
  });

  // ── 21. rc.lit.export_bibtex ────────────────────────────────────────

  registerMethod('rc.lit.export_bibtex', async (params: Record<string, unknown>) => {
    try {
      return service.exportBibtex({
        paperIds: optionalStringArray(params, 'paper_ids'),
        tag: optionalString(params, 'tag'),
        collection: optionalString(params, 'collection'),
        all: optionalBoolean(params, 'all'),
      });
    } catch (err) {
      throw classifyError(err);
    }
  });

  // ── 21b. rc.lit.export_ris ───────────────────────────────────────────

  registerMethod('rc.lit.export_ris', async (params: Record<string, unknown>) => {
    try {
      return service.exportRIS({
        paperIds: optionalStringArray(params, 'paper_ids'),
        tag: optionalString(params, 'tag'),
        collection: optionalString(params, 'collection'),
        all: optionalBoolean(params, 'all'),
      });
    } catch (err) {
      throw classifyError(err);
    }
  });

  // ── 22. rc.lit.collections.list ─────────────────────────────────────

  registerMethod('rc.lit.collections.list', async () => {
    try {
      return service.listCollections();
    } catch (err) {
      throw classifyError(err);
    }
  });

  // ── 23. rc.lit.collections.manage ───────────────────────────────────

  registerMethod('rc.lit.collections.manage', async (params: Record<string, unknown>) => {
    try {
      const action = requireString(params, 'action');
      return service.manageCollection(action, {
        id: optionalString(params, 'id'),
        name: optionalString(params, 'name'),
        description: optionalString(params, 'description'),
        color: optionalString(params, 'color'),
        paper_ids: optionalStringArray(params, 'paper_ids'),
      });
    } catch (err) {
      throw classifyError(err);
    }
  });

  // ── 24. rc.lit.notes.list ───────────────────────────────────────────

  registerMethod('rc.lit.notes.list', async (params: Record<string, unknown>) => {
    try {
      const paperId = requireString(params, 'paper_id');
      return service.listNotes(paperId);
    } catch (err) {
      throw classifyError(err);
    }
  });

  // ── 25. rc.lit.notes.add ────────────────────────────────────────────

  registerMethod('rc.lit.notes.add', async (params: Record<string, unknown>) => {
    try {
      const paperId = requireString(params, 'paper_id');
      const content = requireString(params, 'content');
      const page = optionalNumber(params, 'page');
      const highlight = optionalString(params, 'highlight');
      return service.addNote(paperId, content, page, highlight);
    } catch (err) {
      throw classifyError(err);
    }
  });

  // ── 26. rc.lit.notes.delete ─────────────────────────────────────────

  registerMethod('rc.lit.notes.delete', async (params: Record<string, unknown>) => {
    try {
      const noteId = requireString(params, 'note_id');
      service.deleteNote(noteId);
      return { ok: true };
    } catch (err) {
      throw classifyError(err);
    }
  });

  // ── 27. rc.lit.zotero.detect ─────────────────────────────────────────
  registerMethod('rc.lit.zotero.detect', async () => {
    try {
      return ZoteroBridge.detect();
    } catch (err) {
      throw classifyError(err);
    }
  });

  // ── 28. rc.lit.zotero.stats ──────────────────────────────────────────
  registerMethod('rc.lit.zotero.stats', async () => {
    try {
      const detect = ZoteroBridge.detect();
      if (!detect.available || !detect.db_path) {
        throw new Error('Zotero not found');
      }
      return ZoteroBridge.getStats(detect.db_path);
    } catch (err) {
      throw classifyError(err);
    }
  });

  // ── 29. rc.lit.zotero.import ─────────────────────────────────────────
  registerMethod('rc.lit.zotero.import', async (params: Record<string, unknown>) => {
    try {
      const detect = ZoteroBridge.detect();
      if (!detect.available || !detect.db_path) {
        throw new Error('Zotero not found');
      }
      return ZoteroBridge.importAll(detect.db_path, service, {
        collection: optionalString(params, 'collection'),
        limit: optionalNumber(params, 'limit'),
      });
    } catch (err) {
      throw classifyError(err);
    }
  });

  // ── 30. rc.lit.zotero.sync ──────────────────────────────────────────
  registerMethod('rc.lit.zotero.sync', async (params: Record<string, unknown>) => {
    try {
      const detect = ZoteroBridge.detect();
      if (!detect.available || !detect.db_path) {
        throw new Error('Zotero not found');
      }
      const since = optionalString(params, 'since');
      return ZoteroBridge.importAll(detect.db_path, service, { since });
    } catch (err) {
      throw classifyError(err);
    }
  });

  // ── 31. rc.lit.endnote.detect ────────────────────────────────────────
  registerMethod('rc.lit.endnote.detect', async () => {
    try {
      return EndNoteBridge.detect();
    } catch (err) {
      throw classifyError(err);
    }
  });

  // ── 32. rc.lit.endnote.import ────────────────────────────────────────
  registerMethod('rc.lit.endnote.import', async (params: Record<string, unknown>) => {
    try {
      const detect = EndNoteBridge.detect();
      if (!detect.available || !detect.library_path) {
        throw new Error('EndNote library not found');
      }
      return EndNoteBridge.importAll(detect.library_path, service, {
        limit: optionalNumber(params, 'limit'),
      });
    } catch (err) {
      throw classifyError(err);
    }
  });

  // ── 33. rc.lit.import_ris ────────────────────────────────────────────
  registerMethod('rc.lit.import_ris', async (params: Record<string, unknown>) => {
    try {
      const content = requireString(params, 'content');
      const papers = parseRIS(content);
      if (papers.length === 0) {
        return { added: [], duplicates: [], errors: [] };
      }
      return service.batchAdd(papers);
    } catch (err) {
      throw classifyError(err);
    }
  });
}

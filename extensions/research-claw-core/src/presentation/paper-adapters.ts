import { createHash } from 'node:crypto';

import type { PaperBatchPresentationPayload, PaperCandidate } from './types.js';

const MAX_RESULT_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_INPUT_ROWS = 200;
const MAX_STORED_CANDIDATES = 20;
const MAX_AUTHORS = 10;
const PROVIDER_BY_TOOL: Record<string, string> = {
  get_arxiv_paper: 'arxiv',
  search_openalex: 'openalex',
  search_crossref: 'crossref',
  search_arxiv: 'arxiv',
  search_dblp: 'dblp',
  rp_search: 'research-papers',
  'wentor-network__search_papers': 'wentor-network',
};
const SUPPORTED_FULL_TOOLS = new Set([
  'get_arxiv_paper', 'search_openalex', 'search_crossref',
  'search_arxiv', 'search_dblp', 'rp_search',
]);
const SUPPORTED_PERSISTED_TOOLS = new Set([
  ...SUPPORTED_FULL_TOOLS,
  'wentor-network__search_papers',
]);

export function isSupportedLiteratureTool(
  toolName: string,
  source: 'full' | 'persisted',
): boolean {
  return (source === 'full' ? SUPPORTED_FULL_TOOLS : SUPPORTED_PERSISTED_TOOLS).has(toolName);
}

export function createUnavailableLiteraturePresentation(
  toolName: string,
  options: {
    source: 'full' | 'persisted';
    params?: unknown;
    reason: NonNullable<PaperBatchPresentationPayload['unavailableReason']>;
    persistedDetailsTruncated?: boolean;
  },
): PaperBatchPresentationPayload | null {
  if (!isSupportedLiteratureTool(toolName, options.source)) return null;
  const query = options.source === 'full' ? trustedQuery(toolName, options.params) : undefined;
  return {
    kind: 'paper_batch',
    semantic: 'retrieved',
    status: 'unavailable',
    captureSource: options.source,
    provider: PROVIDER_BY_TOOL[toolName],
    ...(query ? { query } : {}),
    queryUnavailable: !query,
    returned: 0,
    inspected: 0,
    eligible: 0,
    stored: 0,
    inputCapped: false,
    runCapped: false,
    persistedDetailsTruncated: options.persistedDetailsTruncated === true,
    unavailableReason: options.reason,
    candidates: [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function safeString(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!text || text.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) return undefined;
  return text;
}

export function normalizeDoi(value: unknown): string | null {
  let doi = safeString(value, 300);
  if (!doi) return null;
  doi = doi.replace(/^doi:\s*/i, '').replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').toLowerCase();
  return /^10\.\d{4,9}\/[^\s<>]+$/.test(doi) && doi.length <= 255 ? doi : null;
}

export function normalizeArxivId(value: unknown): string | null {
  let arxiv = safeString(value, 160);
  if (!arxiv) return null;
  arxiv = arxiv
    .replace(/^https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf)\//i, '')
    .replace(/\.pdf$/i, '')
    .replace(/^arxiv:\s*/i, '')
    .replace(/v\d+$/i, '');
  return /^(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})$/i.test(arxiv) ? arxiv : null;
}

function safeUrl(value: unknown): string | null | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const text = safeString(value, 2_048);
  if (!text) return null;
  try {
    const url = new URL(text);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !url.hostname) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function safeAuthors(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_AUTHORS).flatMap((author) => {
    const text = safeString(author, 200);
    return text ? [text] : [];
  });
}

function safeYear(value: unknown): number | undefined {
  let candidate = value;
  if (Array.isArray(candidate)) candidate = Array.isArray(candidate[0]) ? candidate[0][0] : candidate[0];
  if (typeof candidate === 'string' && /^\d{4}/.test(candidate)) candidate = Number(candidate.slice(0, 4));
  return typeof candidate === 'number' && Number.isInteger(candidate) && candidate >= 1400 && candidate <= 2200
    ? candidate
    : undefined;
}

function safeCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function abstractPreview(value: unknown): string | undefined {
  const text = safeString(value, 100_000);
  return text ? text.slice(0, 500) : undefined;
}

function trustedQuery(toolName: string, params: unknown): string | undefined {
  if (!isRecord(params)) return undefined;
  const value = toolName === 'get_arxiv_paper' ? params.arxiv_id : params.query;
  return safeString(value, 500);
}

function providerId(value: unknown, provider: string): string | undefined {
  const text = safeString(value, 512);
  if (!text) return undefined;
  if (provider === 'openalex') {
    const match = text.match(/(?:openalex\.org\/)?(W\d+)$/i);
    return match?.[1]?.toUpperCase();
  }
  if (provider === 'dblp') {
    const match = text.match(/dblp\.org\/rec\/(.+)$/i);
    return match?.[1];
  }
  return text;
}

function makeCandidate(input: {
  provider: string;
  providerId?: unknown;
  title?: unknown;
  authors?: unknown;
  year?: unknown;
  venue?: unknown;
  doi?: unknown;
  arxivId?: unknown;
  url?: unknown;
  pdfUrl?: unknown;
  abstract?: unknown;
  citationCount?: unknown;
}, index: number): PaperCandidate | null {
  const title = safeString(input.title, 500);
  if (!title) return null;
  const url = safeUrl(input.url);
  const pdfUrl = safeUrl(input.pdfUrl);
  if (url === null || pdfUrl === null) return null;
  const doi = normalizeDoi(input.doi) ?? undefined;
  const arxivId = normalizeArxivId(input.arxivId) ?? undefined;
  const normalizedProviderId = providerId(input.providerId, input.provider);
  const strongAliases = [
    ...(doi ? [`doi:${doi}`] : []),
    ...(arxivId ? [`arxiv:${arxivId.toLowerCase()}`] : []),
    ...(normalizedProviderId ? [`provider:${input.provider}:${normalizedProviderId}`] : []),
  ];
  const candidateId = createHash('sha256').update([
    input.provider, ...strongAliases, title, String(index),
  ].join('\0')).digest('hex').slice(0, 20);
  return {
    candidateId,
    provider: input.provider,
    ...(normalizedProviderId ? { providerId: normalizedProviderId } : {}),
    returnIndex: index + 1,
    source: input.provider,
    ...(normalizedProviderId ? { sourceId: normalizedProviderId } : {}),
    strongAliases,
    actionable: strongAliases.length > 0,
    title,
    authors: safeAuthors(input.authors),
    ...(safeYear(input.year) ? { year: safeYear(input.year) } : {}),
    ...(safeString(input.venue, 300) ? { venue: safeString(input.venue, 300) } : {}),
    ...(doi ? { doi } : {}),
    ...(arxivId ? { arxivId } : {}),
    ...(url ? { url } : {}),
    ...(pdfUrl ? { pdfUrl } : {}),
    ...(abstractPreview(input.abstract) ? { abstractPreview: abstractPreview(input.abstract) } : {}),
    ...(safeCount(input.citationCount) !== undefined ? { citationCount: safeCount(input.citationCount) } : {}),
  };
}

function parsePersistedPayload(toolName: string, result: Record<string, unknown>): unknown | null {
  if (!Array.isArray(result.content)) return null;
  const textParts = result.content.filter(
    (part): part is { type: 'text'; text: string } => isRecord(part) && part.type === 'text' && typeof part.text === 'string',
  );
  if (textParts.length !== 1) return null;
  let text = textParts[0].text.trim();
  if (Buffer.byteLength(text) > MAX_RESULT_TEXT_BYTES) return null;
  if (toolName === 'rp_search') {
    if (!text.startsWith('[rp] search ')) return null;
    const boundary = text.indexOf('\n\n[');
    if (boundary < 0) return null;
    text = text.slice(boundary + 2);
  }
  if (!(text.startsWith('{') && text.endsWith('}')) && !(text.startsWith('[') && text.endsWith(']'))) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function rowsFor(toolName: string, payload: unknown): {
  provider: string;
  matchedTotal?: number;
  rows: unknown[];
  convert: (row: Record<string, unknown>, index: number) => PaperCandidate | null;
} | null {
  const record = isRecord(payload) ? payload : null;
  if (toolName === 'get_arxiv_paper' && record) {
    return {
      provider: 'arxiv', matchedTotal: 1, rows: [record],
      convert: (row, index) => makeCandidate({
        provider: 'arxiv', providerId: row.arxiv_id, arxivId: row.arxiv_id,
        title: row.title, authors: row.authors, year: row.published,
        doi: row.doi, url: row.abs_url, pdfUrl: row.pdf_url, abstract: row.summary,
      }, index),
    };
  }
  if (toolName === 'search_openalex' && record && Array.isArray(record.results)) {
    return {
      provider: 'openalex', matchedTotal: safeCount(record.total_count), rows: record.results,
      convert: (row, index) => makeCandidate({
        provider: 'openalex', providerId: row.id, title: row.title, authors: row.authors,
        year: row.publication_date, doi: row.doi, url: row.oa_url,
        citationCount: row.cited_by_count,
      }, index),
    };
  }
  if (toolName === 'search_crossref' && record && Array.isArray(record.items)) {
    return {
      provider: 'crossref', matchedTotal: safeCount(record.total_results), rows: record.items,
      convert: (row, index) => makeCandidate({
        provider: 'crossref', providerId: normalizeDoi(row.doi) ?? undefined,
        title: row.title, authors: row.authors, year: row.published, venue: row.container_title,
        doi: row.doi, url: normalizeDoi(row.doi) ? `https://doi.org/${normalizeDoi(row.doi)}` : undefined,
        abstract: row.abstract, citationCount: row.cited_by,
      }, index),
    };
  }
  if (toolName === 'search_arxiv' && record && Array.isArray(record.papers)) {
    return {
      provider: 'arxiv', matchedTotal: safeCount(record.total_results), rows: record.papers,
      convert: (row, index) => makeCandidate({
        provider: 'arxiv', providerId: row.arxiv_id, arxivId: row.arxiv_id,
        title: row.title, authors: row.authors, year: row.published,
        doi: row.doi, url: row.abs_url, pdfUrl: row.pdf_url, abstract: row.summary,
      }, index),
    };
  }
  if (toolName === 'search_dblp' && record && Array.isArray(record.papers)) {
    return {
      provider: 'dblp', matchedTotal: safeCount(record.total_results), rows: record.papers,
      convert: (row, index) => makeCandidate({
        provider: 'dblp', providerId: row.dblp_url, title: row.title, authors: row.authors,
        year: row.year, venue: row.venue, doi: row.doi, url: row.url ?? row.dblp_url,
      }, index),
    };
  }
  if (toolName === 'rp_search' && Array.isArray(payload)) {
    return {
      provider: 'research-papers', rows: payload,
      convert: (row, index) => makeCandidate({
        provider: 'research-papers', providerId: row.scopus_id ?? row.eid ?? row.openalex_id,
        title: row.title, year: row.year, venue: row.source, doi: row.doi,
        url: normalizeDoi(row.doi) ? `https://doi.org/${normalizeDoi(row.doi)}` : undefined,
        pdfUrl: row.oa_pdf_url, abstract: row.abstract, citationCount: row.cited_by,
      }, index),
    };
  }
  if (toolName === 'wentor-network__search_papers' && record && Array.isArray(record.results) && isRecord(record.meta)) {
    return {
      provider: 'wentor-network', matchedTotal: safeCount(record.meta.total), rows: record.results,
      convert: (row, index) => makeCandidate({
        provider: 'wentor-network', providerId: row.paper_id, arxivId: row.arxiv_id,
        title: row.title, year: row.year, abstract: row.abstract,
        url: normalizeArxivId(row.arxiv_id) ? `https://arxiv.org/abs/${normalizeArxivId(row.arxiv_id)}` : undefined,
        pdfUrl: normalizeArxivId(row.arxiv_id) ? `https://arxiv.org/pdf/${normalizeArxivId(row.arxiv_id)}` : undefined,
      }, index),
    };
  }
  return null;
}

export function adaptLiteraturePresentation(
  toolName: string,
  result: unknown,
  options: { source: 'full' | 'persisted'; params?: unknown },
): PaperBatchPresentationPayload | null {
  if (!isSupportedLiteratureTool(toolName, options.source) || !isRecord(result) || result.isError === true) return null;
  if (isRecord(result.details) && (typeof result.details.error === 'string' || result.details.status === 'error')) return null;
  const persistedDetailsTruncated = isRecord(result.details) && result.details.persistedDetailsTruncated === true;
  const payload = options.source === 'persisted'
    ? parsePersistedPayload(toolName, result)
    : result.details;
  const schema = rowsFor(toolName, payload);
  if (!schema) return null;
  const returned = schema.rows.length;
  const inspectedRows = schema.rows.slice(0, MAX_INPUT_ROWS);
  const eligible = inspectedRows.flatMap((row, index) => {
    if (!isRecord(row)) return [];
    const candidate = schema.convert(row, index);
    return candidate ? [candidate] : [];
  });
  const candidates = eligible.slice(0, MAX_STORED_CANDIDATES);
  const query = options.source === 'full' ? trustedQuery(toolName, options.params) : undefined;
  return {
    kind: 'paper_batch',
    semantic: 'retrieved',
    status: 'available',
    captureSource: options.source,
    provider: schema.provider,
    ...(query ? { query } : {}),
    queryUnavailable: !query,
    ...(schema.matchedTotal !== undefined ? { matchedTotal: schema.matchedTotal } : {}),
    returned,
    inspected: inspectedRows.length,
    eligible: eligible.length,
    stored: candidates.length,
    inputCapped: returned > MAX_INPUT_ROWS,
    runCapped: false,
    persistedDetailsTruncated,
    candidates,
  };
}

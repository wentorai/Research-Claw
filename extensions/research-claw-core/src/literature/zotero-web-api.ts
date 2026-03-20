/**
 * Zotero Web API v3 Bridge
 *
 * REST API access to Zotero cloud library.
 * Supports full CRUD — write operations require user confirmation (approval_card).
 *
 * Docs: https://www.zotero.org/support/dev/web_api/v3/basics
 */

import type { PaperInput } from './service.js';

// ── Constants ─────────────────────────────────────────────────────────

const BASE_URL = 'https://api.zotero.org';
const FETCH_TIMEOUT = 10_000;
const MAX_PER_PAGE = 100;
const USER_AGENT = 'Research-Claw/0.5.5';

// ── Types ─────────────────────────────────────────────────────────────

export interface ZoteroWebConfig {
  apiKey: string;
  userId: string;
}

export interface ZoteroWebDetectResult {
  configured: boolean;
  userId: string | null;
  totalItems: number | null;
  rateLimitRemaining: number | null;
}

export interface ZoteroWebItem {
  key: string;
  version: number;
  itemType: string;
  title: string;
  creators: Array<{ creatorType: string; firstName?: string; lastName?: string; name?: string }>;
  date?: string;
  DOI?: string;
  url?: string;
  abstractNote?: string;
  publicationTitle?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  ISSN?: string;
  ISBN?: string;
  tags: Array<{ tag: string; type?: number }>;
  collections: string[];
  dateModified: string;
}

export interface ZoteroWebImportResult {
  imported: number;
  duplicates: number;
  errors: number;
  items: string[];
}

// ── Item type mapping (mirrors zotero.ts) ─────────────────────────────

const ZOTERO_TYPE_MAP: Record<string, string> = {
  journalArticle: 'journal_article',
  conferencePaper: 'conference_paper',
  preprint: 'preprint',
  book: 'book',
  bookSection: 'book_chapter',
  thesis: 'thesis',
  report: 'report',
};

const VENUE_FIELDS: Record<string, string> = {
  journalArticle: 'publicationTitle',
  conferencePaper: 'proceedingsTitle',
  bookSection: 'bookTitle',
  preprint: 'repository',
};

// ── Helpers ────────────────────────────────────────────────────────────

function formatCreatorName(c: ZoteroWebItem['creators'][number]): string {
  if (c.name) return c.name;
  const first = c.firstName?.trim() ?? '';
  const last = c.lastName?.trim() ?? '';
  if (first && last) return `${first} ${last}`;
  return last || first;
}

function parseYear(dateStr: string | undefined): number | null {
  if (!dateStr) return null;
  const match = dateStr.match(/\b((?:19|20)\d{2})\b/);
  return match ? parseInt(match[1], 10) : null;
}

function extractArxivId(item: ZoteroWebItem & Record<string, unknown>): string | null {
  const archiveID = item['archiveID'];
  if (typeof archiveID === 'string' && archiveID.startsWith('arXiv:')) {
    return archiveID.slice(6);
  }
  const extra = item['extra'];
  if (typeof extra === 'string') {
    const match = extra.match(/arXiv[:\s]+(\d+\.\d+(?:v\d+)?)/i);
    if (match) return match[1];
  }
  return null;
}

function generateBibtexKey(authors: string[], year: number | null, title: string): string | null {
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

// ── Bridge class ──────────────────────────────────────────────────────

export class ZoteroWebAPI {
  /**
   * Read config from environment variables. Returns null if not configured.
   */
  static getConfig(): ZoteroWebConfig | null {
    const apiKey = process.env.ZOTERO_API_KEY;
    const userId = process.env.ZOTERO_USER_ID;
    if (!apiKey || !userId) return null;
    return { apiKey, userId };
  }

  /**
   * Validate credentials by issuing a HEAD request to the user's items endpoint.
   */
  static async validateCredentials(config: ZoteroWebConfig): Promise<ZoteroWebDetectResult> {
    const empty: ZoteroWebDetectResult = {
      configured: false, userId: null, totalItems: null, rateLimitRemaining: null,
    };
    try {
      const res = await ZoteroWebAPI.request(config, 'HEAD', `/users/${config.userId}/items?limit=0`);
      if (!res) return empty;
      if (res.status === 401 || res.status === 403) return empty;

      return {
        configured: true,
        userId: config.userId,
        totalItems: parseInt(res.headers.get('Total-Results') ?? '0', 10) || null,
        rateLimitRemaining: parseInt(res.headers.get('X-RateLimit-Remaining') ?? '', 10) || null,
      };
    } catch {
      return empty;
    }
  }

  /**
   * List items with optional pagination and collection filter.
   */
  static async listItems(
    config: ZoteroWebConfig,
    opts?: { limit?: number; start?: number; collection?: string; since?: number },
  ): Promise<ZoteroWebItem[]> {
    const limit = Math.min(opts?.limit ?? 25, MAX_PER_PAGE);
    const params = new URLSearchParams({
      format: 'json',
      limit: String(limit),
      start: String(opts?.start ?? 0),
      sort: 'dateModified',
      direction: 'desc',
    });
    if (opts?.since != null) params.set('since', String(opts.since));

    const basePath = opts?.collection
      ? `/users/${config.userId}/collections/${opts.collection}/items`
      : `/users/${config.userId}/items`;

    return ZoteroWebAPI.fetchItems(config, `${basePath}?${params}`);
  }

  /**
   * Search items by free-text query.
   */
  static async searchItems(
    config: ZoteroWebConfig,
    query: string,
    opts?: { limit?: number },
  ): Promise<ZoteroWebItem[]> {
    const limit = Math.min(opts?.limit ?? 25, MAX_PER_PAGE);
    const params = new URLSearchParams({
      format: 'json',
      q: query,
      limit: String(limit),
      sort: 'dateModified',
      direction: 'desc',
    });

    return ZoteroWebAPI.fetchItems(config, `/users/${config.userId}/items?${params}`);
  }

  /**
   * Fetch a single item by key.
   */
  static async getItem(config: ZoteroWebConfig, itemKey: string): Promise<ZoteroWebItem | null> {
    try {
      const res = await ZoteroWebAPI.request(config, 'GET', `/users/${config.userId}/items/${itemKey}?format=json`);
      if (!res || !res.ok) return null;
      const json = await res.json() as { data: Record<string, unknown> };
      return ZoteroWebAPI.normalizeItem(json.data);
    } catch {
      return null;
    }
  }

  /**
   * Create a new item. Returns key + version on success, null on failure.
   */
  static async createItem(
    config: ZoteroWebConfig,
    data: Record<string, unknown>,
  ): Promise<{ key: string; version: number } | null> {
    try {
      const res = await ZoteroWebAPI.request(
        config, 'POST', `/users/${config.userId}/items`,
        JSON.stringify([data]),
      );
      if (!res || !res.ok) return null;
      const json = await res.json() as {
        successful?: Record<string, { key: string; version: number; data: Record<string, unknown> }>;
      };
      const first = json.successful ? Object.values(json.successful)[0] : null;
      return first ? { key: first.key, version: first.version } : null;
    } catch {
      return null;
    }
  }

  /**
   * Update an existing item (PATCH). Requires version for optimistic locking.
   */
  static async updateItem(
    config: ZoteroWebConfig,
    itemKey: string,
    version: number,
    data: Record<string, unknown>,
  ): Promise<boolean> {
    try {
      const res = await ZoteroWebAPI.request(
        config, 'PATCH', `/users/${config.userId}/items/${itemKey}`,
        JSON.stringify(data),
        { 'If-Unmodified-Since-Version': String(version) },
      );
      return res?.ok === true;
    } catch {
      return false;
    }
  }

  /**
   * Delete an item. Requires version for optimistic locking.
   */
  static async deleteItem(
    config: ZoteroWebConfig,
    itemKey: string,
    version: number,
  ): Promise<boolean> {
    try {
      const res = await ZoteroWebAPI.request(
        config, 'DELETE', `/users/${config.userId}/items/${itemKey}`,
        undefined,
        { 'If-Unmodified-Since-Version': String(version) },
      );
      return res?.status === 204;
    } catch {
      return false;
    }
  }

  /**
   * Convert a ZoteroWebItem to PaperInput for LiteratureService.add().
   */
  static toPaperInput(item: ZoteroWebItem): PaperInput {
    const authors = item.creators
      .filter((c) => c.creatorType === 'author')
      .map(formatCreatorName)
      .filter(Boolean);

    const year = parseYear(item.date);
    const venueField = VENUE_FIELDS[item.itemType] as keyof ZoteroWebItem | undefined;
    const venue = venueField ? (item[venueField] as string | undefined) : undefined;
    const arxivId = extractArxivId(item as ZoteroWebItem & Record<string, unknown>);
    const bibtexKey = generateBibtexKey(authors, year, item.title);

    return {
      title: item.title,
      authors: authors.length > 0 ? authors : undefined,
      abstract: item.abstractNote ?? undefined,
      doi: item.DOI ?? undefined,
      url: item.url ?? undefined,
      arxiv_id: arxivId ?? undefined,
      source: 'zotero_web',
      source_id: item.key,
      venue: venue ?? undefined,
      year: year ?? undefined,
      bibtex_key: bibtexKey ?? undefined,
      tags: item.tags.length > 0 ? item.tags.map((t) => t.tag) : undefined,
      paper_type: ZOTERO_TYPE_MAP[item.itemType] ?? undefined,
      volume: item.volume ?? undefined,
      issue: item.issue ?? undefined,
      pages: item.pages ?? undefined,
      issn: item.ISSN ?? undefined,
      isbn: item.ISBN ?? undefined,
      metadata: {
        zotero_collections: item.collections,
        zotero_item_type: item.itemType,
        zotero_version: item.version,
      },
    };
  }

  // ── Private helpers ────────────────────────────────────────────────

  /**
   * Send a request to the Zotero API with standard headers and timeout.
   * Returns null on network error or rate-limit backoff.
   */
  private static async request(
    config: ZoteroWebConfig,
    method: string,
    path: string,
    body?: string,
    extraHeaders?: Record<string, string>,
  ): Promise<Response | null> {
    const headers: Record<string, string> = {
      'Zotero-API-Key': config.apiKey,
      'Zotero-API-Version': '3',
      'User-Agent': USER_AGENT,
      ...extraHeaders,
    };
    if (body) headers['Content-Type'] = 'application/json';

    try {
      const res = await fetch(`${BASE_URL}${path}`, {
        method,
        headers,
        body: body ?? undefined,
        signal: AbortSignal.timeout(FETCH_TIMEOUT),
      });

      // Handle rate limiting
      const backoff = res.headers.get('Backoff') || res.headers.get('Retry-After');
      if (res.status === 429 || backoff) {
        return null;
      }

      return res;
    } catch {
      return null;
    }
  }

  /**
   * Fetch and normalize a list of items from the API.
   */
  private static async fetchItems(config: ZoteroWebConfig, path: string): Promise<ZoteroWebItem[]> {
    try {
      const res = await ZoteroWebAPI.request(config, 'GET', path);
      if (!res || !res.ok) return [];
      const json = await res.json() as Array<{ data: Record<string, unknown> }>;
      return json
        .map((entry) => ZoteroWebAPI.normalizeItem(entry.data))
        .filter((item): item is ZoteroWebItem => item !== null);
    } catch {
      return [];
    }
  }

  /**
   * Normalize raw API JSON data into a ZoteroWebItem.
   * Returns null if the item has no title or is an unsupported type.
   */
  private static normalizeItem(data: Record<string, unknown>): ZoteroWebItem | null {
    const title = data['title'];
    if (typeof title !== 'string' || !title.trim()) return null;

    return {
      key: String(data['key'] ?? ''),
      version: Number(data['version'] ?? 0),
      itemType: String(data['itemType'] ?? ''),
      title: title.trim(),
      creators: Array.isArray(data['creators']) ? data['creators'] : [],
      date: typeof data['date'] === 'string' ? data['date'] : undefined,
      DOI: typeof data['DOI'] === 'string' ? data['DOI'] : undefined,
      url: typeof data['url'] === 'string' ? data['url'] : undefined,
      abstractNote: typeof data['abstractNote'] === 'string' ? data['abstractNote'] : undefined,
      publicationTitle: typeof data['publicationTitle'] === 'string' ? data['publicationTitle'] : undefined,
      volume: typeof data['volume'] === 'string' && data['volume'] ? data['volume'] : undefined,
      issue: typeof data['issue'] === 'string' && data['issue'] ? data['issue'] : undefined,
      pages: typeof data['pages'] === 'string' && data['pages'] ? data['pages'] : undefined,
      ISSN: typeof data['ISSN'] === 'string' && data['ISSN'] ? data['ISSN'] : undefined,
      ISBN: typeof data['ISBN'] === 'string' && data['ISBN'] ? data['ISBN'] : undefined,
      tags: Array.isArray(data['tags']) ? data['tags'] : [],
      collections: Array.isArray(data['collections']) ? data['collections'] : [],
      dateModified: typeof data['dateModified'] === 'string' ? data['dateModified'] : '',
    };
  }
}

/**
 * Zotero Local API Bridge
 *
 * Connects to Zotero 7's built-in HTTP server at localhost:23119.
 * Read-only, no auth required, requires Zotero to be running.
 *
 * The Local API mirrors the Zotero Web API JSON format but:
 *   - No authentication needed (localhost only)
 *   - User ID is always `0` (current local user)
 *   - Read-only (no write operations)
 *   - Requires Zotero desktop app to be running
 */

import type { ZoteroWebItem } from './zotero-web-api.js';

// ── Constants ──────────────────────────────────────────────────────────

const BASE_URL = 'http://localhost:23119/api/users/0';
const TIMEOUT_MS = 3_000;

// ── Helpers ────────────────────────────────────────────────────────────

function buildUrl(path: string, params?: Record<string, string | number>): string {
  const url = new URL(`${BASE_URL}${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

async function localFetch(url: string): Promise<Response | null> {
  try {
    return await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    return null;
  }
}

/** Normalize the nested Zotero API response { key, version, data: {...} } to flat ZoteroWebItem. */
function normalizeItems(raw: Array<Record<string, unknown>>): ZoteroWebItem[] {
  return raw
    .filter((entry) => entry.data && typeof entry.data === 'object')
    .map((entry) => {
      const d = entry.data as Record<string, unknown>;
      return {
        key: String(entry.key ?? d.key ?? ''),
        version: Number(entry.version ?? d.version ?? 0),
        itemType: String(d.itemType ?? ''),
        title: String(d.title ?? ''),
        creators: (d.creators as ZoteroWebItem['creators']) ?? [],
        date: d.date as string | undefined,
        DOI: d.DOI as string | undefined,
        url: d.url as string | undefined,
        abstractNote: d.abstractNote as string | undefined,
        publicationTitle: d.publicationTitle as string | undefined,
        volume: d.volume as string | undefined,
        issue: d.issue as string | undefined,
        pages: d.pages as string | undefined,
        ISSN: d.ISSN as string | undefined,
        ISBN: d.ISBN as string | undefined,
        tags: (d.tags as ZoteroWebItem['tags']) ?? [],
        collections: (d.collections as string[]) ?? [],
        dateModified: String(d.dateModified ?? entry.dateModified ?? ''),
      } satisfies ZoteroWebItem;
    });
}

// ── ZoteroLocalAPI ─────────────────────────────────────────────────────

export class ZoteroLocalAPI {
  /**
   * Detect whether Zotero's local HTTP server is reachable.
   * Returns item count from the `Total-Results` header when available.
   */
  static async detect(): Promise<{ available: boolean; itemCount: number | null }> {
    const res = await localFetch(buildUrl('/items', { limit: 0 }));
    if (!res || !res.ok) return { available: false, itemCount: null };

    const total = res.headers.get('Total-Results');
    return {
      available: true,
      itemCount: total !== null ? parseInt(total, 10) : null,
    };
  }

  /**
   * List items from the local library, optionally filtered by collection.
   */
  static async listItems(opts?: {
    limit?: number;
    start?: number;
    collection?: string;
  }): Promise<ZoteroWebItem[]> {
    const { limit = 25, start = 0, collection } = opts ?? {};

    const path = collection
      ? `/collections/${collection}/items`
      : '/items';

    const res = await localFetch(buildUrl(path, { limit, start }));
    if (!res || !res.ok) return [];

    const raw = (await res.json()) as Array<Record<string, unknown>>;
    return normalizeItems(raw);
  }

  /**
   * Full-text search across items in the local library.
   */
  static async searchItems(
    query: string,
    opts?: { limit?: number },
  ): Promise<ZoteroWebItem[]> {
    const limit = opts?.limit ?? 25;

    const res = await localFetch(buildUrl('/items', { q: query, limit }));
    if (!res || !res.ok) return [];

    const raw = (await res.json()) as Array<Record<string, unknown>>;
    return normalizeItems(raw);
  }
}

/**
 * Radar tracking config — RPC methods
 *
 * 4 methods:
 *   - rc.radar.config.get  → returns { keywords, authors, journals, sources }
 *   - rc.radar.config.set  → persists tracking config
 *   - rc.radar.scan        → scan sources for new papers (persists results to DB)
 *   - rc.radar.lastScan    → returns cached results from last scan (no network)
 */

import type { Database } from 'better-sqlite3';
import { radarScan, type ScanOptions } from './scanner.js';
import type { RegisterMethod } from '../types.js';

export interface RadarConfig {
  keywords: string[];
  authors: string[];
  journals: string[];
  sources: string[];
}

const DEFAULT_CONFIG: RadarConfig = {
  keywords: [],
  authors: [],
  journals: [],
  sources: ['arxiv', 'semantic_scholar'],
};

function getConfig(db: Database): RadarConfig {
  const row = db.prepare('SELECT keywords, authors, journals, sources FROM rc_radar_config WHERE id = ?').get('default') as
    | { keywords: string; authors: string; journals: string; sources: string }
    | undefined;

  if (!row) return { ...DEFAULT_CONFIG };

  return {
    keywords: JSON.parse(row.keywords),
    authors: JSON.parse(row.authors),
    journals: JSON.parse(row.journals),
    sources: JSON.parse(row.sources),
  };
}

function setConfig(db: Database, config: Partial<RadarConfig>): RadarConfig {
  const current = getConfig(db);
  const merged: RadarConfig = {
    keywords: config.keywords ?? current.keywords,
    authors: config.authors ?? current.authors,
    journals: config.journals ?? current.journals,
    sources: config.sources ?? current.sources,
  };

  db.prepare(`
    INSERT INTO rc_radar_config (id, keywords, authors, journals, sources, updated_at)
    VALUES ('default', ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      keywords = excluded.keywords,
      authors = excluded.authors,
      journals = excluded.journals,
      sources = excluded.sources,
      updated_at = excluded.updated_at
  `).run(
    JSON.stringify(merged.keywords),
    JSON.stringify(merged.authors),
    JSON.stringify(merged.journals),
    JSON.stringify(merged.sources),
  );

  return merged;
}

// ── Scan result cache helpers ────────────────────────────────────────

function persistScanResults(db: Database, results: unknown[]): void {
  try {
    db.prepare(`
      UPDATE rc_radar_config
      SET last_scan_results = ?, last_scan_at = datetime('now')
      WHERE id = 'default'
    `).run(JSON.stringify(results));
  } catch {
    // Non-fatal — cache write failure shouldn't break scan
  }
}

function getCachedScan(db: Database): { results: unknown[]; scanned_at: string | null } | null {
  try {
    const row = db.prepare(
      'SELECT last_scan_results, last_scan_at FROM rc_radar_config WHERE id = ?',
    ).get('default') as { last_scan_results: string | null; last_scan_at: string | null } | undefined;

    if (!row?.last_scan_results) return null;

    return {
      results: JSON.parse(row.last_scan_results),
      scanned_at: row.last_scan_at,
    };
  } catch {
    return null;
  }
}

// ── Inline migration for existing DBs ────────────────────────────────

function ensureCacheColumns(db: Database): void {
  try { db.exec('ALTER TABLE rc_radar_config ADD COLUMN last_scan_at TEXT'); } catch { /* exists */ }
  try { db.exec('ALTER TABLE rc_radar_config ADD COLUMN last_scan_results TEXT'); } catch { /* exists */ }
}

// ── RPC registration ─────────────────────────────────────────────────

export function registerRadarRpc(registerMethod: RegisterMethod, db: Database): void {
  // Ensure cache columns exist (idempotent for existing DBs)
  ensureCacheColumns(db);

  // ── rc.radar.config.get ──────────────────────────────────────────
  registerMethod('rc.radar.config.get', (_params: Record<string, unknown>) => {
    return getConfig(db);
  });

  // ── rc.radar.config.set ──────────────────────────────────────────
  registerMethod('rc.radar.config.set', (params: Record<string, unknown>) => {
    const patch: Partial<RadarConfig> = {};
    if (Array.isArray(params.keywords)) patch.keywords = params.keywords.map(String);
    if (Array.isArray(params.authors)) patch.authors = params.authors.map(String);
    if (Array.isArray(params.journals)) patch.journals = params.journals.map(String);
    if (Array.isArray(params.sources)) patch.sources = params.sources.map(String);
    return setConfig(db, patch);
  });

  // ── rc.radar.scan ─────────────────────────────────────────────────
  // Scans external sources (arXiv, Semantic Scholar) and persists results
  // to rc_radar_config.last_scan_results for offline access via lastScan.
  registerMethod('rc.radar.scan', async (params: Record<string, unknown>) => {
    const options: ScanOptions = {};
    if (Array.isArray(params.keywords)) options.keywords = params.keywords.map(String);
    if (Array.isArray(params.sources)) options.sources = params.sources.map(String);
    if (typeof params.max_results === 'number') options.max_results = Math.min(params.max_results, 50);

    const results = await radarScan(db, options);

    // Persist results for next panel open (non-blocking, non-fatal)
    persistScanResults(db, results);

    return { results };
  });

  // ── rc.radar.lastScan ─────────────────────────────────────────────
  // Returns the last cached scan results without triggering a new scan.
  // Used by the dashboard to populate "Recent Discoveries" on panel open.
  registerMethod('rc.radar.lastScan', (_params: Record<string, unknown>) => {
    const cached = getCachedScan(db);
    if (!cached) return { results: null, scanned_at: null };
    return { results: cached.results, scanned_at: cached.scanned_at };
  });
}

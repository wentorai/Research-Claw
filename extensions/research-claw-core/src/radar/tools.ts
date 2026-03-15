/**
 * Radar tracking — Agent tools
 *
 * 3 tools:
 *   - radar_configure: Set keywords, authors, journals to track
 *   - radar_get_config: Read current radar configuration
 *   - radar_scan: Scan configured sources for new papers
 */

import type { Database } from 'better-sqlite3';
import type { ToolDefinition } from '../types.js';
import { radarScan } from './scanner.js';

function fail(message: string): unknown {
  return { content: [{ type: 'text', text: `Error: ${message}` }], details: { error: message } };
}

interface RadarConfig {
  keywords: string[];
  authors: string[];
  journals: string[];
  sources: string[];
}

function getConfig(db: Database): RadarConfig {
  const row = db.prepare('SELECT keywords, authors, journals, sources FROM rc_radar_config WHERE id = ?').get('default') as
    | { keywords: string; authors: string; journals: string; sources: string }
    | undefined;

  if (!row) {
    return { keywords: [], authors: [], journals: [], sources: ['arxiv', 'semantic_scholar'] };
  }

  try {
    return {
      keywords: JSON.parse(row.keywords),
      authors: JSON.parse(row.authors),
      journals: JSON.parse(row.journals),
      sources: JSON.parse(row.sources),
    };
  } catch {
    return { keywords: [], authors: [], journals: [], sources: ['arxiv', 'semantic_scholar'] };
  }
}

function setConfig(db: Database, patch: Partial<RadarConfig>): RadarConfig {
  const current = getConfig(db);
  const merged: RadarConfig = {
    keywords: patch.keywords ?? current.keywords,
    authors: patch.authors ?? current.authors,
    journals: patch.journals ?? current.journals,
    sources: patch.sources ?? current.sources,
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

export function createRadarTools(db: Database): ToolDefinition[] {
  const tools: ToolDefinition[] = [];

  // ── 1. radar_configure ────────────────────────────────────────────

  tools.push({
    name: 'radar_configure',
    description:
      'Configure the research radar tracking settings. Sets which keywords, authors, ' +
      'and journals to monitor for new papers. Each call replaces the specified arrays ' +
      '(omit a field to keep its current value). The dashboard Radar panel reads this config.',
    parameters: {
      type: 'object',
      properties: {
        keywords: {
          type: 'array',
          items: { type: 'string' },
          description: 'Keywords/topics to track (e.g. "transformer", "attention mechanism", "graph neural network")',
        },
        authors: {
          type: 'array',
          items: { type: 'string' },
          description: 'Author names to track (e.g. "Vaswani", "Hinton")',
        },
        journals: {
          type: 'array',
          items: { type: 'string' },
          description: 'Journal/venue names to track (e.g. "NeurIPS", "Nature", "ICML")',
        },
        sources: {
          type: 'array',
          items: { type: 'string' },
          description: 'Paper sources to scan (default: arxiv, semantic_scholar)',
        },
      },
    },
    async execute(_toolCallId: string, params: Record<string, unknown>): Promise<unknown> {
      try {
        const patch: Partial<RadarConfig> = {};
        if (Array.isArray(params.keywords)) patch.keywords = params.keywords.map(String);
        if (Array.isArray(params.authors)) patch.authors = params.authors.map(String);
        if (Array.isArray(params.journals)) patch.journals = params.journals.map(String);
        if (Array.isArray(params.sources)) patch.sources = params.sources.map(String);

        if (!patch.keywords && !patch.authors && !patch.journals && !patch.sources) {
          return fail('At least one of keywords, authors, journals, or sources must be provided');
        }

        const config = setConfig(db, patch);

        const summary = [
          config.keywords.length > 0 ? `Keywords: ${config.keywords.join(', ')}` : null,
          config.authors.length > 0 ? `Authors: ${config.authors.join(', ')}` : null,
          config.journals.length > 0 ? `Journals: ${config.journals.join(', ')}` : null,
          `Sources: ${config.sources.join(', ')}`,
        ].filter(Boolean).join('\n');

        return {
          content: [{ type: 'text', text: `Radar config updated:\n${summary}` }],
          details: config,
        };
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  });

  // ── 2. radar_get_config ───────────────────────────────────────────

  tools.push({
    name: 'radar_get_config',
    description:
      'Read the current research radar configuration. Returns the tracked keywords, ' +
      'authors, journals, and sources.',
    parameters: {
      type: 'object',
      properties: {},
    },
    async execute(_toolCallId: string, _params: Record<string, unknown>): Promise<unknown> {
      try {
        const config = getConfig(db);
        const isEmpty = config.keywords.length === 0 && config.authors.length === 0 && config.journals.length === 0;

        const summary = isEmpty
          ? 'Radar is not configured yet. Use radar_configure to set tracking keywords, authors, and journals.'
          : [
              config.keywords.length > 0 ? `Keywords: ${config.keywords.join(', ')}` : null,
              config.authors.length > 0 ? `Authors: ${config.authors.join(', ')}` : null,
              config.journals.length > 0 ? `Journals: ${config.journals.join(', ')}` : null,
              `Sources: ${config.sources.join(', ')}`,
            ].filter(Boolean).join('\n');

        return {
          content: [{ type: 'text', text: summary }],
          details: config,
        };
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  });

  // ── 3. radar_scan ─────────────────────────────────────────────────

  tools.push({
    name: 'radar_scan',
    description:
      'Scan configured paper sources (arXiv, Semantic Scholar) for new papers matching ' +
      'the radar tracking config. Returns discovered papers (NOT auto-added to library). ' +
      'Use library_add_paper or library_batch_add to save interesting papers. ' +
      'MUST use this tool when the user asks to check for new papers.',
    parameters: {
      type: 'object',
      properties: {
        keywords: {
          type: 'array',
          items: { type: 'string' },
          description: 'Override keywords (optional, defaults to radar config)',
        },
        sources: {
          type: 'array',
          items: { type: 'string' },
          description: 'Override sources (optional, defaults to radar config). Valid: arxiv, semantic_scholar',
        },
        max_results: {
          type: 'number',
          description: 'Max results per source (default: 20, max: 50)',
        },
      },
    },
    async execute(_toolCallId: string, params: Record<string, unknown>): Promise<unknown> {
      try {
        const options: { keywords?: string[]; sources?: string[]; max_results?: number } = {};
        if (Array.isArray(params.keywords)) options.keywords = params.keywords.map(String);
        if (Array.isArray(params.sources)) options.sources = params.sources.map(String);
        if (typeof params.max_results === 'number') options.max_results = Math.min(params.max_results, 50);

        const results = await radarScan(db, options);

        // Build a text summary
        const totalPapers = results.reduce((sum, r) => sum + r.papers.length, 0);
        const totalSkipped = results.reduce((sum, r) => sum + r.papers_skipped, 0);
        const totalErrors = results.flatMap((r) => r.errors);

        const lines: string[] = [];
        lines.push(`Radar scan complete: ${totalPapers} new papers found, ${totalSkipped} already in library.`);

        for (const result of results) {
          if (result.errors.length > 0) {
            lines.push(`\n[${result.source}] Error: ${result.errors.join('; ')}`);
          } else {
            lines.push(`\n[${result.source}] ${result.papers.length} papers (${result.total_found} total, ${result.papers_skipped} skipped)`);
            for (const paper of result.papers.slice(0, 5)) {
              const authorsStr = paper.authors.slice(0, 3).join(', ');
              lines.push(`  - "${paper.title}" (${authorsStr}${paper.year ? `, ${paper.year}` : ''})`);
            }
            if (result.papers.length > 5) {
              lines.push(`  ... and ${result.papers.length - 5} more`);
            }
          }
        }

        if (totalErrors.length > 0 && totalPapers === 0) {
          lines.push('\nAll sources failed. Check your network connection or try again later.');
        }

        if (totalPapers > 0) {
          lines.push('\nTip: Save these results with workspace_save("outputs/radar/scan-YYYY-MM-DD.md", ...) for future reference.');
          lines.push('Use library_add_paper or library_batch_add to add interesting papers to your library.');
        }

        return {
          content: [{ type: 'text', text: lines.join('\n') }],
          details: { results },
        };
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  });

  return tools;
}

/**
 * Monitor system — Agent tools
 *
 * 4 tools:
 *   - monitor_create:  Create a new monitor for any source type
 *   - monitor_list:    List current monitors with status
 *   - monitor_report:  Cache scan results for a specific monitor
 *   - monitor_scan:    Instant scan (arXiv) without creating a monitor
 *
 * Legacy tools (radar_configure, radar_get_config, radar_scan) are replaced
 * by this unified set.
 */

import type { Database } from 'better-sqlite3';
import type { ToolDefinition } from '../types.js';
import { MonitorService, type SourceType } from './service.js';
import { radarScan } from '../radar/scanner.js';

function ok(text: string, details?: unknown): unknown {
  return { content: [{ type: 'text', text }], details: details ?? {} };
}

function fail(message: string): unknown {
  return { content: [{ type: 'text', text: `Error: ${message}` }], details: { error: message } };
}

const VALID_SOURCE_TYPES = ['arxiv', 'github', 'rss', 'webpage', 'openalex', 'twitter', 'custom'] as const;

export function createMonitorTools(service: MonitorService, db: Database): ToolDefinition[] {
  const tools: ToolDefinition[] = [];

  // ── 1. monitor_create ────────────────────────────────────────────

  tools.push({
    name: 'monitor_create',
    description:
      'Create a new monitoring target. Supports various source types: arxiv (academic papers), ' +
      'github (repos/releases), rss (any RSS/Atom feed), ' +
      'webpage (URL change detection), openalex (open academic data), twitter (X/Twitter accounts), ' +
      'custom (free-form agent prompt). The monitor will run on the specified schedule and ' +
      'send notifications to the dashboard bell when new content is found.',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Human-readable name for the monitor (e.g. "Track Yann LeCun on arXiv")',
        },
        source_type: {
          type: 'string',
          enum: VALID_SOURCE_TYPES,
          description: 'Data source type',
        },
        target: {
          type: 'string',
          description: 'Target identifier: URL for rss/webpage, "org/repo" for github, arXiv categories for arxiv, "@username" for twitter, or empty for keyword-based sources',
        },
        filters: {
          type: 'object',
          properties: {
            keywords: { type: 'array', items: { type: 'string' }, description: 'Keywords to filter by' },
            authors: { type: 'array', items: { type: 'string' }, description: 'Author names to filter by' },
            categories: { type: 'array', items: { type: 'string' }, description: 'arXiv categories (e.g. cs.AI, q-bio.BM)' },
            language: { type: 'string', description: 'Language filter (e.g. en, zh)' },
          },
          description: 'Source-specific filter config (e.g. { keywords: ["protein folding"], authors: ["Jumper"] })',
        },
        schedule: {
          type: 'string',
          description: 'Cron expression (5 fields). Examples: "0 7 * * *" (daily 7am), "0 8 * * 1" (Monday 8am), "0 9 * * 1-5" (weekdays 9am). Default: "0 8 * * *"',
        },
        notify: {
          type: 'boolean',
          description: 'Send notification to dashboard bell on new findings (default: true)',
        },
      },
      required: ['name', 'source_type'],
    },
    async execute(_toolCallId: string, params: Record<string, unknown>): Promise<unknown> {
      try {
        const name = typeof params.name === 'string' ? params.name.trim() : '';
        if (!name) return fail('name is required and must be a non-empty string');

        const sourceType = typeof params.source_type === 'string' ? params.source_type : '';
        if (!VALID_SOURCE_TYPES.includes(sourceType as SourceType)) {
          return fail(`Invalid source_type: "${sourceType}". Valid: ${VALID_SOURCE_TYPES.join(', ')}`);
        }

        const monitor = service.create({
          name,
          source_type: sourceType as SourceType,
          target: typeof params.target === 'string' ? params.target : undefined,
          filters: typeof params.filters === 'object' && params.filters !== null && !Array.isArray(params.filters)
            ? params.filters as Record<string, unknown>
            : undefined,
          schedule: typeof params.schedule === 'string' ? params.schedule : undefined,
          notify: typeof params.notify === 'boolean' ? params.notify : undefined,
        });

        return ok(
          `Monitor created: "${monitor.name}" (${monitor.source_type})\n` +
          `ID: ${monitor.id}\n` +
          `Schedule: ${monitor.schedule}\n` +
          `Target: ${monitor.target || '(keyword-based)'}\n` +
          `The dashboard will register the cron job when the user enables it.`,
          monitor,
        );
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  });

  // ── 2. monitor_list ──────────────────────────────────────────────

  tools.push({
    name: 'monitor_list',
    description:
      'List all configured monitors with their current status. Shows enabled/disabled state, ' +
      'last check time, finding counts, and any errors.',
    parameters: {
      type: 'object',
      properties: {
        source_type: {
          type: 'string',
          enum: VALID_SOURCE_TYPES,
          description: 'Filter by source type (optional)',
        },
        enabled: {
          type: 'boolean',
          description: 'Filter by enabled state (optional)',
        },
      },
    },
    async execute(_toolCallId: string, params: Record<string, unknown>): Promise<unknown> {
      try {
        const opts: { source_type?: string; enabled?: boolean } = {};
        if (typeof params.source_type === 'string') opts.source_type = params.source_type;
        if (typeof params.enabled === 'boolean') opts.enabled = params.enabled;

        const { items, total } = service.list(opts);

        if (items.length === 0) {
          return ok('No monitors configured. Use monitor_create to set up monitoring targets.');
        }

        const lines: string[] = [`${total} monitor(s):\n`];
        for (const m of items) {
          const status = m.enabled ? '✅' : '⬚';
          const lastCheck = m.last_check_at ?? 'never';
          const error = m.last_error ? ` [ERROR: ${m.last_error}]` : '';
          lines.push(`${status} "${m.name}" (${m.source_type}) — schedule: ${m.schedule}, last: ${lastCheck}, findings: ${m.finding_count}${error}`);
        }

        return ok(lines.join('\n'), { items, total });
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  });

  // ── 3. monitor_report ────────────────────────────────────────────

  tools.push({
    name: 'monitor_report',
    description:
      'Report scan results for a specific monitor. Call this after checking a source to ' +
      'cache the results in the dashboard. The results appear in the monitor\'s expanded ' +
      'detail view in the dashboard panel.',
    parameters: {
      type: 'object',
      properties: {
        monitor_id: {
          type: 'string',
          description: 'The monitor ID to report results for',
        },
        results: {
          type: 'array',
          items: { type: 'object' },
          description: 'Array of findings (papers, posts, releases, etc.). Each item should have at least a "title" field.',
        },
        summary: {
          type: 'string',
          description: 'Brief text summary of findings (optional)',
        },
      },
      required: ['monitor_id', 'results'],
    },
    async execute(_toolCallId: string, params: Record<string, unknown>): Promise<unknown> {
      try {
        const monitorId = typeof params.monitor_id === 'string' ? params.monitor_id.trim() : '';
        if (!monitorId) return fail('monitor_id is required');

        const results = Array.isArray(params.results) ? params.results : [];
        const summary = typeof params.summary === 'string' ? params.summary : undefined;

        const monitor = service.report(monitorId, results, summary);

        return ok(
          `Results cached for "${monitor.name}": ${results.length} finding(s). ` +
          `Total findings: ${monitor.finding_count}, checks: ${monitor.check_count}.`,
          monitor,
        );
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  });

  // ── 4. monitor_scan ──────────────────────────────────────────────
  //
  // Instant scan for academic sources (arXiv).
  // Reuses the existing scanner infrastructure. Does NOT create a monitor.

  tools.push({
    name: 'monitor_scan',
    description:
      'Instant scan of academic paper sources (arXiv). Returns discovered ' +
      'papers without creating a persistent monitor. Use this for one-off searches or when ' +
      'the user asks "check for new papers". Results are NOT auto-added to library — use ' +
      'library_add_paper or library_batch_add to save interesting papers.',
    parameters: {
      type: 'object',
      properties: {
        source_type: {
          type: 'string',
          enum: ['arxiv'],
          description: 'Which source to scan (default: arxiv)',
        },
        keywords: {
          type: 'array',
          items: { type: 'string' },
          description: 'Keywords to search for',
        },
        authors: {
          type: 'array',
          items: { type: 'string' },
          description: 'Author names to search for (arXiv only)',
        },
        max_results: {
          type: 'number',
          description: 'Max results per source (default: 20, max: 50)',
        },
      },
    },
    async execute(_toolCallId: string, params: Record<string, unknown>): Promise<unknown> {
      try {
        const options: { keywords?: string[]; sources?: string[]; authors?: string[]; max_results?: number } = {};
        if (Array.isArray(params.keywords)) options.keywords = params.keywords.map(String);
        if (Array.isArray(params.authors)) options.authors = params.authors.map(String);
        if (typeof params.source_type === 'string') options.sources = [params.source_type];
        if (typeof params.max_results === 'number') options.max_results = Math.min(params.max_results, 50);

        if (!options.keywords?.length && !options.authors?.length) {
          return fail('At least one of keywords or authors is required for scanning.');
        }

        const results = await radarScan(db, options);

        const totalPapers = results.reduce((sum, r) => sum + r.papers.length, 0);
        const totalSkipped = results.reduce((sum, r) => sum + r.papers_skipped, 0);

        const lines: string[] = [];
        lines.push(`Scan complete: ${totalPapers} new papers found, ${totalSkipped} already in library.`);

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

        if (totalPapers > 0) {
          lines.push('\nUse library_add_paper or library_batch_add to save interesting papers.');
        }

        return ok(lines.join('\n'), { results });
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  });

  return tools;
}

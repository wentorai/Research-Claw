/**
 * Monitor system — Agent tools
 *
 * 5 tools:
 *   - monitor_create:      Create a new monitor for any source category
 *   - monitor_list:        List current monitors with status
 *   - monitor_report:      Report scan results with dedup fingerprints
 *   - monitor_get_context: Load monitor config + memory before execution
 *   - monitor_note:        Write adaptive notes for future runs
 */

import type { ToolDefinition } from '../types.js';
import { MonitorService } from './service.js';

function ok(text: string, details?: unknown): unknown {
  return { content: [{ type: 'text', text }], details: details ?? {} };
}

function fail(message: string): unknown {
  return { content: [{ type: 'text', text: `Error: ${message}` }], details: { error: message } };
}

export function createMonitorTools(service: MonitorService): ToolDefinition[] {
  const tools: ToolDefinition[] = [];

  // ── 1. monitor_create ────────────────────────────────────────────

  tools.push({
    name: 'monitor_create',
    description:
      'Create a new monitoring target. The source_type is a free-form category string ' +
      '(e.g. "academic", "code", "feed", "web", "social", "report", "reminder", or any custom string). ' +
      'Well-known categories get rich default agent prompts with the Read\u2192Execute\u2192Write protocol. ' +
      'The monitor will run on the specified schedule and send notifications to the dashboard bell ' +
      'when new content is found.',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Human-readable name for the monitor (e.g. "Track Yann LeCun papers")',
        },
        source_type: {
          type: 'string',
          description: 'Category of the data source (e.g. "academic", "code", "feed", "web", "social", "report", "reminder")',
        },
        target: {
          type: 'string',
          description: 'Target identifier: URL for feeds/webpages, "org/repo" for code, or empty for keyword-based sources',
        },
        filters: {
          type: 'object',
          properties: {
            keywords: { type: 'array', items: { type: 'string' }, description: 'Keywords to filter by' },
            authors: { type: 'array', items: { type: 'string' }, description: 'Author names to filter by' },
            journals: { type: 'array', items: { type: 'string' }, description: 'Journal names to filter by' },
            domain: { type: 'string', description: 'Academic domain (e.g. "cs", "bio", "physics")' },
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

        const sourceType = typeof params.source_type === 'string' ? params.source_type.trim() : '';
        if (!sourceType) return fail('source_type is required and must be a non-empty string');

        const monitor = service.create({
          name,
          source_type: sourceType,
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
          description: 'Filter by source type / category (optional)',
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
          const status = m.enabled ? '\u2705' : '\u2b1a';
          const lastCheck = m.last_check_at ?? 'never';
          const error = m.last_error ? ` [ERROR: ${m.last_error}]` : '';
          lines.push(`${status} "${m.name}" (${m.source_type}) \u2014 schedule: ${m.schedule}, last: ${lastCheck}, findings: ${m.finding_count}${error}`);
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
      'Report scan results for a specific monitor with dedup fingerprints. Call this after ' +
      'checking a source to cache the results and update the monitor\'s memory. Fingerprints ' +
      'are compared against previously seen items to compute new_count. Results appear in ' +
      'the monitor\'s expanded detail view in the dashboard panel.',
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
        fingerprints: {
          type: 'array',
          items: { type: 'string' },
          description: 'Unique identifiers for deduplication (e.g. "doi:10.1234/...", "arxiv:2603.12345", "gh:org/repo:release:v1.0"). Compared against memory.seen to count new items.',
        },
        summary: {
          type: 'string',
          description: 'Brief text summary of findings (optional)',
        },
      },
      required: ['monitor_id', 'results', 'fingerprints'],
    },
    async execute(_toolCallId: string, params: Record<string, unknown>): Promise<unknown> {
      try {
        const monitorId = typeof params.monitor_id === 'string' ? params.monitor_id.trim() : '';
        if (!monitorId) return fail('monitor_id is required');

        const results = Array.isArray(params.results) ? params.results : [];
        const fingerprints = Array.isArray(params.fingerprints) ? params.fingerprints.map(String) : [];
        const summary = typeof params.summary === 'string' ? params.summary : undefined;

        const monitor = service.report(monitorId, results, fingerprints, summary);
        const lastRun = monitor.memory.runs.length > 0 ? monitor.memory.runs[monitor.memory.runs.length - 1] : null;

        return ok(
          `Results cached for "${monitor.name}": ${results.length} finding(s), ${lastRun?.new_count ?? 0} new. ` +
          `Total findings: ${monitor.finding_count}, checks: ${monitor.check_count}. ` +
          `Seen pool: ${monitor.memory.seen.length} items.`,
          monitor,
        );
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  });

  // ── 4. monitor_get_context ───────────────────────────────────────

  tools.push({
    name: 'monitor_get_context',
    description:
      'Get a monitor\'s configuration and memory state. MUST be called at the start of every ' +
      'monitor execution to load previous state, dedup info, and adaptive notes.',
    parameters: {
      type: 'object',
      properties: {
        monitor_id: { type: 'string', description: 'The monitor ID' },
      },
      required: ['monitor_id'],
    },
    async execute(_toolCallId: string, params: Record<string, unknown>): Promise<unknown> {
      const id = typeof params.monitor_id === 'string' ? params.monitor_id.trim() : '';
      if (!id) return fail('monitor_id is required');
      try {
        const ctx = service.getContext(id);
        return ok(
          `Monitor "${ctx.config.name}" (${ctx.config.source_type})\n` +
          `Seen: ${ctx.memory.seen_count} items | Last run: ${ctx.memory.last_run?.at ?? 'never'}\n` +
          `Notes: ${ctx.memory.notes || '(none)'}\n` +
          `Agent prompt: ${ctx.agent_prompt}`,
          ctx,
        );
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  });

  // ── 5. monitor_note ──────────────────────────────────────────────

  tools.push({
    name: 'monitor_note',
    description:
      'Write or update adaptive notes for a monitor. Use this to record observations about ' +
      'source reliability, user preferences, or execution patterns for future runs.',
    parameters: {
      type: 'object',
      properties: {
        monitor_id: { type: 'string', description: 'The monitor ID' },
        note: { type: 'string', description: 'Observation or note to save (max 4096 chars). Replaces previous notes.' },
      },
      required: ['monitor_id', 'note'],
    },
    async execute(_toolCallId: string, params: Record<string, unknown>): Promise<unknown> {
      const id = typeof params.monitor_id === 'string' ? params.monitor_id.trim() : '';
      const note = typeof params.note === 'string' ? params.note : '';
      if (!id) return fail('monitor_id is required');
      if (!note) return fail('note is required');
      try {
        const monitor = service.updateNote(id, note);
        return ok(`Notes updated for "${monitor.name}".`, { monitor_id: id, notes: monitor.memory.notes });
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  });

  return tools;
}

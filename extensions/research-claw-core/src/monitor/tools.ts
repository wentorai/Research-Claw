/**
 * Monitor system — Agent tools
 *
 * 7 tools:
 *   - monitor_create:      Create a new monitor for any source category
 *   - monitor_list:        List current monitors with status
 *   - monitor_update:      Update monitor configuration, including schedule
 *   - monitor_report:      Report scan results with dedup fingerprints
 *   - monitor_get_context: Load monitor config + memory before execution
 *   - monitor_collect_candidates: Collect source candidates before agent analysis
 *   - monitor_note:        Write adaptive notes for future runs
 */

import type { ToolDefinition } from '../types.js';
import { MonitorService, type MonitorPatch } from './service.js';

function ok(text: string, details?: unknown): unknown {
  return { content: [{ type: 'text', text }], details: details ?? {} };
}

function fail(message: string): unknown {
  return { content: [{ type: 'text', text: `Error: ${message}` }], details: { error: message } };
}

export function createMonitorTools(service: MonitorService): ToolDefinition[] {
  const tools: ToolDefinition[] = [];
  const categoryExamples = service.peripheralsEnabled
    ? '"academic", "code", "feed", "web", "social", "report", "reminder", "device"'
    : '"academic", "code", "feed", "web", "social", "report", "reminder"';
  const deviceCreateGuidance = service.peripheralsEnabled
    ? 'For source_type "device" the target MUST be a peripheral device id returned by periph_list ' +
      '(the registered uuid — NOT a browser mediaDeviceId, NOT a URL); call periph_list first to get the id. '
    : '';
  const deviceTargetGuidance = service.peripheralsEnabled
    ? ', peripheral device id from periph_list for device monitors'
    : '';
  const deviceUpdateGuidance = service.peripheralsEnabled
    ? 'For source_type "device" the target MUST be a peripheral device id returned by periph_list ' +
      '(the registered uuid — NOT a browser mediaDeviceId, NOT a URL). '
    : '';

  // ── 1. monitor_create ────────────────────────────────────────────

  tools.push({
    name: 'monitor_create',
    description:
      'Create a new monitoring target. The source_type is a free-form category string ' +
      `(e.g. ${categoryExamples}, or any custom string). ` +
      'Well-known categories get rich default agent prompts with the Read\u2192Execute\u2192Write protocol. ' +
      deviceCreateGuidance +
      'The monitor is created disabled. Enable it with monitor_update(enabled=true) \u2014 while the dashboard ' +
      'is online it automatically registers the backing cron job, and the monitor then runs on the specified ' +
      'schedule and sends notifications to the dashboard bell when new content is found.',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Human-readable name for the monitor (e.g. "Track Yann LeCun papers")',
        },
        source_type: {
          type: 'string',
          description: `Category of the data source (e.g. ${categoryExamples})`,
        },
        target: {
          type: 'string',
          description: `Target identifier: URL for feeds/webpages, "org/repo" for code${deviceTargetGuidance}, or empty for keyword-based sources`,
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
          `Status: disabled. Enable it with monitor_update(enabled=true); the dashboard auto-registers the cron job while online.`,
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

  // ── 3. monitor_update ────────────────────────────────────────────

  tools.push({
    name: 'monitor_update',
    description:
      'Update an existing monitor configuration. Use this when the user asks to rename a monitor, ' +
      'change its schedule, target, filters, notification preference, or enable/disable state. ' +
      'Setting enabled=true activates the monitor: while the dashboard is online it automatically ' +
      'registers the backing Gateway cron job (no manual dashboard toggle needed). ' +
      deviceUpdateGuidance +
      'Schedule must be a 5-field cron expression.',
    parameters: {
      type: 'object',
      properties: {
        monitor_id: {
          type: 'string',
          description: 'The monitor ID to update',
        },
        name: {
          type: 'string',
          description: 'New human-readable monitor name',
        },
        source_type: {
          type: 'string',
          description: 'New source category string',
        },
        target: {
          type: 'string',
          description: 'New target identifier or URL',
        },
        filters: {
          type: 'object',
          description: 'Replacement source-specific filter config',
        },
        schedule: {
          type: 'string',
          description: 'Replacement cron expression (5 fields), e.g. "30 9 * * *"',
        },
        enabled: {
          type: 'boolean',
          description: 'Whether the monitor should be enabled',
        },
        notify: {
          type: 'boolean',
          description: 'Whether to send notifications on new findings',
        },
        agent_prompt: {
          type: 'string',
          description: 'Replacement execution prompt for this monitor',
        },
      },
      required: ['monitor_id'],
    },
    async execute(_toolCallId: string, params: Record<string, unknown>): Promise<unknown> {
      try {
        const id = typeof params.monitor_id === 'string' ? params.monitor_id.trim() : '';
        if (!id) return fail('monitor_id is required');

        const patch: MonitorPatch = {};
        if (typeof params.name === 'string') patch.name = params.name;
        if (typeof params.source_type === 'string') patch.source_type = params.source_type;
        if (typeof params.target === 'string') patch.target = params.target;
        if (typeof params.filters === 'object' && params.filters !== null && !Array.isArray(params.filters)) {
          patch.filters = params.filters as Record<string, unknown>;
        } else if (params.filters !== undefined) {
          return fail('filters must be an object');
        }
        if (typeof params.schedule === 'string') patch.schedule = params.schedule;
        if (typeof params.enabled === 'boolean') patch.enabled = params.enabled;
        if (typeof params.notify === 'boolean') patch.notify = params.notify;
        if (typeof params.agent_prompt === 'string') patch.agent_prompt = params.agent_prompt;

        if (Object.keys(patch).length === 0) {
          return fail('at least one update field is required');
        }

        const monitor = service.update(id, patch);
        return ok(
          `Monitor updated: "${monitor.name}"\n` +
          `ID: ${monitor.id}\n` +
          `Schedule: ${monitor.schedule}\n` +
          `Status: ${monitor.enabled ? 'enabled' : 'disabled'}`,
          monitor,
        );
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  });

  // ── 4. monitor_report ────────────────────────────────────────────

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
          description: 'Unique identifiers for deduplication. Prefer exact fingerprint values returned by monitor_collect_candidates for accepted candidates. Do not invent date-based or summary-based fingerprints. Compared against memory.seen to count new items.',
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

  // ── 5. monitor_get_context ───────────────────────────────────────

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

  // ── 6. monitor_collect_candidates ────────────────────────────────

  tools.push({
    name: 'monitor_collect_candidates',
    description:
      'Collect raw monitor candidates in the core collector layer before analysis. ' +
      'Use this after monitor_get_context and before monitor_report. The collector routes by source_type ' +
      '(RSS/feed, API, web, GitHub/code) and returns candidate items with stable fingerprints. ' +
      'If errors contain browser_fallback_required, use the browser tool to inspect the page and then report stable URL-based findings. ' +
      'The agent should analyze/filter these candidates, then call monitor_report with the final findings.',
    parameters: {
      type: 'object',
      properties: {
        monitor_id: { type: 'string', description: 'The monitor ID' },
        limit: { type: 'number', description: 'Maximum candidates to collect (1-100, default 25)' },
      },
      required: ['monitor_id'],
    },
    async execute(_toolCallId: string, params: Record<string, unknown>): Promise<unknown> {
      const id = typeof params.monitor_id === 'string' ? params.monitor_id.trim() : '';
      if (!id) return fail('monitor_id is required');
      const limit = typeof params.limit === 'number' ? params.limit : undefined;
      try {
        const result = await service.collectMonitorCandidates(id, { limit });
        return ok(
          `Collected ${result.candidates.length} candidate(s) for monitor "${id}" using ${result.strategy}.` +
          (result.errors.length ? ` Errors: ${result.errors.join('; ')}` : ''),
          result,
        );
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  });

  // ── 7. monitor_note ──────────────────────────────────────────────

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

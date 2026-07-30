import type { ExecutionTraceService } from '../execution-trace/service.js';
import {
  SkillRegistry,
  type SkillCandidate,
  type SkillLoadResult,
} from './registry.js';

export interface SkillToolResult {
  content: Array<{ type: 'text'; text: string }>;
  details: Record<string, any>;
}

export interface SkillTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(toolCallId: string, params: Record<string, unknown>): Promise<SkillToolResult>;
}

const DEFAULT_SEARCH_CHARS = 4_000;
const MIN_SEARCH_CHARS = 512;
const MAX_SEARCH_CHARS = 8_000;

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function fitCandidatesToBudget(candidates: SkillCandidate[], maxChars: number): SkillCandidate[] {
  const fitted: SkillCandidate[] = [];
  for (const candidate of candidates) {
    const next = [...fitted, candidate];
    if (JSON.stringify(next).length > maxChars) break;
    fitted.push(candidate);
  }
  return fitted;
}

function renderSearchText(
  query: string,
  candidates: SkillCandidate[],
  totalMatches: number,
  maxChars: number,
): string {
  const header = candidates.length === 0
    ? `No Skill candidates found for "${query}".`
    : `Skill candidates for "${query}" (${candidates.length}/${totalMatches}). Select one stable id, then call skill_load.`;
  const lines = [header];
  for (const candidate of candidates) {
    const line = JSON.stringify(candidate);
    if ([...lines, line].join('\n').length > maxChars) break;
    lines.push(line);
  }
  const rendered = lines.join('\n');
  return rendered.length <= maxChars ? rendered : rendered.slice(0, maxChars);
}

function errorResult(result: Exclude<SkillLoadResult, { ok: true }>): SkillToolResult {
  return {
    content: [{ type: 'text', text: `Skill load failed: ${result.message}` }],
    details: {
      schema: 'research-claw.skill-load.v1',
      lifecycle: 'selected',
      error: result.error,
      candidates: result.candidates ?? [],
    },
  };
}

function registryUnavailableResult(error: unknown, schema: string): SkillToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{
      type: 'text',
      text: `Skill Registry is temporarily unavailable: ${message}`,
    }],
    details: {
      schema,
      error: 'registry_unavailable',
      skills: [],
    },
  };
}

export function createSkillTools(registry: SkillRegistry): SkillTool[] {
  return [
    {
      name: 'skill_search',
      description:
        'Search the unified Skill Registry. Returns bounded candidate metadata only; '
        + 'call skill_load with one stable id to read instructions.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'English or Chinese task/methodology query.',
          },
          max_results: {
            type: 'number',
            description: 'Maximum candidate count (default 5, max 8).',
          },
          max_chars: {
            type: 'number',
            description: 'Total candidate metadata character budget (default 4000, range 512-8000).',
          },
          list_catalog: {
            type: 'boolean',
            description: 'Return compact source/category counts, never every Skill body or name.',
          },
          refresh: {
            type: 'boolean',
            description: 'Force a fresh OpenClaw/RP inventory read after a new Skill installation.',
          },
        },
        required: ['query'],
      },
      async execute(_toolCallId, params) {
        const query = String(params.query ?? '');
        const maxChars = clampInteger(
          params.max_chars,
          DEFAULT_SEARCH_CHARS,
          MIN_SEARCH_CHARS,
          MAX_SEARCH_CHARS,
        );
        const force = Boolean(params.refresh);
        if (Boolean(params.list_catalog)) {
          let summary: Awaited<ReturnType<SkillRegistry['catalogSummary']>>;
          try {
            summary = await registry.catalogSummary({ force });
          } catch (error) {
            return registryUnavailableResult(error, 'research-claw.skill-search.v2');
          }
          const raw = JSON.stringify(summary);
          return {
            content: [{
              type: 'text',
              text: raw.length <= maxChars ? raw : raw.slice(0, maxChars),
            }],
            details: {
              schema: 'research-claw.skill-search.v2',
              lifecycle: 'candidate',
              catalog: true,
              summary,
              skills: [],
              compatibility: { contentLoading: 'use skill_load with a stable id' },
            },
          };
        }
        if (!query.trim()) {
          return {
            content: [{ type: 'text', text: 'Skill search failed: query cannot be empty.' }],
            details: {
              schema: 'research-claw.skill-search.v2',
              lifecycle: 'candidate',
              error: 'empty_query',
              skills: [],
              compatibility: { contentLoading: 'use skill_load with a stable id' },
            },
          };
        }

        let search: Awaited<ReturnType<SkillRegistry['search']>>;
        try {
          search = await registry.search(query, {
            maxResults: clampInteger(params.max_results, 5, 1, 8),
            force,
          });
        } catch (error) {
          return registryUnavailableResult(error, 'research-claw.skill-search.v2');
        }
        const candidates = fitCandidatesToBudget(search.candidates, maxChars);
        return {
          content: [{
            type: 'text',
            text: renderSearchText(query, candidates, search.totalMatches, maxChars),
          }],
          details: {
            schema: 'research-claw.skill-search.v2',
            lifecycle: 'candidate',
            query,
            matches: candidates.length,
            totalMatches: search.totalMatches,
            truncated: candidates.length < search.candidates.length,
            skills: candidates,
            compatibility: { contentLoading: 'use skill_load with a stable id' },
          },
        };
      },
    },
    {
      name: 'skill_load',
      description:
        'Load exactly one Skill selected by stable id (preferred) or an unambiguous exact name. '
        + 'Never accepts fuzzy matches and never loads multiple Skills.',
      parameters: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: 'Stable id returned by skill_search, for example rp:systematic-review-guide.',
          },
          refresh: {
            type: 'boolean',
            description: 'Force current OpenClaw status resolution before loading.',
          },
        },
        required: ['id'],
      },
      async execute(_toolCallId, params) {
        let result: Awaited<ReturnType<SkillRegistry['load']>>;
        try {
          result = await registry.load(String(params.id ?? ''), {
            force: Boolean(params.refresh),
          });
        } catch (error) {
          return registryUnavailableResult(error, 'research-claw.skill-load.v1');
        }
        if (!result.ok) return errorResult(result);
        return {
          content: [{
            type: 'text',
            // The content block is exactly the verified SKILL.md body. Its UTF-8
            // byte size is capped before return; no header can push it over.
            text: result.content,
          }],
          details: {
            schema: 'research-claw.skill-load.v1',
            lifecycle: 'loaded',
            selected: result.selected,
            skill: result.skill,
          },
        };
      },
    },
  ];
}

export function recordLoadedSkillFromToolResult(
  service: ExecutionTraceService,
  params: {
    toolName: string;
    result?: unknown;
    sessionKey: string;
    runId: string;
    toolCallId?: string;
    timestamp?: number;
  },
): boolean {
  return recordSkillLifecycleFromToolResult(service, params).loaded > 0;
}

type TraceableSkill = {
  id: string;
  name: string;
  source: string;
  lifecycle: 'candidate' | 'selected' | 'loaded';
};

function traceableSkill(value: unknown, lifecycle: TraceableSkill['lifecycle']): TraceableSkill | null {
  if (!value || typeof value !== 'object') return null;
  const skill = value as Record<string, unknown>;
  if (
    typeof skill.id !== 'string'
    || typeof skill.name !== 'string'
    || typeof skill.source !== 'string'
    || skill.lifecycle !== lifecycle
  ) {
    return null;
  }
  return {
    id: skill.id,
    name: skill.name,
    source: skill.source,
    lifecycle,
  };
}

export function recordSkillLifecycleFromToolResult(
  service: ExecutionTraceService,
  params: {
    toolName: string;
    result?: unknown;
    sessionKey: string;
    runId: string;
    toolCallId?: string;
    timestamp?: number;
  },
): { candidate: number; selected: number; loaded: number } {
  const counts = { candidate: 0, selected: 0, loaded: 0 };
  const result = params.result as {
    details?: {
      lifecycle?: unknown;
      skills?: unknown;
      selected?: unknown;
      skill?: unknown;
      candidates?: unknown;
    };
  } | undefined;
  const details = result?.details;

  if (params.toolName === 'skill_search' && details?.lifecycle === 'candidate') {
    const candidates = Array.isArray(details.skills)
      ? details.skills
        .map((skill) => traceableSkill(skill, 'candidate'))
        .filter((skill): skill is TraceableSkill => skill !== null)
      : [];
    counts.candidate = service.recordSkillCandidates(candidates.map((skill) => ({
      sessionKey: params.sessionKey,
      runId: params.runId,
      skillKey: skill.id,
      skillName: skill.name,
      skillSource: skill.source,
      lifecycle: 'candidate',
      toolCallId: params.toolCallId,
      timestamp: params.timestamp,
    })));
    return counts;
  }

  if (params.toolName !== 'skill_load') return counts;

  const selected = traceableSkill(details?.selected, 'selected');
  const loaded = traceableSkill(details?.skill, 'loaded');
  if (
    details?.lifecycle === 'loaded'
    && selected
    && loaded
    && selected.id === loaded.id
    && selected.name === loaded.name
    && selected.source === loaded.source
  ) {
    const recorded = service.recordLoadedSkill({
      sessionKey: params.sessionKey,
      runId: params.runId,
      skillKey: loaded.id,
      skillName: loaded.name,
      skillSource: loaded.source,
      activation: 'command',
      toolCallId: params.toolCallId,
      timestamp: params.timestamp,
    });
    counts.selected = recorded.selected ? 1 : 0;
    counts.loaded = recorded.loaded ? 1 : 0;
    return counts;
  }

  if (details?.lifecycle === 'selected' && Array.isArray(details.candidates)) {
    for (const value of details.candidates) {
      const candidate = traceableSkill(value, 'selected');
      if (!candidate) continue;
      if (service.recordSkillLifecycle({
        sessionKey: params.sessionKey,
        runId: params.runId,
        skillKey: candidate.id,
        skillName: candidate.name,
        skillSource: candidate.source,
        lifecycle: 'selected',
        toolCallId: params.toolCallId,
        timestamp: params.timestamp,
      })) {
        counts.selected += 1;
      }
    }
  }
  return counts;
}

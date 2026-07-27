/**
 * Runtime self-check reconciliation.
 *
 * Manifest declarations are only expectations. OpenClaw's persisted
 * systemPromptReport is the independent truth for tools and skills actually
 * mounted into a completed agent run. The skills CLI supplies the independent
 * full set of eligible, model-visible skills before prompt-budget truncation.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ProbeInput } from './activation-probe.js';

export interface SkillsCliEntry {
  name: string;
  eligible: boolean;
  blockedByAgentFilter: boolean;
  modelVisible: boolean;
}

export interface SkillsCliReport {
  workspaceDir: string;
  managedSkillsDir: string;
  skills: SkillsCliEntry[];
}

export interface SystemPromptReportLike {
  source: 'run' | 'estimate';
  generatedAt: number;
  sessionKey?: string;
  skills: {
    promptChars: number;
    entries: Array<{ name: string; blockChars: number }>;
  };
  tools: {
    listChars: number;
    schemaChars: number;
    entries: Array<{ name: string }>;
  };
}

export interface RuntimeProbeFinding {
  severity: 'warn';
  kind: 'skills-truncated' | 'tools-not-mounted';
  title: string;
  message: string;
  missingNames: string[];
}

export interface RuntimeProbeAgentEntryLike {
  id?: unknown;
  tools?: { codeMode?: unknown };
  /**
   * Where a per-agent `localModelLean` lives. Declared, and deliberately not
   * read — see the note on runtimeMountAuditSkipReason. Naming it here keeps the
   * next reader from concluding the path was simply overlooked.
   */
  experimental?: unknown;
}

/**
 * Only the config surfaces that can replace the model-facing tool list.
 *
 * OpenClaw accepts `true`, `false`, or an options object for both `toolSearch`
 * and `codeMode`, and the three forms do NOT resolve alike — so they stay
 * `unknown` here and are normalized by the resolvers below rather than by a
 * shape assumption.
 */
export interface RuntimeProbeConfigLike {
  tools?: { toolSearch?: unknown; codeMode?: unknown };
  agents?: {
    /** `codeMode` alone is overridable per agent (`agents.list[].tools.codeMode`). */
    list?: ReadonlyArray<RuntimeProbeAgentEntryLike | null | undefined>;
    /** Holds the fleet-wide `experimental.localModelLean`; declared, not read. */
    defaults?: unknown;
  };
}

/** The canonical unrestricted foreground session for an agent. */
export function foregroundSessionKey(agentId: string): string {
  return `agent:${agentId}:main`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** OpenClaw's shared `true | false | options` normalization for both projections. */
function normalizeProjectionConfig(value: unknown): Record<string, unknown> | undefined {
  if (value === true) return { enabled: true };
  if (value === false) return { enabled: false };
  return isRecord(value) ? value : undefined;
}

const DEFAULT_AGENT_ID = 'main';
const VALID_AGENT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const INVALID_AGENT_ID_CHARS_RE = /[^a-z0-9_-]+/g;

/**
 * Mirrors OpenClaw's `normalizeAgentId`, which is how `resolveAgentConfig` finds
 * an `agents.list` entry. Matching it matters in one direction: missing an entry
 * means missing its code-mode override, which means not skipping, which means
 * reporting every product tool as unmounted — the false alarm this gate exists
 * to prevent.
 */
function normalizeAgentId(value: unknown): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) return DEFAULT_AGENT_ID;
  const lowered = trimmed.toLowerCase();
  if (VALID_AGENT_ID_RE.test(trimmed)) return lowered;
  return (
    lowered
      .replace(INVALID_AGENT_ID_CHARS_RE, '-')
      .replace(/^-+/, '')
      .replace(/-+$/, '')
      .slice(0, 64) || DEFAULT_AGENT_ID
  );
}

/**
 * Tool search treats *any* option other than `enabled` as opting in, so
 * `{ mode: "tools" }` turns it on without ever naming `enabled`. An explicit
 * `enabled` still wins in both directions. There is no per-agent form —
 * OpenClaw resolves this one from the global config alone.
 */
function isToolSearchEnabled(config: RuntimeProbeConfigLike | undefined): boolean {
  const raw = normalizeProjectionConfig(config?.tools?.toolSearch) ?? {};
  const configuredBeyondEnabled = Object.keys(raw).some((key) => key !== 'enabled');
  return typeof raw.enabled === 'boolean' ? raw.enabled : configuredBeyondEnabled;
}

/**
 * Code mode has no implicit opt-in — an options object without `enabled: true`
 * leaves it off, so `{ enabled: false }` and `{ timeoutMs: 5000 }` are both
 * disabled. Unlike tool search it merges a per-agent override on top of the
 * global object, letting one agent turn it on (or off) for itself alone.
 */
function isCodeModeEnabled(
  config: RuntimeProbeConfigLike | undefined,
  agentId: string,
): boolean {
  const globalRaw = normalizeProjectionConfig(config?.tools?.codeMode) ?? {};
  const wanted = normalizeAgentId(agentId);
  const entry = (config?.agents?.list ?? []).find(
    (candidate) => candidate && normalizeAgentId(candidate.id) === wanted,
  );
  const agentRaw = normalizeProjectionConfig(entry?.tools?.codeMode);
  const raw = agentRaw ? { ...globalRaw, ...agentRaw } : globalRaw;
  return raw.enabled === true;
}

/**
 * Decide whether a completed run may be compared against manifest declarations.
 *
 * OpenClaw recomputes the model-facing tool set per run, so a report's tool
 * list is NOT the process-wide mount set:
 *  - a cron job may carry its own `toolsAllow` allowlist (cron/types.ts
 *    CronAgentTurnPayloadFields), and isolated/project runs answer to their own
 *    tool policy;
 *  - tool search and code mode replace the tool list wholesale before it is
 *    recorded (attempt.ts buildSystemPromptReport receives the projected
 *    `effectiveTools`).
 *
 * Reconciling against any of those reports flags every product tool as missing.
 * Only the canonical foreground session under no projection is admissible.
 *
 * Lean local-model mode is deliberately NOT a skip reason. It is a projection,
 * but a narrow one: it drops exactly `browser`, `cron` and `message`, all
 * OpenClaw built-ins that no product manifest declares. Skipping on it would
 * silence the entire audit for every run of a lean agent, buying nothing but
 * protection from a false positive that cannot occur. The manifest guard in
 * runtime-probe.test.ts fails if a product plugin ever claims one of the three.
 */
export function runtimeMountAuditSkipReason(input: {
  sessionKey: string;
  agentId: string;
  config?: RuntimeProbeConfigLike;
}): string | null {
  if (input.sessionKey !== foregroundSessionKey(input.agentId)) {
    return `session ${input.sessionKey} is not the canonical foreground session (its tool policy may legitimately differ)`;
  }
  // Code mode is reported first because it wins when both are configured:
  // OpenClaw gates the tool-search surface on code mode being inactive.
  if (isCodeModeEnabled(input.config, input.agentId)) {
    return 'tools.codeMode is enabled (tools are projected into a code catalog)';
  }
  if (isToolSearchEnabled(input.config)) {
    return 'tools.toolSearch is enabled (tools are projected into a search catalog)';
  }
  return null;
}

function sortedUnique(names: Iterable<string>): string[] {
  return [...new Set([...names].filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function manifestToolNames(plugins: ProbeInput[]): string[] {
  const names: string[] = [];
  for (const plugin of plugins) {
    const contracts = plugin.manifest?.contracts as { tools?: unknown } | undefined;
    if (!Array.isArray(contracts?.tools)) continue;
    for (const name of contracts.tools) {
      if (typeof name === 'string' && name.trim()) names.push(name.trim());
    }
  }
  return sortedUnique(names);
}

export function selectModelVisibleEligibleSkills(report: SkillsCliReport): string[] {
  return sortedUnique(
    report.skills
      .filter(
        (skill) =>
          skill.eligible &&
          !skill.blockedByAgentFilter &&
          skill.modelVisible,
      )
      .map((skill) => skill.name),
  );
}

export function auditRuntimeMounts(input: {
  plugins: ProbeInput[];
  systemPromptReport: SystemPromptReportLike;
  indexedSkillNames: string[];
  /**
   * Declared tools this process deliberately did not register.
   *
   * OpenClaw rejects a tool whose name is absent from `contracts.tools`
   * (plugins/bundled-capability-runtime.ts), so a conditionally registered tool
   * must still be declared unconditionally. Without this exclusion the audit
   * would report the plugin's own deliberate decision as a mount failure.
   */
  intentionallyUnregisteredTools?: Iterable<string>;
}): RuntimeProbeFinding[] {
  if (input.systemPromptReport.source !== 'run') return [];

  const findings: RuntimeProbeFinding[] = [];
  const actualTools = new Set(input.systemPromptReport.tools.entries.map((entry) => entry.name));
  const excluded = new Set(input.intentionallyUnregisteredTools ?? []);
  const missingTools = manifestToolNames(input.plugins).filter(
    (name) => !actualTools.has(name) && !excluded.has(name),
  );
  if (missingTools.length > 0) {
    findings.push({
      severity: 'warn',
      kind: 'tools-not-mounted',
      title: '插件工具未实际挂载',
      message:
        `运行时 systemPromptReport 显示 ${missingTools.length} 个 manifest 声明工具未实际挂载：` +
        `${missingTools.join(', ')}。请检查插件激活、工具注册异常与工具策略。`,
      missingNames: missingTools,
    });
  }

  const actualSkills = new Set(input.systemPromptReport.skills.entries.map((entry) => entry.name));
  const missingSkills = sortedUnique(input.indexedSkillNames).filter(
    (name) => !actualSkills.has(name),
  );
  if (missingSkills.length > 0) {
    findings.push({
      severity: 'warn',
      kind: 'skills-truncated',
      title: '技能预算发生截断',
      message:
        `OpenClaw 索引到 ${sortedUnique(input.indexedSkillNames).length} 个可注入技能，` +
        `但运行时仅注入 ${actualSkills.size} 个；被截断 ${missingSkills.length} 个：` +
        `${missingSkills.join(', ')}。请调整 skills prompt budget 或精简技能集。`,
      missingNames: missingSkills,
    });
  }

  return findings;
}

function expandHome(filePath: string): string {
  if (filePath === '~') return os.homedir();
  if (filePath.startsWith('~/')) return path.join(os.homedir(), filePath.slice(2));
  return filePath;
}

export function resolveSessionStorePath(input: {
  stateDir: string;
  agentId: string;
  configuredStore?: string;
}): string {
  const configured = input.configuredStore?.trim();
  if (!configured) {
    return path.join(input.stateDir, 'agents', input.agentId, 'sessions', 'sessions.json');
  }
  return path.resolve(expandHome(configured.replaceAll('{agentId}', input.agentId)));
}

function isSystemPromptReport(value: unknown): value is SystemPromptReportLike {
  if (value === null || typeof value !== 'object') return false;
  const report = value as Partial<SystemPromptReportLike>;
  return (
    (report.source === 'run' || report.source === 'estimate') &&
    typeof report.generatedAt === 'number' &&
    report.skills !== null &&
    typeof report.skills === 'object' &&
    Array.isArray(report.skills.entries) &&
    report.tools !== null &&
    typeof report.tools === 'object' &&
    Array.isArray(report.tools.entries)
  );
}

export function readSessionPromptReport(input: {
  stateDir: string;
  agentId: string;
  sessionKey?: string;
  configuredStore?: string;
}): SystemPromptReportLike | null {
  const storePath = resolveSessionStorePath(input);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(storePath, 'utf8'));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const entries = parsed as Record<string, { systemPromptReport?: unknown } | undefined>;
  // A requested session must resolve to its OWN report. Falling back to the
  // newest report across all sessions would let a concurrent isolated run —
  // which answers to a different tool policy — be audited as if it were this
  // session, during the window before this run's report is persisted.
  if (input.sessionKey) {
    const requested = entries[input.sessionKey]?.systemPromptReport;
    return isSystemPromptReport(requested) ? requested : null;
  }
  const reports = Object.values(entries)
    .map((entry) => entry?.systemPromptReport)
    .filter(isSystemPromptReport)
    .filter((report) => report.source === 'run')
    .sort((a, b) => b.generatedAt - a.generatedAt);
  return reports[0] ?? null;
}

function parseSkillsCliReport(raw: string): SkillsCliReport {
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== 'object') throw new Error('skills CLI returned non-object JSON');
  const candidate = parsed as Partial<SkillsCliReport>;
  if (!Array.isArray(candidate.skills)) throw new Error('skills CLI JSON has no skills array');
  const skills: SkillsCliEntry[] = candidate.skills.map((entry, index) => {
    if (entry === null || typeof entry !== 'object') {
      throw new Error(`skills CLI entry ${index} is not an object`);
    }
    const skill = entry as Partial<SkillsCliEntry>;
    if (
      typeof skill.name !== 'string' ||
      typeof skill.eligible !== 'boolean' ||
      typeof skill.blockedByAgentFilter !== 'boolean' ||
      typeof skill.modelVisible !== 'boolean'
    ) {
      throw new Error(`skills CLI entry ${index} has an invalid shape`);
    }
    return {
      name: skill.name,
      eligible: skill.eligible,
      blockedByAgentFilter: skill.blockedByAgentFilter,
      modelVisible: skill.modelVisible,
    };
  });
  return {
    workspaceDir: typeof candidate.workspaceDir === 'string' ? candidate.workspaceDir : '',
    managedSkillsDir:
      typeof candidate.managedSkillsDir === 'string' ? candidate.managedSkillsDir : '',
    skills,
  };
}

export async function readSkillsCliReport(input: {
  entryPath: string;
  cwd: string;
  agentId: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): Promise<SkillsCliReport> {
  return await new Promise<SkillsCliReport>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [input.entryPath, 'skills', 'list', '--agent', input.agentId, '--json'],
      {
        cwd: input.cwd,
        env: { ...input.env, NO_COLOR: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    const maxOutputChars = 8 * 1024 * 1024;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`skills CLI timed out after ${input.timeoutMs ?? 15_000}ms`));
    }, input.timeoutMs ?? 15_000);
    timer.unref?.();

    child.stdout.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString();
      if (stdout.length > maxOutputChars) child.kill('SIGKILL');
    });
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
      if (stderr.length > maxOutputChars) child.kill('SIGKILL');
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(
          new Error(
            `skills CLI failed (${signal ?? code ?? 'unknown'}): ${stderr.trim().slice(-1000)}`,
          ),
        );
        return;
      }
      try {
        resolve(parseSkillsCliReport(stdout));
      } catch (error) {
        reject(error);
      }
    });
  });
}

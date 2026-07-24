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
}): RuntimeProbeFinding[] {
  if (input.systemPromptReport.source !== 'run') return [];

  const findings: RuntimeProbeFinding[] = [];
  const actualTools = new Set(input.systemPromptReport.tools.entries.map((entry) => entry.name));
  const missingTools = manifestToolNames(input.plugins).filter((name) => !actualTools.has(name));
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
  if (input.sessionKey) {
    const requested = entries[input.sessionKey]?.systemPromptReport;
    if (isSystemPromptReport(requested)) return requested;
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

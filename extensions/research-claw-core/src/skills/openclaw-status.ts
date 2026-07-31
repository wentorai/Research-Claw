/**
 * Adapter for OpenClaw 2026.6.1's public Skill status contract.
 *
 * `buildWorkspaceSkillStatus` is intentionally internal to OpenClaw and is not
 * exported by the plugin SDK.  `openclaw skills list/info --json` is the public
 * CLI facade over that same status builder, so use it instead of importing a
 * hashed private dist chunk or reimplementing OpenClaw eligibility/precedence.
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { getSkillsSnapshotVersion } from 'openclaw/plugin-sdk/skills-runtime';
import type {
  OpenClawSkillInfo,
  OpenClawSkillStatus,
  OpenClawSkillStatusProvider,
  OpenClawSkillStatusReport,
} from './registry.js';

export interface OpenClawJsonRunner {
  run(args: string[]): Promise<unknown>;
}

interface LaunchSpec {
  command: string;
  prefixArgs: string[];
}

const localRequire = createRequire(import.meta.url);

function launchSpec(): LaunchSpec {
  const explicit = process.env.OPENCLAW_CLI_PATH?.trim();
  if (explicit) {
    if (/\.(?:c?js|mjs|ts)$/i.test(explicit)) {
      return { command: process.execPath, prefixArgs: [explicit] };
    }
    return { command: explicit, prefixArgs: [] };
  }
  const currentEntry = process.argv[1];
  if (
    currentEntry
    && fs.existsSync(currentEntry)
    && /openclaw(?:\.m?js)?$/i.test(path.basename(currentEntry))
  ) {
    return { command: process.execPath, prefixArgs: [currentEntry] };
  }
  try {
    const packageEntry = localRequire.resolve('openclaw');
    const packageCli = path.resolve(path.dirname(packageEntry), '..', 'openclaw.mjs');
    if (fs.existsSync(packageCli)) {
      return { command: process.execPath, prefixArgs: [packageCli] };
    }
  } catch {
    // Fall through to PATH lookup for globally installed OpenClaw.
  }
  return { command: 'openclaw', prefixArgs: [] };
}

function parseJsonOutput(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) throw new Error('OpenClaw CLI returned empty stdout');
  try {
    return JSON.parse(trimmed);
  } catch {
    for (let index = trimmed.indexOf('{'); index >= 0; index = trimmed.indexOf('{', index + 1)) {
      try {
        return JSON.parse(trimmed.slice(index));
      } catch {
        // A launcher banner may precede the JSON object; try the next `{`.
      }
    }
    throw new Error('OpenClaw CLI stdout did not contain a valid JSON object');
  }
}

export class SpawnOpenClawJsonRunner implements OpenClawJsonRunner {
  constructor(private readonly options?: {
    timeoutMs?: number;
    maxOutputChars?: number;
    cwd?: string;
  }) {}

  async run(args: string[]): Promise<unknown> {
    const launch = launchSpec();
    const timeoutMs = Math.max(1_000, this.options?.timeoutMs ?? 20_000);
    const maxOutputChars = Math.max(10_000, this.options?.maxOutputChars ?? 5_000_000);
    return await new Promise((resolve, reject) => {
      const child = spawn(launch.command, [...launch.prefixArgs, ...args], {
        cwd: this.options?.cwd ?? process.cwd(),
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      let overflow = false;
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error(`OpenClaw CLI timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        if (stdout.length + chunk.length > maxOutputChars) {
          overflow = true;
          child.kill('SIGTERM');
          return;
        }
        stdout += chunk;
      });
      child.stderr.on('data', (chunk: string) => {
        if (stderr.length < 100_000) stderr += chunk;
      });
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (overflow) {
          reject(new Error(`OpenClaw CLI output exceeded ${maxOutputChars} characters`));
          return;
        }
        if (code !== 0) {
          const detail = stderr.trim().slice(-2_000);
          reject(new Error(`OpenClaw CLI exited with code ${code}${detail ? `: ${detail}` : ''}`));
          return;
        }
        try {
          resolve(parseJsonOutput(stdout));
        } catch (error) {
          reject(error);
        }
      });
    });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`OpenClaw Skill status is missing string field "${key}"`);
  }
  return value;
}

function statusFromUnknown(value: unknown): OpenClawSkillStatus {
  if (!isRecord(value)) throw new Error('OpenClaw Skill status entry must be an object');
  return {
    name: requiredString(value, 'name'),
    description: typeof value.description === 'string' ? value.description : '',
    source: requiredString(value, 'source'),
    bundled: typeof value.bundled === 'boolean' ? value.bundled : undefined,
    eligible: value.eligible === true,
    disabled: value.disabled === true,
    blockedByAllowlist: value.blockedByAllowlist === true,
    blockedByAgentFilter: value.blockedByAgentFilter === true,
    modelVisible: value.modelVisible === true,
    userInvocable: value.userInvocable === true,
    commandVisible: value.commandVisible === true,
    primaryEnv: typeof value.primaryEnv === 'string' ? value.primaryEnv : undefined,
    homepage: typeof value.homepage === 'string' ? value.homepage : undefined,
  };
}

function reportFromUnknown(value: unknown): OpenClawSkillStatusReport {
  if (!isRecord(value)) throw new Error('OpenClaw Skill status report must be an object');
  if (!Array.isArray(value.skills)) throw new Error('OpenClaw Skill status report is missing skills[]');
  return {
    workspaceDir: requiredString(value, 'workspaceDir'),
    managedSkillsDir: requiredString(value, 'managedSkillsDir'),
    skills: value.skills.map(statusFromUnknown),
  };
}

function infoFromUnknown(value: unknown): OpenClawSkillInfo | null {
  if (!isRecord(value)) throw new Error('OpenClaw Skill info must be an object');
  if (value.error === 'not found') return null;
  const status = statusFromUnknown(value);
  return {
    ...status,
    filePath: requiredString(value, 'filePath'),
    baseDir: requiredString(value, 'baseDir'),
    skillKey: requiredString(value, 'skillKey'),
    always: value.always === true,
  };
}

export class OpenClawCliStatusProvider implements OpenClawSkillStatusProvider {
  private cachedVersion: number | undefined;
  private cachedReport: OpenClawSkillStatusReport | null = null;
  private readonly infoCache = new Map<string, OpenClawSkillInfo | null>();

  constructor(private readonly options?: {
    runner?: OpenClawJsonRunner;
    agentId?: string;
    snapshotVersion?: () => number;
  }) {}

  async list(options?: { force?: boolean }): Promise<OpenClawSkillStatusReport> {
    const version = (this.options?.snapshotVersion ?? getSkillsSnapshotVersion)();
    if (!options?.force && this.cachedReport && this.cachedVersion === version) {
      return this.cachedReport;
    }
    const args = ['skills', 'list', '--json'];
    if (this.options?.agentId) args.push('--agent', this.options.agentId);
    const runner = this.options?.runner ?? new SpawnOpenClawJsonRunner();
    const report = reportFromUnknown(await runner.run(args));
    this.cachedVersion = version;
    this.cachedReport = report;
    this.infoCache.clear();
    return report;
  }

  async info(name: string, options?: { force?: boolean }): Promise<OpenClawSkillInfo | null> {
    const key = name.trim().toLocaleLowerCase('en-US');
    if (!key) return null;
    if (!options?.force && this.infoCache.has(key)) return this.infoCache.get(key) ?? null;
    const args = ['skills', 'info', name, '--json'];
    if (this.options?.agentId) args.push('--agent', this.options.agentId);
    const runner = this.options?.runner ?? new SpawnOpenClawJsonRunner();
    const info = infoFromUnknown(await runner.run(args));
    this.infoCache.set(key, info);
    return info;
  }
}

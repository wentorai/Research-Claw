/**
 * Slash command definitions, parsing, and client-side execution for the dashboard.
 *
 * Ported from OpenClaw's native UI:
 *   - openclaw/ui/src/ui/chat/slash-commands.ts (definitions + parsing)
 *   - openclaw/ui/src/ui/chat/slash-command-executor.ts (execution)
 *
 * Key difference: OC's native UI imports internal modules (session-key, model-catalog,
 * thinking levels). We use simplified implementations that rely solely on gateway RPCs.
 */

import type { GatewayClient } from '../gateway/client';
import i18n from '../i18n';

// ── Types ──

export type SlashCommandCategory = 'session' | 'model' | 'tools';

export interface SlashCommandDef {
  name: string;
  description: string;
  descriptionZh: string;
  args?: string;
  category: SlashCommandCategory;
  /** When true, the command is executed client-side via RPC instead of sent to the agent. */
  executeLocal: boolean;
  /** Fixed argument choices for display. */
  argOptions?: string[];
}

export interface ParsedSlashCommand {
  command: SlashCommandDef;
  args: string;
}

export interface SlashCommandResult {
  /** Markdown-formatted result to display in chat. */
  content: string;
  /** Side-effect action the caller should perform after displaying the result. */
  action?: 'refresh' | 'new-session' | 'stop' | 'clear' | 'clear-local-fallback';
  /** Present after a successful `sessions.reset` when the gateway returns a canonical key. */
  nextSessionKey?: string;
}

// ── Command Definitions ──

export const SLASH_COMMANDS: SlashCommandDef[] = [
  // Session
  { name: 'compact', description: 'Compact session context', descriptionZh: '压缩会话上下文', category: 'session', executeLocal: true },
  { name: 'new', description: 'Start a new session', descriptionZh: '开始新会话', category: 'session', executeLocal: true },
  { name: 'stop', description: 'Stop current run', descriptionZh: '停止当前运行', category: 'session', executeLocal: true },
  { name: 'clear', description: 'Clear chat history', descriptionZh: '清空聊天记录', category: 'session', executeLocal: true },

  // Model
  { name: 'model', description: 'Show or set model', descriptionZh: '查看或设置模型', args: '<name>', category: 'model', executeLocal: true },
  { name: 'think', description: 'Set thinking level', descriptionZh: '设置思考级别', args: '<level>', category: 'model', executeLocal: true, argOptions: ['off', 'low', 'medium', 'high'] },
  { name: 'fast', description: 'Toggle fast mode', descriptionZh: '切换快速模式', args: '<on|off>', category: 'model', executeLocal: true, argOptions: ['on', 'off'] },
  { name: 'verbose', description: 'Toggle verbose mode', descriptionZh: '切换详细模式', args: '<on|off|full>', category: 'model', executeLocal: true, argOptions: ['on', 'off', 'full'] },

  // Tools
  { name: 'help', description: 'Show available commands', descriptionZh: '显示可用命令', category: 'tools', executeLocal: true },
  { name: 'usage', description: 'Show token usage', descriptionZh: '查看 Token 用量', category: 'tools', executeLocal: true },
];

/** Get the localized description for a command based on current i18n language. */
export function getCommandDescription(cmd: SlashCommandDef): string {
  return i18n.language?.startsWith('zh') ? cmd.descriptionZh : cmd.description;
}

/**
 * Get filtered slash command completions matching a partial input.
 * Source: openclaw/ui/src/ui/chat/slash-commands.ts:171-194
 */
export function getSlashCommandCompletions(filter: string): SlashCommandDef[] {
  const lower = filter.toLowerCase();
  const commands = lower
    ? SLASH_COMMANDS.filter(
        (cmd) => cmd.name.startsWith(lower) || cmd.description.toLowerCase().includes(lower),
      )
    : SLASH_COMMANDS;

  const categoryOrder: SlashCommandCategory[] = ['session', 'model', 'tools'];
  return [...commands].sort((a: SlashCommandDef, b: SlashCommandDef) => {
    const ai = categoryOrder.indexOf(a.category);
    const bi = categoryOrder.indexOf(b.category);
    if (ai !== bi) return ai - bi;
    if (lower) {
      const aExact = a.name.startsWith(lower) ? 0 : 1;
      const bExact = b.name.startsWith(lower) ? 0 : 1;
      if (aExact !== bExact) return aExact - bExact;
    }
    return 0;
  });
}

// ── Parsing ──

/**
 * Parse a message as a slash command. Returns null if it doesn't match.
 * Supports `/command`, `/command args...`, and `/command: args...`.
 * Source: openclaw/ui/src/ui/chat/slash-commands.ts:205-230
 */
export function parseSlashCommand(text: string): ParsedSlashCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return null;

  const body = trimmed.slice(1);
  const firstSeparator = body.search(/[\s:]/u);
  const name = firstSeparator === -1 ? body : body.slice(0, firstSeparator);
  let remainder = firstSeparator === -1 ? '' : body.slice(firstSeparator).trimStart();
  if (remainder.startsWith(':')) {
    remainder = remainder.slice(1).trimStart();
  }
  const args = remainder.trim();

  if (!name) return null;

  const command = SLASH_COMMANDS.find((cmd) => cmd.name === name.toLowerCase());
  if (!command) return null;

  return { command, args };
}

// ── Execution ──

/** Session row from sessions.list RPC response. */
interface SessionRow {
  key?: string;
  model?: string;
  modelProvider?: string;
  thinkingLevel?: string;
  fastMode?: boolean;
  verboseLevel?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  contextTokens?: number;
}

interface SessionsListResult {
  sessions?: SessionRow[];
  defaults?: { model?: string };
}

/**
 * Execute a slash command client-side via gateway RPCs.
 * Source: openclaw/ui/src/ui/chat/slash-command-executor.ts
 */
export async function executeSlashCommand(
  client: GatewayClient,
  sessionKey: string,
  commandName: string,
  args: string,
): Promise<SlashCommandResult> {
  switch (commandName) {
    case 'help':
      return executeHelp();
    case 'compact':
      return await executeCompact(client, sessionKey);
    case 'new':
      return { content: i18n.t('slashCmd.newSession'), action: 'new-session' };
    case 'stop':
      return { content: i18n.t('slashCmd.stopping'), action: 'stop' };
    case 'clear':
      return await executeClear(client, sessionKey);
    case 'model':
      return await executeModel(client, sessionKey, args);
    case 'think':
      return await executeThink(client, sessionKey, args);
    case 'fast':
      return await executeFast(client, sessionKey, args);
    case 'verbose':
      return await executeVerbose(client, sessionKey, args);
    case 'usage':
      return await executeUsage(client, sessionKey);
    default:
      return { content: `Unknown command: \`/${commandName}\`` };
  }
}

// ── Command Implementations ──

const CATEGORY_LABELS: Record<SlashCommandCategory, { en: string; zh: string }> = {
  session: { en: 'Session', zh: '会话' },
  model: { en: 'Model', zh: '模型' },
  tools: { en: 'Tools', zh: '工具' },
};

function executeHelp(): SlashCommandResult {
  const isZh = i18n.language?.startsWith('zh');
  const lines = [`**${isZh ? '可用命令' : 'Available Commands'}**\n`];
  let currentCategory = '';

  for (const cmd of SLASH_COMMANDS) {
    if (cmd.category !== currentCategory) {
      currentCategory = cmd.category;
      const label = CATEGORY_LABELS[cmd.category as SlashCommandCategory];
      lines.push(`**${isZh ? label.zh : label.en}**`);
    }
    const argStr = cmd.args ? ` ${cmd.args}` : '';
    lines.push(`\`/${cmd.name}${argStr}\` — ${getCommandDescription(cmd)}`);
  }

  lines.push(`\n${isZh ? '输入 `/` 加命令名称来执行。' : 'Type `/` followed by a command name to execute.'}`);
  return { content: lines.join('\n') };
}

async function executeCompact(
  client: GatewayClient,
  sessionKey: string,
): Promise<SlashCommandResult> {
  try {
    await client.request('sessions.compact', { key: sessionKey });
    return { content: i18n.t('slashCmd.compactSuccess'), action: 'refresh' };
  } catch (err) {
    return { content: `${i18n.t('slashCmd.compactFailed')}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** Archives transcript server-side via OpenClaw `sessions.reset` so reload/history stays empty. */
async function executeClear(
  client: GatewayClient,
  sessionKey: string,
): Promise<SlashCommandResult> {
  try {
    const res = await client.request<{ ok?: boolean; key?: string }>('sessions.reset', {
      key: sessionKey,
      reason: 'reset',
    });
    return {
      content: i18n.t('slashCmd.cleared'),
      action: 'clear',
      nextSessionKey: typeof res?.key === 'string' ? res.key : undefined,
    };
  } catch (err) {
    return {
      content: `${i18n.t('slashCmd.clearFailed')}: ${err instanceof Error ? err.message : String(err)}`,
      action: 'clear-local-fallback',
    };
  }
}

/** i18n shorthand for slash command results. */
function t(key: string, vars?: Record<string, string>): string {
  return i18n.t(`slashCmd.${key}`, vars) as string;
}

async function executeModel(
  client: GatewayClient,
  sessionKey: string,
  args: string,
): Promise<SlashCommandResult> {
  if (!args) {
    try {
      const sessions = await client.request<SessionsListResult>('sessions.list', {});
      const session = findCurrentSession(sessions, sessionKey);
      const model = session?.model || sessions?.defaults?.model || 'default';
      return { content: `**${t('currentModel')}:** \`${model}\`` };
    } catch (err) {
      return { content: `${t('failedModel')}: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  try {
    await client.request('sessions.patch', { key: sessionKey, model: args.trim() });
    return { content: t('modelSet', { model: args.trim() }), action: 'refresh' };
  } catch (err) {
    return { content: `${t('failedModel')}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function executeThink(
  client: GatewayClient,
  sessionKey: string,
  args: string,
): Promise<SlashCommandResult> {
  const rawLevel = args.trim().toLowerCase();
  const validLevels = ['off', 'low', 'medium', 'high'];

  if (!rawLevel) {
    try {
      const sessions = await client.request<SessionsListResult>('sessions.list', {});
      const session = findCurrentSession(sessions, sessionKey);
      const level = session?.thinkingLevel || 'off';
      return { content: `**${t('currentThinking')}:** ${level}\nOptions: ${validLevels.join(', ')}.` };
    } catch (err) {
      return { content: `${t('failedGeneric')}: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  if (!validLevels.includes(rawLevel)) {
    return { content: t('invalidLevel', { value: rawLevel, options: validLevels.join(', ') }) };
  }

  try {
    await client.request('sessions.patch', { key: sessionKey, thinkingLevel: rawLevel });
    return { content: t('thinkingSet', { level: rawLevel }), action: 'refresh' };
  } catch (err) {
    return { content: `${t('failedGeneric')}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function executeFast(
  client: GatewayClient,
  sessionKey: string,
  args: string,
): Promise<SlashCommandResult> {
  const rawMode = args.trim().toLowerCase();

  if (!rawMode || rawMode === 'status') {
    try {
      const sessions = await client.request<SessionsListResult>('sessions.list', {});
      const session = findCurrentSession(sessions, sessionKey);
      const mode = session?.fastMode === true ? 'on' : 'off';
      return { content: `**${t('fastMode')}:** ${mode}\nOptions: on, off.` };
    } catch (err) {
      return { content: `${t('failedGeneric')}: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  if (rawMode !== 'on' && rawMode !== 'off') {
    return { content: t('invalidLevel', { value: args.trim(), options: 'on, off' }) };
  }

  try {
    await client.request('sessions.patch', { key: sessionKey, fastMode: rawMode === 'on' });
    return { content: t(rawMode === 'on' ? 'fastEnabled' : 'fastDisabled'), action: 'refresh' };
  } catch (err) {
    return { content: `${t('failedGeneric')}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function executeVerbose(
  client: GatewayClient,
  sessionKey: string,
  args: string,
): Promise<SlashCommandResult> {
  const rawLevel = args.trim().toLowerCase();
  const validLevels = ['on', 'off', 'full'];

  if (!rawLevel) {
    try {
      const sessions = await client.request<SessionsListResult>('sessions.list', {});
      const session = findCurrentSession(sessions, sessionKey);
      const level = session?.verboseLevel || 'off';
      return { content: `**${t('verboseLevel')}:** ${level}\nOptions: ${validLevels.join(', ')}.` };
    } catch (err) {
      return { content: `${t('failedGeneric')}: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  if (!validLevels.includes(rawLevel)) {
    return { content: t('invalidLevel', { value: rawLevel, options: validLevels.join(', ') }) };
  }

  try {
    await client.request('sessions.patch', { key: sessionKey, verboseLevel: rawLevel });
    return { content: t('verboseSet', { level: rawLevel }), action: 'refresh' };
  } catch (err) {
    return { content: `${t('failedGeneric')}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function executeUsage(
  client: GatewayClient,
  sessionKey: string,
): Promise<SlashCommandResult> {
  try {
    const sessions = await client.request<SessionsListResult>('sessions.list', {});
    const session = findCurrentSession(sessions, sessionKey);
    if (!session) {
      return { content: t('noSession') };
    }
    const input = session.inputTokens ?? 0;
    const output = session.outputTokens ?? 0;
    const total = session.totalTokens ?? input + output;
    const ctx = session.contextTokens ?? 0;
    const pct = ctx > 0 ? Math.round((input / ctx) * 100) : null;

    const lines = [
      `**${t('sessionUsage')}**`,
      `Input: **${fmtTokens(input)}** tokens`,
      `Output: **${fmtTokens(output)}** tokens`,
      `Total: **${fmtTokens(total)}** tokens`,
    ];
    if (pct !== null) {
      lines.push(`Context: **${pct}%** of ${fmtTokens(ctx)}`);
    }
    if (session.model) {
      lines.push(`${t('currentModel')}: \`${session.model}\``);
    }
    return { content: lines.join('\n') };
  } catch (err) {
    return { content: `${t('failedGeneric')}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// ── Helpers ──

function findCurrentSession(
  result: SessionsListResult | undefined,
  sessionKey: string,
): SessionRow | undefined {
  if (!result?.sessions) return undefined;
  const normalizedKey = sessionKey.trim().toLowerCase();
  // Match both bare key ("main") and canonicalized key ("agent:main:main")
  return result.sessions.find((s) => {
    const key = s.key?.trim().toLowerCase() ?? '';
    return key === normalizedKey || key === `agent:main:${normalizedKey}`;
  });
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}k`;
  return String(n);
}

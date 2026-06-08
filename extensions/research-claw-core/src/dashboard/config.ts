import * as fs from 'node:fs';

import { setDashboardSystemPromptAppend } from './prompt-append.js';

export function readSystemPromptAppendFromConfig(
  config: Record<string, unknown> | null | undefined,
): string {
  if (!config) return '';
  const ui = config.ui as Record<string, unknown> | undefined;
  const rc = ui?.researchClaw as Record<string, unknown> | undefined;
  const value = rc?.systemPromptAppend;
  return typeof value === 'string' ? value : '';
}

export function hydrateDashboardSystemPromptFromConfigPath(configPath: string): void {
  try {
    const configText = fs.readFileSync(configPath, 'utf-8');
    const config = JSON.parse(configText) as Record<string, unknown>;
    setDashboardSystemPromptAppend(readSystemPromptAppendFromConfig(config));
  } catch {
    // Config missing or unreadable — keep in-memory default (empty).
  }
}

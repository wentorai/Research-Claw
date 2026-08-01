/**
 * Shared utilities for the tool activity log, used by ChatView (live inline)
 * and ToolActivityHistory (collapsed history panel).
 */

/** Format a timestamp as HH:MM:SS (24-hour, no date). */
export function fmtTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour12: false });
}

/**
 * Safe JSON.stringify for activity log detail objects.
 * Guards against: (1) circular references → fallback to "[Circular]"
 *                 (2) oversized output → truncated with "… (truncated)" suffix
 */
const DETAIL_MAX_CHARS = 8_000;

export function safeStringifyDetail(value: unknown): string {
  try {
    const raw = JSON.stringify(value, null, 2);
    if (raw.length <= DETAIL_MAX_CHARS) return raw;
    return raw.slice(0, DETAIL_MAX_CHARS) + '\n… (truncated)';
  } catch {
    return '"[unserializable]"';
  }
}

type CollapsibleToolActivity = {
  ts: number;
  sessionKey: string;
  runId: string | null;
  toolCallId: string | null;
  scope: 'foreground' | 'background';
  status: string;
};

/**
 * Collapse lifecycle frames for the same tool invocation into one visible row.
 * The raw activity log remains untouched for diagnostics; only the projection
 * replaces `start` with the latest `result`/`end` frame for that exact
 * session + run + toolCallId tuple.
 */
export function collapseToolActivityEntries<T extends CollapsibleToolActivity>(entries: T[]): T[] {
  const collapsed: T[] = [];
  const toolIndex = new Map<string, number>();

  for (const entry of entries) {
    const isToolLifecycle = entry.toolCallId !== null
      && (entry.status === 'tool_start'
        || entry.status === 'tool_result'
        || entry.status === 'tool_end');
    if (!isToolLifecycle) {
      collapsed.push(entry);
      continue;
    }

    const key = [
      entry.sessionKey,
      entry.runId ?? '',
      entry.scope,
      entry.toolCallId,
    ].join('\u0000');
    const existingIndex = toolIndex.get(key);
    if (existingIndex === undefined) {
      toolIndex.set(key, collapsed.length);
      collapsed.push(entry);
    } else {
      collapsed[existingIndex] = entry;
    }
  }

  return collapsed.sort((left, right) => left.ts - right.ts);
}

/** Build a one-line summary for an activity log entry. */
export function fmtActivityRow(entry: {
  ts: number;
  scope: 'foreground' | 'background';
  text: string;
  durationMs?: number;
}): string {
  const scope = entry.scope === 'background' ? 'BG' : 'FG';
  const dur = typeof entry.durationMs === 'number' ? ` ${Math.round(entry.durationMs)}ms` : '';
  return `${fmtTime(entry.ts)} ${scope}  ${entry.text}${dur}`;
}

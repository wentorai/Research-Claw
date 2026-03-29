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

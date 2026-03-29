/**
 * Shared utilities for the tool activity log, used by ChatView (live inline)
 * and ToolActivityHistory (collapsed history panel).
 */

/** Format a timestamp as HH:MM:SS (24-hour, no date). */
export function fmtTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour12: false });
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

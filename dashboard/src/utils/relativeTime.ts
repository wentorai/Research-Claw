/**
 * Relative time formatter.
 *
 * Formats an ISO timestamp into a human-readable relative time string.
 * Returns a localized "never run" string for null/undefined inputs.
 */

export function relativeTime(
  isoString: string | null | undefined,
  locale: string = 'en',
): string {
  if (!isoString) {
    return locale.startsWith('zh') ? '从未运行' : 'Never run';
  }

  const date = parseTimestamp(isoString);
  const now = Date.now();
  const diffMs = now - date.getTime();

  // Future dates: show full date
  if (diffMs < 0) {
    return formatFullDate(date);
  }

  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (locale.startsWith('zh')) {
    if (diffSec < 60) return '刚刚';
    if (diffMin < 60) return `${diffMin} 分钟前`;
    if (diffHour < 24) return `${diffHour} 小时前`;
    if (diffDay < 7) return `${diffDay} 天前`;
    return formatFullDate(date);
  }

  // English
  if (diffSec < 60) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHour < 24) return `${diffHour}h ago`;
  if (diffDay < 7) return `${diffDay}d ago`;
  return formatFullDate(date);
}

function parseTimestamp(value: string): Date {
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value;
  return new Date(normalized);
}

function formatFullDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const h = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  return `${y}-${m}-${d} ${h}:${min}`;
}

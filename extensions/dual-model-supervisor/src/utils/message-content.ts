/**
 * Normalize OpenClaw / Anthropic / OpenAI message `content` to plain text for supervisor prompts.
 * Gateway may pass `content` as string, array of blocks, or a single block object — naive
 * `${content}` or array stringification yields "[object Object]".
 */

/** Recursively convert a single content block (text, image, tool_use, tool_result, etc.) to plain text. */
function blockToText(block: unknown): string {
  if (block == null) return '';
  if (typeof block === 'string') return block;
  if (typeof block !== 'object') return String(block);

  const o = block as Record<string, unknown>;

  if (typeof o.text === 'string') return o.text;

  const t = o.type;
  if (t === 'text' && typeof o.text === 'string') return o.text;

  if (t === 'image_url' || t === 'input_image' || t === 'image') return '[image]';
  if (t === 'video_url') return '[video]';

  if (t === 'tool_use' && typeof o.name === 'string') {
    const input = o.input;
    const s = typeof input === 'string' ? input : JSON.stringify(input ?? {});
    return `[tool:${o.name}] ${s.length > 800 ? `${s.slice(0, 800)}…` : s}`;
  }

  if (t === 'tool_result') {
    const c = o.content;
    if (typeof c === 'string') return `[tool_result] ${c}`;
    if (Array.isArray(c)) return c.map(blockToText).join('\n');
    return `[tool_result] ${JSON.stringify(c).slice(0, 1200)}`;
  }

  if (Array.isArray(o.content)) {
    return o.content.map(blockToText).filter((s) => s.length > 0).join('\n');
  }

  try {
    const j = JSON.stringify(o);
    return j.length > 4000 ? `${j.slice(0, 4000)}…` : j;
  } catch {
    return '[content]';
  }
}

/**
 * Convert message `content` (any shape) to a single plain-text string for logging / reviewer prompts.
 */
export function messageContentToPlainText(content: unknown): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(blockToText).filter((s) => s.length > 0).join('\n');
  }
  if (typeof content === 'object') {
    return blockToText(content);
  }
  return String(content);
}

/**
 * Plain-text form of `content`, truncated to `maxChars` Unicode code units.
 */
export function truncateMessagePlainText(content: unknown, maxChars: number): string {
  const s = messageContentToPlainText(content);
  if (s.length <= maxChars) return s;
  return s.slice(0, maxChars);
}

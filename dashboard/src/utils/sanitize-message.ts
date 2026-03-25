/**
 * Unified message sanitization pipeline for user messages loaded from chat history.
 *
 * OpenClaw channels (Feishu, Telegram, Discord, etc.) inject metadata, sender
 * attribution, and system hints into user message text before storing it in the
 * session transcript. The gateway strips *some* of these (envelope headers for
 * core channels, [message_id:] lines, structured JSON metadata blocks) but
 * residual patterns survive and pollute the dashboard display.
 *
 * This module consolidates ALL stripping logic that was previously fragmented
 * across chat.ts (stripInjectedContext) and MessageBubble.tsx (stripUserMetaPrefix)
 * into a single pipeline. Adding new patterns here is the ONLY place needed.
 *
 * Reference:
 *   - openclaw/src/shared/chat-envelope.ts — gateway-side stripping
 *   - openclaw/extensions/feishu/src/bot.ts:817-860 — Feishu body formatting
 *   - openclaw/src/auto-reply/envelope.ts:190-220 — universal envelope formatting
 */

// ── Pattern Definitions ──

/** Cron reminder injection — entire message should be dropped.
 * Exported for reuse in chat.ts handleChatEvent (real-time delta filtering). */
export const CRON_REMINDER_RE = /A scheduled reminder has been triggered\b/i;

/** [Research-Claw] context block header */
const RC_BLOCK_START_RE = /^\[Research-Claw\]/;
/** Indented continuation of an [Research-Claw] block */
const RC_BLOCK_CONTINUATION_RE = /^\s{2,}-\s/;

/** System: prefixed lines (exec events, run commands) */
const SYSTEM_LINE_RE = /^System:\s/;

/** Feishu [System: ...] bracket injections (mention hints, permission errors) */
const FEISHU_SYSTEM_INJECTION_RE = /\n*\[System:\s[^\]]*\]/g;

/** [message_id: ...] lines — backup for gateway stripping */
const MESSAGE_ID_LINE_RE = /^\s*\[message_id:\s*[^\]]+\]\s*$/;

/** [Replying to: "..."] prefix (Feishu reply context) */
const FEISHU_REPLY_PREFIX_RE = /^\[Replying to:\s+"[^"]*"\]\s*\n*/;

/** Channel ID tags: [id:xxx chat:xxx] (Telegram/iMessage) */
const CHANNEL_ID_TAG_RE = /\s*\[id:\S+\s+chat:\S+\]/g;

/** Envelope headers with timestamp pattern (backup for extension channels like Feishu) */
const ENVELOPE_WITH_TIMESTAMP_RE = /^\[[A-Z][a-zA-Z]*\s+[^\]]*\d{4}-\d{2}-\d{2}[^\]]*\]\s*/;

/** Timestamp tag: [Day YYYY-MM-DD HH:MM GMT+N] */
const TIMESTAMP_TAG_RE = /^\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2}\s+GMT[+-]\d+\]\s*(.*)/;

/** Feishu open user ID prefix: ou_{hex}: message */
const FEISHU_OPENID_PREFIX_RE = /^ou_[0-9a-f]{20,}:\s*/;

/** Self-attribution prefix: (self): message */
const SELF_ATTRIBUTION_RE = /^\(self\):\s*/;

/**
 * Generic sender label prefix: Name: message (1-50 chars before colon).
 * Only applied when hadChannelMarkers is true to avoid false positives.
 */
const SENDER_LABEL_PREFIX_RE = /^[^\n:]{1,50}:\s+/;

// ── Pipeline ──

/**
 * Sanitize a user message for display. Strips all known injection patterns
 * from OpenClaw channel relay, Research-Claw context injection, and system lines.
 *
 * Returns the cleaned user text, or empty string if the entire message was metadata.
 */
export function sanitizeUserMessage(text: string): string {
  if (!text) return '';

  // Step 1: Cron reminder — strip to empty
  if (CRON_REMINDER_RE.test(text)) return '';

  // Track whether channel-specific markers were found (for safe sender prefix stripping)
  let hadChannelMarkers = false;

  // Step 2-3: Line-by-line stripping of [Research-Claw] blocks and System: lines
  const lines = text.split('\n');
  const afterLineStrip: string[] = [];
  let inRcBlock = false;

  for (const line of lines) {
    // [Research-Claw] block start
    if (RC_BLOCK_START_RE.test(line)) {
      inRcBlock = true;
      continue;
    }
    // Indented continuation of [Research-Claw] block
    if (inRcBlock && RC_BLOCK_CONTINUATION_RE.test(line)) {
      continue;
    }
    inRcBlock = false;

    // System: prefixed lines
    if (SYSTEM_LINE_RE.test(line)) continue;

    // [message_id: ...] lines (Step 5)
    if (MESSAGE_ID_LINE_RE.test(line)) {
      hadChannelMarkers = true;
      continue;
    }

    afterLineStrip.push(line);
  }

  let result = afterLineStrip.join('\n');

  // Step 4: [System: ...] bracket injections (Feishu)
  if (/\[System:\s/.test(result)) {
    hadChannelMarkers = true;
    FEISHU_SYSTEM_INJECTION_RE.lastIndex = 0;
    result = result.replace(FEISHU_SYSTEM_INJECTION_RE, '');
  }

  // Step 6: [Replying to: "..."] prefix
  if (FEISHU_REPLY_PREFIX_RE.test(result)) {
    hadChannelMarkers = true;
    result = result.replace(FEISHU_REPLY_PREFIX_RE, '');
  }

  // Step 7: [id:xxx chat:xxx] channel ID tags
  if (/\[id:\S/.test(result)) {
    hadChannelMarkers = true;
    CHANNEL_ID_TAG_RE.lastIndex = 0;
    result = result.replace(CHANNEL_ID_TAG_RE, '');
  }

  // Step 8: Envelope headers with timestamps (backup for extension channels)
  if (ENVELOPE_WITH_TIMESTAMP_RE.test(result)) {
    hadChannelMarkers = true;
    result = result.replace(ENVELOPE_WITH_TIMESTAMP_RE, '');
  }

  // Step 9: Timestamp tags [Day YYYY-MM-DD HH:MM GMT+N]
  // Process line by line to handle timestamp at start of any line
  const tsLines = result.split('\n');
  const afterTs: string[] = [];
  for (const line of tsLines) {
    const tsMatch = line.match(TIMESTAMP_TAG_RE);
    if (tsMatch) {
      if (tsMatch[1].length > 0) afterTs.push(tsMatch[1]);
      continue;
    }
    // Skip leading empty lines
    if (line.trim() === '' && afterTs.length === 0) continue;
    afterTs.push(line);
  }
  result = afterTs.join('\n');

  // Step 10: Feishu open_id prefix — always safe to strip
  if (FEISHU_OPENID_PREFIX_RE.test(result)) {
    hadChannelMarkers = true;
    result = result.replace(FEISHU_OPENID_PREFIX_RE, '');
  }

  // Step 11: (self): self-attribution prefix
  if (SELF_ATTRIBUTION_RE.test(result)) {
    result = result.replace(SELF_ATTRIBUTION_RE, '');
  }

  // Step 12: Generic sender label prefix — ONLY when channel markers were detected
  // This avoids false positives on legitimate user text like "Note: something"
  if (hadChannelMarkers && SENDER_LABEL_PREFIX_RE.test(result)) {
    result = result.replace(SENDER_LABEL_PREFIX_RE, '');
  }

  // Step 13: Trim
  return result.trim();
}

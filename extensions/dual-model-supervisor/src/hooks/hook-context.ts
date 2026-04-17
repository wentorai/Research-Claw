/**
 * Inspect OpenClaw `message_sending` hook context (runtime shape varies by gateway version).
 */

/** Stable substring used in appended footers; also used for idempotent skip. */
export const SUPERVISOR_REVIEW_SUMMARY_MARKER = '🔍 **[Supervisor]**';

export type MessageSendingCtxSnapshot = {
  keys: string[];
  /** True when context suggests this is a streaming/partial chunk, not the final assistant message. */
  deferReview: boolean;
  /** True when the message is being delivered through an external channel (Telegram, WeChat, etc.). */
  isChannelDelivery: boolean;
  flags: {
    streaming?: unknown;
    partial?: unknown;
    stream?: unknown;
    isFinal?: unknown;
    done?: unknown;
    complete?: unknown;
    phase?: unknown;
    channel?: unknown;
    deliveryMode?: unknown;
    source?: unknown;
  };
};

/**
 * Take a "snapshot" of the `message_sending` hook context, inspecting its keys
 * and streaming/partial flags to decide whether the output review should be deferred.
 *
 * Some gateway versions send intermediate streaming chunks through this hook;
 * we only want to review the final assembled message to avoid partial-content reviews
 * and to ensure the footer is appended exactly once.
 *
 * Also detects whether the message is being delivered through an external channel,
 * which determines whether the review footer should be appended.
 */
export function snapshotMessageSendingCtx(ctx: unknown): MessageSendingCtxSnapshot {
  const keys = ctx && typeof ctx === 'object' ? Object.keys(ctx as object).sort() : [];
  const o = (ctx && typeof ctx === 'object' ? ctx : {}) as Record<string, unknown>;
  const flags = {
    streaming: o.streaming,
    partial: o.partial,
    stream: o.stream,
    isFinal: o.isFinal,
    done: o.done,
    complete: o.complete,
    phase: o.phase,
    channel: o.channel,
    deliveryMode: o.deliveryMode,
    source: o.source,
  };

  // Detect channel delivery: the gateway sets channel info when delivering to external channels
  const isChannelDelivery = detectChannelDelivery(o);

  if (o.isFinal === true || o.done === true || o.complete === true) {
    return { keys, deferReview: false, isChannelDelivery, flags };
  }

  // Do not defer on `stream` / `streaming` alone — some gateways set those on the **final**
  // assembled message (streaming transport), which would skip all output review and never append a footer.
  // Rely on `partial`, explicit non-final flags (`isFinal`/`done`/`complete` === false), or `phase` chunk hints.
  const deferReview =
    o.partial === true ||
    o.isFinal === false ||
    o.done === false ||
    o.complete === false ||
    (typeof o.phase === 'string' && /delta|streaming|partial|chunk/i.test(o.phase));

  return { keys, deferReview, isChannelDelivery, flags };
}

/**
 * Detect whether the current message is being delivered through an external channel.
 *
 * The gateway provides channel context in `message_sending` when the message
 * is being routed to an external channel plugin (Telegram, WeChat, Discord, etc.).
 * Dashboard-initiated messages do NOT have channel context.
 */
function detectChannelDelivery(ctx: Record<string, unknown>): boolean {
  // Check for explicit channel field
  if (typeof ctx.channel === 'string' && ctx.channel.length > 0) return true;
  // Check for delivery mode indicating external delivery
  if (ctx.deliveryMode === 'direct' || ctx.deliveryMode === 'announce') return true;
  // Check for source indicating channel-originated message
  if (typeof ctx.source === 'string' && /^(telegram|discord|weixin|wechat|feishu|slack|imessage)/i.test(ctx.source)) return true;
  // Check for nested channel info (some gateway versions)
  const delivery = ctx.delivery as Record<string, unknown> | undefined;
  if (delivery && typeof delivery === 'object') {
    if (typeof delivery.channel === 'string' && delivery.channel.length > 0) return true;
    if (delivery.mode === 'direct' || delivery.mode === 'announce') return true;
  }
  return false;
}

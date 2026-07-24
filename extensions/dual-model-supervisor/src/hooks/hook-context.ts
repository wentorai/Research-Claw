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
export function snapshotMessageSendingCtx(event: unknown, hookCtx?: unknown): MessageSendingCtxSnapshot {
  const keys = event && typeof event === 'object' ? Object.keys(event as object).sort() : [];
  const o = (event && typeof event === 'object' ? event : {}) as Record<string, unknown>;
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
  const isChannelDelivery = detectChannelDelivery(o, hookCtx);

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
 * Surfaces that are NOT external channels — a delivery whose authoritative
 * `ctx.channelId` is one of these (or empty) must NOT receive the channel footer.
 */
const NON_CHANNEL_IDS = new Set(['', 'dashboard', 'web', 'internal', 'smoke']);

/**
 * Detect whether the current message is being delivered through an external channel.
 *
 * AUTHORITATIVE signal: the OpenClaw hook ctx (2nd handler arg) carries a REQUIRED
 * `channelId` on `PluginHookMessageContext` (host-derived from
 * OriginatingChannel/Surface/Provider). One real OC path
 * (`buildMessageSendingBeforeDeliver`) fires the event as `{ to, content }` with NO
 * metadata at all — the channel lives ONLY in `ctx.channelId` — so channel detection
 * MUST read the ctx, not just the event. Dashboard/web/internal surfaces are excluded.
 *
 * The event/metadata checks are kept as belt-and-suspenders for the other outbound
 * paths (deliver/telegram) that DO stamp `metadata.channel`.
 */
function detectChannelDelivery(event: Record<string, unknown>, hookCtx?: unknown): boolean {
  // 1) Authoritative: non-empty ctx.channelId that is a real external channel.
  const ctxObj = (hookCtx && typeof hookCtx === 'object' ? hookCtx : undefined) as Record<string, unknown> | undefined;
  const channelId = ctxObj?.channelId;
  if (typeof channelId === 'string' && channelId.length > 0) {
    return !NON_CHANNEL_IDS.has(channelId.toLowerCase());
  }
  // 2) Belt-and-suspenders: some outbound paths stamp channel signals on the event/metadata.
  if (hasChannelSignals(event)) return true;
  const metadata = event.metadata as Record<string, unknown> | undefined;
  if (metadata && typeof metadata === 'object' && hasChannelSignals(metadata)) return true;
  return false;
}

/** Channel-delivery signals, checked both at the top level and inside `metadata`. */
function hasChannelSignals(o: Record<string, unknown>): boolean {
  // Check for explicit channel field
  if (typeof o.channel === 'string' && o.channel.length > 0) return true;
  // Check for delivery mode indicating external delivery
  if (o.deliveryMode === 'direct' || o.deliveryMode === 'announce') return true;
  // Check for source indicating channel-originated message
  if (typeof o.source === 'string' && /^(telegram|discord|weixin|wechat|feishu|slack|imessage)/i.test(o.source)) return true;
  // Check for nested channel info (some gateway versions)
  const delivery = o.delivery as Record<string, unknown> | undefined;
  if (delivery && typeof delivery === 'object') {
    if (typeof delivery.channel === 'string' && delivery.channel.length > 0) return true;
    if (delivery.mode === 'direct' || delivery.mode === 'announce') return true;
  }
  return false;
}

/**
 * Reviewer HTTP adapters — one per provider group in `SUPERVISOR_REVIEWER_PROVIDER_IDS`.
 *
 * Each adapter handles that vendor's auth convention, request body shape, and response parsing.
 * Custom / unlisted providers still go through `resolveAdapter(api)`.
 */

import type { ModelsProviderEntry, ModelsProviderModelDef, SupportedReviewerApi } from '../core/types.js';
import type { SupervisorReviewerProviderId } from '../../supervisor-reviewer-providers.js';
import { isSupervisorReviewerProviderId } from '../../supervisor-reviewer-providers.js';

export type { SupportedReviewerApi };

/**
 * Protocol adapter interface — each implementation handles auth, request body, and response
 * parsing for a specific API protocol (OpenAI chat completions or Anthropic messages).
 */
export interface ReviewerApiAdapter {
  /** API protocol this adapter implements. */
  readonly protocol: SupportedReviewerApi;
  /** Build HTTP headers including auth for the given provider config. */
  buildHeaders(provider: ModelsProviderEntry): Record<string, string>;
  /** Build the JSON request body for a non-streaming completion call. */
  buildBody(provider: ModelsProviderEntry, modelId: string, system: string, user: string): Record<string, unknown>;
  /** Extract the assistant's text content from the raw JSON response. */
  extractText(data: Record<string, unknown>): string | undefined;
}

// ── Shared helpers ──────────────────────────────────────────────────────

function findModelDef(provider: ModelsProviderEntry, modelId: string): ModelsProviderModelDef | undefined {
  return provider.models?.find((m) => m.id === modelId);
}

function applyMaxTokens(body: Record<string, unknown>, provider: ModelsProviderEntry, modelId: string): void {
  const def = findModelDef(provider, modelId);
  if (def?.maxTokens !== undefined && Number.isFinite(def.maxTokens)) {
    body.max_tokens = def.maxTokens;
  }
}

function extractOpenAiText(data: Record<string, unknown>): string | undefined {
  const choices = data.choices as Array<{ message?: { content?: string } }> | undefined;
  return choices?.[0]?.message?.content;
}

function extractAnthropicText(data: Record<string, unknown>): string | undefined {
  const content = data.content;
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === 'object' && 'text' in block && typeof (block as { text?: string }).text === 'string') {
      parts.push((block as { text: string }).text);
    }
  }
  return parts.length > 0 ? parts.join('') : undefined;
}

// ── OpenAI-compatible adapter ──────────────────────────────────────────
// Z.AI / 智谱 (zai, zai-global, zai-coding, zai-coding-global)
// Moonshot / Kimi (moonshot, moonshot-cn)
// All use Bearer token auth + OpenAI chat completion format.

const openaiCompatAdapter: ReviewerApiAdapter = {
  protocol: 'openai-completions',
  buildHeaders(provider) {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (provider.headers) {
      for (const [k, v] of Object.entries(provider.headers)) {
        if (typeof v === 'string' && v.length > 0) h[k] = v;
      }
    }
    if (provider.apiKey) h.Authorization = `Bearer ${provider.apiKey}`;
    return h;
  },
  buildBody(provider, modelId, system, user) {
    const body: Record<string, unknown> = {
      model: modelId,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    };
    applyMaxTokens(body, provider, modelId);
    return body;
  },
  extractText: extractOpenAiText,
};

// ── Anthropic Messages-compatible adapter (Kimi Coding) ────────────────
// Auth: `x-api-key` + `anthropic-version`, same as Anthropic Messages API — not Bearer.
// Reviewer resolves POST URL to `{baseUrl}/v1/messages` in reviewer.ts.

const kimiCodingAdapter: ReviewerApiAdapter = {
  protocol: 'anthropic-messages',
  buildHeaders(provider) {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (provider.headers) {
      for (const [k, v] of Object.entries(provider.headers)) {
        if (typeof v === 'string' && v.length > 0) h[k] = v;
      }
    }
    if (provider.apiKey) {
      h['x-api-key'] = provider.apiKey;
    }
    if (!h['anthropic-version'] && !h['Anthropic-Version']) {
      h['anthropic-version'] = '2023-06-01';
    }
    return h;
  },
  buildBody(provider, modelId, system, user) {
    const body: Record<string, unknown> = {
      model: modelId,
      system,
      messages: [{ role: 'user', content: user }],
    };
    applyMaxTokens(body, provider, modelId);
    if (typeof body.max_tokens !== 'number' || !Number.isFinite(body.max_tokens)) {
      body.max_tokens = 8192;
    }
    return body;
  },
  extractText: extractAnthropicText,
};

// ── Anthropic Messages-compatible adapter (MiniMax) ────────────────────
// Auth: Bearer token + `anthropic-version`.
// minimax.io (Intl) / minimaxi.com (CN).

const minimaxAdapter: ReviewerApiAdapter = {
  protocol: 'anthropic-messages',
  buildHeaders(provider) {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (provider.headers) {
      for (const [k, v] of Object.entries(provider.headers)) {
        if (typeof v === 'string' && v.length > 0) h[k] = v;
      }
    }
    if (provider.apiKey) h.Authorization = `Bearer ${provider.apiKey}`;
    if (!h['anthropic-version'] && !h['Anthropic-Version']) {
      h['anthropic-version'] = '2023-06-01';
    }
    return h;
  },
  buildBody(provider, modelId, system, user) {
    const body: Record<string, unknown> = {
      model: modelId,
      system,
      messages: [{ role: 'user', content: user }],
    };
    applyMaxTokens(body, provider, modelId);
    return body;
  },
  extractText: extractAnthropicText,
};

// ── Provider → Adapter mapping ──────────────────────────────────────────

export const REVIEWER_ADAPTER_BY_PROVIDER: Record<SupervisorReviewerProviderId, ReviewerApiAdapter> = {
  'zai':                openaiCompatAdapter,
  'zai-global':         openaiCompatAdapter,
  'zai-coding':         openaiCompatAdapter,
  'zai-coding-global':  openaiCompatAdapter,
  'moonshot':           openaiCompatAdapter,
  'moonshot-cn':        openaiCompatAdapter,
  'kimi-coding':        kimiCodingAdapter,
  'minimax':            minimaxAdapter,
  'minimax-cn':         minimaxAdapter,
};

// ── Public resolution ───────────────────────────────────────────────────

/**
 * Generic fallback for custom (non-preset) providers — picks by `api` protocol string.
 */
export function resolveAdapter(api: string | undefined): ReviewerApiAdapter | null {
  const kind = api ?? 'openai-completions';
  if (kind === 'openai-completions') return openaiCompatAdapter;
  if (kind === 'anthropic-messages') return kimiCodingAdapter;
  return null;
}

/**
 * Primary entry point: preset providers resolve by id → dedicated adapter;
 * custom providers fall back to `resolveAdapter(api)`.
 */
export function resolveAdapterForReviewer(providerId: string | undefined, api: string | undefined): ReviewerApiAdapter | null {
  if (providerId && isSupervisorReviewerProviderId(providerId)) {
    return REVIEWER_ADAPTER_BY_PROVIDER[providerId];
  }
  return resolveAdapter(api);
}

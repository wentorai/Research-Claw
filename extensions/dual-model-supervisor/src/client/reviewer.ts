/**
 * Dual Model Supervisor — Reviewer Model API Client
 *
 * Uses the same `models.providers.<id>` entry as the main stack: `baseUrl`, `apiKey`, optional `headers`,
 * and `models[]` (e.g. `maxTokens` for the `supervisorModel` row).
 * `baseUrl` is used as the HTTP POST URL as stored in config (only trailing `/` trimmed); do not append paths here — match whatever the gateway / dashboard persists for that provider.
 */

import type {
  ModelsProviderEntry,
  PluginLogger,
  ReviewerReadiness,
  RuntimeLlmComplete,
  SupervisorConfig,
} from '../core/types.js';
import { SUPPORTED_REVIEWER_APIS } from '../core/types.js';
import { parseModelRef } from '../core/config.js';
import type { ReviewerApiAdapter } from './api-adapters.js';
import { resolveAdapterForReviewer } from './api-adapters.js';

/**
 * User-facing degradation copy. Keep the structured technical reason in
 * `rc.supervisor.status.reviewerUnavailableReason`; terminal and audit surfaces
 * should tell a person what still works and what they can do next.
 */
export function describeReviewerUnavailableForUser(): string {
  return 'AI review is unavailable. Dangerous-command protection remains active. '
    + 'Choose a valid reviewer model in Supervisor settings, or check its API key, balance, and provider settings.';
}

function hasProviderAuth(providerCfg: ModelsProviderEntry): boolean {
  if (providerCfg.apiKey) return true;
  const h = providerCfg.headers;
  if (!h) return false;
  const a = h.Authorization ?? h.authorization;
  return typeof a === 'string' && a.length > 0;
}

// ── Result cache (5-min TTL) ───────────────────────────────────────────

const CACHE_TTL_MS = 5 * 60 * 1000;
const _cache = new Map<string, { result: unknown; ts: number }>();

function cacheKey(prompt: string, content: string): string {
  const raw = `${prompt}::${content}`;
  let hash = 0;
  for (let i = 0; i < raw.length; i++) {
    const chr = raw.charCodeAt(i);
    hash = ((hash << 5) - hash) + chr;
    hash |= 0;
  }
  return String(hash);
}

function getCached<T>(key: string): T | null {
  const entry = _cache.get(key);
  if (entry && Date.now() - entry.ts < CACHE_TTL_MS) {
    return entry.result as T;
  }
  if (entry) _cache.delete(key);
  return null;
}

function setCache(key: string, result: unknown): void {
  _cache.set(key, { result, ts: Date.now() });
  const now = Date.now();
  for (const [k, v] of _cache) {
    if (now - v.ts > CACHE_TTL_MS) _cache.delete(k);
  }
}

function trimUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

/** Anthropic Messages API: POST `{base}/v1/messages` (Kimi Coding mirrors this). */
function resolveAnthropicMessagesRequestUrl(base: string): string {
  const b = trimUrl(base);
  if (/\/v1\/messages$/i.test(b)) return b;
  return `${b}/v1/messages`;
}

// ── API Client ─────────────────────────────────────────────────────────

export interface ReviewerClientOptions {
  supervisorConfig: SupervisorConfig;
  providers: Record<string, ModelsProviderEntry>;
  logger: PluginLogger;
  fallbackModel?: string;
  /**
   * Host-owned completion path. It resolves OpenClaw auth profiles, environment
   * credentials and provider runtime auth exactly like the main agent.
   */
  runtimeComplete?: RuntimeLlmComplete;
}

export class ReviewerClient {
  private supervisorConfig: SupervisorConfig;
  private providers: Record<string, ModelsProviderEntry>;
  private logger: PluginLogger;
  /** Fallback model reference from main model config (`agents.defaults.model.primary`). */
  private fallbackModel: string;
  private readonly runtimeComplete?: RuntimeLlmComplete;
  /** Cached adapter for the effective reviewer model; refreshed on config/provider updates. */
  private _adapter: ReviewerApiAdapter | null = null;
  /**
   * Cached readiness for the effective reviewer model — recomputed with `_adapter`, never
   * separately. This initializer is never observable: the constructor calls
   * `_resolveAdapter()`, which overwrites it on both the success and the failure path.
   */
  private _readiness: ReviewerReadiness = { ready: false, modelSource: 'unavailable', effectiveModel: '', reason: 'not resolved yet' };
  /** Last readiness state already logged, so a persistent failure is reported once, not per call. */
  private _loggedReadinessKey = '';

  /**
   * Serialize all reviewer HTTP calls. Multiple hooks (summary extract, output review, consistency, …)
   * previously issued concurrent requests and could exhaust connections or destabilize the gateway.
   */
  private _reviewQueue: Promise<void> = Promise.resolve();

  constructor(opts: ReviewerClientOptions) {
    this.supervisorConfig = opts.supervisorConfig;
    this.providers = opts.providers;
    this.logger = opts.logger;
    this.fallbackModel = opts.fallbackModel ?? '';
    this.runtimeComplete = opts.runtimeComplete;
    this._resolveAdapter();
  }

  /** Update the provider map (e.g. after config change) and re-resolve the adapter. */
  updateProviders(providers: Record<string, ModelsProviderEntry>): void {
    this.providers = providers;
    this._resolveAdapter();
  }

  updateSupervisorConfig(cfg: SupervisorConfig): void {
    this.supervisorConfig = cfg;
    this._resolveAdapter();
  }

  updateFallbackModel(model: string): void {
    this.fallbackModel = model;
    this._resolveAdapter();
  }

  /**
   * The effective reviewer model and whether it can be called.
   *
   * `supervisorModel` empty ⇒ the MAIN model is inherited DYNAMICALLY: it is resolved
   * here on every config/provider/main-model update and never written back into config
   * (materializing it would freeze the inherit relation the moment the user switches
   * main models). Callers use this for status, audit and logs so the reason a deep
   * review is unavailable cannot drift from the reason the call actually fails.
   */
  getReadiness(): ReviewerReadiness {
    return { ...this._readiness };
  }

  /**
   * Recompute the effective model, its readiness and the protocol adapter together.
   * Pure (no network, no logging) so it can run on every update regardless of state.
   */
  private _computeReadiness(): { readiness: ReviewerReadiness; adapter: ReviewerApiAdapter | null } {
    const explicit = this.supervisorConfig.supervisorModel.trim();
    const effectiveModel = explicit || this.fallbackModel.trim();
    const configuredSource = explicit ? 'explicit' as const : 'inherited' as const;
    const unavailable = (reason: string) => ({
      readiness: { ready: false, modelSource: 'unavailable' as const, effectiveModel, reason },
      adapter: null,
    });

    if (!effectiveModel) {
      return unavailable('no reviewer model: supervisorModel is empty and the main model (agents.defaults.model.primary) is not set');
    }

    const parsed = parseModelRef(effectiveModel);
    if (!parsed) {
      return unavailable(`unparsable model reference "${effectiveModel}" (expected "<provider>/<modelId>")`);
    }

    const providerCfg = this.providers[parsed.provider];
    if (!providerCfg) {
      return unavailable(`provider "${parsed.provider}" not found in models.providers (available: ${Object.keys(this.providers).join(', ') || 'none'})`);
    }

    // Typed `string | undefined`, but openclaw.json is hand-editable and the plugin's
    // `providers` block is not covered by configSchema — the value is genuinely unknown.
    if (typeof providerCfg.baseUrl !== 'string' || !providerCfg.baseUrl.trim()) {
      return unavailable(`invalid baseUrl: models.providers.${parsed.provider}.baseUrl must be a non-empty string for the reviewer model`);
    }

    // Setup Wizard normally stores credentials in OpenClaw's auth profile
    // store, not inline in models.providers. The host completion runtime is the
    // canonical path that can resolve those credentials. Structural provider
    // validation still happens above so a typo such as ghost/reviewer is not
    // advertised as ready merely because the runtime function exists.
    if (this.runtimeComplete) {
      return {
        readiness: {
          ready: true,
          modelSource: configuredSource,
          effectiveModel,
        },
        adapter: null,
      };
    }

    const adapter = resolveAdapterForReviewer(parsed.provider, providerCfg.api);
    if (!adapter) {
      return unavailable(
        `unsupported reviewer protocol "${String(providerCfg.api ?? 'openai-completions')}" for provider "${parsed.provider}" (supported: ${SUPPORTED_REVIEWER_APIS.join(', ')})`,
      );
    }

    if (!hasProviderAuth(providerCfg)) {
      return unavailable(`missing credentials: provider "${parsed.provider}" has no apiKey and no Authorization header`);
    }

    return { readiness: { ready: true, modelSource: configuredSource, effectiveModel }, adapter };
  }

  /** Refresh cached readiness + adapter after any config / provider / main-model change. */
  private _resolveAdapter(): void {
    try {
      const { readiness, adapter } = this._computeReadiness();
      this._readiness = readiness;
      this._adapter = adapter;
    } catch (err) {
      // Backstop: this runs in the CONSTRUCTOR, so an exception would escape register()
      // and take the whole plugin — including the model-free safety gate — down with it.
      // A broken provider entry must only ever degrade deep review.
      this._readiness = {
        ready: false,
        modelSource: 'unavailable',
        effectiveModel: '',
        reason: `reviewer model resolution failed: ${err instanceof Error ? err.message : String(err)}`,
      };
      this._adapter = null;
    }
  }

  /**
   * Call the reviewer model. Returns parsed JSON or null on failure.
   *
   * Options for the before_tool_call SECURITY GATE (never-over-block):
   *  - `bypassQueue`: skip the shared serial `_reviewQueue` so a benign high-risk
   *    tool's gate is not stalled behind unrelated summary/output reviews.
   *  - `timeoutMs`: fail OPEN (resolve `null`) if the review does not complete in
   *    time, so the tool is never stalled on a slow round-trip. On timeout the
   *    underlying request is ABORTED: the tool has already proceeded, so its answer
   *    can no longer influence anything and letting it run to the 30s cap would just
   *    hold a connection and spend reviewer tokens.
   */
  async review<T>(
    systemPrompt: string,
    userContent: string,
    opts?: { bypassQueue?: boolean; timeoutMs?: number },
  ): Promise<T | null> {
    const key = cacheKey(systemPrompt, userContent);
    const cached = getCached<T>(key);
    if (cached !== null) {
      return cached;
    }

    const gated = opts?.timeoutMs != null && opts.timeoutMs > 0;
    const controller = gated ? new AbortController() : undefined;

    let core: Promise<T | null>;
    if (opts?.bypassQueue) {
      // Do NOT chain onto (or advance) the shared queue — run immediately.
      core = this._reviewAfterQueue<T>(systemPrompt, userContent, key, controller?.signal);
    } else {
      const run = this._reviewQueue
        .catch(() => undefined)
        .then(() => this._reviewAfterQueue<T>(systemPrompt, userContent, key, controller?.signal));
      this._reviewQueue = run.then(
        () => undefined,
        () => undefined,
      );
      core = run;
    }

    // No gate requested (undefined/0/negative) → return the raw call. Callers that
    // need the never-over-block bound (the before_tool_call security gate) MUST pass
    // a positive timeoutMs; parseConfig clamps toolReviewGateMs into its declared
    // range, so a config-derived gate is always positive and finite.
    if (!gated) {
      return core;
    }

    // Gate: whichever settles first. `core` never rejects (_reviewAfterQueue catches
    // and returns null), so on timeout we fail open with null.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const gate = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        controller!.abort(new Error(`reviewer gate timeout after ${opts.timeoutMs}ms`));
        resolve(null);
      }, opts.timeoutMs);
    });
    try {
      return await Promise.race([core, gate]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async _reviewAfterQueue<T>(
    systemPrompt: string,
    userContent: string,
    key: string,
    signal?: AbortSignal,
  ): Promise<T | null> {
    try {
      const result = await this._callApi(systemPrompt, userContent, signal);
      if (result !== null) {
        setCache(key, result);
      }
      return result as T | null;
    } catch (err) {
      // A gate timeout cancels this request on purpose — the caller already failed open.
      // Reporting it as a failure would blame the reviewer for our own deadline.
      if (signal?.aborted) {
        this.logger.debug?.(`[ReviewerClient] Deep review cancelled: ${signal.reason instanceof Error ? signal.reason.message : 'gate timeout'}`);
        return null;
      }
      this.logger.error(`Reviewer call failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /**
   * Fire-and-forget async review.
   */
  reviewAsync<T>(systemPrompt: string, userContent: string, callback?: (result: T | null) => void): void {
    this.review<T>(systemPrompt, userContent)
      .then((result) => callback?.(result))
      .catch((err) => {
        this.logger.error(`Async reviewer call failed: ${err instanceof Error ? err.message : String(err)}`);
        callback?.(null);
      });
  }

  private async _callApi(systemPrompt: string, userContent: string, signal?: AbortSignal): Promise<unknown | null> {
    // Same truth source as status/audit: whatever readiness says is unavailable is
    // exactly what fails here, with the same reason.
    const readiness = this._readiness;
    if (!readiness.ready) {
      const key = `${readiness.effectiveModel}|${readiness.reason ?? ''}`;
      if (key !== this._loggedReadinessKey) {
        this._loggedReadinessKey = key;
        this.logger.error(`[ReviewerClient] ${describeReviewerUnavailableForUser()}`);
      }
      return null;
    }
    this._loggedReadinessKey = '';

    if (this.runtimeComplete) {
      const result = await this.runtimeComplete({
        messages: [{ role: 'user', content: userContent }],
        // Empty supervisorModel means dynamic inheritance. Omitting `model`
        // lets the host choose the current main model and auth profile.
        ...(this.supervisorConfig.supervisorModel.trim()
          ? { model: readiness.effectiveModel }
          : {}),
        systemPrompt,
        temperature: 0,
        purpose: 'dual-model-supervisor review',
        signal,
      });
      if (!result.text.trim()) {
        this.logger.error('Reviewer API returned empty content');
        return null;
      }
      const parsedJson = parseJsonFromResponse(result.text);
      if (parsedJson === null) {
        this.logger.error('[ReviewerClient] Failed to parse JSON from response');
        return null;
      }
      return parsedJson;
    }

    // Non-null by construction: readiness.ready ⇒ model parses, provider exists with
    // auth + baseUrl, and the adapter resolved.
    const parsed = parseModelRef(readiness.effectiveModel)!;
    const providerCfg = this.providers[parsed.provider];
    const base = providerCfg.baseUrl!.trim();
    const adapter = this._adapter!;

    const url =
      adapter.protocol === 'anthropic-messages'
        ? resolveAnthropicMessagesRequestUrl(base)
        : trimUrl(base);
    const headers = adapter.buildHeaders(providerCfg);
    const body = adapter.buildBody(providerCfg, parsed.modelId, systemPrompt, userContent);

    // Hard cap for ungated callers; the caller's gate signal (when present) cancels earlier.
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      this.logger.error(`Reviewer API error ${response.status}: ${text.slice(0, 200)}`);
      return null;
    }

    const data = await response.json() as Record<string, unknown>;
    const content = adapter.extractText(data);

    if (!content || (typeof content === 'string' && content.trim().length === 0)) {
      this.logger.error('Reviewer API returned empty content');
      return null;
    }

    const parsedJson = parseJsonFromResponse(content);
    if (parsedJson === null) {
      this.logger.error('[ReviewerClient] Failed to parse JSON from response');
      return null;
    }

    return parsedJson;
  }
}

function parseJsonFromResponse(content: string): unknown | null {
  try {
    return JSON.parse(content);
  } catch { /* continue */ }

  const fenceMatch = content.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) {
    try { return JSON.parse(fenceMatch[1]); } catch { /* continue */ }
  }

  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try { return JSON.parse(jsonMatch[0]); } catch { /* give up */ }
  }

  return null;
}

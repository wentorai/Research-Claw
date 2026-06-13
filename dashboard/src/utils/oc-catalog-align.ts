/**
 * OC → RC model-card alignment (pure, compute-only).
 *
 * OpenClaw's gateway `models.list` exposes an authoritative model catalog
 * (src/gateway/server-methods/models.ts → { models: ModelCatalogEntry[] }).
 * RC's dashboard historically built model cards from a hand-maintained static
 * mirror (provider-presets.ts) + a 32K contextWindow fallback, so a card's
 * contextWindow could drift far from OC's real value (e.g. glm-5v-turbo wrote
 * 32_000 while OC's catalog says 202_800). A wrong contextWindow mis-sizes the
 * preemptive-compaction trigger.
 *
 * This module resolves the authoritative card fields for a configured model by
 * matching it against the OC catalog. It only COMPUTES — callers decide whether
 * to write the result back into config.
 *
 * Authoritative fields (present on ModelCatalogEntry):
 *   - contextWindow  (also accepts contextTokens as an alias)
 *   - input
 *   - reasoning      (only when the catalog entry carries it)
 * NOT managed here:
 *   - maxTokens      (absent from ModelCatalogEntry → caller keeps RC's value)
 *   - api            (left to the protocol probe → never touched)
 */

/** Subset of OpenClaw's ModelCatalogEntry that the dashboard consumes. */
export interface OcModelCatalogEntry {
  id: string;
  name?: string;
  provider: string;
  contextWindow?: number;
  contextTokens?: number;
  reasoning?: boolean;
  input?: string[];
  api?: string;
}

/** An RC model card as stored under models.providers[].models[]. */
export interface RcModelCard {
  id: string;
  name?: string;
  reasoning?: boolean;
  input?: string[];
  contextWindow?: number;
  maxTokens?: number;
  [key: string]: unknown;
}

export type CatalogMatchKind = 'exact' | 'basename' | 'none';

export interface CardAlignment {
  /** Aligned card (a NEW object; input authored back as a fresh array). */
  card: RcModelCard;
  /** Whether any managed field actually changed. */
  changed: boolean;
  /** How the OC entry was located. */
  matched: CatalogMatchKind;
  /** The OC entry that supplied authoritative values (when matched). */
  source?: OcModelCatalogEntry;
  before: Pick<RcModelCard, 'contextWindow' | 'input' | 'reasoning'>;
  after: Pick<RcModelCard, 'contextWindow' | 'input' | 'reasoning'>;
}

/** contextWindow with contextTokens accepted as an alias. */
function entryContextWindow(entry: OcModelCatalogEntry): number | undefined {
  return entry.contextWindow ?? entry.contextTokens;
}

function sameInput(a: string[] | undefined, b: string[] | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

/**
 * Find the authoritative OC catalog entry for a configured model.
 *
 * Match strategy:
 *   1. exact:    catalog entry whose provider AND id both equal the configured
 *                provider/id (RC may declare a model under a custom provider key
 *                that collides with OC's native key, e.g. deepseek/deepseek-v4-pro).
 *   2. basename: no exact hit → match by model id across ANY provider (RC custom
 *                provider keys like "zai-coding" do not equal OC's "zai", so the
 *                only way to reach the authoritative value is by id). When several
 *                providers expose the same id, take the one with the LARGEST
 *                contextWindow (never shrink a window and trip compaction early).
 *   3. none:     genuinely custom model OC has never heard of → caller keeps the
 *                user's own values.
 */
export function findCatalogEntry(
  provider: string,
  modelId: string,
  catalog: OcModelCatalogEntry[],
): { entry: OcModelCatalogEntry; matched: 'exact' | 'basename' } | null {
  const exact = catalog.find((e) => e.provider === provider && e.id === modelId);
  if (exact) return { entry: exact, matched: 'exact' };

  const byId = catalog.filter((e) => e.id === modelId);
  if (byId.length === 0) return null;

  const best = byId.reduce((acc, e) =>
    (entryContextWindow(e) ?? -1) > (entryContextWindow(acc) ?? -1) ? e : acc,
  );
  return { entry: best, matched: 'basename' };
}

/**
 * Align one RC model card against the OC catalog.
 *
 * Pure: returns a fresh card; the input card is not mutated. Only contextWindow,
 * input, and reasoning may change — and reasoning only when the matched OC entry
 * actually carries it. maxTokens, api, name, and any other fields pass through
 * untouched.
 */
export function alignCardWithCatalog(
  provider: string,
  card: RcModelCard,
  catalog: OcModelCatalogEntry[],
): CardAlignment {
  const before = {
    contextWindow: card.contextWindow,
    input: card.input ? [...card.input] : card.input,
    reasoning: card.reasoning,
  };

  const hit = findCatalogEntry(provider, card.id, catalog);
  if (!hit) {
    return {
      card: { ...card },
      changed: false,
      matched: 'none',
      before,
      after: before,
    };
  }

  const next: RcModelCard = { ...card };
  const ctx = entryContextWindow(hit.entry);
  if (ctx != null) next.contextWindow = ctx;
  if (hit.entry.input) next.input = [...hit.entry.input];
  if (hit.entry.reasoning !== undefined) next.reasoning = hit.entry.reasoning;

  const changed =
    next.contextWindow !== before.contextWindow ||
    !sameInput(next.input, before.input) ||
    next.reasoning !== before.reasoning;

  return {
    card: next,
    changed,
    matched: hit.matched,
    source: hit.entry,
    before,
    after: {
      contextWindow: next.contextWindow,
      input: next.input,
      reasoning: next.reasoning,
    },
  };
}

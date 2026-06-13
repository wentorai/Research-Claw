import { describe, it, expect } from 'vitest';
import {
  alignCardWithCatalog,
  findCatalogEntry,
  type OcModelCatalogEntry,
  type RcModelCard,
} from './oc-catalog-align';
import { ocModelsListAllPayload } from '../__fixtures__/gateway-payloads/oc-model-catalog';

const catalog = ocModelsListAllPayload.models;

// RC config cards as shipped in research-claw/config/openclaw.json.
const RC_CARDS: Record<string, { provider: string; card: RcModelCard }> = {
  deepseek: {
    provider: 'deepseek',
    card: {
      id: 'deepseek-v4-pro',
      name: 'deepseek-v4-pro',
      reasoning: true,
      input: ['text'],
      contextWindow: 1_000_000,
      maxTokens: 384_000,
    },
  },
  openai: {
    provider: 'openai',
    card: {
      id: 'gpt-5.4',
      name: 'gpt-5.4',
      reasoning: true,
      input: ['text', 'image'],
      contextWindow: 128_000,
      maxTokens: 16_384,
    },
  },
  zai: {
    provider: 'zai-coding',
    card: {
      id: 'glm-5v-turbo',
      name: 'glm-5v-turbo',
      reasoning: false,
      input: ['text', 'image'],
      contextWindow: 32_000,
      maxTokens: 16_384,
    },
  },
  minimax: {
    provider: 'minimax',
    card: {
      id: 'MiniMax-M2.7',
      name: 'MiniMax-M2.7',
      reasoning: true,
      input: ['text'],
      contextWindow: 200_000,
      maxTokens: 8_192,
    },
  },
};

describe('findCatalogEntry', () => {
  it('prefers an exact provider+id match over other providers exposing the same id', () => {
    // gpt-5.4 lives under both github-copilot (128K) and openai (272K).
    const hit = findCatalogEntry('openai', 'gpt-5.4', catalog);
    expect(hit?.matched).toBe('exact');
    expect(hit?.entry.provider).toBe('openai');
    expect(hit?.entry.contextWindow).toBe(272_000);
  });

  it('falls back to a basename match when the provider key differs (zai-coding → zai)', () => {
    const hit = findCatalogEntry('zai-coding', 'glm-5v-turbo', catalog);
    expect(hit?.matched).toBe('basename');
    expect(hit?.entry.provider).toBe('zai');
    expect(hit?.entry.contextWindow).toBe(202_800);
  });

  it('returns null for a model OC has never heard of', () => {
    expect(findCatalogEntry('minimax', 'MiniMax-M2.7', catalog)).toBeNull();
  });

  it('on a basename collision picks the largest contextWindow', () => {
    const synthetic: OcModelCatalogEntry[] = [
      { id: 'x', provider: 'a', contextWindow: 100 },
      { id: 'x', provider: 'b', contextWindow: 900 },
      { id: 'x', provider: 'c', contextWindow: 500 },
    ];
    const hit = findCatalogEntry('unknown', 'x', synthetic);
    expect(hit?.matched).toBe('basename');
    expect(hit?.entry.provider).toBe('b');
    expect(hit?.entry.contextWindow).toBe(900);
  });
});

describe('alignCardWithCatalog — real RC models against OC 2026.6.1', () => {
  it('deepseek/deepseek-v4-pro: 1M already authoritative → unchanged', () => {
    const { provider, card } = RC_CARDS.deepseek;
    const r = alignCardWithCatalog(provider, card, catalog);
    expect(r.matched).toBe('exact');
    expect(r.changed).toBe(false);
    expect(r.after.contextWindow).toBe(1_000_000);
    expect(r.card.maxTokens).toBe(384_000); // RC-only field preserved
    expect(r.card.reasoning).toBe(true); // OC entry carries no reasoning → keep RC
  });

  it('openai/gpt-5.4: stale 128K → OC 272K', () => {
    const { provider, card } = RC_CARDS.openai;
    const r = alignCardWithCatalog(provider, card, catalog);
    expect(r.matched).toBe('exact');
    expect(r.changed).toBe(true);
    expect(r.before.contextWindow).toBe(128_000);
    expect(r.after.contextWindow).toBe(272_000);
    expect(r.card.maxTokens).toBe(16_384);
  });

  it('zai-coding/glm-5v-turbo: stale 32K → OC 202.8K via basename', () => {
    const { provider, card } = RC_CARDS.zai;
    const r = alignCardWithCatalog(provider, card, catalog);
    expect(r.matched).toBe('basename');
    expect(r.changed).toBe(true);
    expect(r.before.contextWindow).toBe(32_000);
    expect(r.after.contextWindow).toBe(202_800);
    expect(r.card.reasoning).toBe(false); // unchanged
  });

  it('minimax/MiniMax-M2.7: not in OC catalog → all values preserved', () => {
    const { provider, card } = RC_CARDS.minimax;
    const r = alignCardWithCatalog(provider, card, catalog);
    expect(r.matched).toBe('none');
    expect(r.changed).toBe(false);
    expect(r.card.contextWindow).toBe(200_000);
    expect(r.card.maxTokens).toBe(8_192);
    expect(r.card).toEqual(card); // identical content
  });
});

describe('alignCardWithCatalog — field-level rules', () => {
  it('adopts reasoning only when the OC entry carries it', () => {
    const withReasoning: OcModelCatalogEntry[] = [
      { id: 'm', provider: 'p', contextWindow: 50_000, reasoning: true },
    ];
    const card: RcModelCard = { id: 'm', reasoning: false, contextWindow: 10_000 };
    const r = alignCardWithCatalog('p', card, withReasoning);
    expect(r.card.reasoning).toBe(true);
    expect(r.card.contextWindow).toBe(50_000);
    expect(r.changed).toBe(true);
  });

  it('keeps RC reasoning when the OC entry omits it', () => {
    const noReasoning: OcModelCatalogEntry[] = [
      { id: 'm', provider: 'p', contextWindow: 10_000 },
    ];
    const card: RcModelCard = { id: 'm', reasoning: true, contextWindow: 10_000 };
    const r = alignCardWithCatalog('p', card, noReasoning);
    expect(r.card.reasoning).toBe(true);
    expect(r.changed).toBe(false);
  });

  it('keeps RC contextWindow when the OC entry has neither contextWindow nor contextTokens', () => {
    const noCtx: OcModelCatalogEntry[] = [
      { id: 'm', provider: 'p', input: ['text'] },
    ];
    const card: RcModelCard = { id: 'm', contextWindow: 12_345, input: ['text'] };
    const r = alignCardWithCatalog('p', card, noCtx);
    expect(r.matched).toBe('exact');
    expect(r.after.contextWindow).toBe(12_345);
    expect(r.changed).toBe(false);
  });

  it('accepts contextTokens as a contextWindow alias', () => {
    const aliased: OcModelCatalogEntry[] = [
      { id: 'm', provider: 'p', contextTokens: 64_000 },
    ];
    const card: RcModelCard = { id: 'm', contextWindow: 8_000 };
    const r = alignCardWithCatalog('p', card, aliased);
    expect(r.after.contextWindow).toBe(64_000);
  });

  it('never mutates the input card', () => {
    const card: RcModelCard = { id: 'gpt-5.4', contextWindow: 128_000 };
    const snapshot = JSON.parse(JSON.stringify(card));
    alignCardWithCatalog('openai', card, catalog);
    expect(card).toEqual(snapshot);
  });

  it('aligning an already-aligned card is a no-op (idempotent)', () => {
    const { provider, card } = RC_CARDS.openai;
    const first = alignCardWithCatalog(provider, card, catalog);
    const second = alignCardWithCatalog(provider, first.card, catalog);
    expect(second.changed).toBe(false);
    expect(second.card).toEqual(first.card);
  });
});

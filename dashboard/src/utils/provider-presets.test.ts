/**
 * Tests for provider-presets.ts
 * Covers MiniMax M2.7 model additions (PR #18) and general preset integrity.
 */
import { describe, it, expect } from 'vitest';
import {
  PROVIDER_PRESETS,
  getPreset,
  detectPresetFromProvider,
} from './provider-presets';

describe('MiniMax provider presets (PR #18)', () => {
  const minimax = PROVIDER_PRESETS.find((p) => p.id === 'minimax')!;
  const minimaxCn = PROVIDER_PRESETS.find((p) => p.id === 'minimax-cn')!;

  it('both MiniMax presets exist', () => {
    expect(minimax).toBeDefined();
    expect(minimaxCn).toBeDefined();
  });

  it('international preset contains M2.7 and M2.7-highspeed models', () => {
    const ids = minimax.models.map((m) => m.id);
    expect(ids).toContain('MiniMax-M2.7');
    expect(ids).toContain('MiniMax-M2.7-highspeed');
  });

  it('CN preset contains M2.7 and M2.7-highspeed models', () => {
    const ids = minimaxCn.models.map((m) => m.id);
    expect(ids).toContain('MiniMax-M2.7');
    expect(ids).toContain('MiniMax-M2.7-highspeed');
  });

  it('M2.7 models are positioned before M2.5 models (default selection)', () => {
    const m27Idx = minimax.models.findIndex((m) => m.id === 'MiniMax-M2.7');
    const m25Idx = minimax.models.findIndex((m) => m.id === 'MiniMax-M2.5');
    expect(m27Idx).toBeLessThan(m25Idx);

    const m27CnIdx = minimaxCn.models.findIndex((m) => m.id === 'MiniMax-M2.7');
    const m25CnIdx = minimaxCn.models.findIndex((m) => m.id === 'MiniMax-M2.5');
    expect(m27CnIdx).toBeLessThan(m25CnIdx);
  });

  it('M2.7 is the first model (becomes default on provider selection)', () => {
    expect(minimax.models[0].id).toBe('MiniMax-M2.7');
    expect(minimaxCn.models[0].id).toBe('MiniMax-M2.7');
  });

  it('M2.7 models have correct properties', () => {
    const m27 = minimax.models.find((m) => m.id === 'MiniMax-M2.7')!;
    const m27hs = minimax.models.find((m) => m.id === 'MiniMax-M2.7-highspeed')!;

    expect(m27.reasoning).toBe(true);
    expect(m27.input).toEqual(['text']);
    expect(m27.contextWindow).toBe(200_000);
    expect(m27.maxTokens).toBe(8_192);

    expect(m27hs.reasoning).toBe(true);
    expect(m27hs.input).toEqual(['text']);
    expect(m27hs.contextWindow).toBe(200_000);
    expect(m27hs.maxTokens).toBe(8_192);
  });

  it('CN preset M2.7 models have identical properties to international', () => {
    const intl = minimax.models.filter((m) => m.id.startsWith('MiniMax-M2.7'));
    const cn = minimaxCn.models.filter((m) => m.id.startsWith('MiniMax-M2.7'));

    expect(intl.length).toBe(2);
    expect(cn.length).toBe(2);

    for (let i = 0; i < intl.length; i++) {
      expect(cn[i].id).toBe(intl[i].id);
      expect(cn[i].reasoning).toBe(intl[i].reasoning);
      expect(cn[i].input).toEqual(intl[i].input);
      expect(cn[i].contextWindow).toBe(intl[i].contextWindow);
      expect(cn[i].maxTokens).toBe(intl[i].maxTokens);
    }
  });

  it('MiniMax international uses correct endpoint and API protocol', () => {
    expect(minimax.baseUrl).toBe('https://api.minimax.io/anthropic');
    expect(minimax.api).toBe('anthropic-messages');
  });

  it('MiniMax CN uses correct endpoint and API protocol', () => {
    expect(minimaxCn.baseUrl).toBe('https://api.minimaxi.com/anthropic');
    expect(minimaxCn.api).toBe('anthropic-messages');
  });

  it('still contains VL-01 vision model alongside M2.7', () => {
    const ids = minimax.models.map((m) => m.id);
    expect(ids).toContain('MiniMax-VL-01');
    const vl01 = minimax.models.find((m) => m.id === 'MiniMax-VL-01')!;
    expect(vl01.input).toContain('image');
  });
});

describe('getPreset', () => {
  it('returns minimax preset by id', () => {
    const preset = getPreset('minimax');
    expect(preset.id).toBe('minimax');
  });

  it('returns minimax-cn preset by id', () => {
    const preset = getPreset('minimax-cn');
    expect(preset.id).toBe('minimax-cn');
  });

  it('falls back to custom for unknown id', () => {
    const preset = getPreset('nonexistent-provider');
    expect(preset.id).toBe('custom');
  });
});

describe('detectPresetFromProvider', () => {
  it('detects minimax by provider key', () => {
    expect(detectPresetFromProvider('minimax')).toBe('minimax');
  });

  it('detects minimax-cn by provider key', () => {
    expect(detectPresetFromProvider('minimax-cn')).toBe('minimax-cn');
  });

  it('falls back to custom for empty provider', () => {
    expect(detectPresetFromProvider('')).toBe('custom');
  });
});

describe('DeepSeek provider preset', () => {
  const deepseek = PROVIDER_PRESETS.find((p) => p.id === 'deepseek')!;

  it('exists with official endpoint and OpenAI-compatible protocol', () => {
    expect(deepseek).toBeDefined();
    expect(deepseek.baseUrl).toBe('https://api.deepseek.com');
    expect(deepseek.api).toBe('openai-completions');
  });

  it('contains deepseek-v4-flash and deepseek-v4-pro models', () => {
    const ids = deepseek.models.map((m) => m.id);
    expect(ids).toContain('deepseek-v4-flash');
    expect(ids).toContain('deepseek-v4-pro');
  });

  it('uses documented context and output limits', () => {
    const flash = deepseek.models.find((m) => m.id === 'deepseek-v4-flash')!;
    const pro = deepseek.models.find((m) => m.id === 'deepseek-v4-pro')!;

    expect(flash.contextWindow).toBe(1_000_000);
    expect(pro.contextWindow).toBe(1_000_000);
    expect(flash.maxTokens).toBe(384_000);
    expect(pro.maxTokens).toBe(384_000);
  });

  it('marks DeepSeek v4 models as reasoning models', () => {
    const flash = deepseek.models.find((m) => m.id === 'deepseek-v4-flash')!;
    const pro = deepseek.models.find((m) => m.id === 'deepseek-v4-pro')!;
    expect(flash.reasoning).toBe(true);
    expect(pro.reasoning).toBe(true);
  });

  it('can be resolved by provider key', () => {
    expect(detectPresetFromProvider('deepseek')).toBe('deepseek');
    expect(getPreset('deepseek').id).toBe('deepseek');
  });
});

/**
 * Tests for provider-presets.ts
 * Covers MiniMax M3/M2.7 model support and general preset integrity.
 */
import { describe, it, expect } from 'vitest';
import {
  PROVIDER_PRESETS,
  getPreset,
  detectPresetFromProvider,
  inferApiFromUrl,
  protocolProbeOrder,
} from './provider-presets';

describe('MiniMax provider presets', () => {
  const minimax = PROVIDER_PRESETS.find((p) => p.id === 'minimax')!;
  const minimaxCn = PROVIDER_PRESETS.find((p) => p.id === 'minimax-cn')!;

  it('both MiniMax presets exist', () => {
    expect(minimax).toBeDefined();
    expect(minimaxCn).toBeDefined();
  });

  it('international preset contains M3, M2.7, and M2.7-highspeed models', () => {
    const ids = minimax.models.map((m) => m.id);
    expect(ids).toContain('MiniMax-M3');
    expect(ids).toContain('MiniMax-M2.7');
    expect(ids).toContain('MiniMax-M2.7-highspeed');
  });

  it('CN preset contains M3, M2.7, and M2.7-highspeed models', () => {
    const ids = minimaxCn.models.map((m) => m.id);
    expect(ids).toContain('MiniMax-M3');
    expect(ids).toContain('MiniMax-M2.7');
    expect(ids).toContain('MiniMax-M2.7-highspeed');
  });

  it('M3 is positioned before M2.7 and M2.5 models (default selection)', () => {
    const m3Idx = minimax.models.findIndex((m) => m.id === 'MiniMax-M3');
    const m27Idx = minimax.models.findIndex((m) => m.id === 'MiniMax-M2.7');
    const m25Idx = minimax.models.findIndex((m) => m.id === 'MiniMax-M2.5');
    expect(m3Idx).toBeLessThan(m27Idx);
    expect(m27Idx).toBeLessThan(m25Idx);

    const m3CnIdx = minimaxCn.models.findIndex((m) => m.id === 'MiniMax-M3');
    const m27CnIdx = minimaxCn.models.findIndex((m) => m.id === 'MiniMax-M2.7');
    const m25CnIdx = minimaxCn.models.findIndex((m) => m.id === 'MiniMax-M2.5');
    expect(m3CnIdx).toBeLessThan(m27CnIdx);
    expect(m27CnIdx).toBeLessThan(m25CnIdx);
  });

  it('M3 is the first model (becomes default on provider selection)', () => {
    expect(minimax.models[0].id).toBe('MiniMax-M3');
    expect(minimaxCn.models[0].id).toBe('MiniMax-M3');
  });

  it('M3 has OpenClaw 6.1 properties', () => {
    const m3 = minimax.models.find((m) => m.id === 'MiniMax-M3')!;

    expect(m3.reasoning).toBe(true);
    expect(m3.input).toEqual(['text', 'image']);
    expect(m3.contextWindow).toBe(1_000_000);
    expect(m3.maxTokens).toBe(131_072);
  });

  it('M2.7 models have correct properties', () => {
    const m27 = minimax.models.find((m) => m.id === 'MiniMax-M2.7')!;
    const m27hs = minimax.models.find((m) => m.id === 'MiniMax-M2.7-highspeed')!;

    expect(m27.reasoning).toBe(true);
    expect(m27.input).toEqual(['text']);
    expect(m27.contextWindow).toBe(204_800);
    expect(m27.maxTokens).toBe(131_072);

    expect(m27hs.reasoning).toBe(true);
    expect(m27hs.input).toEqual(['text']);
    expect(m27hs.contextWindow).toBe(204_800);
    expect(m27hs.maxTokens).toBe(131_072);
  });

  it('CN preset M3/M2.7 models have identical properties to international', () => {
    const trackedIds = new Set(['MiniMax-M3', 'MiniMax-M2.7', 'MiniMax-M2.7-highspeed']);
    const intl = minimax.models.filter((m) => trackedIds.has(m.id));
    const cn = minimaxCn.models.filter((m) => trackedIds.has(m.id));

    expect(intl.length).toBe(3);
    expect(cn.length).toBe(3);

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

  it('still contains VL-01 vision model alongside M3/M2.7', () => {
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

describe('Moonshot Kimi K3 model', () => {
  const cn = PROVIDER_PRESETS.find((p) => p.id === 'moonshot-cn')!;
  const intl = PROVIDER_PRESETS.find((p) => p.id === 'moonshot')!;

  it('exists in both moonshot presets', () => {
    expect(cn.models.map((m) => m.id)).toContain('kimi-k3');
    expect(intl.models.map((m) => m.id)).toContain('kimi-k3');
  });

  it('uses the documented 1M context and 131K output cap', () => {
    for (const preset of [cn, intl]) {
      const k3 = preset.models.find((m) => m.id === 'kimi-k3')!;
      expect(k3.contextWindow).toBe(1_048_576);
      expect(k3.maxTokens).toBe(131_072);
    }
  });

  it('is marked as a reasoning model (thinking-only per Moonshot /v1/models)', () => {
    // Without reasoning: true the idle watchdog kills K3 during its think phase.
    for (const preset of [cn, intl]) {
      expect(preset.models.find((m) => m.id === 'kimi-k3')!.reasoning).toBe(true);
    }
  });

  it('accepts image input', () => {
    expect(cn.models.find((m) => m.id === 'kimi-k3')!.input).toContain('image');
  });
});

describe('inferApiFromUrl', () => {
  it('defaults to openai-completions for empty url', () => {
    expect(inferApiFromUrl('')).toBe('openai-completions');
  });

  it('returns openai-completions for an OpenAI-compatible url', () => {
    expect(inferApiFromUrl('https://api.openai.com/v1')).toBe('openai-completions');
  });

  it('returns anthropic-messages for a url with /anthropic path', () => {
    expect(inferApiFromUrl('https://foo/anthropic')).toBe('anthropic-messages');
  });

  it('returns anthropic-messages for the anthropic.com host', () => {
    expect(inferApiFromUrl('https://api.anthropic.com')).toBe('anthropic-messages');
  });
});

describe('protocolProbeOrder', () => {
  it('probes anthropic-messages first for the anthropic.com host', () => {
    expect(protocolProbeOrder('https://api.anthropic.com')).toEqual([
      'anthropic-messages',
      'openai-completions',
      'openai-responses',
    ]);
  });

  it('probes anthropic-messages first for a /anthropic path', () => {
    expect(protocolProbeOrder('https://api.minimax.io/anthropic')).toEqual([
      'anthropic-messages',
      'openai-completions',
      'openai-responses',
    ]);
  });

  it('probes openai-completions first for an OpenAI-compatible url', () => {
    expect(protocolProbeOrder('https://api.deepseek.com')).toEqual([
      'openai-completions',
      'openai-responses',
      'anthropic-messages',
    ]);
  });

  it('probes openai-completions first for a non-anthropic vendor url', () => {
    expect(protocolProbeOrder('https://open.bigmodel.cn/api/coding/paas/v4')).toEqual([
      'openai-completions',
      'openai-responses',
      'anthropic-messages',
    ]);
  });

  it('falls back to completions-first for an empty url', () => {
    expect(protocolProbeOrder('')).toEqual([
      'openai-completions',
      'openai-responses',
      'anthropic-messages',
    ]);
  });

  it('falls back to completions-first for garbage input without throwing', () => {
    // @ts-expect-error — intentionally passing non-string garbage to assert robustness
    expect(protocolProbeOrder({ not: 'a url' })).toEqual([
      'openai-completions',
      'openai-responses',
      'anthropic-messages',
    ]);
  });
});

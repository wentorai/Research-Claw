import { describe, expect, it } from 'vitest';

describe('rc.supervisor.config allowlist', () => {
  const ALLOWED_KEYS = [
    'enabled', 'supervisorModel', 'reviewMode',
    'appendReviewToChannelOutput', 'memoryGuard',
    'courseCorrection', 'highRiskTools',
  ];

  it('filters out unknown keys from params', () => {
    const params = {
      supervisorModel: 'test/model',
      __proto__: {},
      constructor: 'evil',
      unknownKey: 'should-be-filtered',
    };

    const filtered: Record<string, unknown> = {};
    for (const key of ALLOWED_KEYS) {
      if (key in params) {
        filtered[key] = (params as Record<string, unknown>)[key];
      }
    }

    expect(Object.keys(filtered)).toEqual(['supervisorModel']);
    expect(filtered).not.toHaveProperty('__proto__');
    expect(filtered).not.toHaveProperty('constructor');
    expect(filtered).not.toHaveProperty('unknownKey');
  });

  it('accepts all known keys when provided', () => {
    const params: Record<string, unknown> = {
      enabled: true,
      supervisorModel: 'openai/gpt-4o-mini',
      reviewMode: 'correct',
      appendReviewToChannelOutput: false,
      memoryGuard: { enabled: true, keyCategories: [] },
      courseCorrection: { enabled: false, deviationThreshold: 0.5, forceRegenerate: false, maxRegenerateAttempts: 3 },
      highRiskTools: ['bash'],
      extraField: 'nope',
    };

    const filtered: Record<string, unknown> = {};
    for (const key of ALLOWED_KEYS) {
      if (key in params) {
        filtered[key] = params[key];
      }
    }

    expect(Object.keys(filtered).sort()).toEqual(ALLOWED_KEYS.slice().sort());
    expect(filtered).not.toHaveProperty('extraField');
  });

  it('returns empty object when no known keys are present', () => {
    const params = {
      foo: 'bar',
      baz: 123,
    };

    const filtered: Record<string, unknown> = {};
    for (const key of ALLOWED_KEYS) {
      if (key in params) {
        filtered[key] = (params as Record<string, unknown>)[key];
      }
    }

    expect(Object.keys(filtered).length).toBe(0);
  });
});

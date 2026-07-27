import { describe, expect, it } from 'vitest';
import { parseConfig } from '../core/config.js';

describe('rc.supervisor.config allowlist', () => {
  const ALLOWED_KEYS = [
    'enabled', 'supervisorModel', 'reviewMode',
    'courseCorrection', 'highRiskTools',
    'dangerousToolPolicy', 'toolReviewGateMs', 'grounding',
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
      courseCorrection: { enabled: false, deviationThreshold: 0.5, forceRegenerate: false, maxRegenerateAttempts: 3 },
      highRiskTools: ['bash'],
      dangerousToolPolicy: 'approve',
      toolReviewGateMs: 2000,
      grounding: { networkPolicy: 'off', verdictMode: 'flag' },
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

describe('rc.supervisor.config nested merge', () => {
  it('preserves courseCorrection sub-fields on partial update', () => {
    const current = {
      enabled: true,
      supervisorModel: 'test/model',
      reviewMode: 'correct' as const,
      courseCorrection: {
        enabled: true,
        deviationThreshold: 0.8,
        forceRegenerate: true,
        maxRegenerateAttempts: 5,
      },
      highRiskTools: ['exec'],
    };

    // Simulate partial update: only change deviationThreshold
    const filtered: Record<string, unknown> = { courseCorrection: { deviationThreshold: 0.3 } };

    const merged: Record<string, unknown> = { ...current, ...filtered };
    if (filtered.courseCorrection && typeof filtered.courseCorrection === 'object' && current.courseCorrection) {
      merged.courseCorrection = { ...current.courseCorrection, ...(filtered.courseCorrection as Record<string, unknown>) };
    }

    const result = parseConfig(merged);
    expect(result.courseCorrection.deviationThreshold).toBe(0.3);
    expect(result.courseCorrection.enabled).toBe(true);
    expect(result.courseCorrection.forceRegenerate).toBe(true);
    expect(result.courseCorrection.maxRegenerateAttempts).toBe(5);
  });

});

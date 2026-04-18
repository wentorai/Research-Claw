import { describe, expect, it } from 'vitest';
import {
  validateReviewResult,
  validateToolReviewResult,
  validateConsistencyResult,
  validateTaskParsingResult,
  validateMessageSummary,
  validateMemoryLossItems,
  validateDeviationAnalysis,
} from '../core/validators.js';

describe('validateReviewResult', () => {
  it('accepts valid response', () => {
    const r = validateReviewResult({
      blocked: false,
      corrected: false,
      warnings: ['test warning'],
      memoryAlerts: [],
      deviationScore: 0.3,
      qualityScore: 0.9,
      reportText: 'Looks good',
    });
    expect(r).not.toBeNull();
    expect(r!.blocked).toBe(false);
    expect(r!.warnings).toEqual(['test warning']);
    expect(r!.deviationScore).toBe(0.3);
  });

  it('sanitizes non-boolean blocked to false (fail-safe)', () => {
    const r = validateReviewResult({ blocked: 'yes', corrected: 'true' });
    expect(r!.blocked).toBe(false);
    expect(r!.corrected).toBe(false);
  });

  it('clamps scores to 0-1 range', () => {
    const r = validateReviewResult({ blocked: false, deviationScore: 5.0, qualityScore: -1 });
    expect(r!.deviationScore).toBe(1);
    expect(r!.qualityScore).toBe(0);
  });

  it('returns null for non-object input', () => {
    expect(validateReviewResult(null)).toBeNull();
    expect(validateReviewResult('string')).toBeNull();
    expect(validateReviewResult(42)).toBeNull();
  });

  it('filters non-string items from warnings array', () => {
    const r = validateReviewResult({ blocked: false, warnings: ['valid', 42, null, 'also valid'] });
    expect(r!.warnings).toEqual(['valid', 'also valid']);
  });
});

describe('validateToolReviewResult', () => {
  const originalKeys = ['command', 'path', 'content'];

  it('accepts valid response', () => {
    const r = validateToolReviewResult(
      { blocked: false, warnings: [] },
      originalKeys,
    );
    expect(r).not.toBeNull();
    expect(r!.blocked).toBe(false);
  });

  it('filters correctedParams to only original keys (prevents injection)', () => {
    const r = validateToolReviewResult(
      {
        blocked: false,
        correctedParams: {
          command: 'ls -la',        // allowed — exists in original
          path: '/safe/path',       // allowed
          injectedKey: 'malicious', // MUST be filtered out
          __proto__: {},            // MUST be filtered out
        },
        warnings: [],
      },
      originalKeys,
    );
    expect(r).not.toBeNull();
    expect(r!.correctedParams).toEqual({ command: 'ls -la', path: '/safe/path' });
    expect(r!.correctedParams).not.toHaveProperty('injectedKey');
    expect(r!.correctedParams).not.toHaveProperty('__proto__');
  });

  it('rejects correctedParams with no valid keys', () => {
    const r = validateToolReviewResult(
      { blocked: false, correctedParams: { evil: 'data' }, warnings: [] },
      originalKeys,
    );
    expect(r!.correctedParams).toBeUndefined();
  });

  it('handles blocked: "yes" as false (fail-safe)', () => {
    const r = validateToolReviewResult({ blocked: 'yes' }, originalKeys);
    expect(r!.blocked).toBe(false);
  });
});

describe('validateConsistencyResult', () => {
  it('accepts valid response', () => {
    const r = validateConsistencyResult({
      hasIssue: true,
      correction: 'Fix this',
      details: ['Issue 1'],
    });
    expect(r!.hasIssue).toBe(true);
    expect(r!.correction).toBe('Fix this');
  });

  it('defaults hasIssue to false for non-boolean', () => {
    const r = validateConsistencyResult({ hasIssue: 1 });
    expect(r!.hasIssue).toBe(false);
  });
});

describe('validateTaskParsingResult', () => {
  it('accepts valid response', () => {
    const r = validateTaskParsingResult({
      researchGoal: 'Study AI safety',
      targetConclusions: ['Conclusion 1'],
      methodology: 'Literature review',
    });
    expect(r).not.toBeNull();
    expect(r!.researchGoal).toBe('Study AI safety');
  });

  it('returns null when researchGoal is empty', () => {
    expect(validateTaskParsingResult({ researchGoal: '', targetConclusions: [] })).toBeNull();
    expect(validateTaskParsingResult({ researchGoal: '  ', targetConclusions: [] })).toBeNull();
  });

  it('returns null for missing researchGoal', () => {
    expect(validateTaskParsingResult({ targetConclusions: ['x'] })).toBeNull();
  });
});

describe('validateMessageSummary', () => {
  it('accepts valid response with all fields', () => {
    const r = validateMessageSummary({
      claims: ['Claim 1'],
      decisions: [],
      references: ['Ref 1'],
      conditions: [],
      reasoning: ['A therefore B'],
      limitations: ['Limit 1'],
      negations: ['Not X'],
      nextSteps: ['Step 1'],
    });
    expect(r).not.toBeNull();
    expect(r!.claims).toEqual(['Claim 1']);
    expect(r!.negations).toEqual(['Not X']);
  });

  it('returns empty arrays for missing fields', () => {
    const r = validateMessageSummary({});
    expect(r!.claims).toEqual([]);
    expect(r!.decisions).toEqual([]);
  });
});

describe('validateMemoryLossItems', () => {
  it('extracts valid items', () => {
    const items = validateMemoryLossItems({
      lostItems: [
        { category: 'research_goal', content: 'Lost goal', importance: 'critical' },
        { category: 'key_conclusion', content: 'Lost fact' },  // missing importance → default medium
      ],
    });
    expect(items).toHaveLength(2);
    expect(items[1].importance).toBe('medium');
  });

  it('filters invalid items', () => {
    const items = validateMemoryLossItems({
      lostItems: [
        { category: 123, content: 'bad category' },  // non-string category
        'not an object',
        null,
      ],
    });
    expect(items).toHaveLength(0);
  });
});

describe('validateDeviationAnalysis', () => {
  it('clamps deviation score', () => {
    const r = validateDeviationAnalysis({ deviation: 1.5, qualityScore: -0.2 });
    expect(r!.deviation).toBe(1);
    expect(r!.qualityScore).toBe(0);
  });
});

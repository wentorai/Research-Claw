import { describe, it, expect } from 'vitest';
import { fmtTime, fmtActivityRow, safeStringifyDetail } from './activity-log';

// ── fmtTime ───────────────────────────────────────────────────────────

describe('fmtTime', () => {
  it('returns HH:MM:SS for a given timestamp', () => {
    // Use a fixed UTC date and check format (locale-dependent, but always 24h)
    const ts = new Date('2026-03-30T08:05:09Z').getTime();
    const result = fmtTime(ts);
    // Should contain colons and be 8 chars (HH:MM:SS)
    expect(result).toMatch(/^\d{1,2}:\d{2}:\d{2}$/);
  });
});

// ── fmtActivityRow ────────────────────────────────────────────────────

describe('fmtActivityRow', () => {
  it('formats foreground entry without duration', () => {
    const row = fmtActivityRow({
      ts: Date.now(),
      scope: 'foreground',
      text: 'Tool started: search_openalex',
    });
    expect(row).toContain('FG');
    expect(row).toContain('Tool started: search_openalex');
    expect(row).not.toContain('ms');
  });

  it('formats background entry with duration', () => {
    const row = fmtActivityRow({
      ts: Date.now(),
      scope: 'background',
      text: 'Tool returned: get_work',
      durationMs: 1234.5,
    });
    expect(row).toContain('BG');
    expect(row).toContain('Tool returned: get_work');
    expect(row).toContain('1235ms');
  });
});

// ── safeStringifyDetail ───────────────────────────────────────────────

describe('safeStringifyDetail', () => {
  it('serializes normal objects', () => {
    const result = safeStringifyDetail({ foo: 'bar', num: 42 });
    expect(JSON.parse(result)).toEqual({ foo: 'bar', num: 42 });
  });

  it('handles null', () => {
    expect(safeStringifyDetail(null)).toBe('null');
  });

  it('handles undefined', () => {
    // JSON.stringify(undefined) returns undefined (not a string),
    // but wrapped in an object it becomes null. Direct undefined
    // should not crash.
    const result = safeStringifyDetail(undefined);
    // undefined is not valid JSON; our function should not crash
    expect(typeof result).toBe('string');
  });

  it('handles circular references without crashing', () => {
    const obj: Record<string, unknown> = { a: 1 };
    obj.self = obj; // circular
    const result = safeStringifyDetail(obj);
    expect(result).toBe('"[unserializable]"');
  });

  it('truncates oversized output at 8KB with marker', () => {
    // Create an object that serializes to > 8KB
    const big = { data: 'x'.repeat(10_000) };
    const result = safeStringifyDetail(big);
    expect(result.length).toBeLessThanOrEqual(8_000 + 20); // 8KB + marker
    expect(result).toContain('… (truncated)');
  });

  it('does NOT truncate output under 8KB', () => {
    const small = { data: 'x'.repeat(100) };
    const result = safeStringifyDetail(small);
    expect(result).not.toContain('truncated');
    expect(JSON.parse(result)).toEqual(small);
  });

  it('handles nested objects', () => {
    const nested = { a: { b: { c: [1, 2, { d: true }] } } };
    const result = safeStringifyDetail(nested);
    expect(JSON.parse(result)).toEqual(nested);
  });
});

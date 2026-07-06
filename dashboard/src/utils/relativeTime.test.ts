/**
 * relativeTime Utility — Unit Tests (GAP-12)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { relativeTime } from './relativeTime';

describe('relativeTime', () => {
  beforeEach(() => {
    // Fix the current time for deterministic tests
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-14T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Null/undefined handling ────────────────────────────────────────

  it('returns "Never run" for null (EN)', () => {
    expect(relativeTime(null, 'en')).toBe('Never run');
  });

  it('returns "从未运行" for null (ZH)', () => {
    expect(relativeTime(null, 'zh-CN')).toBe('从未运行');
  });

  it('returns "Never run" for undefined (EN)', () => {
    expect(relativeTime(undefined, 'en')).toBe('Never run');
  });

  // ── Recent timestamps (EN) ────────────────────────────────────────

  it('returns "just now" for < 60 seconds ago (EN)', () => {
    const thirtySecsAgo = new Date(Date.now() - 30_000).toISOString();
    expect(relativeTime(thirtySecsAgo, 'en')).toBe('just now');
  });

  it('returns "Xm ago" for < 60 minutes ago (EN)', () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString();
    expect(relativeTime(fiveMinAgo, 'en')).toBe('5m ago');
  });

  it('treats SQLite UTC timestamps as UTC instead of local time', () => {
    expect(relativeTime('2026-03-14 11:55:00', 'en')).toBe('5m ago');
  });

  it('returns "Xh ago" for < 24 hours ago (EN)', () => {
    const threeHoursAgo = new Date(Date.now() - 3 * 3600_000).toISOString();
    expect(relativeTime(threeHoursAgo, 'en')).toBe('3h ago');
  });

  it('returns "Xd ago" for < 7 days ago (EN)', () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 86400_000).toISOString();
    expect(relativeTime(twoDaysAgo, 'en')).toBe('2d ago');
  });

  it('returns full date for >= 7 days ago (EN)', () => {
    const tenDaysAgo = new Date(Date.now() - 10 * 86400_000).toISOString();
    const result = relativeTime(tenDaysAgo, 'en');
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  // ── Recent timestamps (ZH) ────────────────────────────────────────

  it('returns "刚刚" for < 60 seconds ago (ZH)', () => {
    const tenSecsAgo = new Date(Date.now() - 10_000).toISOString();
    expect(relativeTime(tenSecsAgo, 'zh-CN')).toBe('刚刚');
  });

  it('returns "X 分钟前" for < 60 minutes ago (ZH)', () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString();
    expect(relativeTime(fiveMinAgo, 'zh-CN')).toBe('5 分钟前');
  });

  it('returns "X 小时前" for < 24 hours ago (ZH)', () => {
    const threeHoursAgo = new Date(Date.now() - 3 * 3600_000).toISOString();
    expect(relativeTime(threeHoursAgo, 'zh-CN')).toBe('3 小时前');
  });

  it('returns "X 天前" for < 7 days ago (ZH)', () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 86400_000).toISOString();
    expect(relativeTime(twoDaysAgo, 'zh-CN')).toBe('2 天前');
  });

  // ── Future dates ──────────────────────────────────────────────────

  it('returns full date for future timestamps', () => {
    const future = new Date(Date.now() + 86400_000).toISOString();
    const result = relativeTime(future, 'en');
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  // ── Default locale ────────────────────────────────────────────────

  it('defaults to English locale', () => {
    expect(relativeTime(null)).toBe('Never run');
  });
});

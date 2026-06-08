import { describe, it, expect } from 'vitest';
import {
  evaluateSessionFreshness,
  isSessionRowStale,
  readSessionResetPolicy,
} from './session-freshness';

describe('session-freshness', () => {
  describe('readSessionResetPolicy', () => {
    it('reads idle reset from config.session.reset', () => {
      const policy = readSessionResetPolicy({
        session: { reset: { mode: 'idle', idleMinutes: 4320 } },
      });
      expect(policy.mode).toBe('idle');
      expect(policy.idleMinutes).toBe(4320);
    });

    it('reads long idle window from config (RC default ~365 days)', () => {
      const policy = readSessionResetPolicy({
        session: { reset: { mode: 'idle', idleMinutes: 525600 } },
      });
      expect(policy.idleMinutes).toBe(525600);
      const now = Date.parse('2026-06-05T12:00:00.000Z');
      const result = evaluateSessionFreshness(
        { updatedAt: now - 30 * 24 * 60 * 60_000, now },
        policy,
      );
      expect(result.fresh).toBe(true);
    });
  });

  describe('evaluateSessionFreshness', () => {
    const idlePolicy = { mode: 'idle' as const, atHour: 4, idleMinutes: 4320 };

    it('marks session stale after idle window', () => {
      const now = Date.parse('2026-06-05T12:00:00.000Z');
      const last = now - 4321 * 60_000;
      const result = evaluateSessionFreshness({ updatedAt: last, now }, idlePolicy);
      expect(result.fresh).toBe(false);
      expect(result.staleReason).toBe('idle');
    });

    it('keeps session fresh inside idle window', () => {
      const now = Date.parse('2026-06-05T12:00:00.000Z');
      const last = now - 1000 * 60_000;
      const result = evaluateSessionFreshness({ updatedAt: last, now }, idlePolicy);
      expect(result.fresh).toBe(true);
    });
  });

  describe('isSessionRowStale', () => {
    it('uses updatedAt when interaction timestamps are missing', () => {
      const now = Date.parse('2026-06-05T12:00:00.000Z');
      const stale = isSessionRowStale(
        { updatedAt: now - 5000 * 60_000 },
        { mode: 'idle', atHour: 4, idleMinutes: 4320 },
        now,
      );
      expect(stale).toBe(true);
    });
  });
});

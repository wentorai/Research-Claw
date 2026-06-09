import { describe, it, expect } from 'vitest';
import { isHeartbeatSessionKey, isMainSessionKey, normalizeSessionKey, toGatewaySessionKey } from './session-key';

describe('normalizeSessionKey', () => {
  it('strips the canonical agent prefix', () => {
    expect(normalizeSessionKey('agent:main:project-abc')).toBe('project-abc');
    expect(normalizeSessionKey('agent:main:main')).toBe('main');
    expect(normalizeSessionKey('agent:custom:foo')).toBe('foo');
  });

  it('is a no-op for bare keys', () => {
    expect(normalizeSessionKey('project-abc')).toBe('project-abc');
    expect(normalizeSessionKey('main')).toBe('main');
  });

  it('returns empty string for undefined', () => {
    expect(normalizeSessionKey(undefined)).toBe('');
  });
});

describe('isMainSessionKey', () => {
  it('matches bare and canonical main', () => {
    expect(isMainSessionKey('main')).toBe(true);
    expect(isMainSessionKey('agent:main:main')).toBe(true);
  });

  it('rejects non-main keys', () => {
    expect(isMainSessionKey('project-x')).toBe(false);
    expect(isMainSessionKey('agent:main:project-x')).toBe(false);
  });
});

describe('isHeartbeatSessionKey', () => {
  it('matches the isolated heartbeat session (canonical + bare)', () => {
    expect(isHeartbeatSessionKey('agent:main:main:heartbeat')).toBe(true);
    expect(isHeartbeatSessionKey('main:heartbeat')).toBe(true);
    expect(isHeartbeatSessionKey('heartbeat')).toBe(true);
    expect(isHeartbeatSessionKey('agent:main:heartbeat')).toBe(true);
    expect(isHeartbeatSessionKey('agent:main:main:heartbeat:sub')).toBe(true);
  });

  it('does not match real user sessions', () => {
    expect(isHeartbeatSessionKey('main')).toBe(false);
    expect(isHeartbeatSessionKey('agent:main:main')).toBe(false);
    expect(isHeartbeatSessionKey('project-x')).toBe(false);
    expect(isHeartbeatSessionKey('agent:main:project-x')).toBe(false);
  });

  it('does not match substrings that are not a :heartbeat segment', () => {
    expect(isHeartbeatSessionKey('xheartbeat')).toBe(false);
    expect(isHeartbeatSessionKey('heartbeats')).toBe(false);
    expect(isHeartbeatSessionKey('agent:main:my-heartbeat-notes')).toBe(false);
  });
});

describe('toGatewaySessionKey', () => {
  it('prefixes bare keys and preserves canonical keys', () => {
    expect(toGatewaySessionKey('main')).toBe('agent:main:main');
    expect(toGatewaySessionKey('project-x')).toBe('agent:main:project-x');
    expect(toGatewaySessionKey('agent:main:foo')).toBe('agent:main:foo');
    expect(toGatewaySessionKey('')).toBe('agent:main:main');
  });
});

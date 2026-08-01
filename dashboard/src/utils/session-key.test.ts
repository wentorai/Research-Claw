import { describe, it, expect } from 'vitest';
import {
  isHeartbeatSessionKey,
  isInternalSessionNamingKey,
  isMainSessionKey,
  isSubagentSessionKey,
  normalizeSessionKey,
  toGatewaySessionKey,
} from './session-key';

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

describe('isSubagentSessionKey', () => {
  it('matches synthetic subagent sessions (canonical + bare)', () => {
    expect(isSubagentSessionKey('agent:main:subagent:5e8e783e-086f-4f5c-93b6-ba24cd42be93')).toBe(true);
    expect(isSubagentSessionKey('subagent:5e8e783e-086f-4f5c-93b6-ba24cd42be93')).toBe(true);
    expect(isSubagentSessionKey('subagent')).toBe(true);
  });

  it('does not match real user sessions', () => {
    expect(isSubagentSessionKey('main')).toBe(false);
    expect(isSubagentSessionKey('agent:main:main')).toBe(false);
    expect(isSubagentSessionKey('agent:main:project-x')).toBe(false);
    expect(isSubagentSessionKey('agent:main:main:heartbeat')).toBe(false);
  });

  it('does not match substrings that are not a subagent segment', () => {
    expect(isSubagentSessionKey('subagents')).toBe(false);
    expect(isSubagentSessionKey('agent:main:my-subagent-notes')).toBe(false);
  });
});

describe('isInternalSessionNamingKey', () => {
  it('matches the one-shot Research-Claw naming run and only that synthetic segment', () => {
    expect(isInternalSessionNamingKey(
      'agent:main:session-naming:session-name-5e8e783e-086f-4f5c-93b6-ba24cd42be93',
    )).toBe(true);
    expect(isInternalSessionNamingKey(
      'session-naming:session-name-5e8e783e-086f-4f5c-93b6-ba24cd42be93',
    )).toBe(true);
    expect(isInternalSessionNamingKey('agent:main:project-session-naming-notes')).toBe(false);
    expect(isInternalSessionNamingKey('agent:main:project-x')).toBe(false);
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

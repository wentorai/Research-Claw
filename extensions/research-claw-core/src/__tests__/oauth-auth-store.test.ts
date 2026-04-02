import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  apiKeyStatus,
  clearApiKeyProfile,
  setApiKeyProfile,
} from '../oauth/service.js';

const originalHome = process.env.HOME;

function authStorePath(homeDir: string): string {
  return path.join(homeDir, '.openclaw', 'agents', 'main', 'agent', 'auth-profiles.json');
}

describe('oauth auth-profile helpers', () => {
  afterEach(() => {
    process.env.HOME = originalHome;
  });

  it('writes api_key credentials into auth-profiles.json', () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-auth-store-'));
    process.env.HOME = homeDir;

    const result = setApiKeyProfile('zai-coding', 'sk-zai-coding-test');
    const store = JSON.parse(fs.readFileSync(authStorePath(homeDir), 'utf8')) as {
      profiles: Record<string, { type: string; provider: string; key: string }>;
      order?: Record<string, string[]>;
      lastGood?: Record<string, string>;
    };

    expect(result.profileId).toBe('zai-coding:manual');
    expect(store.profiles['zai-coding:manual']).toEqual({
      type: 'api_key',
      provider: 'zai-coding',
      key: 'sk-zai-coding-test',
    });
    expect(store.order?.['zai-coding']).toEqual(['zai-coding:manual']);
    expect(store.lastGood?.['zai-coding']).toBe('zai-coding:manual');
    expect(apiKeyStatus('zai-coding')).toEqual({
      configured: true,
      profileId: 'zai-coding:manual',
      profileType: 'api_key',
    });
  });

  it('clears api_key credentials for a provider', () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-auth-store-'));
    process.env.HOME = homeDir;

    setApiKeyProfile('zai-coding', 'sk-zai-coding-test');
    const result = clearApiKeyProfile('zai-coding');
    const store = JSON.parse(fs.readFileSync(authStorePath(homeDir), 'utf8')) as {
      profiles: Record<string, unknown>;
      order?: Record<string, string[]>;
      lastGood?: Record<string, string>;
    };

    expect(result.removed).toEqual(['zai-coding:manual']);
    expect(store.profiles['zai-coding:manual']).toBeUndefined();
    expect(store.order?.['zai-coding']).toEqual([]);
    expect(store.lastGood?.['zai-coding']).toBeUndefined();
    expect(apiKeyStatus('zai-coding')).toEqual({
      configured: false,
      profileId: null,
      profileType: null,
    });
  });
});

import { describe, it, expect } from 'vitest';
import {
  allocateNextProfileProviderId,
  allocateProfileProviderId,
  collectApiProfileRestoreEntries,
  isApiProfileProviderKey,
  listApiProfilesFromConfig,
  slugifyProfileLabel,
} from './api-profiles';
import { REDACTED_SENTINEL } from './config-patch';

describe('api-profiles', () => {
  it('detects custom profile provider keys', () => {
    expect(isApiProfileProviderKey('custom')).toBe(true);
    expect(isApiProfileProviderKey('custom-relay-a')).toBe(true);
    expect(isApiProfileProviderKey('openai')).toBe(false);
  });

  it('allocates unique profile ids', () => {
    expect(allocateProfileProviderId('中转站 A', [])).toMatch(/^custom-p[a-z0-9]+$/);
    expect(allocateProfileProviderId('Relay A', ['custom-relay-a'])).toBe('custom-relay-a-2');
  });

  it('allocates next profile slot like custom provider flow', () => {
    expect(allocateNextProfileProviderId([])).toBe('custom');
    expect(allocateNextProfileProviderId(['custom'])).toBe('custom-profile');
    expect(allocateNextProfileProviderId(['custom', 'custom-profile'])).toBe('custom-profile-2');
  });

  it('lists profiles from config', () => {
    const config = {
      agents: { defaults: { model: { primary: 'custom-relay-b/gpt-4o' } } },
      models: {
        providers: {
          'custom-relay-a': {
            baseUrl: 'https://a.example/v1',
            apiKey: 'sk-a',
            api: 'openai-completions',
            models: [{ id: 'glm-4', name: '中转站 A' }],
          },
          'custom-relay-b': {
            baseUrl: 'https://b.example/v1',
            apiKey: REDACTED_SENTINEL,
            api: 'openai-completions',
            models: [{ id: 'gpt-4o', name: 'Relay B' }],
          },
        },
      },
    };
    const profiles = listApiProfilesFromConfig(config);
    expect(profiles).toHaveLength(2);
    expect(profiles.find((p) => p.id === 'custom-relay-b')?.isActive).toBe(true);
    expect(profiles.find((p) => p.id === 'custom-relay-a')?.label).toBe('中转站 A');
  });

  it('collects restore entries for inactive profiles', () => {
    const config = {
      agents: { defaults: { model: { primary: 'custom-relay-b/m1' } } },
      models: {
        providers: {
          'custom-relay-a': {
            baseUrl: 'https://a.example/v1',
            apiKey: REDACTED_SENTINEL,
            models: [{ id: 'm0' }],
          },
          'custom-relay-b': {
            baseUrl: 'https://b.example/v1',
            apiKey: REDACTED_SENTINEL,
            models: [{ id: 'm1' }],
          },
        },
      },
    };
    const restored = collectApiProfileRestoreEntries(config, 'custom-relay-b', {
      apiKeys: {},
      models: {},
    });
    expect(restored['custom-relay-a']).toEqual({ modelId: 'm0', apiKey: REDACTED_SENTINEL });
    expect(restored['custom-relay-b']).toBeUndefined();
  });

  it('skips excluded profiles when collecting restore entries', () => {
    const config = {
      agents: { defaults: { model: { primary: 'custom-relay-b/m1' } } },
      models: {
        providers: {
          'custom-relay-a': {
            baseUrl: 'https://a.example/v1',
            apiKey: REDACTED_SENTINEL,
            models: [{ id: 'm0' }],
          },
          'custom-relay-b': {
            baseUrl: 'https://b.example/v1',
            apiKey: REDACTED_SENTINEL,
            models: [{ id: 'm1' }],
          },
        },
      },
    };
    const restored = collectApiProfileRestoreEntries(
      config,
      'custom-relay-b',
      { apiKeys: {}, models: {} },
      ['custom-relay-a'],
    );
    expect(restored['custom-relay-a']).toBeUndefined();
  });

  it('slugify handles empty label', () => {
    expect(slugifyProfileLabel('   ')).toBe('profile');
  });

  it('lists configured presets alongside custom profiles', () => {
    const config = {
      agents: { defaults: { model: { primary: 'deepseek/deepseek-chat' } } },
      models: {
        providers: {
          openai: {
            baseUrl: 'https://chatgpt.com/backend-api',
            api: 'openai-chatgpt-responses',
            models: [{ id: 'gpt-5.4' }],
          },
          deepseek: {
            baseUrl: 'https://api.deepseek.com',
            apiKey: 'sk-deepseek',
            api: 'openai-completions',
            models: [{ id: 'deepseek-chat' }],
          },
          'custom-relay-a': {
            baseUrl: 'https://a.example/v1',
            apiKey: 'sk-a',
            api: 'openai-completions',
            models: [{ id: 'glm-4', name: '中转站 A' }],
          },
        },
      },
    };
    const profiles = listApiProfilesFromConfig(config);
    expect(profiles).toHaveLength(3);

    const openai = profiles.find((p) => p.id === 'openai');
    expect(openai?.isBuiltin).toBe(true);
    expect(openai?.requiresApiKey).toBe(false);
    expect(openai?.label).toBe('OpenAI ChatGPT (OAuth)');

    const deepseek = profiles.find((p) => p.id === 'deepseek');
    expect(deepseek?.isBuiltin).toBe(true);
    expect(deepseek?.requiresApiKey).toBe(true);
    expect(deepseek?.isActive).toBe(true);

    const custom = profiles.find((p) => p.id === 'custom-relay-a');
    expect(custom?.isBuiltin).toBe(false);
    expect(custom?.requiresApiKey).toBe(true);
  });

  it('excludes preset entries with no configured models', () => {
    const config = {
      agents: { defaults: { model: { primary: 'deepseek/deepseek-chat' } } },
      models: {
        providers: {
          // Residual scaffold — no models configured, must be skipped.
          minimax: { baseUrl: 'https://api.minimax.io/v1' },
          openai: { baseUrl: 'https://chatgpt.com/backend-api', models: [] },
          deepseek: {
            baseUrl: 'https://api.deepseek.com',
            apiKey: 'sk-deepseek',
            models: [{ id: 'deepseek-chat' }],
          },
        },
      },
    };
    const profiles = listApiProfilesFromConfig(config);
    expect(profiles.map((p) => p.id)).toEqual(['deepseek']);
  });
});

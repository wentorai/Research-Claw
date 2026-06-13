import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import ApiProfilesSection from './ApiProfilesSection';
import type { ApiProfile } from '../../utils/api-profiles';

// Mock antd App.useApp (modal.confirm)
vi.mock('antd', async () => {
  const actual = await vi.importActual<typeof import('antd')>('antd');
  const MockApp = Object.assign(
    (props: Record<string, unknown>) => (actual.App as unknown as (p: unknown) => unknown)(props),
    {
      ...actual.App,
      useApp: () => ({ modal: { confirm: vi.fn() }, message: {}, notification: {} }),
    },
  );
  return { ...actual, App: MockApp };
});

// Mock i18next — the t mock echoes the key so we can assert which key was used.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      typeof opts?.defaultValue === 'string' && !key.includes('.') ? (opts.defaultValue as string) : key,
    i18n: { changeLanguage: vi.fn() },
  }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

function makeProfile(overrides: Partial<ApiProfile> = {}): ApiProfile {
  return {
    id: 'custom-relay-a',
    label: 'Relay A',
    baseUrl: 'https://a.example/v1',
    api: 'openai-completions',
    modelId: 'm0',
    apiKeyConfigured: true,
    isActive: false,
    isBuiltin: false,
    requiresApiKey: true,
    ...overrides,
  };
}

function renderSection(profiles: ApiProfile[]) {
  return render(
    <ApiProfilesSection
      profiles={profiles}
      activeProviderId=""
      onSelectProfile={vi.fn()}
      onActivateProfile={vi.fn().mockResolvedValue(undefined)}
      onAddProfile={vi.fn()}
      onDeleteProfile={vi.fn().mockResolvedValue(undefined)}
    />,
  );
}

describe('ApiProfilesSection', () => {
  it('shows an OAuth status for OAuth presets instead of "API key missing"', () => {
    renderSection([
      makeProfile({
        id: 'openai',
        label: 'OpenAI ChatGPT (OAuth)',
        isBuiltin: true,
        requiresApiKey: false,
        apiKeyConfigured: false,
      }),
    ]);
    expect(screen.getByText(/settings\.apiProfilesOAuth/)).toBeTruthy();
    expect(screen.queryByText(/settings\.apiKeyMissing/)).toBeNull();
  });

  it('shows Configured for a non-OAuth preset with a saved key', () => {
    renderSection([
      makeProfile({
        id: 'deepseek',
        label: 'DeepSeek',
        isBuiltin: true,
        requiresApiKey: true,
        apiKeyConfigured: true,
      }),
    ]);
    expect(screen.getByText(/settings\.providerConfigured/)).toBeTruthy();
    expect(screen.queryByText(/settings\.apiProfilesOAuth/)).toBeNull();
  });

  it('shows the missing-key status for a non-OAuth profile without a key', () => {
    renderSection([makeProfile({ apiKeyConfigured: false })]);
    expect(screen.getByText(/settings\.apiKeyMissing/)).toBeTruthy();
  });
});

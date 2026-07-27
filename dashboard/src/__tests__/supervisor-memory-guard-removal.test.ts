import { describe, expect, it } from 'vitest';

import en from '../i18n/en.json';
import zh from '../i18n/zh-CN.json';
import { buildSaveConfig } from '../utils/config-patch';

function legacyConfig() {
  return {
    agents: {
      defaults: {
        model: { primary: 'custom/test-model' },
        imageModel: { primary: 'custom/test-model' },
      },
    },
    models: {
      providers: {
        custom: {
          baseUrl: 'https://example.invalid/v1',
          api: 'openai-completions',
          models: [{ id: 'test-model', name: 'test-model' }],
        },
      },
    },
    plugins: {
      entries: {
        'dual-model-supervisor': {
          enabled: true,
          config: {
            enabled: true,
            supervisorModel: '',
            reviewMode: 'full',
            memoryGuard: {
              enabled: true,
              keyCategories: ['research_goal'],
            },
            appendReviewToChannelOutput: true,
            courseCorrection: {
              enabled: true,
              deviationThreshold: 0.5,
              forceRegenerate: false,
              maxRegenerateAttempts: 3,
            },
          },
        },
      },
    },
  };
}

function supervisorConfig(config: Record<string, unknown>): Record<string, unknown> {
  const plugins = config.plugins as { entries: Record<string, { config: Record<string, unknown> }> };
  return plugins.entries['dual-model-supervisor'].config;
}

describe('Dashboard withdraws unsupported Supervisor capabilities honestly', () => {
  it('migrates legacy full and strips Memory Guard/footer switches on the next save', () => {
    const saved = buildSaveConfig(legacyConfig(), {
      provider: 'custom',
      baseUrl: 'https://example.invalid/v1',
      apiKey: 'test-key',
      textModel: 'test-model',
      supervisorEnabled: true,
      supervisorModel: '',
      supervisorReviewMode: 'correct',
    });
    const supervisor = supervisorConfig(saved);

    expect(supervisor.reviewMode).toBe('correct');
    expect(supervisor).not.toHaveProperty('memoryGuard');
    expect(supervisor).not.toHaveProperty('appendReviewToChannelOutput');
    expect((supervisor.courseCorrection as { enabled: boolean }).enabled).toBe(true);
  });

  it('contains no Full Protection or Memory Guard settings copy in either locale', () => {
    for (const bundle of [en, zh]) {
      const settings = bundle.settings as Record<string, unknown>;
      expect(settings).not.toHaveProperty('reviewModeFull');
      expect(settings).not.toHaveProperty('reviewModeFullDesc');
      expect(bundle.supervisor as Record<string, unknown>).not.toHaveProperty('typeMemoryGuard');
    }

    expect(JSON.stringify(en)).not.toMatch(/Full Protection|memory guard|memory loss detection/i);
    expect(JSON.stringify(zh)).not.toMatch(/全面防护|记忆保护|记忆丢失检测/);
  });
});

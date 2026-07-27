import { describe, expect, it } from 'vitest';
import { resolveAdapterForReviewer } from '../client/api-adapters.js';
import type { ModelsProviderEntry } from '../core/types.js';

const provider: ModelsProviderEntry = {
  baseUrl: 'https://api.deepseek.com',
  apiKey: 'test-only',
  api: 'openai-completions',
  models: [{ id: 'deepseek-chat', maxTokens: 4096 }],
};

describe('DeepSeek reviewer adapter', () => {
  it('uses a non-streaming, non-thinking request while preserving the configured token limit', () => {
    const adapter = resolveAdapterForReviewer('deepseek', provider.api);

    expect(adapter).not.toBeNull();
    expect(adapter!.buildBody(provider, 'deepseek-chat', 'system', 'user')).toMatchObject({
      model: 'deepseek-chat',
      stream: false,
      thinking: { type: 'disabled' },
      max_tokens: 4096,
      messages: [
        { role: 'system', content: 'system' },
        { role: 'user', content: 'user' },
      ],
    });
  });

  it('does not leak DeepSeek-only request controls to a custom OpenAI-compatible provider', () => {
    const adapter = resolveAdapterForReviewer('custom-provider', 'openai-completions');
    const body = adapter!.buildBody(provider, 'deepseek-chat', 'system', 'user');

    expect(body).not.toHaveProperty('thinking');
    expect(body).not.toHaveProperty('stream');
  });

  it('never treats reasoning_content as the reviewer JSON result', () => {
    const adapter = resolveAdapterForReviewer('deepseek', provider.api);

    expect(adapter!.extractText({
      choices: [{
        message: {
          content: '',
          reasoning_content: '{"flagged":false}',
        },
      }],
    })).toBe('');
  });
});

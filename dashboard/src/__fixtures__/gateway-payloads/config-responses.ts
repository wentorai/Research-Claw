/**
 * Realistic config.get gateway response payloads.
 *
 * These fixtures represent the ACTUAL data format the gateway returns from
 * `config.get` after `redactConfigSnapshot()` has scrubbed sensitive fields.
 *
 * The `config.get` handler reads the on-disk config file snapshot and returns:
 *   - `config`  — project-level config (parsed from the file, REDACTED)
 *   - `resolved` — merged config after $include + ${ENV} substitution (REDACTED)
 *   - `raw`    — JSON5 source text (sensitive values replaced with sentinel)
 *   - `hash`   — SHA-256 of the raw file contents (used for optimistic concurrency)
 *
 * Sources:
 *   - openclaw/src/gateway/server-methods/config.ts:263-270  (config.get handler)
 *   - openclaw/src/config/redact-snapshot.ts:353-402          (redactConfigSnapshot)
 *   - openclaw/src/config/redact-snapshot.ts:73               (REDACTED_SENTINEL)
 *   - openclaw/src/config/types.openclaw.ts:137-154           (ConfigFileSnapshot)
 *   - openclaw/src/gateway/protocol/schema/config.ts:10       (ConfigGetParamsSchema)
 *   - openclaw/src/gateway/protocol/schema/config.ts:12-18    (ConfigSetParamsSchema)
 *   - openclaw/src/gateway/protocol/schema/config.ts:20-31    (ConfigApplyParamsSchema)
 *
 * Update these when OpenClaw protocol changes.
 */

const REDACTED = '__OPENCLAW_REDACTED__';

// ─── ZAI single-provider (most common setup for Chinese users) ───────
// Simulates a user who configured Z.AI (zhipu) with glm-5 text model.
// API key is redacted in both `config` and `resolved` by redactConfigSnapshot().
export const CONFIG_GET_ZAI_SINGLE = {
  config: {
    agents: {
      defaults: {
        model: { primary: 'zai/glm-5' },
        imageModel: { primary: 'zai/glm-5' },
      },
    },
    models: {
      providers: {
        zai: {
          baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
          api: 'openai-completions',
          apiKey: REDACTED,
          models: [
            {
              id: 'glm-5',
              name: 'glm-5',
              reasoning: true,
              input: ['text'],
              contextWindow: 204800,
              maxTokens: 131072,
            },
          ],
        },
      },
    },
  },
  resolved: {
    agents: {
      defaults: {
        model: { primary: 'zai/glm-5' },
        imageModel: { primary: 'zai/glm-5' },
        heartbeat: { every: '5m' },
      },
    },
    models: {
      providers: {
        zai: {
          baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
          api: 'openai-completions',
          apiKey: REDACTED,
          models: [
            {
              id: 'glm-5',
              name: 'glm-5',
              reasoning: true,
              input: ['text'],
              contextWindow: 204800,
              maxTokens: 131072,
            },
          ],
        },
      },
    },
  },
  raw: `{
  agents: {
    defaults: {
      model: { primary: "zai/glm-5" },
      imageModel: { primary: "zai/glm-5" },
    },
  },
  models: {
    providers: {
      zai: {
        baseUrl: "https://open.bigmodel.cn/api/paas/v4",
        api: "openai-completions",
        apiKey: "${REDACTED}",
        models: [
          {
            id: "glm-5",
            name: "glm-5",
            reasoning: true,
            input: ["text"],
            contextWindow: 204800,
            maxTokens: 131072,
          },
        ],
      },
    },
  },
}`,
  hash: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
};

// ─── Dual-provider: OpenAI text + ZAI vision ─────────────────────────
// User configured OpenAI for text and Z.AI for vision (separate providers).
// Both API keys are redacted.
export const CONFIG_GET_DUAL_PROVIDER = {
  config: {
    agents: {
      defaults: {
        model: { primary: 'openai/gpt-4o' },
        imageModel: { primary: 'zai/glm-4.6v' },
      },
    },
    models: {
      providers: {
        openai: {
          baseUrl: 'https://api.openai.com/v1',
          api: 'openai-completions',
          apiKey: REDACTED,
          models: [
            {
              id: 'gpt-4o',
              name: 'gpt-4o',
              reasoning: false,
              input: ['text', 'image'],
              contextWindow: 128000,
              maxTokens: 16384,
            },
          ],
        },
        zai: {
          baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
          api: 'openai-completions',
          apiKey: REDACTED,
          models: [
            {
              id: 'glm-4.6v',
              name: 'glm-4.6v',
              reasoning: false,
              input: ['text', 'image'],
              contextWindow: 8192,
              maxTokens: 4096,
            },
          ],
        },
      },
    },
  },
  resolved: {
    agents: {
      defaults: {
        model: { primary: 'openai/gpt-4o' },
        imageModel: { primary: 'zai/glm-4.6v' },
        heartbeat: { every: '5m' },
      },
    },
    models: {
      providers: {
        openai: {
          baseUrl: 'https://api.openai.com/v1',
          api: 'openai-completions',
          apiKey: REDACTED,
          models: [
            {
              id: 'gpt-4o',
              name: 'gpt-4o',
              reasoning: false,
              input: ['text', 'image'],
              contextWindow: 128000,
              maxTokens: 16384,
            },
          ],
        },
        zai: {
          baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
          api: 'openai-completions',
          apiKey: REDACTED,
          models: [
            {
              id: 'glm-4.6v',
              name: 'glm-4.6v',
              reasoning: false,
              input: ['text', 'image'],
              contextWindow: 8192,
              maxTokens: 4096,
            },
          ],
        },
      },
    },
  },
  raw: null,
  hash: 'b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3',
};

// ─── Config with proxy settings ──────────────────────────────────────
// User configured Anthropic provider with HTTP proxy for restricted networks.
export const CONFIG_GET_WITH_PROXY = {
  config: {
    agents: {
      defaults: {
        model: { primary: 'anthropic/claude-sonnet-4-6' },
        imageModel: { primary: 'anthropic/claude-sonnet-4-6' },
      },
    },
    models: {
      providers: {
        anthropic: {
          baseUrl: 'https://api.anthropic.com',
          api: 'anthropic-messages',
          apiKey: REDACTED,
          models: [
            {
              id: 'claude-sonnet-4-6',
              name: 'claude-sonnet-4-6',
              reasoning: false,
              input: ['text', 'image'],
              contextWindow: 200000,
              maxTokens: 16384,
            },
          ],
        },
      },
    },
    env: {
      HTTP_PROXY: 'http://127.0.0.1:7890',
      HTTPS_PROXY: 'http://127.0.0.1:7890',
    },
  },
  resolved: {
    agents: {
      defaults: {
        model: { primary: 'anthropic/claude-sonnet-4-6' },
        imageModel: { primary: 'anthropic/claude-sonnet-4-6' },
        heartbeat: { every: '5m' },
      },
    },
    models: {
      providers: {
        anthropic: {
          baseUrl: 'https://api.anthropic.com',
          api: 'anthropic-messages',
          apiKey: REDACTED,
          models: [
            {
              id: 'claude-sonnet-4-6',
              name: 'claude-sonnet-4-6',
              reasoning: false,
              input: ['text', 'image'],
              contextWindow: 200000,
              maxTokens: 16384,
            },
          ],
        },
      },
    },
    env: {
      HTTP_PROXY: 'http://127.0.0.1:7890',
      HTTPS_PROXY: 'http://127.0.0.1:7890',
    },
  },
  raw: null,
  hash: 'c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4',
};

// ─── Empty/minimal config (needs_setup state) ────────────────────────
// First boot: config file exists but has no model or provider configured.
// The snapshot is valid=true (syntactically) but semantically incomplete.
export const CONFIG_GET_EMPTY = {
  config: {},
  resolved: {},
  raw: '{}',
  hash: 'd4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5',
};

// ─── Config with existing heartbeat and custom agent settings ────────
// Tests that buildSaveConfig preserves fields it doesn't manage.
export const CONFIG_GET_WITH_HEARTBEAT = {
  config: {
    agents: {
      defaults: {
        model: { primary: 'zai/glm-5' },
        imageModel: { primary: 'zai/glm-5' },
        heartbeat: { every: '3m' },
      },
    },
    models: {
      providers: {
        zai: {
          baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
          api: 'openai-completions',
          apiKey: REDACTED,
          models: [
            {
              id: 'glm-5',
              name: 'glm-5',
              reasoning: true,
              input: ['text'],
              contextWindow: 204800,
              maxTokens: 131072,
            },
          ],
        },
      },
    },
  },
  resolved: {
    agents: {
      defaults: {
        model: { primary: 'zai/glm-5' },
        imageModel: { primary: 'zai/glm-5' },
        heartbeat: { every: '3m' },
      },
    },
    models: {
      providers: {
        zai: {
          baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
          api: 'openai-completions',
          apiKey: REDACTED,
          models: [
            {
              id: 'glm-5',
              name: 'glm-5',
              reasoning: true,
              input: ['text'],
              contextWindow: 204800,
              maxTokens: 131072,
            },
          ],
        },
      },
    },
  },
  raw: null,
  hash: 'e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6',
};

// ─── Config with stale provider from a previous setup ────────────────
// Simulates migrating from an old 'rc' provider to 'openai'.
// The 'rc' entry is preserved when saving another provider (merge, not replace).
export const CONFIG_GET_STALE_PROVIDER = {
  config: {
    agents: {
      defaults: {
        model: { primary: 'rc/old-model' },
        imageModel: { primary: 'rc/old-model' },
      },
    },
    models: {
      providers: {
        rc: {
          baseUrl: 'http://old-endpoint.example.com',
          api: 'openai-completions',
          apiKey: REDACTED,
          models: [
            {
              id: 'old-model',
              name: 'old-model',
              reasoning: false,
              input: ['text'],
              contextWindow: 128000,
              maxTokens: 16384,
            },
          ],
        },
      },
    },
  },
  resolved: {
    agents: {
      defaults: {
        model: { primary: 'rc/old-model' },
        imageModel: { primary: 'rc/old-model' },
      },
    },
    models: {
      providers: {
        rc: {
          baseUrl: 'http://old-endpoint.example.com',
          api: 'openai-completions',
          apiKey: REDACTED,
          models: [
            {
              id: 'old-model',
              name: 'old-model',
              reasoning: false,
              input: ['text'],
              contextWindow: 128000,
              maxTokens: 16384,
            },
          ],
        },
      },
    },
  },
  raw: null,
  hash: 'f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1',
};

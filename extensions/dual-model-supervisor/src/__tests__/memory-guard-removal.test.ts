import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { parseConfig } from '../core/config.js';
import { loadPluginFresh } from './harness/plugin-harness.js';

const EXPECTED_TYPED_HOOKS = [
  'before_message_write',
  'before_prompt_build',
  'before_tool_call',
  'llm_input',
  'llm_output',
  'message_received',
  'session_end',
];

describe('withdrawn Memory Guard contract', () => {
  it('migrates legacy full mode to correct without disabling supervision', () => {
    const config = parseConfig({
      enabled: true,
      supervisorModel: 'test/reviewer',
      reviewMode: 'full',
      memoryGuard: { enabled: true, keyCategories: ['research_goal'] },
    });

    expect(config.enabled).toBe(true);
    expect(config.reviewMode).toBe('correct');
    expect(config).not.toHaveProperty('memoryGuard');
  });

  it('registers no compaction hooks and preserves every supported supervisor hook', async () => {
    const harness = await loadPluginFresh({
      enabled: true,
      supervisorModel: 'test/reviewer',
      reviewMode: 'correct',
    });

    expect(harness.hookNames().sort()).toEqual(EXPECTED_TYPED_HOOKS);
  });

  it('does not expose the withdrawn feature through status or config RPC', async () => {
    const harness = await loadPluginFresh({
      enabled: true,
      supervisorModel: 'test/reviewer',
      reviewMode: 'full',
      memoryGuard: { enabled: true },
    });

    const status = await harness.rpc.get('rc.supervisor.status')!({});
    expect(status).toMatchObject({ enabled: true, reviewMode: 'correct' });
    expect(status).not.toHaveProperty('memoryGuardEnabled');

    const updated = await harness.rpc.get('rc.supervisor.config')!({
      reviewMode: 'full',
      memoryGuard: { enabled: false },
    });
    expect(updated).toMatchObject({
      ok: true,
      config: { enabled: true, reviewMode: 'correct' },
    });
    expect((updated as { config: unknown }).config).not.toHaveProperty('memoryGuard');
  });

  it('removes full mode and Memory Guard from the OpenClaw manifest', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const manifest = JSON.parse(
      fs.readFileSync(path.resolve(here, '../../openclaw.plugin.json'), 'utf8'),
    ) as {
      description: string;
      configSchema: { properties: Record<string, unknown> };
    };
    const reviewMode = manifest.configSchema.properties.reviewMode as {
      enum: string[];
      description: string;
    };

    expect(reviewMode.enum).toEqual(['off', 'filter-only', 'correct']);
    expect(reviewMode.description).not.toMatch(/full|memory/i);
    expect(manifest.configSchema.properties).not.toHaveProperty('memoryGuard');
    expect(manifest.description).not.toMatch(/memory guard/i);
  });
});

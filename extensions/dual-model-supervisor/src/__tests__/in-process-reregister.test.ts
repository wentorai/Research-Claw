import { describe, expect, it } from 'vitest';

import { loadPluginFresh } from './harness/plugin-harness.js';

const EXPECTED_TYPED_HOOKS = [
  'after_compaction',
  'before_compaction',
  'before_message_write',
  'before_prompt_build',
  'before_tool_call',
  'llm_input',
  'llm_output',
  'message_received',
  'session_end',
];

describe('in-process gateway re-registration', () => {
  it('registers all typed hooks on a fresh PluginApi from the same module instance', async () => {
    const harness = await loadPluginFresh({
      enabled: true,
      reviewMode: 'audit',
      supervisorModel: 'test/reviewer',
    });

    expect(harness.hookNames().sort()).toEqual(EXPECTED_TYPED_HOOKS);
    harness.reregisterCurrentApi();
    expect(harness.hookHandlerCounts()).toEqual(
      Object.fromEntries(EXPECTED_TYPED_HOOKS.map((name) => [name, 1])),
    );
    expect(harness.registerFreshApi().sort()).toEqual(EXPECTED_TYPED_HOOKS);
  });
});

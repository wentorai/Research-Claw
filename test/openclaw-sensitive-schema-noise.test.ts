import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '..');
const PATCH = fs.readFileSync(path.join(ROOT, 'patches', 'openclaw@2026.9.2.patch'), 'utf8');
const RUNTIME_SCHEMA = path.join(
  ROOT,
  'node_modules',
  'openclaw',
  'dist',
  'runtime-schema-D3-BdLtQ.js',
);

describe('Research-Claw sensitive schema log policy', () => {
  it('does not enumerate heuristic sensitive field names in local runtime logs', () => {
    const installedRuntime = fs.readFileSync(RUNTIME_SCHEMA, 'utf8');
    expect(installedRuntime).not.toContain('possibly sensitive key found');
    // 2026.9.2 already dropped the heuristic debug line, so the patch carries no
    // schema hunk any more and the invariant is asserted on the runtime above.
    expect(PATCH).not.toContain('possibly sensitive key found');
  });

  it('retains explicit sensitive hints used to mask configuration values', async () => {
    const { r: readBestEffortRuntimeConfigSchema } = await import(
      '../node_modules/openclaw/dist/runtime-schema-D3-BdLtQ.js'
    ) as unknown as {
      r: () => Promise<{ uiHints?: Record<string, { sensitive?: boolean }> }>;
    };

    const result = await readBestEffortRuntimeConfigSchema();

    expect(result.uiHints?.['gateway.auth.token']?.sensitive).toBe(true);
    expect(result.uiHints?.['models.providers.*.apiKey']?.sensitive).toBe(true);
  });
});

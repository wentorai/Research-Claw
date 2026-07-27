import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(__dirname, '..', 'scripts', 'ensure-config.cjs');

function runEnsureConfig(config: object): any {
  const dir = mkdtempSync(join(tmpdir(), 'rc-ensure-mcp-'));
  const p = join(dir, 'openclaw.json');
  writeFileSync(p, JSON.stringify(config, null, 2));
  execFileSync('node', [SCRIPT, p]);
  return JSON.parse(readFileSync(p, 'utf8'));
}

describe('ensure-config mcp guard (narrowed)', () => {
  it('keeps user-configured mcp servers (plaud) across runs', () => {
    const out = runEnsureConfig({
      mcp: { servers: { plaud: { command: 'npx', args: ['-y', '@plaud-ai/mcp@0.3.5'] } } },
    });
    expect(out.mcp?.servers?.plaud?.command).toBe('npx');
  });
  it('removes only the legacy markitdown entry', () => {
    const out = runEnsureConfig({
      mcp: { servers: {
        markitdown: { command: 'markitdown-mcp', args: [] },
        plaud: { command: 'npx', args: ['-y', '@plaud-ai/mcp@0.3.5'] },
      } },
    });
    expect(out.mcp?.servers?.markitdown).toBeUndefined();
    expect(out.mcp?.servers?.plaud).toBeDefined();
  });
});

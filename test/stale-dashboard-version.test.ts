import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');

describe('stale Dashboard cannot reconnect after an upgrade', () => {
  it('native and Docker startup publish the installed Research-Claw UI version', () => {
    for (const relative of ['scripts/run.sh', 'scripts/docker-entrypoint.sh']) {
      const source = fs.readFileSync(path.join(ROOT, relative), 'utf8');
      expect(source).toContain('RESEARCH_CLAW_UI_VERSION');
      expect(source).toContain('package.json');
    }
  });

  it('the OpenClaw patch rejects only mismatched control-ui clients with an actionable message', () => {
    const patch = fs.readFileSync(path.join(ROOT, 'patches', 'openclaw@2026.6.1.patch'), 'utf8');

    expect(patch).toContain('process.env.RESEARCH_CLAW_UI_VERSION');
    expect(patch).toContain('GATEWAY_CLIENT_IDS.CONTROL_UI');
    expect(patch).toContain('connectParams.client.version !== expectedControlUiVersion');
    expect(patch).toContain('Refresh this page');
    expect(patch).toContain('"FORBIDDEN"');
  });
});

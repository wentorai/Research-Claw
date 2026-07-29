import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const RELEASE_VERSION = '0.8.1';
const WITHDRAWN_VERSION = ['0.8', '2'].join('.');

function read(relative: string): string {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8');
}

describe('public release version contract', () => {
  it('uses v0.8.1 as the only current product version', () => {
    const metadataFiles = [
      'package.json',
      'extensions/research-claw-core/package.json',
      'extensions/research-claw-core/openclaw.plugin.json',
      'extensions/wentor-connect/package.json',
      'extensions/wentor-connect/openclaw.plugin.json',
    ];

    for (const relative of metadataFiles) {
      expect(JSON.parse(read(relative)).version, relative).toBe(RELEASE_VERSION);
    }

    for (const relative of [
      'extensions/research-claw-core/index.ts',
      'extensions/wentor-connect/index.ts',
    ]) {
      expect(read(relative), relative).toContain(`version: '${RELEASE_VERSION}'`);
    }

    for (const relative of [
      'workspace/.ResearchClaw/IDENTITY.md',
      'workspace/.ResearchClaw/IDENTITY.md.example',
    ]) {
      expect(read(relative), relative).toContain(
        `**Version:** ${RELEASE_VERSION}`,
      );
    }
  });

  it('shows v0.8.1 in both public README badges', () => {
    for (const relative of ['README.md', 'README.en.md']) {
      const content = read(relative);
      expect(content, relative).toContain(`version-v${RELEASE_VERSION}-`);
      expect(content, relative).not.toContain(`version-v${WITHDRAWN_VERSION}-`);
    }
  });

  it('does not publish release or validation documents for the withdrawn version', () => {
    for (const relative of [
      `RELEASE_v${WITHDRAWN_VERSION}.md`,
      `docs/engineering/v${WITHDRAWN_VERSION}-validation.md`,
    ]) {
      expect(fs.existsSync(path.join(ROOT, relative)), relative).toBe(false);
    }

    expect(read('RELEASE_v0.8.1.md')).not.toContain(`v${WITHDRAWN_VERSION}`);
    expect(read('docs/engineering/v0.8.1-validation.md')).not.toContain(
      `v${WITHDRAWN_VERSION}`,
    );
  });
});

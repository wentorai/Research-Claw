import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const PREVIOUS_RELEASE_VERSION = '0.8.2';
const CANDIDATE_VERSION = '0.8.3';

function read(relative: string): string {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8');
}

describe('0.8.3 candidate version contract', () => {
  it('uses v0.8.3 at every runtime and user-visible candidate version point', () => {
    const metadataFiles = [
      'package.json',
      'extensions/research-claw-core/package.json',
      'extensions/research-claw-core/openclaw.plugin.json',
      'extensions/wentor-connect/package.json',
      'extensions/wentor-connect/openclaw.plugin.json',
    ];

    for (const relative of metadataFiles) {
      expect(JSON.parse(read(relative)).version, relative).toBe(CANDIDATE_VERSION);
    }

    for (const relative of [
      'extensions/research-claw-core/index.ts',
      'extensions/wentor-connect/index.ts',
    ]) {
      expect(read(relative), relative).toContain(`version: '${CANDIDATE_VERSION}'`);
    }

    for (const relative of [
      'workspace/.ResearchClaw/IDENTITY.md',
      'workspace/.ResearchClaw/IDENTITY.md.example',
    ]) {
      expect(read(relative), relative).toContain(
        `**Version:** ${CANDIDATE_VERSION}`,
      );
    }

    for (const relative of [
      'dashboard/src/i18n/en.json',
      'dashboard/src/i18n/zh-CN.json',
    ]) {
      expect(JSON.parse(read(relative)).status.versionFallback, relative).toBe(
        `v${CANDIDATE_VERSION}`,
      );
    }
  });

  it('shows v0.8.3 in both candidate README badges', () => {
    for (const relative of ['README.md', 'README.en.md']) {
      const content = read(relative);
      expect(content, relative).toContain(`version-v${CANDIDATE_VERSION}-`);
      expect(content, relative).not.toContain(
        `version-v${PREVIOUS_RELEASE_VERSION}-`,
      );
    }
  });

  it('does not create release-only 0.8.3 artifacts before manual acceptance', () => {
    expect(
      fs.existsSync(path.join(ROOT, `RELEASE_v${PREVIOUS_RELEASE_VERSION}.md`)),
    ).toBe(true);

    for (const relative of [
      `RELEASE_v${CANDIDATE_VERSION}.md`,
      `docs/engineering/v${CANDIDATE_VERSION}-validation.md`,
    ]) {
      expect(fs.existsSync(path.join(ROOT, relative)), relative).toBe(false);
    }

    expect(read(`RELEASE_v${PREVIOUS_RELEASE_VERSION}.md`)).not.toContain(
      `v${CANDIDATE_VERSION}`,
    );
  });
});

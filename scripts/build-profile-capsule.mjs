#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { chmod, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const profileRoot = path.resolve(process.argv[2] ?? path.join(root, 'profiles', 'fixtures', 'thermoelectric-user-a'));
const skillsRoot = path.join(profileRoot, 'skills');
const outputPath = path.join(profileRoot, 'capsule.json');
const expectedSlugs = [
  'develop-flexible-bismuth-telluride',
  'engineer-gete-thermoelectrics',
  'research-thermoelectric-semiconductors',
];

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function collectFiles(skillRoot, relative = '') {
  const entries = await readdir(path.join(skillRoot, relative), { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`symlink forbidden: ${child}`);
    if (entry.isDirectory()) files.push(...await collectFiles(skillRoot, child));
    else if (entry.isFile()) files.push(child);
    else throw new Error(`unsupported file type: ${child}`);
  }
  return files;
}

const items = [];
for (const slug of expectedSlugs) {
  const skillRoot = path.join(skillsRoot, slug);
  const paths = await collectFiles(skillRoot);
  const files = [];
  for (const relativePath of paths) {
    if (relativePath !== 'SKILL.md' && !/^references\/[a-z0-9-]+\.md$/.test(relativePath)) {
      throw new Error(`Capsule v1 forbids ${slug}/${relativePath}`);
    }
    const content = await readFile(path.join(skillRoot, relativePath), 'utf8');
    files.push({ path: relativePath, encoding: 'utf8', sha256: sha256(content), content });
  }
  items.push({ slug, files });
}

const capsule = {
  schemaVersion: 1,
  profile: { id: 'thermoelectric-user-a', revision: 1, requiredRcVersion: '0.8.3' },
  model: {
    providerId: 'custom-rc-profile-thermoelectric-user-a',
    api: 'openai-completions',
    baseUrl: 'https://provider.example.invalid/v1',
    model: {
      id: 'thermoelectric-fixture-model',
      name: 'Thermoelectric fixture model',
      input: ['text'],
      contextWindow: 128000,
      maxTokens: 8192,
    },
  },
  secrets: { modelApiKey: 'RC_TEST_ONLY_FAKE_MODEL_KEY' },
  policy: {
    capabilities: {
      peripherals: 'disabled',
      supervisor: 'enabled-hidden',
      settings: 'enabled-hidden',
      extensions: 'enabled-hidden',
    },
    supervisor: { reviewMode: 'correct', inheritPrimaryModel: true },
  },
  skills: { items },
};

const outputBytes = `${JSON.stringify(capsule, null, 2)}\n`;
const stagingPath = `${outputPath}.tmp-${process.pid}`;
await writeFile(stagingPath, outputBytes, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
await chmod(stagingPath, 0o600);
await rename(stagingPath, outputPath);
await chmod(outputPath, 0o600);
if (process.platform !== 'win32') {
  const mode = (await stat(outputPath)).mode & 0o777;
  if (mode !== 0o600) throw new Error(`Capsule fixture mode is ${mode.toString(8)}, expected 600`);
}
process.stdout.write(`${JSON.stringify({ output: path.relative(root, outputPath), files: items.reduce((n, item) => n + item.files.length, 0) })}\n`);

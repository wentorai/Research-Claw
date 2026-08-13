#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import YAML from 'yaml';

const profileRoot = path.resolve(process.argv[2] ?? 'profiles/fixtures/thermoelectric-user-a');
const capsulePath = path.join(profileRoot, 'capsule.json');
const rawCapsule = await readFile(capsulePath);
const capsule = JSON.parse(rawCapsule.toString('utf8'));
const expectedSlugs = [
  'develop-flexible-bismuth-telluride',
  'engineer-gete-thermoelectrics',
  'research-thermoelectric-semiconductors',
];
const allowedTop = ['model', 'policy', 'profile', 'schemaVersion', 'secrets', 'skills'];

function invariant(value, message) {
  if (!value) throw new Error(message);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function exactKeys(value, keys, label) {
  invariant(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
  invariant(JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort()), `${label} has unexpected keys`);
}

function parseFrontmatter(content, slug) {
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(content);
  invariant(match, `${slug}/SKILL.md lacks YAML frontmatter`);
  const doc = YAML.parse(match[1]);
  exactKeys(doc, ['name', 'description'], `${slug} frontmatter`);
  invariant(doc.name === slug, `${slug} frontmatter name mismatch`);
  invariant(typeof doc.description === 'string' && doc.description.trim() === doc.description && !doc.description.includes('\n'), `${slug} description must be one nonempty line`);
  invariant(doc.description.length >= 80 && doc.description.length <= 800, `${slug} description length out of bounds`);
  invariant(!/\balways\b/i.test(match[1]), `${slug} must not set always`);
}

function validateLinks(content, slug, relativePath, sourcePaths) {
  const linkPattern = /(?<!!)\[[^\]]+\]\(([^)]+)\)/g;
  for (const match of content.matchAll(linkPattern)) {
    const target = match[1].trim().replace(/^<|>$/g, '');
    if (/^(?:https?:|mailto:|#)/i.test(target)) continue;
    invariant(!target.includes('\\') && !target.includes('\0'), `${slug}/${relativePath} has unsafe link`);
    const withoutFragment = target.split('#', 1)[0];
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(relativePath), withoutFragment));
    invariant(!resolved.startsWith('../') && sourcePaths.has(resolved), `${slug}/${relativePath} has unresolved link ${target}`);
  }
}

exactKeys(capsule, allowedTop, 'capsule');
invariant(capsule.schemaVersion === 1, 'schemaVersion must be 1');
exactKeys(capsule.profile, ['id', 'revision', 'requiredRcVersion'], 'profile');
invariant(capsule.profile.id === 'thermoelectric-user-a' && capsule.profile.revision === 1 && capsule.profile.requiredRcVersion === '0.8.3', 'profile identity mismatch');
exactKeys(capsule.model, ['providerId', 'api', 'baseUrl', 'model'], 'model');
exactKeys(capsule.model.model, ['id', 'name', 'input', 'contextWindow', 'maxTokens'], 'model.model');
invariant(capsule.model.providerId === 'custom-rc-profile-thermoelectric-user-a', 'providerId mismatch');
invariant(capsule.model.api === 'openai-completions', 'model api mismatch');
const baseUrl = new URL(capsule.model.baseUrl);
invariant(baseUrl.protocol === 'https:' && !baseUrl.username && !baseUrl.password && !baseUrl.hash, 'baseUrl must be safe HTTPS');
exactKeys(capsule.secrets, ['modelApiKey'], 'secrets');
invariant(capsule.secrets.modelApiKey === 'RC_TEST_ONLY_FAKE_MODEL_KEY', 'fixture must use exact fake secret');
exactKeys(capsule.policy, ['capabilities', 'supervisor'], 'policy');
exactKeys(capsule.policy.capabilities, ['extensions', 'peripherals', 'settings', 'supervisor'], 'policy.capabilities');
exactKeys(capsule.policy.supervisor, ['inheritPrimaryModel', 'reviewMode'], 'policy.supervisor');
exactKeys(capsule.skills, ['items'], 'skills');
invariant(Array.isArray(capsule.skills.items), 'skills.items must be an array');
invariant(capsule.skills.items.length <= 10, 'Capsule has more than 10 Skills');
invariant(JSON.stringify(capsule.skills.items.map((item) => item.slug)) === JSON.stringify(expectedSlugs), 'Skill order/identity mismatch');

let fileCount = 0;
let totalContentBytes = 0;
for (const item of capsule.skills.items) {
  exactKeys(item, ['files', 'slug'], `skill ${item.slug}`);
  invariant(/^[a-z0-9-]+$/.test(item.slug), `invalid slug ${item.slug}`);
  invariant(Array.isArray(item.files) && item.files.length > 0, `${item.slug} files missing`);
  const sourceRoot = path.join(profileRoot, 'skills', item.slug);
  const topEntries = await readdir(sourceRoot, { withFileTypes: true });
  invariant(topEntries.every((entry) => entry.name === 'SKILL.md' || entry.name === 'references'), `${item.slug} has a forbidden top-level asset`);
  const sourcePaths = new Set(item.files.map((file) => file.path));
  invariant(sourcePaths.size === item.files.length && sourcePaths.has('SKILL.md'), `${item.slug} duplicate/missing root SKILL.md`);
  const expectedFiles = ['SKILL.md', ...(await readdir(path.join(sourceRoot, 'references'))).sort().map((name) => `references/${name}`)].sort();
  invariant(JSON.stringify([...sourcePaths].sort()) === JSON.stringify(expectedFiles), `${item.slug} source/file-map drift`);
  for (const file of item.files) {
    exactKeys(file, ['content', 'encoding', 'path', 'sha256'], `${item.slug}/${file.path}`);
    invariant(file.encoding === 'utf8', `${item.slug}/${file.path} encoding must be utf8`);
    invariant(file.path === 'SKILL.md' || /^references\/[a-z0-9-]+\.md$/.test(file.path), `invalid Capsule path ${item.slug}/${file.path}`);
    const sourcePath = path.join(sourceRoot, ...file.path.split('/'));
    const stat = await lstat(sourcePath);
    invariant(stat.isFile() && !stat.isSymbolicLink(), `${item.slug}/${file.path} is not a plain file`);
    const source = await readFile(sourcePath, 'utf8');
    invariant(source === file.content, `${item.slug}/${file.path} content drift`);
    invariant(sha256(file.content) === file.sha256, `${item.slug}/${file.path} hash mismatch`);
    invariant(Buffer.byteLength(file.content) <= 256 * 1024, `${item.slug}/${file.path} exceeds 256 KiB`);
    invariant(!file.content.includes('\u0000'), `${item.slug}/${file.path} contains NUL`);
    if (file.path === 'SKILL.md') {
      parseFrontmatter(file.content, item.slug);
      invariant(file.content.split('\n').length < 500, `${item.slug}/SKILL.md must stay under 500 lines`);
    }
    validateLinks(file.content, item.slug, file.path, sourcePaths);
    fileCount += 1;
    totalContentBytes += Buffer.byteLength(file.content);
  }
}

invariant(fileCount <= 100, 'Capsule has more than 100 files');
invariant(totalContentBytes <= 2 * 1024 * 1024, 'Capsule content exceeds 2 MiB');

process.stdout.write(`${JSON.stringify({
  profileId: capsule.profile.id,
  skillCount: capsule.skills.items.length,
  fileCount,
  totalContentBytes,
  capsuleBytes: rawCapsule.byteLength,
  capsuleDigest: sha256(rawCapsule),
  fakeSecretOnly: true,
}, null, 2)}\n`);

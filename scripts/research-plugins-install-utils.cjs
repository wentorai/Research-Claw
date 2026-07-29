'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const RESEARCH_PLUGINS_ID = 'research-plugins';
const RESEARCH_PLUGINS_PACKAGE = '@wentorai/research-plugins';
const RESEARCH_PLUGINS_INTEGRITY_FILE =
  '.research-claw-integrity.json';

function isManagedResearchPluginsPath(candidate) {
  if (typeof candidate !== 'string') return false;
  const normalized = candidate.replace(/\\/g, '/').replace(/\/+$/, '');
  return /(?:^|\/)\.openclaw\/extensions\/research-plugins$/.test(normalized);
}

function dependencyPath(pluginDir, packageName) {
  if (
    typeof packageName !== 'string'
    || packageName.length === 0
    || packageName.includes('\\')
    || packageName.split('/').some((part) => part === '' || part === '..')
  ) {
    return null;
  }
  return path.join(pluginDir, 'node_modules', ...packageName.split('/'));
}

function findLeafSkillDocuments(skillsRoot) {
  const documents = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(candidate);
      } else if (entry.isFile() && entry.name === 'SKILL.md') {
        documents.push(fs.realpathSync(candidate));
      }
    }
  };
  visit(skillsRoot);
  return documents.filter((document) => {
    const directoryPrefix = `${path.dirname(document)}${path.sep}`;
    return !documents.some(
      (candidate) =>
        candidate !== document && candidate.startsWith(directoryPrefix),
    );
  });
}

function computeResearchPluginsIntegrity(pluginDir) {
  const hash = crypto.createHash('sha256');
  const visit = (directory) => {
    for (const name of fs.readdirSync(directory).sort()) {
      if (
        directory === pluginDir
        && name === RESEARCH_PLUGINS_INTEGRITY_FILE
      ) {
        continue;
      }
      const absolute = path.join(directory, name);
      const relative = path.relative(pluginDir, absolute)
        .split(path.sep)
        .join('/');
      const stat = fs.lstatSync(absolute);
      if (stat.isDirectory()) {
        hash.update(`D\0${relative}\0`);
        visit(absolute);
      } else if (stat.isFile()) {
        hash.update(`F\0${relative}\0`);
        hash.update(fs.readFileSync(absolute));
      } else if (stat.isSymbolicLink()) {
        hash.update(`L\0${relative}\0${fs.readlinkSync(absolute)}\0`);
      } else {
        hash.update(`O\0${relative}\0`);
      }
    }
  };
  visit(pluginDir);
  return hash.digest('hex');
}

function writeResearchPluginsIntegrityRecord(pluginDir) {
  const record = {
    schemaVersion: 1,
    algorithm: 'sha256',
    digest: computeResearchPluginsIntegrity(pluginDir),
  };
  const recordPath = path.join(
    pluginDir,
    RESEARCH_PLUGINS_INTEGRITY_FILE,
  );
  const temporaryPath = `${recordPath}.tmp-${process.pid}-${crypto
    .randomBytes(8)
    .toString('hex')}`;
  try {
    fs.writeFileSync(
      temporaryPath,
      `${JSON.stringify(record)}\n`,
      { mode: 0o600 },
    );
    fs.renameSync(temporaryPath, recordPath);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
  return record;
}

function inspectResearchPluginsInstall(pluginDir, options = {}) {
  const requireIntegrity = options.requireIntegrity === true;
  const ignoreIntegrity = options.requireIntegrity === false;
  try {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(pluginDir, 'package.json'), 'utf8'),
    );
    const manifest = JSON.parse(
      fs.readFileSync(
        path.join(pluginDir, 'openclaw.plugin.json'),
        'utf8',
      ),
    );
    const catalogSource = fs.readFileSync(
      path.join(pluginDir, 'catalog.json'),
      'utf8',
    );
    const catalog = JSON.parse(catalogSource);

    if (packageJson.name !== RESEARCH_PLUGINS_PACKAGE) {
      return { usable: false, reason: 'package-name-mismatch' };
    }
    if (manifest.id !== RESEARCH_PLUGINS_ID) {
      return { usable: false, reason: 'manifest-id-mismatch' };
    }
    if (
      typeof manifest.main !== 'string'
      || manifest.main.trim().length === 0
    ) {
      return { usable: false, reason: 'manifest-main-missing' };
    }
    if (
      typeof catalog !== 'object'
      || catalog === null
      || Array.isArray(catalog)
      || !Array.isArray(catalog.items)
      || catalog.items.length === 0
    ) {
      return { usable: false, reason: 'catalog-invalid' };
    }
    if (
      typeof packageJson.version !== 'string'
      || packageJson.version.length === 0
      || manifest.version !== packageJson.version
    ) {
      return { usable: false, reason: 'version-mismatch' };
    }

    const resolvedRoot = fs.realpathSync(pluginDir);
    const skillItems = catalog.items.filter(
      (item) => item && item.type === 'skill',
    );
    if (skillItems.length === 0) {
      return { usable: false, reason: 'catalog-skills-missing' };
    }
    const catalogSkillDocuments = new Set();
    const catalogSkillIds = new Set();
    for (const item of skillItems) {
      if (
        typeof item.id !== 'string'
        || item.id.length === 0
        || typeof item.name !== 'string'
        || item.name.length === 0
        || typeof item.description !== 'string'
        || item.description.length === 0
        || typeof item.category !== 'string'
        || item.category.length === 0
        || typeof item.subcategory !== 'string'
        || item.subcategory.length === 0
        || !Array.isArray(item.keywords)
        || item.keywords.some((keyword) => typeof keyword !== 'string')
        || typeof item.path !== 'string'
        || item.path.length === 0
      ) {
        return { usable: false, reason: 'catalog-skill-invalid' };
      }
      const skillPath = path.resolve(resolvedRoot, item.path, 'SKILL.md');
      const rootPrefix = `${resolvedRoot}${path.sep}`;
      if (
        !skillPath.startsWith(rootPrefix)
        || !fs.existsSync(skillPath)
        || !fs.statSync(skillPath).isFile()
        || !fs.realpathSync(skillPath).startsWith(rootPrefix)
      ) {
        return { usable: false, reason: 'catalog-skill-unavailable' };
      }
      const realSkillPath = fs.realpathSync(skillPath);
      if (
        catalogSkillIds.has(item.id)
        || catalogSkillDocuments.has(realSkillPath)
      ) {
        return { usable: false, reason: 'catalog-skill-duplicate' };
      }
      catalogSkillIds.add(item.id);
      catalogSkillDocuments.add(realSkillPath);
    }
    const leafSkillDocuments = findLeafSkillDocuments(
      path.join(resolvedRoot, 'skills'),
    );
    if (
      leafSkillDocuments.length !== catalogSkillDocuments.size
      || leafSkillDocuments.some(
        (document) => !catalogSkillDocuments.has(document),
      )
    ) {
      return { usable: false, reason: 'catalog-skills-incomplete' };
    }

    const mainPath = path.resolve(resolvedRoot, manifest.main);
    const root = `${resolvedRoot}${path.sep}`;
    if (
      !mainPath.startsWith(root)
      || !fs.existsSync(mainPath)
      || !fs.statSync(mainPath).isFile()
      || !fs.realpathSync(mainPath).startsWith(root)
    ) {
      return { usable: false, reason: 'manifest-main-unavailable' };
    }

    const missingDependencies = [];
    const dependencies =
      packageJson.dependencies
      && typeof packageJson.dependencies === 'object'
      && !Array.isArray(packageJson.dependencies)
        ? Object.keys(packageJson.dependencies)
        : [];
    for (const dependency of dependencies) {
      const installedDir = dependencyPath(pluginDir, dependency);
      let resolvedEntry = null;
      try {
        resolvedEntry = require.resolve(dependency, { paths: [pluginDir] });
      } catch {
        resolvedEntry = null;
      }
      if (
        installedDir === null
        || !fs.existsSync(path.join(installedDir, 'package.json'))
        || !fs.statSync(path.join(installedDir, 'package.json')).isFile()
        || resolvedEntry === null
        || !fs.realpathSync(resolvedEntry).startsWith(
          `${fs.realpathSync(installedDir)}${path.sep}`,
        )
      ) {
        missingDependencies.push(dependency);
      }
    }
    if (missingDependencies.length > 0) {
      return {
        usable: false,
        reason: 'production-dependencies-missing',
        missingDependencies,
      };
    }

    const integrityDigest = computeResearchPluginsIntegrity(pluginDir);
    let integrityStatus = 'ignored';
    if (!ignoreIntegrity) {
      let integritySource = null;
      try {
        integritySource = fs.readFileSync(
          path.join(pluginDir, RESEARCH_PLUGINS_INTEGRITY_FILE),
          'utf8',
        );
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          return { usable: false, reason: 'integrity-record-unavailable' };
        }
        if (requireIntegrity) {
          return { usable: false, reason: 'integrity-record-missing' };
        }
      }
      if (integritySource === null) {
        integrityStatus = 'legacy';
      } else {
        let integrityRecord;
        try {
          integrityRecord = JSON.parse(integritySource);
        } catch {
          return { usable: false, reason: 'integrity-record-invalid' };
        }
        if (
          integrityRecord?.schemaVersion !== 1
          || integrityRecord?.algorithm !== 'sha256'
          || integrityRecord?.digest !== integrityDigest
        ) {
          return { usable: false, reason: 'integrity-mismatch' };
        }
        integrityStatus = 'verified';
      }
    }

    return {
      usable: true,
      reason: 'ready',
      version:
        typeof packageJson.version === 'string' ? packageJson.version : null,
      catalogDigest: crypto
        .createHash('sha256')
        .update(catalogSource)
        .digest('hex'),
      integrityDigest,
      integrityStatus,
      mainPath,
      dependencies,
    };
  } catch {
    return { usable: false, reason: 'required-files-unavailable' };
  }
}

function isUsableResearchPluginsInstall(pluginDir) {
  return inspectResearchPluginsInstall(pluginDir).usable;
}

module.exports = {
  RESEARCH_PLUGINS_ID,
  RESEARCH_PLUGINS_INTEGRITY_FILE,
  RESEARCH_PLUGINS_PACKAGE,
  computeResearchPluginsIntegrity,
  inspectResearchPluginsInstall,
  isManagedResearchPluginsPath,
  isUsableResearchPluginsInstall,
  writeResearchPluginsIntegrityRecord,
};

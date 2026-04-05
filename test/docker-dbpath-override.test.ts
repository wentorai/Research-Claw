/**
 * Docker dbPath override test
 *
 * Validates that the Docker entrypoint correctly overrides dbPath
 * after ensure-config.cjs normalizes it to os.homedir() (which is
 * /root in Docker, but the volume mounts at /app/.research-claw).
 *
 * Tests the full config flow: ensure-config.cjs → Docker patch → idempotency
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

const ENSURE_CONFIG = path.resolve(__dirname, '../scripts/ensure-config.cjs');
const DOCKER_DB_PATH = '/app/.research-claw/library.db';
const HOME_DB_PATH = path.join(os.homedir(), '.research-claw', 'library.db');

/**
 * Simulates the Docker entrypoint's inline Node.js config patch.
 * This is extracted from docker-entrypoint.sh for testability.
 */
function applyDockerDbPathPatch(configPath: string): boolean {
  const c = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  let changed = false;

  const rcEntry = c.plugins?.entries?.['research-claw-core'];
  if (rcEntry) {
    if (!rcEntry.config) { rcEntry.config = {}; changed = true; }
    if (rcEntry.config.dbPath !== DOCKER_DB_PATH) {
      rcEntry.config.dbPath = DOCKER_DB_PATH;
      changed = true;
    }
  }

  if (changed) {
    fs.writeFileSync(configPath, JSON.stringify(c, null, 2) + '\n');
  }
  return changed;
}

function readDbPath(configPath: string): string | undefined {
  const c = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  return c.plugins?.entries?.['research-claw-core']?.config?.dbPath;
}

/** Minimal RC project config that triggers ensure-config.cjs normalization */
function makeConfig(dbPath?: string) {
  return {
    plugins: {
      entries: {
        'research-claw-core': {
          enabled: true,
          config: {
            ...(dbPath !== undefined ? { dbPath } : {}),
            autoTrackGit: true,
          },
        },
      },
    },
  };
}

describe('Docker dbPath override', () => {
  let tmpDir: string;
  let configDir: string;
  let configPath: string;

  beforeEach(() => {
    // Simulate Docker layout: <project>/config/openclaw.json
    // ensure-config.cjs derives projectRoot from path.dirname(configPath)/..
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-docker-test-'));
    configDir = path.join(tmpDir, 'config');
    fs.mkdirSync(configDir, { recursive: true });
    configPath = path.join(configDir, 'openclaw.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('overrides homedir dbPath to Docker volume path', () => {
    // After ensure-config, dbPath = os.homedir()/.research-claw/library.db
    fs.writeFileSync(configPath, JSON.stringify(makeConfig(HOME_DB_PATH), null, 2));

    const changed = applyDockerDbPathPatch(configPath);
    expect(changed).toBe(true);
    expect(readDbPath(configPath)).toBe(DOCKER_DB_PATH);
  });

  it('is idempotent — second run makes no changes', () => {
    fs.writeFileSync(configPath, JSON.stringify(makeConfig(DOCKER_DB_PATH), null, 2));

    const changed = applyDockerDbPathPatch(configPath);
    expect(changed).toBe(false);
    expect(readDbPath(configPath)).toBe(DOCKER_DB_PATH);
  });

  it('handles missing config object on rcEntry', () => {
    const cfg = {
      plugins: {
        entries: {
          'research-claw-core': { enabled: true },
        },
      },
    };
    fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));

    const changed = applyDockerDbPathPatch(configPath);
    expect(changed).toBe(true);
    expect(readDbPath(configPath)).toBe(DOCKER_DB_PATH);
  });

  it('handles missing rcEntry gracefully (no crash)', () => {
    fs.writeFileSync(configPath, JSON.stringify({ plugins: { entries: {} } }, null, 2));

    const changed = applyDockerDbPathPatch(configPath);
    expect(changed).toBe(false);
  });

  it('overrides legacy relative dbPath', () => {
    fs.writeFileSync(configPath, JSON.stringify(makeConfig('.research-claw/library.db'), null, 2));

    const changed = applyDockerDbPathPatch(configPath);
    expect(changed).toBe(true);
    expect(readDbPath(configPath)).toBe(DOCKER_DB_PATH);
  });

  it('overrides tilde dbPath', () => {
    fs.writeFileSync(configPath, JSON.stringify(makeConfig('~/.research-claw/library.db'), null, 2));

    const changed = applyDockerDbPathPatch(configPath);
    expect(changed).toBe(true);
    expect(readDbPath(configPath)).toBe(DOCKER_DB_PATH);
  });

  it('full flow: ensure-config.cjs → Docker patch produces correct dbPath', () => {
    // Start with old-style relative dbPath (pre-PR#50)
    fs.writeFileSync(configPath, JSON.stringify(makeConfig('.research-claw/library.db'), null, 2));

    // Step 1: ensure-config.cjs normalizes to homedir
    execFileSync('node', [ENSURE_CONFIG, configPath]);
    const afterEnsure = readDbPath(configPath);
    expect(afterEnsure).toBe(HOME_DB_PATH);

    // Step 2: Docker patch overrides to volume-backed path
    const changed = applyDockerDbPathPatch(configPath);
    expect(changed).toBe(true);
    expect(readDbPath(configPath)).toBe(DOCKER_DB_PATH);
  });

  it('full flow is idempotent across two boot cycles', () => {
    fs.writeFileSync(configPath, JSON.stringify(makeConfig('.research-claw/library.db'), null, 2));

    // Boot cycle 1
    execFileSync('node', [ENSURE_CONFIG, configPath]);
    applyDockerDbPathPatch(configPath);
    expect(readDbPath(configPath)).toBe(DOCKER_DB_PATH);

    // Boot cycle 2: ensure-config.cjs runs again.
    // In real Docker (projectRoot=/app), normalizeRcDbPath matches /app/.research-claw
    // as legacyAbs and converts back to homedir — then Docker patch fixes it again.
    // In test env (projectRoot=tmpDir), /app/... doesn't match legacyAbs so it stays.
    // Either way, after Docker patch, final result must be DOCKER_DB_PATH.
    execFileSync('node', [ENSURE_CONFIG, configPath]);
    applyDockerDbPathPatch(configPath);
    expect(readDbPath(configPath)).toBe(DOCKER_DB_PATH);
  });

  it('simulates real Docker boot cycle where ensure-config oscillates', () => {
    // Simulate the /app projectRoot by placing config at <tmpDir>/.research-claw/
    // so legacyAbs = path.join(tmpDir, '.research-claw', 'library.db')
    // matches the Docker path we set.
    const appDbPath = path.join(tmpDir, '.research-claw', 'library.db');

    // Start with dbPath pointing to project-relative .research-claw (pre-PR#50)
    fs.writeFileSync(configPath, JSON.stringify(makeConfig(appDbPath), null, 2));

    // ensure-config.cjs: legacyAbs = path.join(projectRoot, '.research-claw', 'library.db')
    // = appDbPath → normalizes to HOME_DB_PATH
    execFileSync('node', [ENSURE_CONFIG, configPath]);
    expect(readDbPath(configPath)).toBe(HOME_DB_PATH);

    // Docker patch overrides to the volume-backed path
    // (in this test we use appDbPath as the "Docker volume path")
    const dockerPatch = (cfgPath: string) => {
      const c = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      let changed = false;
      const entry = c.plugins?.entries?.['research-claw-core'];
      if (entry) {
        if (!entry.config) { entry.config = {}; changed = true; }
        if (entry.config.dbPath !== appDbPath) {
          entry.config.dbPath = appDbPath;
          changed = true;
        }
      }
      if (changed) fs.writeFileSync(cfgPath, JSON.stringify(c, null, 2) + '\n');
      return changed;
    };

    expect(dockerPatch(configPath)).toBe(true);
    expect(readDbPath(configPath)).toBe(appDbPath);

    // Boot cycle 2: ensure-config converts appDbPath back to HOME_DB_PATH (oscillation)
    execFileSync('node', [ENSURE_CONFIG, configPath]);
    expect(readDbPath(configPath)).toBe(HOME_DB_PATH);

    // Docker patch fixes it again → final result correct
    expect(dockerPatch(configPath)).toBe(true);
    expect(readDbPath(configPath)).toBe(appDbPath);
  });
});

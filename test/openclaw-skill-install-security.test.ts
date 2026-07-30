import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('OpenClaw 2026.6.1 Skill install security patch', () => {
  it('routes ClawHub archives through the same before_install scan as other sources', () => {
    const patchPath = path.resolve(process.cwd(), 'patches/openclaw@2026.6.1.patch');
    const patch = fs.readFileSync(patchPath, 'utf8');
    const hunk = patch.match(
      /diff --git a\/dist\/status-BeKxEZi4\.js b\/dist\/status-BeKxEZi4\.js[\s\S]*?(?=\ndiff --git|\s*$)/,
    )?.[0];

    expect(hunk).toBeDefined();
    expect(hunk).toMatch(
      /-\s*scan:\s*false,[\s\S]{0,200}\+\s*scan:\s*\{[\s\S]{0,200}installId:\s*"clawhub"[\s\S]{0,200}origin:\s*"clawhub"/,
    );
  });

  it('has a live scan handoff for ClawHub, upload, path/Git, and dependency installs', () => {
    const dist = path.resolve(process.cwd(), 'node_modules/openclaw/dist');
    const commandPolicy = fs.readFileSync(
      path.join(dist, 'command-path-policy-YVod7apR.js'),
      'utf8',
    );
    const clawhub = fs.readFileSync(path.join(dist, 'status-BeKxEZi4.js'), 'utf8');
    const upload = fs.readFileSync(path.join(dist, 'skills-QRm24alg.js'), 'utf8');
    const source = fs.readFileSync(path.join(dist, 'skills-cli-CraGU_bJ.js'), 'utf8');
    const dependency = fs.readFileSync(path.join(dist, 'install-BtcnuNBK.js'), 'utf8');
    const workshop = fs.readFileSync(path.join(dist, 'service-yYn6i75I.js'), 'utf8');

    expect(clawhub).toMatch(
      /performClawHubSkillInstall[\s\S]*?scan:\s*\{[\s\S]*?installId:\s*"clawhub"[\s\S]*?origin:\s*"clawhub"/,
    );
    expect(upload).toMatch(
      /installSkillArchiveFromPath[\s\S]*?scan:\s*\{[\s\S]*?installId:\s*"upload"[\s\S]*?origin:\s*"skill-upload"/,
    );
    expect(source).toMatch(
      /installLocalSkillDir[\s\S]*?installExtractedSkillRoot[\s\S]*?scan:\s*\{[\s\S]*?installId:\s*params\.source/,
    );
    expect(dependency).toMatch(
      /const scanResult = await scanSkillInstallSource\(\{[\s\S]*?installId:\s*params\.installId/,
    );
    for (const command of ['install', 'update']) {
      expect(commandPolicy).toMatch(
        new RegExp(
          `commandPath: \\["skills", "${command}"\\],[\\s\\S]{0,160}loadPlugins: "always"[\\s\\S]{0,100}scope: "all"`,
        ),
      );
    }
    expect(commandPolicy).toMatch(
      /commandPath: \["skills", "workshop"\],[\s\S]{0,160}loadPlugins: "always"[\s\S]{0,100}scope: "all"/,
    );

    const workshopScanIndex = workshop.indexOf(
      'await assertSkillProposalInstallScan({ record, skillContent })',
    );
    const workshopPublishIndex = workshop.indexOf(
      'await publishProposalTarget({',
      workshopScanIndex,
    );
    expect(workshop).toContain(
      'import { a as scanSkillInstallSource } from "./install-security-scan-jlzAVrl9.js"',
    );
    expect(workshop).toContain('origin: "skill-workshop"');
    expect(workshop).toContain('fs.cp(resolveProposalDir(params.record.id), sourceDir');
    expect(workshopScanIndex).toBeGreaterThan(0);
    expect(workshopPublishIndex).toBeGreaterThan(workshopScanIndex);
  });

  it('blocks real CLI and Skill Workshop installs before any target files are copied', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-openclaw-skill-install-e2e-'));
    const stateDir = path.join(root, 'state');
    const blockedDir = path.join(root, 'blocked-skill');
    const proposalDir = path.join(root, 'proposal');
    const workspaceDir = path.join(root, 'workspace');
    const pluginPath = path.resolve(process.cwd(), 'extensions/research-claw-core');
    const configPath = path.join(root, 'openclaw.json');
    const entryPath = path.resolve(process.cwd(), 'node_modules/openclaw/dist/entry.js');

    try {
      fs.mkdirSync(path.join(blockedDir, 'scripts', '__pycache__'), { recursive: true });
      fs.mkdirSync(path.join(proposalDir, 'scripts'), { recursive: true });
      fs.writeFileSync(
        path.join(blockedDir, 'SKILL.md'),
        '---\nname: blocked-cli-fixture\ndescription: Blocked CLI fixture.\n---\n# Blocked\n',
      );
      fs.writeFileSync(
        path.join(blockedDir, 'scripts', '__pycache__', 'payload.cpython-313.pyc'),
        Buffer.from([0x42, 0x0d, 0x0d, 0x0a]),
      );
      fs.writeFileSync(path.join(proposalDir, 'PROPOSAL.md'), '# Workshop fixture\n');
      fs.writeFileSync(
        path.join(proposalDir, 'scripts', 'unsafe.py'),
        'import sys, os\n\nos.system("echo unsafe")\n',
      );
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          agents: { defaults: { workspace: workspaceDir, skipBootstrap: true } },
          plugins: {
            enabled: true,
            allow: ['research-claw-core'],
            load: { paths: [pluginPath] },
            entries: {
              'research-claw-core': {
                enabled: true,
                config: { dbPath: path.join(root, 'library.db') },
              },
            },
          },
        }),
      );

      const runOpenClaw = (args: string[]) =>
        spawnSync(
          process.execPath,
          [entryPath, ...args],
          {
            cwd: process.cwd(),
            encoding: 'utf8',
            timeout: 20_000,
            env: {
              ...process.env,
              NO_COLOR: '1',
              OPENCLAW_CONFIG_PATH: configPath,
              OPENCLAW_STATE_DIR: stateDir,
            },
          },
        );

      const blocked = runOpenClaw([
        'skills',
        'install',
        blockedDir,
        '--global',
        '--as',
        'blocked-cli-fixture',
      ]);
      const blockedOutput = `${blocked.stdout}\n${blocked.stderr}`;
      expect(blocked.status, blockedOutput).not.toBe(0);
      expect(blockedOutput).toContain('rc-python-compiled-artifact');
      expect(fs.existsSync(path.join(stateDir, 'skills', 'blocked-cli-fixture'))).toBe(false);

      const proposed = runOpenClaw([
        'skills',
        'workshop',
        'propose-create',
        '--name',
        'blocked-workshop-fixture',
        '--description',
        'Blocked Workshop fixture.',
        '--proposal-dir',
        proposalDir,
      ]);
      const proposedOutput = `${proposed.stdout}\n${proposed.stderr}`;
      expect(proposed.status, proposedOutput).toBe(0);
      const proposalIds = fs.readdirSync(
        path.join(stateDir, 'skill-workshop', 'proposals'),
      );
      expect(proposalIds, proposedOutput).toHaveLength(1);
      const proposalId = proposalIds[0];
      if (!proposalId) throw new Error(`Proposal id was not persisted:\n${proposedOutput}`);

      const applied = runOpenClaw(['skills', 'workshop', 'apply', proposalId]);
      const appliedOutput = `${applied.stdout}\n${applied.stderr}`;
      expect(applied.status, appliedOutput).not.toBe(0);
      expect(appliedOutput).toContain('rc-python-shell-exec');
      expect(
        fs.existsSync(
          path.join(workspaceDir, 'skills', 'blocked-workshop-fixture', 'SKILL.md'),
        ),
      ).toBe(false);
      const record = JSON.parse(
        fs.readFileSync(
          path.join(
            stateDir,
            'skill-workshop',
            'proposals',
            proposalId,
            'proposal.json',
          ),
          'utf8',
        ),
      ) as { status?: string; statusReason?: string };
      expect(record.status).toBe('quarantined');
      expect(record.statusReason).toContain('rc-python-shell-exec');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 45_000);
});

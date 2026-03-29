import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface PptConfig {
  pptRoot: string;
  workspaceRoot: string;
  repoRoot: string;
}

export interface PptInitParams {
  projectName: string;
  format?: string;
}

export interface PptExportParams {
  projectPath: string;
  stage?: string;
}

export interface PptRunResult {
  ok: boolean;
  code: number;
  command: string;
  cwd: string;
  stdout: string;
  stderr: string;
  projectPath?: string;
  outputPath?: string;
  sourceOutputPath?: string;
}

export interface PptOpenResult {
  ok: boolean;
  fallback?: 'docker';
  containerPath?: string;
}

export interface PptRenameResult {
  ok: boolean;
  oldPath: string;
  newPath: string;
}

function isSafeRelativePath(input: string): boolean {
  if (!input || input.includes('\0')) return false;
  return !path.isAbsolute(input) && !input.split('/').includes('..');
}

export class PptService {
  private readonly pptRoot: string;
  private readonly workspaceRoot: string;
  private readonly repoRoot: string;
  private readonly workspaceOutputsRoot: string;
  private readonly outputsRoot: string;

  constructor(cfg: PptConfig) {
    this.pptRoot = path.resolve(cfg.pptRoot);
    this.workspaceRoot = path.resolve(cfg.workspaceRoot);
    this.repoRoot = path.resolve(cfg.repoRoot);
    this.workspaceOutputsRoot = path.join(this.workspaceRoot, 'outputs');
    this.outputsRoot = path.join(this.workspaceRoot, 'outputs', 'ppt');
    fs.mkdirSync(this.workspaceOutputsRoot, { recursive: true });
    fs.mkdirSync(this.outputsRoot, { recursive: true });
  }

  getStatus() {
    const scriptsRoot = path.join(this.pptRoot, 'skills', 'ppt-master', 'scripts');
    return {
      pptRoot: this.pptRoot,
      outputsRoot: this.outputsRoot,
      workspaceOutputsRoot: this.workspaceOutputsRoot,
      exists: fs.existsSync(this.pptRoot),
      scriptsRoot,
      hasProjectManager: fs.existsSync(path.join(scriptsRoot, 'project_manager.py')),
      hasSvgToPptx: fs.existsSync(path.join(scriptsRoot, 'svg_to_pptx.py')),
    };
  }

  async bootstrapPptMaster(): Promise<{
    ok: boolean;
    cwd: string;
    stdout: string;
    stderr: string;
    method: 'submodule' | 'clone' | 'noop';
  }> {
    const cwd = this.repoRoot;
    const targetDir = path.join(this.repoRoot, 'ppt-master');
    const scriptsRoot = path.join(targetDir, 'skills', 'ppt-master', 'scripts');
    const hasScripts =
      fs.existsSync(path.join(scriptsRoot, 'project_manager.py')) &&
      fs.existsSync(path.join(scriptsRoot, 'svg_to_pptx.py'));
    if (hasScripts) {
      return { ok: true, cwd, stdout: 'ppt-master already present', stderr: '', method: 'noop' };
    }

    const gitDir = path.join(this.repoRoot, '.git');
    if (!fs.existsSync(gitDir)) {
      throw new Error(`repoRoot is not a git repository: ${this.repoRoot}`);
    }

    const gitmodules = path.join(this.repoRoot, '.gitmodules');
    const hasSubmodule = fs.existsSync(gitmodules) &&
      fs.readFileSync(gitmodules, 'utf-8').includes('path = ppt-master');

    if (hasSubmodule) {
      const res = await this.runCmd(
        ['git', 'submodule', 'update', '--init', '--recursive', 'ppt-master'],
        cwd,
        300_000,
      );
      return { ...res, method: 'submodule' };
    }

    // Fallback: clone directly (for non-submodule deployments).
    const res = await this.runCmd(
      ['git', 'clone', '--depth', '1', 'https://github.com/hugohe3/ppt-master.git', 'ppt-master'],
      cwd,
      300_000,
    );
    return { ...res, method: 'clone' };
  }

  listWorkspaceOutputs(): { root: string; files: string[] } {
    const files: Array<{ path: string; mtimeMs: number }> = [];
    const stack: string[] = [this.workspaceOutputsRoot];
    while (stack.length > 0 && files.length < 500) {
      const current = stack.pop();
      if (!current || !fs.existsSync(current)) continue;
      const entries = fs.readdirSync(current, { withFileTypes: true });
      for (const entry of entries) {
        const abs = path.join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(abs);
          continue;
        }
        if (!entry.isFile()) continue;
        const stat = fs.statSync(abs);
        files.push({ path: abs, mtimeMs: stat.mtimeMs });
      }
    }
    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return {
      root: this.workspaceOutputsRoot,
      files: files.map((x) => x.path),
    };
  }

  async initProject(params: PptInitParams): Promise<PptRunResult> {
    const projectName = params.projectName.trim();
    if (!projectName) throw new Error('projectName is required');
    if (!/^[a-zA-Z0-9._-]+$/.test(projectName)) {
      throw new Error('projectName must only contain letters, numbers, dot, underscore, or dash');
    }
    const format = (params.format ?? 'ppt169').trim();
    if (!format) throw new Error('format is required');

    const script = path.join(this.pptRoot, 'skills', 'ppt-master', 'scripts', 'project_manager.py');
    const result = await this.runPython([script, 'init', projectName, '--format', format], this.pptRoot, 120_000);
    const stdout = result.stdout ?? '';
    const createdPathMatch =
      stdout.match(/^\[OK\]\s+Project initialized:\s+(.+)$/m) ??
      stdout.match(/^Project created:\s+(.+)$/m);
    const parsedPath = createdPathMatch?.[1]?.trim();
    const projectPath = parsedPath
      ? path.resolve(this.pptRoot, parsedPath)
      : path.join(this.pptRoot, 'projects', projectName);
    return {
      ...result,
      projectPath,
    };
  }

  async exportProject(params: PptExportParams): Promise<PptRunResult> {
    const relProjectPath = params.projectPath.trim();
    if (!isSafeRelativePath(relProjectPath)) {
      throw new Error('projectPath must be a relative path under pptRoot');
    }
    const stage = (params.stage ?? 'final').trim();
    if (!stage) throw new Error('stage is required');

    const projectAbsPath = path.resolve(this.pptRoot, relProjectPath);
    if (!projectAbsPath.startsWith(this.pptRoot + path.sep) && projectAbsPath !== this.pptRoot) {
      throw new Error('projectPath escapes pptRoot');
    }
    if (!fs.existsSync(projectAbsPath)) {
      throw new Error(`projectPath not found: ${relProjectPath}`);
    }

    const script = path.join(this.pptRoot, 'skills', 'ppt-master', 'scripts', 'svg_to_pptx.py');
    const result = await this.runPython([script, projectAbsPath, '-s', stage], this.pptRoot, 300_000);
    const generatedPptx = path.join(projectAbsPath, 'presentation.pptx');
    if (!fs.existsSync(generatedPptx)) {
      throw new Error(`Export output not found: ${generatedPptx}`);
    }

    // Move exported file into workspace/outputs for unified access from dashboard.
    const dateDir = new Date().toISOString().slice(0, 10);
    const dayRoot = path.join(this.outputsRoot, dateDir);
    fs.mkdirSync(dayRoot, { recursive: true });
    const projectBase = path.basename(projectAbsPath);
    const safeStage = stage.replace(/[^a-zA-Z0-9._-]/g, '_') || 'final';
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const targetName = `ppt-${projectBase}-${safeStage}-${stamp}.pptx`;
    const targetPath = path.join(dayRoot, targetName);
    fs.copyFileSync(generatedPptx, targetPath);

    return {
      ...result,
      stdout: `${result.stdout}\n[research-claw] copied output to: ${targetPath}`.trim(),
      projectPath: projectAbsPath,
      outputPath: targetPath,
      sourceOutputPath: generatedPptx,
    };
  }

  async openOutput(filePath: string): Promise<PptOpenResult> {
    const p = filePath.trim();
    if (!p) throw new Error('filePath is required');

    const abs = path.isAbsolute(p) ? path.resolve(p) : path.resolve(this.pptRoot, p);
    const inPptRoot = abs === this.pptRoot || abs.startsWith(this.pptRoot + path.sep);
    const inOutputs = abs === this.workspaceOutputsRoot || abs.startsWith(this.workspaceOutputsRoot + path.sep);
    if (!inPptRoot && !inOutputs) {
      throw new Error('filePath must be under pptRoot or workspace outputs');
    }
    if (!fs.existsSync(abs)) {
      throw new Error(`file does not exist: ${abs}`);
    }

    // No desktop in Docker environments; let UI handle fallback.
    if (fs.existsSync('/.dockerenv') || process.env.DOCKER === '1') {
      return { ok: false, fallback: 'docker', containerPath: abs };
    }

    await this.runOpen(abs);
    return { ok: true };
  }

  async renameOutputFile(inputPath: string, desiredBaseName: string): Promise<PptRenameResult> {
    const inP = inputPath.trim();
    const base = desiredBaseName.trim();
    if (!inP) throw new Error('inputPath is required');
    if (!base) throw new Error('desiredBaseName is required');

    const abs = path.isAbsolute(inP) ? path.resolve(inP) : path.resolve(this.workspaceRoot, inP);
    const inOutputs = abs === this.workspaceOutputsRoot || abs.startsWith(this.workspaceOutputsRoot + path.sep);
    if (!inOutputs) {
      throw new Error('inputPath must be under workspace/outputs');
    }
    if (!fs.existsSync(abs)) {
      throw new Error(`file does not exist: ${abs}`);
    }
    if (!abs.toLowerCase().endsWith('.pptx')) {
      throw new Error('inputPath must be a .pptx file');
    }

    const dir = path.dirname(abs);
    const ext = '.pptx';

    // Strip any extension in desiredBaseName, normalize and remove path separators.
    const stripExt = base.replace(/\.[^.]+$/, '');
    const sanitized = stripExt
      .replace(/[\/\\]/g, '_')
      .replace(/[^a-zA-Z0-9._\- \u4e00-\u9fa5]+/g, '_')
      .trim()
      .replace(/\s+/g, '_')
      .replace(/_+/g, '_');

    if (!sanitized) throw new Error('desiredBaseName after sanitization is empty');

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const makeName = (counter?: number) =>
      counter ? `${sanitized}-${stamp}-${counter}${ext}` : `${sanitized}-${stamp}${ext}`;

    let targetName = makeName();
    let targetPath = path.join(dir, targetName);
    let counter = 2;
    while (fs.existsSync(targetPath)) {
      targetName = makeName(counter++);
      targetPath = path.join(dir, targetName);
    }

    fs.renameSync(abs, targetPath);
    return { ok: true, oldPath: abs, newPath: targetPath };
  }

  private runPython(args: string[], cwd: string, timeoutMs: number): Promise<PptRunResult> {
    return new Promise((resolve, reject) => {
      const child = spawn('python3', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      let killedByTimeout = false;
      const timer = setTimeout(() => {
        killedByTimeout = true;
        child.kill('SIGTERM');
      }, timeoutMs);

      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        const result: PptRunResult = {
          ok: code === 0 && !killedByTimeout,
          code: code ?? -1,
          command: `python3 ${args.map((x) => JSON.stringify(x)).join(' ')}`,
          cwd,
          stdout: stdout.trim(),
          stderr: (killedByTimeout ? `Timed out after ${timeoutMs}ms\n` : '') + stderr.trim(),
        };
        if (!result.ok) {
          reject(new Error(result.stderr || result.stdout || 'ppt command failed'));
          return;
        }
        resolve(result);
      });
    });
  }

  private runCmd(
    args: string[],
    cwd: string,
    timeoutMs: number,
  ): Promise<{ ok: boolean; cwd: string; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const [bin, ...rest] = args;
      const child = spawn(bin!, rest, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      let killedByTimeout = false;
      const timer = setTimeout(() => {
        killedByTimeout = true;
        child.kill('SIGTERM');
      }, timeoutMs);

      child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
      child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        const ok = code === 0 && !killedByTimeout;
        const out = stdout.trim();
        const err = (killedByTimeout ? `Timed out after ${timeoutMs}ms\n` : '') + stderr.trim();
        if (!ok) {
          reject(new Error(err || out || `command failed: ${args.join(' ')}`));
          return;
        }
        resolve({ ok: true, cwd, stdout: out, stderr: err });
      });
    });
  }

  private runOpen(absPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      let child;
      if (process.platform === 'darwin') {
        child = spawn('open', [absPath], { cwd: this.pptRoot, stdio: 'ignore' });
      } else if (process.platform === 'win32') {
        child = spawn('cmd', ['/c', 'start', '', absPath], { cwd: this.pptRoot, stdio: 'ignore' });
      } else {
        child = spawn('xdg-open', [absPath], { cwd: this.pptRoot, stdio: 'ignore' });
      }
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`failed to open file (exit ${code ?? -1})`));
      });
    });
  }
}

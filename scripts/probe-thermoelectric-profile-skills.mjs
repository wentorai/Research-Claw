#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const profileRoot = path.resolve(process.argv[2] ?? path.join(root, 'profiles', 'fixtures', 'thermoelectric-user-a'));
const openClawEntry = path.join(root, 'node_modules', 'openclaw', 'dist', 'entry.js');
const openClawPackage = path.join(root, 'node_modules', 'openclaw', 'package.json');
const expectedVersion = '2026.6.1';
const tasks = [
  {
    expectedSkill: 'research-thermoelectric-semiconductors',
    reference: 'references/research-methodology.md',
    prompt: '请为新的热电半导体发电材料建立从输运物理到器件的可证伪研究路线。',
  },
  {
    expectedSkill: 'develop-flexible-bismuth-telluride',
    reference: 'references/benchmarking-and-reliability.md',
    prompt: '请设计柔性碲化铋薄膜可穿戴发电器的弯折可靠性和器件基准测试。',
  },
  {
    expectedSkill: 'engineer-gete-thermoelectrics',
    reference: 'references/devices-and-reliability.md',
    prompt: '请设计GeTe热电材料到扩散阻挡层、单腿和模块的可靠性研究。',
  },
];

let tempRoot;
let provider;
let cleanupPromise;
const taskState = new Map();
const children = new Set();
const cliTimeoutOverride = Number.parseInt(process.env.RC_T03_PROBE_CLI_TIMEOUT_MS ?? '', 10);
const readyFile = process.env.RC_T03_PROBE_READY_FILE;

function invariant(value, message) {
  if (!value) throw new Error(message);
}

function parseJson(stdout) {
  const source = stdout.trim();
  for (let index = source.indexOf('{'); index >= 0; index = source.indexOf('{', index + 1)) {
    try { return JSON.parse(source.slice(index)); } catch { /* skip launcher banner */ }
  }
  throw new Error(`OpenClaw output did not contain JSON: ${source.slice(0, 500)}`);
}

function isolatedEnv(stateDir, workspaceDir) {
  const inherited = {};
  for (const key of ['PATH', 'Path', 'PATHEXT', 'SHELL', 'COMSPEC', 'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'TZ']) {
    if (process.env[key] !== undefined) inherited[key] = process.env[key];
  }
  return {
    ...inherited,
    HOME: path.join(tempRoot, 'home'),
    USERPROFILE: path.join(tempRoot, 'home'),
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: path.join(stateDir, 'openclaw.json'),
    NO_PROXY: '127.0.0.1,localhost,::1',
    no_proxy: '127.0.0.1,localhost,::1',
    RC_T03_WORKSPACE: workspaceDir,
  };
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = (ms) => Promise.race([
    new Promise((resolve) => child.once('exit', () => resolve(true))),
    new Promise((resolve) => setTimeout(() => resolve(false), ms)),
  ]);
  child.kill('SIGTERM');
  if (!await exited(2000) && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await exited(2000);
  }
  invariant(child.exitCode !== null || child.signalCode !== null, `OpenClaw child ${child.pid} survived cleanup`);
}

async function updateReadyFile() {
  if (!readyFile || !tempRoot) return;
  await writeFile(readyFile, `${JSON.stringify({ tempRoot, childPids: [...children].map((child) => child.pid).filter(Boolean) })}\n`, 'utf8');
}

async function runCli(args, env, timeout = 30_000) {
  const effectiveTimeout = Number.isFinite(cliTimeoutOverride) && cliTimeoutOverride > 0 ? cliTimeoutOverride : timeout;
  const child = spawn(process.execPath, [openClawEntry, ...args], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  await updateReadyFile();
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { if (stdout.length < 5 * 1024 * 1024) stdout += chunk; });
  child.stderr.on('data', (chunk) => { if (stderr.length < 5 * 1024 * 1024) stderr += chunk; });
  let timer;
  try {
    const outcome = await Promise.race([
      new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code, signal) => resolve({ code, signal }));
      }),
      new Promise((resolve) => { timer = setTimeout(() => resolve({ timeout: true }), effectiveTimeout); }),
    ]);
    if (outcome.timeout) {
      await stopChild(child);
      throw new Error(`OpenClaw CLI timed out after ${effectiveTimeout} ms`);
    }
    invariant(outcome.code === 0, `OpenClaw CLI failed (${outcome.code ?? outcome.signal}): ${stderr.slice(-2000)}`);
    return stdout;
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) await stopChild(child);
    children.delete(child);
    await updateReadyFile();
  }
}

function streamChunk(response, delta, finishReason = null) {
  response.write(`data: ${JSON.stringify({
    id: 'chatcmpl-t03', object: 'chat.completion.chunk', created: 0, model: 'fixture',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`);
}

function toolCall(response, id, filePath) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  streamChunk(response, {
    role: 'assistant',
    tool_calls: [{ index: 0, id, type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: filePath }) } }],
  });
  streamChunk(response, {}, 'tool_calls');
  response.end('data: [DONE]\n\n');
}

function messageText(message) {
  if (typeof message?.content === 'string') return message.content;
  if (!Array.isArray(message?.content)) return '';
  return message.content.map((part) => typeof part === 'string' ? part : (part?.text ?? '')).join('\n');
}

function finalAnswer(response, expectedSkill) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  streamChunk(response, { role: 'assistant', content: `T03_SELECTED:${expectedSkill}` });
  streamChunk(response, {}, 'stop');
  response.end('data: [DONE]\n\n');
}

async function startProvider() {
  provider = http.createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/v1/models') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ object: 'list', data: [{ id: 'fixture', object: 'model' }] }));
      return;
    }
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404).end();
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const promptText = body.messages?.map(messageText).join('\n') ?? '';
    const task = tasks.find((candidate) => promptText.includes(candidate.prompt));
    invariant(task, 'provider could not route deterministic task');
    invariant(promptText.includes(task.expectedSkill), `${task.expectedSkill} missing from real model prompt`);
    const state = taskState.get(task.expectedSkill) ?? { step: 0, reads: [] };
    const directory = `skills/rc-profile--thermoelectric-user-a--${task.expectedSkill}`;
    if (state.step === 0) {
      state.step = 1;
      state.reads.push('SKILL.md');
      taskState.set(task.expectedSkill, state);
      toolCall(response, `read-skill-${task.expectedSkill}`, `${directory}/SKILL.md`);
    } else if (state.step === 1) {
      state.step = 2;
      state.reads.push(task.reference);
      taskState.set(task.expectedSkill, state);
      toolCall(response, `read-reference-${task.expectedSkill}`, `${directory}/${task.reference}`);
    } else {
      state.step = 3;
      taskState.set(task.expectedSkill, state);
      finalAnswer(response, task.expectedSkill);
    }
  });
  await new Promise((resolve, reject) => {
    provider.once('error', reject);
    provider.listen(0, '127.0.0.1', resolve);
  });
  const address = provider.address();
  invariant(address && typeof address === 'object', 'provider did not bind');
  return address.port;
}

async function writeConfig(stateDir, workspaceDir, port) {
  await mkdir(stateDir, { recursive: true });
  await writeFile(path.join(stateDir, 'openclaw.json'), `${JSON.stringify({
    agents: { defaults: { workspace: workspaceDir, skipBootstrap: true, model: { primary: 'fixture/fixture' }, timeoutSeconds: 20 } },
    models: { mode: 'merge', providers: { fixture: {
      baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'RC_T03_LOCAL_FAKE_KEY', api: 'openai-completions',
      models: [{ id: 'fixture', name: 'T03 fixture', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 256 }],
    } } },
    skills: { allowBundled: ['rc-t03-no-bundled-skills'], limits: { maxSkillsInPrompt: 10, maxSkillsPromptChars: 30000 } },
  }, null, 2)}\n`, { mode: 0o600 });
}

async function materializeWorkspace(workspaceDir) {
  const capsule = JSON.parse(await readFile(path.join(profileRoot, 'capsule.json'), 'utf8'));
  for (const item of capsule.skills.items) {
    const skillDir = path.join(workspaceDir, 'skills', `rc-profile--thermoelectric-user-a--${item.slug}`);
    for (const file of item.files) {
      const target = path.join(skillDir, ...file.path.split('/'));
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, file.content, 'utf8');
    }
  }
}

async function cleanup() {
  await Promise.all([...children].map((child) => stopChild(child)));
  children.clear();
  await updateReadyFile();
  if (provider) {
    provider.closeAllConnections?.();
    await new Promise((resolve) => provider.close(resolve));
    provider = undefined;
  }
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
}

function cleanupOnce() {
  cleanupPromise ??= cleanup();
  return cleanupPromise;
}

async function main() {
  const manifest = JSON.parse(await readFile(openClawPackage, 'utf8'));
  invariant(manifest.version === expectedVersion, `probe requires OpenClaw ${expectedVersion}`);
  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'rc-t03-thermo-skills-'));
  const ordinaryWorkspace = path.join(tempRoot, 'ordinary-workspace');
  const ordinaryState = path.join(tempRoot, 'ordinary-state');
  const profileWorkspace = path.join(tempRoot, 'profile-workspace');
  const profileState = path.join(tempRoot, 'profile-state');
  await Promise.all([mkdir(ordinaryWorkspace, { recursive: true }), mkdir(profileWorkspace, { recursive: true }), mkdir(path.join(tempRoot, 'home'), { recursive: true })]);
  const port = await startProvider();
  await Promise.all([
    writeConfig(ordinaryState, ordinaryWorkspace, port),
    writeConfig(profileState, profileWorkspace, port),
    materializeWorkspace(profileWorkspace),
  ]);
  await updateReadyFile();

  const ordinary = parseJson(await runCli(['skills', 'list', '--json', '--agent', 'main'], isolatedEnv(ordinaryState, ordinaryWorkspace)));
  const ordinaryInventory = ordinary.skills.filter((entry) => tasks.some((task) => task.expectedSkill === entry.name)).map((entry) => entry.name);
  const profileList = parseJson(await runCli(['skills', 'list', '--json', '--agent', 'main'], isolatedEnv(profileState, profileWorkspace)));
  const profileInventory = [];
  for (const task of tasks) {
    const info = parseJson(await runCli(['skills', 'info', task.expectedSkill, '--json', '--agent', 'main'], isolatedEnv(profileState, profileWorkspace)));
    invariant(info.source === 'openclaw-workspace', `${task.expectedSkill} source was ${info.source}`);
    profileInventory.push({ name: task.expectedSkill, source: info.source });
  }
  profileInventory.sort((a, b) => a.name.localeCompare(b.name));
  invariant(profileList.skills.filter((entry) => tasks.some((task) => task.expectedSkill === entry.name)).length === 3, 'Profile list did not include all three Skills');

  const taskSelections = [];
  for (let index = 0; index < tasks.length; index += 1) {
    const task = tasks[index];
    const stdout = await runCli(['agent', '--local', '--json', '--session-id', `t03-task-${index}`, '--message', task.prompt, '--timeout', '20'], isolatedEnv(profileState, profileWorkspace), 45_000);
    invariant(stdout.includes(`T03_SELECTED:${task.expectedSkill}`), `${task.expectedSkill} agent selection failed`);
    const state = taskState.get(task.expectedSkill);
    invariant(state?.step === 3, `${task.expectedSkill} did not complete two real read calls`);
    taskSelections.push({ expectedSkill: task.expectedSkill, readSkill: task.expectedSkill, readReference: state.reads[1] });
  }

  return { openClawVersion: manifest.version, ordinaryInventory, profileInventory, taskSelections };
}

for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  process.once(signal, () => { void cleanupOnce().finally(() => process.exit(code)); });
}

let result;
try {
  result = await main();
} finally {
  await cleanupOnce();
}
invariant(provider === undefined, 'loopback provider survived cleanup');
invariant(children.size === 0, 'OpenClaw child registry survived cleanup');
let tempSurvived = true;
try { await access(tempRoot); } catch { tempSurvived = false; }
invariant(!tempSurvived, 'temporary OpenClaw state survived cleanup');
process.stdout.write(`${JSON.stringify({ ...result, cleanup: 'clean' }, null, 2)}\n`);

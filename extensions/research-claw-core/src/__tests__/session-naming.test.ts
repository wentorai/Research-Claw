import { describe, expect, it, vi } from 'vitest';
import { SessionNamingService, sanitizeTitle } from '../session-naming/service.js';
import { registerSessionNamingRpc } from '../session-naming/rpc.js';
import type { RegisterMethod } from '../types.js';

describe('sanitizeTitle', () => {
  it('takes the first non-empty line and trims whitespace', () => {
    expect(sanitizeTitle('\n  注意力机制论文整理  \n第二行')).toBe('注意力机制论文整理');
  });

  it('strips surrounding quotes (CJK and ASCII)', () => {
    expect(sanitizeTitle('"Attention Survey"')).toBe('Attention Survey');
    expect(sanitizeTitle('“注意力机制论文整理”')).toBe('注意力机制论文整理');
    expect(sanitizeTitle("'quoted title'")).toBe('quoted title');
  });

  it('strips trailing punctuation and a leading title label', () => {
    expect(sanitizeTitle('注意力机制论文整理。')).toBe('注意力机制论文整理');
    expect(sanitizeTitle('Attention survey.')).toBe('Attention survey');
    expect(sanitizeTitle('标题：注意力机制论文整理')).toBe('注意力机制论文整理');
    expect(sanitizeTitle('Title: Attention survey')).toBe('Attention survey');
    expect(sanitizeTitle('会话标题: 图神经网络')).toBe('图神经网络');
  });

  it('hard caps at 40 characters for an unbroken string', () => {
    expect(sanitizeTitle('x'.repeat(80))).toHaveLength(40);
  });

  it('backs off to a word boundary instead of chopping a Latin word', () => {
    const input = 'GNN Molecular Property Prediction Methods Survey Overview Report';
    const title = sanitizeTitle(input);
    expect(title.length).toBeLessThanOrEqual(40);
    expect(title.endsWith(' ')).toBe(false);
    expect(input).toContain(title.split(' ').pop()!);
  });

  it('hard-cuts a CJK title with no spaces at the cap', () => {
    expect(sanitizeTitle('图'.repeat(60))).toHaveLength(40);
  });

  it('returns empty string for blank input', () => {
    expect(sanitizeTitle('')).toBe('');
    expect(sanitizeTitle('  \n  ')).toBe('');
  });
});

describe('SessionNamingService.generateTitle', () => {
  it('uses the host LLM runtime without overriding its bound agent or model', async () => {
    const runtimeComplete = vi.fn().mockResolvedValue({
      text: '“注意力机制论文整理”\n',
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
      agentId: 'main',
      usage: {},
      audit: { caller: { kind: 'plugin', id: 'research-claw-core' } },
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const service = new SessionNamingService({ runtimeComplete });
    const title = await service.generateTitle({
      userText: '请帮我整理 Transformer 注意力机制的代表性论文',
      assistantText: '好的，可以从 Attention Is All You Need 开始……',
    });

    expect(title).toBe('注意力机制论文整理');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(runtimeComplete).toHaveBeenCalledWith(expect.objectContaining({
      maxTokens: expect.any(Number),
      purpose: 'research-claw:session-auto-name',
      temperature: 0,
      messages: [expect.objectContaining({
        role: 'user',
        content: expect.stringContaining('Transformer'),
      })],
    }));
    // OC 6.1 binds plugin completions to its own runtime authority. Supplying
    // agentId or model here is an override and is rejected before inference.
    expect(runtimeComplete.mock.calls[0][0]).not.toHaveProperty('agentId');
    expect(runtimeComplete.mock.calls[0][0]).not.toHaveProperty('model');
  });

  it('follows the host runtime failure without falling back to direct provider calls', async () => {
    const runtimeComplete = vi.fn().mockRejectedValue(new Error('model auth unavailable'));
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const service = new SessionNamingService({ runtimeComplete });

    await expect(service.generateTitle({ userText: 'q', assistantText: 'a' }))
      .rejects.toThrow(/model auth unavailable/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws a traceable error when the host runtime was not injected', async () => {
    const service = new SessionNamingService();
    await expect(service.generateTitle({ userText: 'q', assistantText: 'a' }))
      .rejects.toThrow(/Research-Claw LLM runtime/);
  });

  it('throws when the runtime returns an empty title', async () => {
    const service = new SessionNamingService({
      runtimeComplete: vi.fn().mockResolvedValue({ text: '   ' }),
    });
    await expect(service.generateTitle({ userText: 'q', assistantText: 'a' })).rejects.toThrow(/empty title/);
  });
});

describe('rc.session.autoName RPC', () => {
  function setup(runtimeComplete = vi.fn().mockResolvedValue({ text: '注意力机制论文整理' })) {
    const handlers = new Map<string, (params: Record<string, unknown>) => Promise<unknown> | unknown>();
    const registerMethod: RegisterMethod = (method, handler) => handlers.set(method, handler);
    registerSessionNamingRpc(registerMethod, new SessionNamingService({ runtimeComplete }));
    return { handlers, runtimeComplete };
  }

  it('registers rc.session.autoName and returns { ok, title }', async () => {
    const { handlers, runtimeComplete } = setup();

    expect(handlers.has('rc.session.autoName')).toBe(true);
    const result = await handlers.get('rc.session.autoName')!({
      key: 'agent:main:project-e5f6g7h8',
      userText: '请帮我整理 Transformer 注意力机制的代表性论文',
      assistantText: '好的……',
    });
    expect(result).toEqual({ ok: true, title: '注意力机制论文整理' });
    expect(runtimeComplete).toHaveBeenCalledTimes(1);
  });

  it('rejects missing userText/assistantText', async () => {
    const { handlers } = setup();
    const handler = handlers.get('rc.session.autoName')!;
    await expect(Promise.resolve(handler({ assistantText: 'a' }))).rejects.toThrow(/userText/);
    await expect(Promise.resolve(handler({ userText: 'q' }))).rejects.toThrow(/assistantText/);
  });
});

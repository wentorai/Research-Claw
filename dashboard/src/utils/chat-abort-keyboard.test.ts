/**
 * chat-abort-keyboard.test.ts — 全局 Esc 停止生成快捷键的 IME 合成守卫
 *
 * 缺陷背景：`installChatAbortKeyboardShortcuts()` 在 window 上以 **capture** 相
 * 挂了一个 keydown 监听,只要 `isActiveChatRun()` 为真且键是 Escape 就 abort。
 * 但 Escape 同时是所有 CJK 输入法「取消候选词」的标准按键 —— 中文用户在 agent
 * 流式输出期间边看边打下一条消息,按 Esc 关掉候选窗,就会把正在跑的生成杀掉,
 * 且 `stopImmediatePropagation()` 让输入法侧无从补救。
 *
 * 合成期的 keydown 由 `KeyboardEvent.isComposing` 标识(候选窗打开时为 true),
 * 守卫必须在读取按键语义之前先看这一位。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mock the chat store: abort() is the destructive action under test ─────────
const abortMock = vi.fn();
vi.mock('../stores/chat', () => ({
  useChatStore: {
    getState: () => ({ abort: abortMock }),
  },
}));

// ── Mock the run gate so every test runs "with an active chat run" ────────────
const isActiveChatRunMock = vi.fn();
vi.mock('./chat-run', () => ({
  isActiveChatRun: () => isActiveChatRunMock(),
}));

import { installChatAbortKeyboardShortcuts } from './chat-abort-keyboard';

/**
 * The module installs exactly once per process (module-level `installed` flag),
 * so install it once here and reuse the listener across tests.
 */
installChatAbortKeyboardShortcuts();

function pressEscape(opts: { isComposing?: boolean; keyCode?: number } = {}) {
  // KeyboardEvent's `isComposing` is readonly and NOT settable through the
  // constructor's init dict in happy-dom, so define it on the instance — this
  // mirrors what the browser reports while an IME candidate window is open.
  const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  Object.defineProperty(event, 'isComposing', { value: opts.isComposing ?? false });
  if (opts.keyCode !== undefined) {
    Object.defineProperty(event, 'keyCode', { value: opts.keyCode });
  }
  window.dispatchEvent(event);
  return event;
}

beforeEach(() => {
  abortMock.mockReset();
  isActiveChatRunMock.mockReset();
  isActiveChatRunMock.mockReturnValue(true); // a run IS streaming
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('installChatAbortKeyboardShortcuts — IME composition guard', () => {
  it('Esc 在输入法合成期(isComposing=true)不得中止生成', () => {
    const event = pressEscape({ isComposing: true });

    expect(abortMock).not.toHaveBeenCalled();
    // 也不得吞掉事件 —— 输入法自己要用这次 Esc 关候选窗
    expect(event.defaultPrevented).toBe(false);
  });

  it('Esc 在合成期的 keyCode=229 形态下同样不得中止生成', () => {
    // Chrome 在合成期把 keydown 的 keyCode 统一报成 229;个别输入法/浏览器组合
    // 下 isComposing 缺失,229 是第二道可观测特征。
    const event = pressEscape({ isComposing: false, keyCode: 229 });

    expect(abortMock).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it('Esc 在非合成期仍然正常中止生成(守卫不得误伤主路径)', () => {
    const event = pressEscape({ isComposing: false });

    expect(abortMock).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it('没有活跃生成时,任何 Esc 都不中止', () => {
    isActiveChatRunMock.mockReturnValue(false);

    pressEscape({ isComposing: false });

    expect(abortMock).not.toHaveBeenCalled();
  });
});

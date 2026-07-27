/**
 * App.needs-token.test.tsx — needs_token 引导页 token 输入框的 IME 合成守卫
 *
 * 缺陷背景：`bootState === 'needs_token'` 时渲染的 `Input.Password` 用
 * `onPressEnter` 直接做整页跳转(`window.location.href = ?token=...`)。
 * antd Input 的 `onPressEnter` 由 rc-input 从 keydown 直接派生,没有合成守卫,
 * 所以合成期(候选窗打开)的那次 Enter 会带着半成品串跳走整页,用户已输入的
 * 内容全部丢失,且落回同一张 needs_token 页。
 *
 * 守卫必须在读取按键语义之前先看合成位。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (opts && typeof opts === 'object' && 'defaultValue' in opts) return String(opts.defaultValue);
      return key;
    },
    i18n: { changeLanguage: vi.fn(), language: 'zh-CN' },
  }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  Trans: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));

import App from './App';
import { useConfigStore } from './stores/config';
import { useGatewayStore } from './stores/gateway';

const originalHref = window.location.href;
let assignedHref: string | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  assignedHref = null;
  // Intercept the navigation instead of letting happy-dom actually navigate.
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { pathname: '/', search: '' },
  });
  Object.defineProperty(window.location, 'href', {
    configurable: true,
    get: () => originalHref,
    set: (v: string) => { assignedHref = v; },
  });

  useConfigStore.setState({
    bootState: 'needs_token',
    theme: 'dark',
    locale: 'zh-CN',
    loadConfig: vi.fn().mockResolvedValue(undefined),
  } as never);
  useGatewayStore.setState({
    state: 'disconnected',
    client: null,
    connectError: null,
    connect: vi.fn(),
  } as never);
});

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).location;
});

function tokenInput(): HTMLInputElement {
  return screen.getByPlaceholderText('boot.tokenPlaceholder') as HTMLInputElement;
}

describe('App needs_token — token 输入框 IME 合成守卫 (CJK)', () => {
  it('合成期按 Enter 不得带着半成品串整页跳转', () => {
    render(<App />);
    const input = tokenInput();
    fireEvent.change(input, { target: { value: '令牌' } });

    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });

    expect(assignedHref).toBeNull();
  });

  it('合成期的 keyCode=229 形态同样不得跳转', () => {
    render(<App />);
    const input = tokenInput();
    fireEvent.change(input, { target: { value: '令牌' } });

    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 });

    expect(assignedHref).toBeNull();
  });

  it('非合成期按 Enter 照常携带 token 跳转（守卫不得误伤主路径）', () => {
    render(<App />);
    const input = tokenInput();
    fireEvent.change(input, { target: { value: 'abc123' } });

    fireEvent.keyDown(input, { key: 'Enter', isComposing: false });

    expect(assignedHref).toBe('/?token=abc123');
  });
});

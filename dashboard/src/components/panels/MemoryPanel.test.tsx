/**
 * MemoryPanel.test.tsx — 记忆搜索框的 IME 合成守卫
 *
 * 缺陷背景：搜索框是 antd `Input`,`onPressEnter={handleSearch}` 直接挂在
 * rc-input 上。rc-input 的 `onPressEnter` 是从 keydown 里按 `key === 'Enter'`
 * 直接派生的,**自身没有任何合成守卫**(与 antd `Input.Search` 不同,后者内部
 * 有 composedRef)。中文用户输入「记忆」时,用来选定候选词的那次 Enter 会被
 * 当成一次真实搜索,拿着半成品拼音去打 `rc.memory.*`,并把面板置为 loading。
 *
 * 守卫必须在读取按键语义之前先看合成位:合成期的 Enter 一次网络请求都不能发,
 * 非合成期必须照常搜索。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import React from 'react';
import { ConfigProvider } from 'antd';
import { MemoryPanel } from './MemoryPanel';
import { useMemoryStore } from '../../stores/memory';
import { useGatewayStore } from '../../stores/gateway';

const fetchMemories = vi.fn().mockResolvedValue(undefined);
const fetchStats = vi.fn().mockResolvedValue(undefined);
const syncHookLogs = vi.fn().mockResolvedValue(undefined);

function Wrapper({ children }: { children: React.ReactNode }) {
  return <ConfigProvider>{children}</ConfigProvider>;
}

async function renderPanel() {
  const utils = render(
    <Wrapper>
      <MemoryPanel />
    </Wrapper>,
  );
  // Let the mount-time loadData() settle, then forget those calls — the
  // assertions below are only about what the Enter key triggers.
  await waitFor(() => expect(fetchMemories).toHaveBeenCalled());
  fetchMemories.mockClear();
  return utils;
}

function searchInput(): HTMLInputElement {
  return screen.getByPlaceholderText('搜索记忆...') as HTMLInputElement;
}

beforeEach(() => {
  vi.clearAllMocks();
  useGatewayStore.setState({ state: 'disconnected' } as never);
  useMemoryStore.setState({
    memories: [],
    selectedType: null,
    searchQuery: '',
    stats: null,
    fetchMemories,
    fetchStats,
    syncHookLogs,
  } as never);
});

describe('MemoryPanel — 搜索框 IME 合成守卫 (CJK)', () => {
  it('合成期按 Enter 不得用半成品查询触发搜索', async () => {
    await renderPanel();
    const input = searchInput();
    fireEvent.change(input, { target: { value: '记忆' } });

    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    });

    expect(fetchMemories).not.toHaveBeenCalled();
  });

  it('合成期的 keyCode=229 形态同样不得触发搜索', async () => {
    await renderPanel();
    const input = searchInput();
    fireEvent.change(input, { target: { value: '会话' } });

    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 });
    });

    expect(fetchMemories).not.toHaveBeenCalled();
  });

  it('非合成期按 Enter 照常搜索（守卫不得误伤主路径）', async () => {
    await renderPanel();
    const input = searchInput();
    fireEvent.change(input, { target: { value: '记忆' } });

    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter', isComposing: false });
    });

    await waitFor(() => expect(fetchMemories).toHaveBeenCalledTimes(1));
  });
});
